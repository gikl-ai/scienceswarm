/**
 * Gbrain-native compiled truth updater.
 *
 * The core MCS loop is: new evidence touches a concept, the concept's
 * compiled truth is re-synthesized, typed links are written, and any
 * contradictions are surfaced instead of resolved automatically.
 */

import { createHash } from "node:crypto";
import type { BrainConfig, IngestCost } from "./types";
import type { LLMClient } from "./llm";
import { ensureBrainStoreReady, getBrainStore } from "./store";
import type { GbrainEngineAdapter } from "./stores/gbrain-engine-adapter";
import { chunkText } from "./stores/gbrain-chunker";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

export type ContradictionSeverity = "critical" | "notable" | "minor";

export interface CompileClaim {
  text: string;
  source: string;
}

export interface CompileEvidence {
  content: string;
  sourceSlug?: string;
  sourceTitle?: string;
  sourceType?: string;
  observedAt?: string;
  claims?: CompileClaim[];
}

export interface CompileContradiction {
  id: string;
  severity: ContradictionSeverity;
  confidence: number;
  newClaim: string;
  existingClaim: string;
  newSource: string;
  existingSource: string;
  implication: string;
}

export interface CompilePageResult {
  slug: string;
  compiledTruth: string;
  previousCompiledTruth: string;
  claimsExtracted: number;
  contradictions: CompileContradiction[];
  backlinksAdded: number;
  timelineEntriesAdded: number;
  durationMs: number;
  cost: IngestCost;
}

interface CompileEnginePage {
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  content_hash?: string | null;
}

interface CompileEngine {
  transaction<T>(fn: (engine: CompileEngine) => Promise<T>): Promise<T>;
  getPage(slug: string): Promise<CompileEnginePage | null>;
  putPage(
    slug: string,
    page: {
      type: string;
      title: string;
      compiled_truth: string;
      timeline?: string;
      frontmatter?: Record<string, unknown>;
      content_hash?: string;
    },
  ): Promise<unknown>;
  upsertChunks(
    slug: string,
    chunks: Array<{
      chunk_index: number;
      chunk_text: string;
      chunk_source: "compiled_truth" | "timeline";
    }>,
  ): Promise<void>;
  getTimeline(
    slug: string,
    opts?: { limit?: number },
  ): Promise<Array<{ date: string | Date; source?: string | null; summary: string; detail?: string | null }>>;
  addTimelineEntry(
    slug: string,
    entry: { date: string; source?: string; summary: string; detail?: string },
  ): Promise<void>;
  addLink(
    from: string,
    to: string,
    context?: string | null,
    linkType?: string,
  ): Promise<void>;
}

export interface CompilePageDeps {
  engine?: CompileEngine;
  now?: () => Date;
  getUserHandle?: () => string;
}

interface ClaimExtractionResponse {
  claims?: Array<string | Partial<CompileClaim>>;
}

interface ContradictionResponse {
  contradictions?: Array<{
    new_claim?: string;
    existing_claim?: string;
    new_source?: string;
    existing_source?: string;
    severity?: string;
    confidence?: number;
    implication?: string;
  }>;
}

interface SynthesisResponse {
  compiled_truth?: string;
}

const ZERO_COST: IngestCost = {
  inputTokens: 0,
  outputTokens: 0,
  estimatedUsd: 0,
  model: "none",
};

