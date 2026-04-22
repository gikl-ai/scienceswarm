import matter from "gray-matter";

import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { getLLMClient, getBrainConfig, isErrorResponse } from "../_shared";
import { ensureBrainStoreReady, getBrainStore, type BrainPage } from "@/brain/store";
import { filterProjectPages } from "@/brain/project-organizer";
import { isLocalRequest } from "@/lib/local-guard";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

const PAGE_SCAN_LIMIT = 5000;
const PAGE_SELECTION_LIMIT = 14;
const PAGE_EXCERPT_LIMIT = 900;

type EvidenceSource = {
  slug: string;
  title: string;
  filename?: string;
  excerpt?: string;
};

type EvidenceClaim = {
  id: string;
  statement: string;
  qualifiers: string[];
  confidence: "high" | "medium" | "low";
  sources: EvidenceSource[];
};

type EvidenceTension = {
  id: string;
  summary: string;
  why: string;
  confidence: "high" | "medium" | "low";
  claim_ids: string[];
  sources: EvidenceSource[];
};

type EvidenceUncertainty = {
  gap: string;
  next_clarification: string;
};

type EvidenceMapPayload = {
  focused_question: string;
  claims: EvidenceClaim[];
  tensions: EvidenceTension[];
  uncertainties: EvidenceUncertainty[];
  honesty_note: string;
};

type EvidenceMapRequestBody = {
  projectId?: unknown;
  question?: unknown;
  focusBrainSlug?: unknown;
};

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g) ?? [];
}

function normalizeConfidence(value: unknown): "high" | "medium" | "low" {
  return value === "high" || value === "low" ? value : "medium";
}

function slugifySegment(value: string): string {
  let slug = "";
  let needsSeparator = false;
  for (const character of value.trim().toLowerCase()) {
    const code = character.charCodeAt(0);
    const isSafe =
      (code >= 48 && code <= 57)
      || (code >= 97 && code <= 122);

    if (isSafe) {
      if (needsSeparator && slug.length > 0) {
        slug += "-";
      }
      slug += character;
      needsSeparator = false;
      if (slug.length >= 60) break;
      continue;
    }

    needsSeparator = slug.length > 0;
  }

  while (slug.endsWith("-")) {
    slug = slug.slice(0, -1);
  }
  return slug || "evidence-map";
}

function compactTimestampForSlug(timestamp: string): string {
  return [
    timestamp.slice(0, 10),
    timestamp.slice(11, 13),
    timestamp.slice(14, 16),
    timestamp.slice(17, 19),
    timestamp.slice(20, 23),
  ].join("-");
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeSourceFilename(page: BrainPage): string | undefined {
  const frontmatter = page.frontmatter ?? {};
  const sourceFilename = readNonEmptyString(frontmatter.source_filename);
  if (sourceFilename) return sourceFilename;
  const sourcePath = readNonEmptyString(frontmatter.source_path);
  if (sourcePath) return sourcePath;

  const fileRefs = Array.isArray(frontmatter.file_refs)
    ? frontmatter.file_refs
    : [];
  for (const ref of fileRefs) {
    if (!ref || typeof ref !== "object") continue;
    const filename = readNonEmptyString((ref as { filename?: unknown }).filename);
    if (filename) return filename;
  }

  const sourceRefs = Array.isArray(frontmatter.source_refs)
    ? frontmatter.source_refs
    : [];
  for (const ref of sourceRefs) {
    if (!ref || typeof ref !== "object") continue;
    const source = readNonEmptyString((ref as { ref?: unknown }).ref);
    if (source) return source;
  }

  return undefined;
}

function excerptPageContent(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.slice(0, PAGE_EXCERPT_LIMIT);
}

function pageScore(page: BrainPage, questionTerms: string[]): number {
  if (questionTerms.length === 0) return 0;
  const haystack = [
    page.title,
    page.path,
    normalizeSourceFilename(page) ?? "",
    page.content.slice(0, 4000),
  ].join(" ").toLowerCase();
  return questionTerms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0,
  );
}

