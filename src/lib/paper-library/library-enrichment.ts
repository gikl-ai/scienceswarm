import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { ingestPdfFromPath } from "@/brain/ingest/pdf-to-page";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { getBrainStore, type BrainPage } from "@/brain/store";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { frontmatterMatchesStudy } from "@/lib/studies/frontmatter";

import { paperLibraryPageSlugForMetadata } from "./applied-metadata";
import {
  LibraryCitationGraphSchema,
  PaperAcquisitionRecordSchema,
  PaperIdentifierSchema,
  PaperSuggestionSchema,
  type GapSuggestion,
  type LibraryCitationGraph,
  type LibraryCitationGraphEdge,
  type LibraryCitationGraphNode,
  type PaperAcquisitionRecord,
  type PaperAcquisitionTool,
  type PaperIdentifier,
  type PaperLibraryAcquisitionItem,
  type PaperLibraryAcquisitionLocationSource,
  type PaperLibraryGraphNode,
  type PaperSuggestion,
} from "./contracts";
import { getOrBuildPaperLibraryGaps } from "./gaps";
import {
  deterministicPaperNodeId,
  getOrBuildPaperLibraryGraph,
  normalizePaperIdentifiers,
} from "./graph";
import { findLatestPaperLibraryScan } from "./jobs";

const LIBRARY_GRAPH_NODE_LIMIT = 120;
const LIBRARY_GRAPH_EDGE_LIMIT = 240;
const LIBRARY_SUGGESTION_LIMIT = 8;

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      compacted[key] = compactObject(entry as Record<string, unknown>);
      continue;
    }
    compacted[key] = entry;
  }
  return compacted;
}