export async function compilePage(
  slug: string,
  newEvidence: CompileEvidence,
  config: BrainConfig,
  llm: LLMClient,
  deps: CompilePageDeps = {},
): Promise<CompilePageResult> {
  const start = Date.now();
  const targetSlug = normalizeGbrainSlug(slug);
  const sourceSlug = newEvidence.sourceSlug
    ? normalizeGbrainSlug(newEvidence.sourceSlug)
    : undefined;
  const now = deps.now?.() ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const updatedAt = now.toISOString();
  const compiledBy = deps.getUserHandle?.() ?? getCurrentUserHandle();
  const engine = deps.engine ?? (await defaultCompileEngine());
  const costs: IngestCost[] = [];

  const current = await engine.getPage(targetSlug);
  if (!current) {
    throw new Error(`compilePage: no gbrain page found for '${targetSlug}'`);
  }
  const currentTimeline = await engine.getTimeline(targetSlug, { limit: 50 });
  const timelineContext = formatTimelineContext(current.timeline, currentTimeline);

  const evidenceSource = sourceSlug ?? newEvidence.sourceTitle ?? "new evidence";
  const newClaims = sanitizeClaims(
    newEvidence.claims?.length
      ? newEvidence.claims
      : await extractClaims({
          llm,
          text: newEvidence.content,
          source: evidenceSource,
          model: config.extractionModel,
          costs,
          label: "source claims",
        }),
  );
  const existingClaims = sanitizeClaims(
    await extractClaims({
      llm,
      text: [current.compiled_truth, timelineContext].filter(Boolean).join("\n\n"),
      source: targetSlug,
      model: config.extractionModel,
      costs,
      label: "compiled truth claims",
    }),
  );
  const contradictions = await compareClaims({
    llm,
    newClaims,
    existingClaims,
    model: config.extractionModel,
    costs,
  });
  const compiledTruth = await synthesizeCompiledTruth({
    llm,
    targetTitle: current.title,
    previousCompiledTruth: current.compiled_truth,
    timelineContext,
    evidence: newEvidence,
    newClaims,
    contradictions,
    model: config.synthesisModel,
    costs,
  });

  let backlinksAdded = 0;
  let timelineEntriesAdded = 0;
  const frontmatter = {
    ...(current.frontmatter ?? {}),
    compiled_truth_updated_at: updatedAt,
    compiled_by: compiledBy,
    evidence_sources: dedupeStrings([
      ...toStringArray(current.frontmatter?.evidence_sources),
      ...(sourceSlug ? [sourceSlug] : []),
    ]),
    contradictions_open: contradictions.length,
  };
  const contentHash = createContentHash({
    type: current.type,
    title: current.title,
    compiledTruth,
    timeline: current.timeline ?? "",
    frontmatter,
  });
  const chunks = buildChunks(compiledTruth);

  await engine.transaction(async (tx) => {
    await tx.putPage(targetSlug, {
      type: current.type,
      title: current.title,
      compiled_truth: compiledTruth,
      timeline: current.timeline ?? "",
      frontmatter,
      content_hash: contentHash,
    });
    await tx.upsertChunks(targetSlug, chunks);

    await tx.addTimelineEntry(targetSlug, {
      date,
      source: evidenceSource,
      summary: `Compiled truth updated from ${newEvidence.sourceTitle ?? evidenceSource}`,
      detail: [
        `${newClaims.length} claim${newClaims.length === 1 ? "" : "s"} extracted.`,
        `${contradictions.length} contradiction${contradictions.length === 1 ? "" : "s"} surfaced.`,
      ].join(" "),
    });
    timelineEntriesAdded += 1;

    if (sourceSlug) {
      await tx.addLink(
        targetSlug,
        sourceSlug,
        newEvidence.sourceTitle ?? "compiled evidence",
        "cites",
      );
      backlinksAdded += 1;
    }

    for (const contradiction of contradictions) {
      if (!sourceSlug) continue;
      await tx.addLink(
        sourceSlug,
        targetSlug,
        `new: ${contradiction.newClaim}\nexisting: ${contradiction.existingClaim}`,
        "contradicts",
      );
      backlinksAdded += 1;
    }
  });

  return {
    slug: targetSlug,
    compiledTruth,
    previousCompiledTruth: current.compiled_truth,
    claimsExtracted: newClaims.length,
    contradictions,
    backlinksAdded,
    timelineEntriesAdded,
    durationMs: Date.now() - start,
    cost: aggregateCosts(costs),
  };
}

async function defaultCompileEngine(): Promise<CompileEngine> {
  await ensureBrainStoreReady();
  const store = getBrainStore() as GbrainEngineAdapter;
  return store.engine as unknown as CompileEngine;
}

async function extractClaims(input: {
  llm: LLMClient;
  text: string;
  source: string;
  model: string;
  costs: IngestCost[];
  label: string;
}): Promise<CompileClaim[]> {
  if (!input.text.trim()) return [];
  try {
    const response = await input.llm.complete({
      system: CLAIM_EXTRACTION_PROMPT,
      user: JSON.stringify({
        task: `Extract ${input.label}`,
        source: input.source,
        text: input.text,
      }),
      model: input.model,
      maxTokens: 900,
    });
    input.costs.push(response.cost);
    const parsed = parseJsonObject<ClaimExtractionResponse>(response.content);
    if (!parsed) return heuristicClaims(input.text, input.source);
    const claims = parsed.claims ?? [];
    const source = input.source;
    return claims.map((claim) =>
      typeof claim === "string"
        ? { text: claim, source }
        : { text: String(claim.text ?? ""), source: String(claim.source ?? source) },
    );
  } catch {
    return heuristicClaims(input.text, input.source);
  }
}