function selectPagesForQuestion(
  pages: BrainPage[],
  question: string,
): BrainPage[] {
  const questionTerms = tokenize(question);
  const scoredPages = pages
    .map((page) => ({
      page,
      score: pageScore(page, questionTerms),
    }))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      const typeDelta = Number(left.page.type !== "paper") - Number(right.page.type !== "paper");
      if (typeDelta !== 0) return typeDelta;
      return left.page.path.localeCompare(right.page.path);
    });

  const maxScore = scoredPages[0]?.score ?? 0;
  const relevanceFloor =
    questionTerms.length === 0
      ? 0
      : maxScore >= 3
        ? maxScore - 1
        : Math.min(maxScore, 2);
  const highSignal = scoredPages.filter(
    ({ score }) => score >= relevanceFloor && score > 0,
  );
  const prioritized = highSignal.length > 0 ? highSignal : scoredPages;
  const selected = prioritized
    .slice(0, PAGE_SELECTION_LIMIT)
    .map(({ page }) => page);
  const minimumContext = Math.min(3, scoredPages.length);
  if (selected.length < minimumContext) {
    for (const candidate of scoredPages) {
      if (selected.some((page) => page.path === candidate.page.path)) continue;
      selected.push(candidate.page);
      if (selected.length >= minimumContext) break;
    }
  }

  return selected;
}

function formatPagesForPrompt(pages: BrainPage[]): string {
  return pages
    .map((page, index) => {
      const filename = normalizeSourceFilename(page);
      const lines = [
        `### Source ${index + 1}`,
        `slug: ${page.path}`,
        `title: ${page.title}`,
        `type: ${page.type}`,
      ];
      if (filename) {
        lines.push(`filename: ${filename}`);
      }
      lines.push("content:");
      lines.push(excerptPageContent(page.content));
      return lines.join("\n");
    })
    .join("\n\n");
}

function extractJsonObject(content: string): string | null {
  const fencedMatch = content.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  const objectMatch = content.match(/\{[\s\S]*\}/);
  return objectMatch?.[0]?.trim() ?? null;
}

function normalizeSource(entry: unknown, pages: Map<string, BrainPage>): EvidenceSource | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const slug = readNonEmptyString(record.slug);
  const page = slug ? pages.get(slug) : null;
  const title = readNonEmptyString(record.title) ?? page?.title ?? slug;
  if (!slug || !title) return null;

  return {
    slug,
    title,
    filename: readNonEmptyString(record.filename) ?? (page ? normalizeSourceFilename(page) : undefined),
    excerpt: readNonEmptyString(record.excerpt) ?? (page ? excerptPageContent(page.content) : undefined),
  };
}

function normalizeEvidenceMapPayload(
  raw: unknown,
  pages: Map<string, BrainPage>,
  fallbackQuestion: string,
): EvidenceMapPayload {
  const record = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const claims = Array.isArray(record.claims) ? record.claims : [];
  const tensions = Array.isArray(record.tensions) ? record.tensions : [];
  const uncertainties = Array.isArray(record.uncertainties)
    ? record.uncertainties
    : [];

  return {
    focused_question:
      readNonEmptyString(record.focused_question) ?? fallbackQuestion,
    claims: claims.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const claim = entry as Record<string, unknown>;
      const statement = readNonEmptyString(claim.statement);
      if (!statement) return [];
      const sources = (Array.isArray(claim.sources) ? claim.sources : [])
        .map((source) => normalizeSource(source, pages))
        .filter((source): source is EvidenceSource => Boolean(source));
      if (sources.length === 0) return [];
      return [{
        id: readNonEmptyString(claim.id) ?? `claim-${index + 1}`,
        statement,
        qualifiers: Array.isArray(claim.qualifiers)
          ? claim.qualifiers
              .map((value) => readNonEmptyString(value))
              .filter((value): value is string => Boolean(value))
          : [],
        confidence: normalizeConfidence(claim.confidence),
        sources,
      }];
    }),
    tensions: tensions.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") return [];
      const tension = entry as Record<string, unknown>;
      const summary = readNonEmptyString(tension.summary);
      if (!summary) return [];
      const sources = (Array.isArray(tension.sources) ? tension.sources : [])
        .map((source) => normalizeSource(source, pages))
        .filter((source): source is EvidenceSource => Boolean(source));
      return [{
        id: readNonEmptyString(tension.id) ?? `tension-${index + 1}`,
        summary,
        why: readNonEmptyString(tension.why)
          ?? "The available evidence does not fully agree on conditions, interpretation, or framing.",
        confidence: normalizeConfidence(tension.confidence),
        claim_ids: Array.isArray(tension.claim_ids)
          ? tension.claim_ids
              .map((value) => readNonEmptyString(value))
              .filter((value): value is string => Boolean(value))
          : [],
        sources,
      }];
    }),
    uncertainties: uncertainties.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const uncertainty = entry as Record<string, unknown>;
      const gap = readNonEmptyString(uncertainty.gap);
      const nextClarification = readNonEmptyString(
        uncertainty.next_clarification,
      );
      if (!gap || !nextClarification) return [];
      return [{ gap, next_clarification: nextClarification }];
    }),
    honesty_note:
      readNonEmptyString(record.honesty_note)
      ?? "This evidence map is limited to the selected visible project sources and should be updated when better evidence arrives.",
  };
}