function sourceUrlsFromIdentifiers(identifiers: PaperIdentifier): string[] {
  const normalized = normalizePaperIdentifiers(identifiers);
  return [
    normalized.arxivId ? `https://arxiv.org/pdf/${normalized.arxivId}.pdf` : undefined,
    normalized.doi ? `https://doi.org/${normalized.doi}` : undefined,
    normalized.openAlexId ? `https://openalex.org/${normalized.openAlexId.replace(/^https?:\/\/openalex\.org\//i, "")}` : undefined,
    normalized.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${normalized.pmid}/` : undefined,
  ].filter((entry): entry is string => Boolean(entry));
}

function identifierAliases(identifiers: PaperIdentifier | undefined): string[] {
  const normalized = normalizePaperIdentifiers(identifiers);
  return [
    normalized.doi ? `doi:${normalized.doi}` : undefined,
    normalized.arxivId ? `arxiv:${normalized.arxivId}` : undefined,
    normalized.pmid ? `pmid:${normalized.pmid}` : undefined,
    normalized.openAlexId ? `openalex:${normalized.openAlexId}` : undefined,
  ].filter((entry): entry is string => Boolean(entry));
}

function normalizedTitle(value: string | undefined): string {
  return value?.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim() ?? "";
}

function graphNodeToLibraryNode(node: PaperLibraryGraphNode): LibraryCitationGraphNode {
  return {
    ...node,
    localStatus: node.local ? "local_pdf" : node.suggestion ? "suggested" : "external",
  };
}

function mergeLibraryNode(
  nodes: Map<string, LibraryCitationGraphNode>,
  next: LibraryCitationGraphNode,
): void {
  const existing = nodes.get(next.id);
  if (!existing) {
    nodes.set(next.id, next);
    return;
  }

  const local = existing.local || next.local;
  nodes.set(next.id, {
    ...existing,
    kind: local ? "local_paper" : existing.kind,
    paperIds: Array.from(new Set([...existing.paperIds, ...next.paperIds])),
    title: existing.title ?? next.title,
    authors: existing.authors.length > 0 ? existing.authors : next.authors,
    year: existing.year ?? next.year,
    venue: existing.venue ?? next.venue,
    identifiers: PaperIdentifierSchema.parse({
      ...next.identifiers,
      ...existing.identifiers,
    }),
    local,
    suggestion: local ? false : existing.suggestion || next.suggestion,
    sources: Array.from(new Set([...existing.sources, ...next.sources])),
    evidence: Array.from(new Set([...existing.evidence, ...next.evidence])),
    referenceCount: existing.referenceCount ?? next.referenceCount,
    citationCount: existing.citationCount ?? next.citationCount,
    gbrainSlug: existing.gbrainSlug ?? next.gbrainSlug,
    localStatus: local
      ? existing.localStatus === "gbrain_page" || next.localStatus === "gbrain_page"
        ? "gbrain_page"
        : "local_pdf"
      : existing.localStatus,
  });
}

function frontmatterObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function identifiersFromPage(page: BrainPage): PaperIdentifier {
  const frontmatter = page.frontmatter ?? {};
  const identifiers = frontmatterObject(frontmatter.identifiers);
  return normalizePaperIdentifiers({
    doi: typeof identifiers.doi === "string" ? identifiers.doi : undefined,
    arxivId: typeof identifiers.arxivId === "string"
      ? identifiers.arxivId
      : typeof identifiers.arxiv_id === "string"
        ? identifiers.arxiv_id
        : undefined,
    pmid: typeof identifiers.pmid === "string" ? identifiers.pmid : undefined,
    openAlexId: typeof identifiers.openAlexId === "string"
      ? identifiers.openAlexId
      : typeof identifiers.openalex_id === "string"
        ? identifiers.openalex_id
        : undefined,
  });
}

function pageProjectMatches(page: BrainPage, project: string): boolean {
  const frontmatter = page.frontmatter ?? {};
  const paperLibrary = frontmatterObject(frontmatter.paper_library);
  const enrichment = frontmatterObject(frontmatter.paper_library_enrichment);
  return (
    frontmatterMatchesStudy(frontmatter, project)
    || paperLibrary.project === project
    || paperLibrary.study === project
    || enrichment.project === project
    || enrichment.study === project
  );
}

function gbrainPageToLibraryNode(page: BrainPage): LibraryCitationGraphNode {
  const slug = page.path.replace(/\.md$/i, "");
  const identifiers = identifiersFromPage(page);
  const title = typeof page.title === "string" && page.title.trim() ? page.title.trim() : path.basename(page.path);
  const authors = Array.isArray(page.frontmatter.authors)
    ? page.frontmatter.authors.filter((entry): entry is string => typeof entry === "string")
    : [];
  const year = typeof page.frontmatter.year === "number" ? page.frontmatter.year : undefined;
  const venue = typeof page.frontmatter.venue === "string" ? page.frontmatter.venue : undefined;
  const nodeId = deterministicPaperNodeId(identifiers, `paper:gbrain:${slug}`);
  return {
    id: nodeId,
    kind: "local_paper",
    paperIds: [slug],
    title,
    authors,
    year,
    venue,
    identifiers,
    local: true,
    suggestion: false,
    sources: ["gbrain"],
    evidence: [`gbrain:${slug}`],
    gbrainSlug: slug,
    localStatus: "gbrain_page",
  };
}

async function readGbrainPaperNodes(project: string, brainRoot: string): Promise<LibraryCitationGraphNode[]> {
  try {
    const pages = await getBrainStore({ root: brainRoot }).listPages({ type: "paper", limit: 5000 });
    return pages.filter((page) => pageProjectMatches(page, project)).map(gbrainPageToLibraryNode);
  } catch {
    return [];
  }
}

function edgeWithProvenance(edge: LibraryCitationGraphEdge): LibraryCitationGraphEdge {
  const evidence = edge.evidence.length > 0 ? edge.evidence : [`${edge.source}:${edge.kind}`];
  return {
    ...edge,
    evidence,
    provenance: edge.provenance.length > 0 ? edge.provenance : evidence,
  };
}

function questionRelevantSuggestionScore(suggestion: GapSuggestion, question?: string): number {
  if (!question) return suggestion.score.overall;
  const terms = Array.from(new Set(
    question.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3),
  ));
  if (terms.length === 0) return suggestion.score.overall;
  const haystack = [
    suggestion.title,
    suggestion.venue,
    ...suggestion.authors,
    ...suggestion.reasonCodes,
  ].join(" ").toLowerCase();
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return Math.min(1, suggestion.score.overall + matches / Math.max(terms.length, 4) * 0.25);
}

function localPaperAliases(nodes: Iterable<LibraryCitationGraphNode>): Set<string> {
  const aliases = new Set<string>();
  for (const node of nodes) {
    if (!node.local) continue;
    identifierAliases(node.identifiers).forEach((alias) => aliases.add(alias));
    const title = normalizedTitle(node.title);
    if (title) aliases.add(`title:${title}`);
  }
  return aliases;
}

function suggestionIsAlreadyLocal(
  suggestion: Pick<PaperSuggestion, "identifiers" | "title">,
  aliases: Set<string>,
): boolean {
  if (identifierAliases(suggestion.identifiers).some((alias) => aliases.has(alias))) return true;
  const title = normalizedTitle(suggestion.title);
  return Boolean(title && aliases.has(`title:${title}`));
}

export function paperSuggestionFromGapSuggestion(input: {
  suggestion: GapSuggestion;
  question?: string;
  localAliases?: Set<string>;
}): PaperSuggestion {
  const sourceUrls = sourceUrlsFromIdentifiers(input.suggestion.identifiers);
  const alreadyLocal = input.localAliases
    ? suggestionIsAlreadyLocal(input.suggestion, input.localAliases)
    : false;
  const downloadStatus = alreadyLocal
    ? "already_local"
    : input.suggestion.identifiers.arxivId
      ? "open_pdf_found"
      : sourceUrls.length > 0
        ? "metadata_only"
        : "unknown";
  const recommendedAction = downloadStatus === "already_local"
    ? "cite_only"
    : downloadStatus === "open_pdf_found"
      ? "download_now"
      : downloadStatus === "metadata_only"
        ? "cite_only"
        : "save_for_later";
  return PaperSuggestionSchema.parse({
    title: input.suggestion.title,
    identifiers: normalizePaperIdentifiers(input.suggestion.identifiers),
    sourceUrls,
    reasonForThisQuestion: input.question
      ? `Relevant to "${input.question}" because the library graph connects it to ${input.suggestion.localConnectionCount} local paper${input.suggestion.localConnectionCount === 1 ? "" : "s"}.`
      : `The library graph connects this missing paper to ${input.suggestion.localConnectionCount} local paper${input.suggestion.localConnectionCount === 1 ? "" : "s"}.`,
    graphEvidence: [
      `gap:${input.suggestion.id}`,
      ...input.suggestion.evidenceNodeIds.map((nodeId) => `node:${nodeId}`),
      ...input.suggestion.evidenceClusterIds.map((clusterId) => `cluster:${clusterId}`),
    ],
    localEvidencePaperIds: input.suggestion.evidencePaperIds,
    downloadStatus,
    recommendedAction,
    confidence: questionRelevantSuggestionScore(input.suggestion, input.question),
  });
}

export async function buildLibraryCitationGraphContext(input: {
  project: string;
  brainRoot: string;
  scanId?: string;
  question?: string;
  refresh?: boolean;
  suggestionLimit?: number;
}): Promise<LibraryCitationGraph | null> {
  const scan = input.scanId
    ? { id: input.scanId, updatedAt: undefined as string | undefined }
    : await findLatestPaperLibraryScan(input.project, input.brainRoot);
  if (!scan?.id) return null;

  const [graph, gaps, gbrainNodes] = await Promise.all([
    getOrBuildPaperLibraryGraph({
      project: input.project,
      scanId: scan.id,
      brainRoot: input.brainRoot,
      refresh: input.refresh,
    }),
    getOrBuildPaperLibraryGaps({
      project: input.project,
      scanId: scan.id,
      brainRoot: input.brainRoot,
      refresh: input.refresh,
    }),
    readGbrainPaperNodes(input.project, input.brainRoot),
  ]);
  if (!graph) return null;

  const nodes = new Map<string, LibraryCitationGraphNode>();
  for (const node of graph.nodes) mergeLibraryNode(nodes, graphNodeToLibraryNode(node));
  for (const node of gbrainNodes) mergeLibraryNode(nodes, node);

  const aliases = localPaperAliases(nodes.values());
  const suggestions = (gaps?.suggestions ?? [])
    .slice()
    .sort((left, right) =>
      questionRelevantSuggestionScore(right, input.question)
      - questionRelevantSuggestionScore(left, input.question)
    )
    .slice(0, input.suggestionLimit ?? LIBRARY_SUGGESTION_LIMIT)
    .map((suggestion) => paperSuggestionFromGapSuggestion({
      suggestion,
      question: input.question,
      localAliases: aliases,
    }));

  const generatedAt = nowIso();
  return LibraryCitationGraphSchema.parse({
    project: input.project,
    scanId: scan.id,
    question: input.question,
    generatedAt,
    nodes: Array.from(nodes.values()).slice(0, LIBRARY_GRAPH_NODE_LIMIT),
    edges: graph.edges
      .map((edge) => edgeWithProvenance({ ...edge, provenance: [], agentDerived: false }))
      .slice(0, LIBRARY_GRAPH_EDGE_LIMIT),
    sources: [
      {
        id: `paper-library-graph:${scan.id}`,
        kind: "paper_library_graph",
        generatedAt: graph.updatedAt,
        digest: stableHash({ nodes: graph.nodes.length, edges: graph.edges.length, updatedAt: graph.updatedAt }),
        itemCount: graph.nodes.length,
      },
      ...(gaps ? [{
        id: `paper-library-gaps:${scan.id}`,
        kind: "paper_library_gaps" as const,
        generatedAt: gaps.updatedAt,
        digest: stableHash({ suggestions: gaps.suggestions.length, updatedAt: gaps.updatedAt }),
        itemCount: gaps.suggestions.length,
      }] : []),
      {
        id: "gbrain-paper-pages",
        kind: "gbrain_pages",
        generatedAt,
        digest: stableHash(gbrainNodes.map((node) => [node.id, node.gbrainSlug])),
        itemCount: gbrainNodes.length,
      },
    ],
    suggestions,
    warnings: Array.from(new Set([
      ...graph.warnings,
      ...(gaps?.warnings ?? []),
    ])).sort(),
  });
}

export function normalizeAgentPaperSuggestions(
  value: unknown,
  context: { localNodes?: LibraryCitationGraphNode[] } = {},
): { suggestions: PaperSuggestion[]; rejected: Array<{ index: number; issues: string[] }> } {
  const candidates = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { suggestions?: unknown }).suggestions)
      ? (value as { suggestions: unknown[] }).suggestions
      : [];
  const aliases = localPaperAliases(context.localNodes ?? []);
  const suggestions: PaperSuggestion[] = [];
  const rejected: Array<{ index: number; issues: string[] }> = [];

  candidates.forEach((candidate, index) => {
    const parsed = PaperSuggestionSchema.safeParse(candidate);
    if (!parsed.success) {
      rejected.push({
        index,
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
      });
      return;
    }

    if (suggestionIsAlreadyLocal(parsed.data, aliases)) {
      suggestions.push({
        ...parsed.data,
        downloadStatus: "already_local",
        recommendedAction: "cite_only",
      });
      return;
    }

    suggestions.push(parsed.data);
  });

  return { suggestions, rejected };
}

function acquisitionToolFromLocation(source?: PaperLibraryAcquisitionLocationSource): PaperAcquisitionTool {
  switch (source) {
    case "arxiv":
      return "arxiv";
    case "openalex":
      return "openalex";
    case "semantic_scholar":
      return "semantic_scholar";
    default:
      return "manual";
  }
}

export function acquisitionRecordFromItem(input: {
  project: string;
  item: PaperLibraryAcquisitionItem;
  status?: PaperAcquisitionRecord["status"];
  createdAt?: string;
  error?: string;
}): PaperAcquisitionRecord {
  const sourceUrl = input.item.sourceUrl ?? input.item.selectedLocation?.url ?? input.item.locations[0]?.url;
  const downloadStatus = input.item.status === "acquired" || input.item.mode === "download_pdf"
    ? "open_pdf_found"
    : input.item.status === "metadata_only" || input.item.mode === "metadata_only"
      ? "metadata_only"
      : "unknown";
  return PaperAcquisitionRecordSchema.parse({
    project: input.project,
    originatingQuestion: input.item.originatingQuestion,
    suggestion: {
      title: input.item.title,
      identifiers: normalizePaperIdentifiers(input.item.identifiers),
      sourceUrls: sourceUrl ? [sourceUrl] : sourceUrlsFromIdentifiers(input.item.identifiers),
      reasonForThisQuestion: input.item.rationale,
      graphEvidence: [
        `gap:${input.item.suggestionId}`,
        ...input.item.evidenceNodeIds.map((nodeId) => `node:${nodeId}`),
        ...input.item.evidenceClusterIds.map((clusterId) => `cluster:${clusterId}`),
      ],
      localEvidencePaperIds: input.item.evidencePaperIds,
      downloadStatus,
      recommendedAction: downloadStatus === "open_pdf_found" ? "download_now" : "cite_only",
      confidence: input.item.score.overall,
    },
    tool: input.item.tool ?? acquisitionToolFromLocation(input.item.selectedLocation?.source),
    sourceUrl,
    downloadedPath: input.item.localPath,
    gbrainSlug: input.item.gbrainSlug,
    checksum: input.item.checksum,
    consentScope: input.item.consentScope ?? "per_session",
    status: input.status ?? (
      input.item.status === "acquired"
        ? "downloaded"
        : input.item.status === "metadata_only"
          ? "metadata_persisted"
          : input.item.status === "watching"
            ? "skipped"
            : input.item.status === "failed"
              ? "failed"
              : "skipped"
    ),
    createdAt: input.createdAt ?? input.item.updatedAt,
    error: input.error ?? input.item.error,
  });
}

function formatRecordBlock(record: PaperAcquisitionRecord, pdfMarkdown?: string): string {
  const lines = [
    "## Research Library Enrichment",
    "",
    `Status: ${record.status}`,
    `Tool: ${record.tool}`,
  ];
  if (record.originatingQuestion) lines.push(`Originating question: ${record.originatingQuestion}`);
  if (record.sourceUrl) lines.push(`Source URL: ${record.sourceUrl}`);
  if (record.downloadedPath) lines.push(`Downloaded PDF: \`${record.downloadedPath}\``);
  if (record.checksum) lines.push(`SHA-256: ${record.checksum}`);
  lines.push(`Consent scope: ${record.consentScope}`);
  lines.push("", "Why this paper:", record.suggestion.reasonForThisQuestion);
  if (record.suggestion.graphEvidence.length > 0) {
    lines.push("", "Graph evidence:");
    lines.push(...record.suggestion.graphEvidence.map((entry) => `- ${entry}`));
  }
  if (record.suggestion.localEvidencePaperIds.length > 0) {
    lines.push("", `Local evidence paper IDs: ${record.suggestion.localEvidencePaperIds.join(", ")}`);
  }
  if (record.status === "metadata_persisted") {
    lines.push("", "Download status: no legal open PDF was persisted for this record.");
  }
  if (record.error) lines.push("", `Error: ${record.error}`);
  if (pdfMarkdown) {
    lines.push("", "### Imported PDF Text", "", pdfMarkdown.replace(/^# .+?\n+/, "").trim());
  }
  return lines.join("\n");
}

function mergeSection(existingCompiledTruth: string | undefined, heading: string, nextSection: string): string {
  const trimmedExisting = (existingCompiledTruth ?? "").trim();
  if (!trimmedExisting) return nextSection;
  const headingPattern = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const sectionMatch = headingPattern.exec(trimmedExisting);
  if (!sectionMatch) return `${trimmedExisting}\n\n${nextSection}`;
  const sectionStart = sectionMatch.index;
  const afterHeading = sectionStart + sectionMatch[0].length;
  const nextSectionOffset = trimmedExisting.slice(afterHeading).search(/\n##\s+/);
  const sectionEnd = nextSectionOffset === -1
    ? trimmedExisting.length
    : afterHeading + nextSectionOffset;
  return [
    trimmedExisting.slice(0, sectionStart).trim(),
    nextSection,
    trimmedExisting.slice(sectionEnd).trim(),
  ].filter(Boolean).join("\n\n");
}

function appendTimeline(existingTimeline: string, entry: string): string {
  const trimmedExisting = existingTimeline.trim();
  const trimmedEntry = entry.trim();
  if (!trimmedEntry || trimmedExisting.includes(trimmedEntry)) return trimmedExisting;
  return trimmedExisting ? `${trimmedExisting}\n\n${trimmedEntry}` : trimmedEntry;
}

export async function persistPaperAcquisitionRecordToGbrain(input: {
  record: PaperAcquisitionRecord;
  brainRoot: string;
}): Promise<PaperAcquisitionRecord> {
  let record = PaperAcquisitionRecordSchema.parse(input.record);
  let pdfMarkdown: string | undefined;
  if (record.status === "downloaded") {
    if (!record.downloadedPath) throw new Error("Downloaded paper record is missing downloadedPath.");
    const ingest = await ingestPdfFromPath({
      pdfPath: record.downloadedPath,
      fileName: path.basename(record.downloadedPath),
    });
    if (!ingest.ok) {
      throw new Error(ingest.message);
    }
    pdfMarkdown = ingest.markdown;
    record = PaperAcquisitionRecordSchema.parse({
      ...record,
      checksum: record.checksum ?? await sha256File(record.downloadedPath),
    });
  }

  if (record.status !== "downloaded" && record.status !== "metadata_persisted" && record.status !== "already_local") {
    return record;
  }

  const slug = record.gbrainSlug
    ?? paperLibraryPageSlugForMetadata(
      `acquired-${stableHash(record.suggestion.title)}`,
      record.suggestion.identifiers,
    );
  const userHandle = getCurrentUserHandle();
  const client = createInProcessGbrainClient({ root: input.brainRoot });
  const day = record.createdAt.slice(0, 10);
  const timelineEntry = `- **${day}** | ScienceSwarm library enrichment - ${record.status} \`${record.suggestion.title}\` from ${record.sourceUrl ?? "local graph context"}.`;

  await client.persistTransaction(slug, async (existing) => {
    const previousFrontmatter = existing?.frontmatter ?? {};
    const enrichment = {
      ...frontmatterObject(previousFrontmatter.paper_library_enrichment),
      study: record.project,
      study_slug: record.project,
      legacy_project_slug: record.project,
      status: record.status,
      tool: record.tool,
      source_url: record.sourceUrl,
      downloaded_path: record.downloadedPath,
      checksum: record.checksum,
      originating_question: record.originatingQuestion,
      graph_evidence: record.suggestion.graphEvidence,
      local_evidence_paper_ids: record.suggestion.localEvidencePaperIds,
      consent_scope: record.consentScope,
      updated_at: nowIso(),
      updated_by: userHandle,
    };

    return {
      page: {
        type: "paper",
        title: record.suggestion.title,
        compiledTruth: mergeSection(
          existing?.compiledTruth,
          "Research Library Enrichment",
          formatRecordBlock(record, pdfMarkdown),
        ),
        timeline: appendTimeline(existing?.timeline ?? "", timelineEntry),
        frontmatter: compactObject({
          ...previousFrontmatter,
          entity_type: "paper",
          study: previousFrontmatter.study ?? record.project,
          study_slug: previousFrontmatter.study_slug ?? record.project,
          legacy_project_slug: previousFrontmatter.legacy_project_slug ?? previousFrontmatter.project ?? record.project,
          paper_library_enrichment: enrichment,
          identifiers: record.suggestion.identifiers,
          authors: previousFrontmatter.authors,
          captured_by: previousFrontmatter.captured_by ?? userHandle,
          updated_by: userHandle,
          updated_at: nowIso(),
        }),
      },
    };
  });

  return PaperAcquisitionRecordSchema.parse({ ...record, gbrainSlug: slug });
}