async function compareClaims(input: {
  llm: LLMClient;
  newClaims: CompileClaim[];
  existingClaims: CompileClaim[];
  model: string;
  costs: IngestCost[];
}): Promise<CompileContradiction[]> {
  if (input.newClaims.length === 0 || input.existingClaims.length === 0) {
    return [];
  }
  try {
    const response = await input.llm.complete({
      system: CONTRADICTION_PROMPT,
      user: JSON.stringify({
        task: "Compare claims for direct scientific contradictions",
        new_claims: input.newClaims,
        existing_claims: input.existingClaims,
      }),
      model: input.model,
      maxTokens: 900,
    });
    input.costs.push(response.cost);
    const parsed = parseJsonObject<ContradictionResponse>(response.content);
    if (!parsed) return heuristicContradictions(input.newClaims, input.existingClaims);
    return sanitizeContradictions(parsed?.contradictions ?? []);
  } catch {
    return heuristicContradictions(input.newClaims, input.existingClaims);
  }
}

async function synthesizeCompiledTruth(input: {
  llm: LLMClient;
  targetTitle: string;
  previousCompiledTruth: string;
  timelineContext: string;
  evidence: CompileEvidence;
  newClaims: CompileClaim[];
  contradictions: CompileContradiction[];
  model: string;
  costs: IngestCost[];
}): Promise<string> {
  try {
    const response = await input.llm.complete({
      system: SYNTHESIS_PROMPT,
      user: JSON.stringify({
        task: "Rewrite compiled truth",
        target_title: input.targetTitle,
        previous_compiled_truth: input.previousCompiledTruth,
        current_timeline: input.timelineContext,
        new_evidence: input.evidence.content,
        new_claims: input.newClaims,
        contradictions: input.contradictions,
      }),
      model: input.model,
      maxTokens: 1600,
    });
    input.costs.push(response.cost);
    const parsed = parseJsonObject<SynthesisResponse>(response.content);
    const compiledTruth = parsed?.compiled_truth?.trim();
    if (compiledTruth) return compiledTruth;
    if (response.content.trim()) return response.content.trim();
  } catch {
    // Fall through to deterministic fallback.
  }
  return fallbackSynthesis(input.previousCompiledTruth, input.evidence, input.contradictions);
}