function buildEvidenceMapMarkdown(args: {
  projectId: string;
  payload: EvidenceMapPayload;
  generatedAt: string;
  generatedBy: string;
  question: string;
  sourcePages: BrainPage[];
}): string {
  const title = `Evidence Map: ${args.payload.focused_question}`;
  const frontmatter = {
    title,
    type: "note",
    project: args.projectId,
    analysis_kind: "evidence_map",
    question: args.question,
    generated_at: args.generatedAt,
    generated_by: args.generatedBy,
    claim_count: args.payload.claims.length,
    tension_count: args.payload.tensions.length,
    source_page_count: args.sourcePages.length,
    source_pages: args.sourcePages.map((page) => page.path),
  };

  const claimLines = args.payload.claims.flatMap((claim, index) => {
    const lines = [
      `### Claim ${index + 1}`,
      "",
      claim.statement,
      "",
      `Confidence: ${claim.confidence}`,
    ];
    if (claim.qualifiers.length > 0) {
      lines.push("", "Qualifiers:");
      for (const qualifier of claim.qualifiers) {
        lines.push(`- ${qualifier}`);
      }
    }
    lines.push("", "Sources:");
    for (const source of claim.sources) {
      const sourceLabel = source.filename
        ? `${source.title} (${source.filename})`
        : source.title;
      lines.push(`- [[${source.slug}]] - ${sourceLabel}`);
      if (source.excerpt) {
        lines.push(`  Evidence: ${source.excerpt}`);
      }
    }
    lines.push("");
    return lines;
  });

  const tensionLines = args.payload.tensions.flatMap((tension, index) => {
    const lines = [
      `### Tension ${index + 1}`,
      "",
      tension.summary,
      "",
      `Confidence: ${tension.confidence}`,
      `Why this may disagree: ${tension.why}`,
    ];
    if (tension.claim_ids.length > 0) {
      lines.push(`Related claims: ${tension.claim_ids.join(", ")}`);
    }
    if (tension.sources.length > 0) {
      lines.push("", "Sources:");
      for (const source of tension.sources) {
        const sourceLabel = source.filename
          ? `${source.title} (${source.filename})`
          : source.title;
        lines.push(`- [[${source.slug}]] - ${sourceLabel}`);
      }
    }
    lines.push("");
    return lines;
  });

  const uncertaintyLines =
    args.payload.uncertainties.length > 0
      ? args.payload.uncertainties.flatMap((entry, index) => [
          `### Gap ${index + 1}`,
          "",
          entry.gap,
          "",
          `Next clarification: ${entry.next_clarification}`,
          "",
        ])
      : ["- No major unresolved gaps were called out from the selected sources.", ""];

  return matter.stringify(
    [
      `# ${title}`,
      "",
      "## Focused question",
      "",
      args.payload.focused_question,
      "",
      "## Core claims",
      "",
      ...(claimLines.length > 0
        ? claimLines
        : ["- No confident claims could be extracted from the selected sources.", ""]),
      "## Tensions and conflicts",
      "",
      ...(tensionLines.length > 0
        ? tensionLines
        : ["- No direct tensions were identified from the selected sources.", ""]),
      "## Uncertainties",
      "",
      ...uncertaintyLines,
      "## Honesty note",
      "",
      args.payload.honesty_note,
      "",
    ].join("\n"),
    frontmatter,
  );
}

const SYSTEM_PROMPT = `You build project evidence maps for scientists.

Use only the supplied project sources. Do not invent claims or confidence.
When evidence is weak, say so plainly.

Return valid JSON with this exact shape:
{
  "focused_question": "string",
  "claims": [
    {
      "id": "claim-1",
      "statement": "specific claim grounded in the evidence",
      "qualifiers": ["important context such as model, assay, condition, timeframe, or framing caveat"],
      "confidence": "high|medium|low",
      "sources": [
        {
          "slug": "page slug from the provided sources",
          "title": "page title",
          "filename": "best visible filename if available",
          "excerpt": "short evidence excerpt copied or paraphrased from the source"
        }
      ]
    }
  ],
  "tensions": [
    {
      "id": "tension-1",
      "summary": "what is in tension or conflict",
      "why": "why the disagreement may exist",
      "confidence": "high|medium|low",
      "claim_ids": ["claim-1", "claim-2"],
      "sources": [
        {
          "slug": "page slug from the provided sources",
          "title": "page title",
          "filename": "best visible filename if available"
        }
      ]
    }
  ],
  "uncertainties": [
    {
      "gap": "what remains underspecified or noisy",
      "next_clarification": "the next best clarification or experiment"
    }
  ],
  "honesty_note": "one sentence about limits or uncertainty"
}

Rules:
- Every claim must cite at least one source.
- Only put items in tensions when the evidence is genuinely in tension, not merely broad.
- Prefer specific, falsifiable claims over general summaries.
- Preserve disagreement instead of flattening it into one narrative.
- Keep the output compact and high signal.`;

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: EvidenceMapRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = readNonEmptyString(body.projectId);
  if (!projectId) {
    return Response.json({ error: "projectId is required" }, { status: 400 });
  }

  try {
    assertSafeProjectSlug(projectId);
  } catch {
    return Response.json({ error: "projectId must be a safe bare slug" }, { status: 400 });
  }

  const question =
    readNonEmptyString(body.question)
    ?? "What does the current project evidence support, and where does it disagree?";
  const focusBrainSlug = readNonEmptyString(body.focusBrainSlug);

  try {
    await ensureBrainStoreReady();
    const allPages = await getBrainStore().listPages({ limit: PAGE_SCAN_LIMIT });
    const projectPages = filterProjectPages(allPages, projectId)
      .filter((page) => {
        if (page.type === "project" || page.content.trim().length === 0) {
          return false;
        }
        return page.frontmatter?.analysis_kind !== "evidence_map";
      });
    if (projectPages.length === 0) {
      return Response.json(
        { error: `No readable project pages found for ${projectId}.` },
        { status: 404 },
      );
    }

    const selectedPages = selectPagesForQuestion(projectPages, question);
    if (focusBrainSlug) {
      const focusedPage = projectPages.find((page) => page.path === focusBrainSlug);
      if (focusedPage && !selectedPages.some((page) => page.path === focusedPage.path)) {
        selectedPages.unshift(focusedPage);
        if (selectedPages.length > PAGE_SELECTION_LIMIT) {
          selectedPages.length = PAGE_SELECTION_LIMIT;
        }
      }
    }
    const llm = getLLMClient(config);
    const completion = await llm.complete({
      system: SYSTEM_PROMPT,
      user: [
        `Project: ${projectId}`,
        `Focused question: ${question}`,
        "",
        "Sources:",
        formatPagesForPrompt(selectedPages),
      ].join("\n"),
      model: config.synthesisModel,
    });

    const jsonPayload = extractJsonObject(completion.content);
    if (!jsonPayload) {
      return Response.json(
        { error: "Evidence map model response did not contain valid JSON." },
        { status: 502 },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonPayload);
    } catch {
      return Response.json(
        { error: "Evidence map model response contained malformed JSON." },
        { status: 502 },
      );
    }
    const pageMap = new Map(selectedPages.map((page) => [page.path, page]));
    const payload = normalizeEvidenceMapPayload(parsed, pageMap, question);
    const timestamp = new Date().toISOString();
    const generatedBy = (() => {
      try {
        return getCurrentUserHandle();
      } catch {
        return "scienceswarm";
      }
    })();
    const slug = [
      "analysis",
      "evidence-maps",
      projectId,
      `${compactTimestampForSlug(timestamp)}-${slugifySegment(payload.focused_question)}`,
    ].join("/");

    const markdown = buildEvidenceMapMarkdown({
      projectId,
      payload,
      generatedAt: timestamp,
      generatedBy,
      question,
      sourcePages: selectedPages,
    });

    const gbrain = createInProcessGbrainClient();
    await gbrain.putPage(slug, markdown);

    return Response.json({
      brain_slug: slug,
      project_url: `/dashboard/project?name=${encodeURIComponent(projectId)}&brain_slug=${encodeURIComponent(slug)}`,
      summary: {
        question: payload.focused_question,
        claimCount: payload.claims.length,
        tensionCount: payload.tensions.length,
        sourcePageCount: selectedPages.length,
        honestyNote: payload.honesty_note,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Evidence map generation failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