function sanitizeClaims(claims: CompileClaim[]): CompileClaim[] {
  const seen = new Set<string>();
  const out: CompileClaim[] = [];
  for (const claim of claims) {
    const text = claim.text.trim();
    if (text.length < 8) continue;
    const source = claim.source.trim() || "unknown";
    const key = `${source}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, source });
  }
  return out.slice(0, 12);
}

function sanitizeContradictions(
  rawContradictions: NonNullable<ContradictionResponse["contradictions"]>,
): CompileContradiction[] {
  const out: CompileContradiction[] = [];
  for (const raw of rawContradictions) {
    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? raw.confidence
        : 0.75;
    if (confidence < 0.65) continue;
    const severity = normalizeSeverity(raw.severity);
    const newClaim = raw.new_claim?.trim();
    const existingClaim = raw.existing_claim?.trim();
    if (!newClaim || !existingClaim) continue;
    out.push({
      id: contradictionId(newClaim, existingClaim, out.length),
      severity,
      confidence,
      newClaim,
      existingClaim,
      newSource: raw.new_source?.trim() || "new evidence",
      existingSource: raw.existing_source?.trim() || "compiled truth",
      implication: raw.implication?.trim() || "Review this conflict before treating either claim as settled.",
    });
  }
  return out;
}

function normalizeSeverity(value?: string): ContradictionSeverity {
  if (value === "critical" || value === "notable" || value === "minor") {
    return value;
  }
  return "notable";
}

function heuristicClaims(text: string, source: string): CompileClaim[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20)
    .slice(0, 6)
    .map((sentence) => ({ text: sentence, source }));
}

function heuristicContradictions(
  newClaims: CompileClaim[],
  existingClaims: CompileClaim[],
): CompileContradiction[] {
  const contradictions: CompileContradiction[] = [];
  for (const newClaim of newClaims) {
    for (const existingClaim of existingClaims) {
      if (!looksContradictory(newClaim.text, existingClaim.text)) continue;
      contradictions.push({
        id: contradictionId(newClaim.text, existingClaim.text, contradictions.length),
        severity: "notable",
        confidence: 0.7,
        newClaim: newClaim.text,
        existingClaim: existingClaim.text,
        newSource: newClaim.source,
        existingSource: existingClaim.source,
        implication: "Automated lexical check found opposing language; confirm manually.",
      });
    }
  }
  return contradictions.slice(0, 5);
}

function looksContradictory(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const negators = [" not ", " no ", " never ", " refute", " contradict", " deceptive", " fails"];
  return negators.some((token) => left.includes(token) !== right.includes(token));
}

function fallbackSynthesis(
  previousCompiledTruth: string,
  evidence: CompileEvidence,
  contradictions: CompileContradiction[],
): string {
  const source = evidence.sourceTitle ?? evidence.sourceSlug ?? "new evidence";
  const contradictionLine =
    contradictions.length > 0
      ? `\n\nOpen contradiction: ${contradictions[0].newClaim} conflicts with ${contradictions[0].existingClaim}.`
      : "";
  const previous = previousCompiledTruth.trim() || "Not yet synthesized.";
  return [
    previous,
    `Update from ${source}: ${truncate(evidence.content.trim(), 900)}${contradictionLine}`,
  ].join("\n\n");
}

function buildChunks(compiledTruth: string): Array<{
  chunk_index: number;
  chunk_text: string;
  chunk_source: "compiled_truth";
}> {
  return chunkText(compiledTruth).map((chunk, index) => ({
    chunk_index: index,
    chunk_text: chunk.text,
    chunk_source: "compiled_truth",
  }));
}

function createContentHash(input: {
  type: string;
  title: string;
  compiledTruth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function formatTimelineContext(
  inlineTimeline: string | undefined,
  entries: Array<{ date: string | Date; source?: string | null; summary: string; detail?: string | null }>,
): string {
  const lines = entries.map((entry) => {
    const date = entry.date instanceof Date
      ? entry.date.toISOString().slice(0, 10)
      : String(entry.date).slice(0, 10);
    const source = entry.source ? ` (${entry.source})` : "";
    const detail = entry.detail ? ` ${entry.detail}` : "";
    return `- ${date}${source}: ${entry.summary}${detail}`;
  });
  const inline = inlineTimeline?.trim();
  if (inline) {
    lines.push(inline);
  }
  return lines.length > 0 ? `Prior timeline evidence:\n${lines.join("\n")}` : "";
}

function parseJsonObject<T>(content: string): T | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function normalizeGbrainSlug(input: string): string {
  let slug = input.trim().replace(/^gbrain:/, "").replace(/\\/g, "/");
  if (!slug || slug.startsWith("/") || slug.split("/").includes("..")) {
    throw new Error(`Invalid gbrain slug: '${input}'`);
  }
  slug = slug.replace(/\.mdx?$/i, "");
  return slug.toLowerCase();
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function contradictionId(claim1: string, claim2: string, index: number): string {
  const hash = createHash("sha256")
    .update(`${claim1}|${claim2}|${index}`)
    .digest("hex")
    .slice(0, 12);
  return `contradiction-${hash}`;
}

function aggregateCosts(costs: IngestCost[]): IngestCost {
  if (costs.length === 0) return ZERO_COST;
  return {
    inputTokens: costs.reduce((sum, cost) => sum + cost.inputTokens, 0),
    outputTokens: costs.reduce((sum, cost) => sum + cost.outputTokens, 0),
    estimatedUsd: costs.reduce((sum, cost) => sum + cost.estimatedUsd, 0),
    model: costs.map((cost) => cost.model).filter(Boolean).join("+") || "unknown",
  };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

const CLAIM_EXTRACTION_PROMPT = `Extract explicit scientific claims from the provided text.
Return JSON only:
{
  "claims": [
    { "text": "specific falsifiable or evidential claim", "source": "source id" }
  ]
}
Rules: keep claims concise, do not invent claims, and omit background-only prose.`;

const CONTRADICTION_PROMPT = `Compare new claims against existing compiled-truth claims.
Return JSON only:
{
  "contradictions": [
    {
      "new_claim": "...",
      "existing_claim": "...",
      "new_source": "...",
      "existing_source": "...",
      "severity": "critical" | "notable" | "minor",
      "confidence": 0.0,
      "implication": "..."
    }
  ]
}
Only include direct contradictions or strong scientific tensions. Do not flag missing information or wording differences.`;

const SYNTHESIS_PROMPT = `Rewrite the target page's compiled truth using the previous compiled truth plus the new evidence.
Return JSON only:
{ "compiled_truth": "updated compiled truth markdown" }
Rules: preserve useful settled context, incorporate new evidence with provenance, and surface contradictions as open issues without resolving them automatically.`;
