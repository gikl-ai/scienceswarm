import { createHash } from "node:crypto";

import {
  PAPER_LIBRARY_STATE_VERSION,
  PaperIdentifierSchema,
  PaperLibraryGraphSchema,
  type PaperIdentifier,
  type PaperIdentityCandidate,
  type PaperLibraryErrorCode,
  type PaperLibraryGraph,
  type PaperLibraryGraphEdge,
  type PaperLibraryGraphNode,
  type PaperLibraryGraphResponse,
  type PaperLibraryGraphSourceRun,
  type PaperMetadataSource,
  type PaperReviewItem,
  type SourceRunStatus,
} from "./contracts";
import {
  buildEnrichmentCacheKey,
  getUsableCacheEntry,
  isSourcePaused,
  readEnrichmentCache,
  updateSourceHealth,
  upsertCacheEntry,
  writeEnrichmentCache,
} from "./enrichment-cache";
import { readPaperLibraryScan } from "./jobs";
import { readAllPaperReviewItems } from "./review";
import {
  getPaperLibraryGraphPath,
  readCursorWindow,
  readPersistedState,
} from "./state";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

const MAX_RELATIONS_PER_KIND = 25;

interface PaperGraphSeed {
  item: PaperReviewItem;
  candidate: PaperIdentityCandidate;
  identifiers: PaperIdentifier;
  nodeId: string;
}

export interface PaperLibraryExternalPaper {
  sourceId?: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  identifiers?: PaperIdentifier;
  evidence?: string[];
  referenceCount?: number;
  citationCount?: number;
}

export interface PaperLibraryGraphRelations {
  references: PaperLibraryExternalPaper[];
  citations: PaperLibraryExternalPaper[];
  bridgePapers: PaperLibraryExternalPaper[];
  referenceCount?: number;
  citationCount?: number;
}

export interface PaperLibraryGraphFetchResult extends Partial<PaperLibraryGraphRelations> {
  status?: SourceRunStatus;
  errorCode?: PaperLibraryErrorCode;
  retryAfter?: string;
  message?: string;
}

export interface PaperLibraryGraphAdapter {
  source: PaperMetadataSource;
  lookupIdentifier?(identifiers: PaperIdentifier): string | null;
  fetch(seed: {
    paperId: string;
    identifiers: PaperIdentifier;
    title?: string;
    authors: string[];
    year?: number;
    venue?: string;
  }): Promise<PaperLibraryGraphFetchResult>;
}

export interface BuildPaperLibraryGraphInput {
  project: string;
  scanId: string;
  brainRoot: string;
  adapters?: PaperLibraryGraphAdapter[];
  useCache?: boolean;
  persist?: boolean;
}

function normalizeGraph(value: unknown): PaperLibraryGraph {
  const parsed = PaperLibraryGraphSchema.parse(value);
  return {
    ...parsed,
    nodes: parsed.nodes ?? [],
    edges: parsed.edges ?? [],
    sourceRuns: parsed.sourceRuns ?? [],
    warnings: parsed.warnings ?? [],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function normalizeDoi(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  return normalized || undefined;
}

function normalizeArxivId(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/^arxiv:\s*/i, "")
    .replace(/v\d+$/i, "")
    .toLowerCase();
  return normalized || undefined;
}

function normalizePmid(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^pmid:\s*/i, "");
  return normalized || undefined;
}

function normalizeOpenAlexId(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^https?:\/\/openalex\.org\//i, "")
    .toLowerCase();
  return normalized || undefined;
}

export function normalizePaperIdentifiers(identifiers: PaperIdentifier | undefined): PaperIdentifier {
  return PaperIdentifierSchema.parse({
    doi: normalizeDoi(identifiers?.doi),
    arxivId: normalizeArxivId(identifiers?.arxivId),
    pmid: normalizePmid(identifiers?.pmid),
    openAlexId: normalizeOpenAlexId(identifiers?.openAlexId),
  });
}

export function deterministicPaperNodeId(identifiers: PaperIdentifier | undefined, fallback: string): string {
  const normalized = normalizePaperIdentifiers(identifiers);
  if (normalized.doi) return `paper:doi:${normalized.doi}`;
  if (normalized.arxivId) return `paper:arxiv:${normalized.arxivId}`;
  if (normalized.pmid) return `paper:pmid:${normalized.pmid}`;
  if (normalized.openAlexId) return `paper:openalex:${normalized.openAlexId}`;
  return fallback;
}

function identifierAliases(identifiers: PaperIdentifier | undefined): string[] {
  const normalized = normalizePaperIdentifiers(identifiers);
  return [
    normalized.doi ? `doi:${normalized.doi}` : undefined,
    normalized.arxivId ? `arxiv:${normalized.arxivId}` : undefined,
    normalized.pmid ? `pmid:${normalized.pmid}` : undefined,
    normalized.openAlexId ? `openalex:${normalized.openAlexId}` : undefined,
  ].filter((alias): alias is string => Boolean(alias));
}

function mergeUnique<T>(left: T[] | undefined, right: T[] | undefined): T[] {
  return Array.from(new Set([...(left ?? []), ...(right ?? [])]));
}

function mergeIdentifiers(left: PaperIdentifier | undefined, right: PaperIdentifier | undefined): PaperIdentifier {
  const normalizedLeft = normalizePaperIdentifiers(left);
  const normalizedRight = normalizePaperIdentifiers(right);
  return PaperIdentifierSchema.parse({
    doi: normalizedLeft.doi ?? normalizedRight.doi,
    arxivId: normalizedLeft.arxivId ?? normalizedRight.arxivId,
    pmid: normalizedLeft.pmid ?? normalizedRight.pmid,
    openAlexId: normalizedLeft.openAlexId ?? normalizedRight.openAlexId,
  });
}

function upsertNode(nodes: Map<string, PaperLibraryGraphNode>, next: PaperLibraryGraphNode): void {
  const existing = nodes.get(next.id);
  if (!existing) {
    nodes.set(next.id, next);
    return;
  }
  const local = existing.local || next.local;
  const suggestion = local ? false : existing.suggestion || next.suggestion;
  nodes.set(next.id, {
    ...existing,
    kind: local ? "local_paper" : (suggestion ? "bridge_suggestion" : existing.kind),
    paperIds: mergeUnique(existing.paperIds, next.paperIds),
    title: existing.local ? existing.title ?? next.title : next.title ?? existing.title,
    authors: existing.authors.length > 0 ? existing.authors : next.authors,
    year: existing.year ?? next.year,
    venue: existing.venue ?? next.venue,
    identifiers: mergeIdentifiers(existing.identifiers, next.identifiers),
    local,
    suggestion,
    sources: mergeUnique(existing.sources, next.sources),
    evidence: mergeUnique(existing.evidence, next.evidence),
    referenceCount: existing.referenceCount ?? next.referenceCount,
    citationCount: existing.citationCount ?? next.citationCount,
  });
}

function addEdge(edges: Map<string, PaperLibraryGraphEdge>, edge: Omit<PaperLibraryGraphEdge, "id">): void {
  const id = `edge:${stableHash(edge)}`;
  const existing = edges.get(id);
  edges.set(id, existing ? { ...existing, evidence: mergeUnique(existing.evidence, edge.evidence) } : { id, ...edge });
}

function candidateForItem(item: PaperReviewItem): PaperIdentityCandidate | undefined {
  return item.candidates.find((candidate) => candidate.id === item.selectedCandidateId) ?? item.candidates[0];
}

function correctionString(item: PaperReviewItem, key: string): string | undefined {
  const value = item.correction?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function correctionNumber(item: PaperReviewItem, key: string): number | undefined {
  const value = item.correction?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function correctionAuthors(item: PaperReviewItem): string[] | undefined {
  const value = item.correction?.authors;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  if (typeof value === "string") return value.split(/,\s*/).filter(Boolean);
  return undefined;
}

function identifiersForItem(item: PaperReviewItem, candidate: PaperIdentityCandidate): PaperIdentifier {
  return normalizePaperIdentifiers({
    ...candidate.identifiers,
    doi: correctionString(item, "doi") ?? candidate.identifiers.doi,
    arxivId: correctionString(item, "arxiv_id") ?? correctionString(item, "arxivId") ?? candidate.identifiers.arxivId,
    pmid: correctionString(item, "pmid") ?? candidate.identifiers.pmid,
    openAlexId: correctionString(item, "openalex_id") ?? correctionString(item, "openAlexId") ?? candidate.identifiers.openAlexId,
  });
}

function seedForItem(item: PaperReviewItem): PaperGraphSeed | null {
  if (item.state === "ignored") return null;
  const candidate = candidateForItem(item);
  if (!candidate) return null;
  const identifiers = identifiersForItem(item, candidate);
  const nodeId = deterministicPaperNodeId(identifiers, `paper:local:${item.paperId}`);
  return { item, candidate, identifiers, nodeId };
}

function nodeFromSeed(seed: PaperGraphSeed): PaperLibraryGraphNode {
  const { item, candidate, identifiers } = seed;
  return {
    id: seed.nodeId,
    kind: "local_paper",
    paperIds: [item.paperId],
    title: correctionString(item, "title") ?? candidate.title,
    authors: correctionAuthors(item) ?? candidate.authors,
    year: correctionNumber(item, "year") ?? candidate.year,
    venue: correctionString(item, "venue") ?? candidate.venue,
    identifiers,
    local: true,
    suggestion: false,
    sources: [candidate.source],
    evidence: mergeUnique(candidate.evidence, [
      item.source?.relativePath ? `local:${item.source.relativePath}` : undefined,
      item.state === "corrected" ? "user_corrected" : `review:${item.state}`,
    ].filter((entry): entry is string => Boolean(entry))),
  };
}

function hasStableIdentifier(identifiers: PaperIdentifier): boolean {
  return identifierAliases(identifiers).length > 0;
}

function cacheIdentifier(identifiers: PaperIdentifier): string | null {
  const normalized = normalizePaperIdentifiers(identifiers);
  if (normalized.doi) return `doi:${normalized.doi}`;
  if (normalized.arxivId) return `arxiv:${normalized.arxivId}`;
  if (normalized.pmid) return `pmid:${normalized.pmid}`;
  if (normalized.openAlexId) return `openalex:${normalized.openAlexId}`;
  return null;
}

function normalizeRelations(result: PaperLibraryGraphFetchResult): PaperLibraryGraphRelations {
  return {
    references: (result.references ?? []).slice(0, MAX_RELATIONS_PER_KIND),
    citations: (result.citations ?? []).slice(0, MAX_RELATIONS_PER_KIND),
    bridgePapers: (result.bridgePapers ?? []).slice(0, MAX_RELATIONS_PER_KIND),
    referenceCount: result.referenceCount,
    citationCount: result.citationCount,
  };
}

function relationCount(relations: PaperLibraryGraphRelations): number {
  return relations.references.length + relations.citations.length + relations.bridgePapers.length;
}

function relationsFromCacheValue(value: unknown): PaperLibraryGraphRelations {
  if (typeof value !== "object" || value === null) {
    return { references: [], citations: [], bridgePapers: [] };
  }
  const record = value as Partial<PaperLibraryGraphRelations>;
  return normalizeRelations({
    references: Array.isArray(record.references) ? record.references : [],
    citations: Array.isArray(record.citations) ? record.citations : [],
    bridgePapers: Array.isArray(record.bridgePapers) ? record.bridgePapers : [],
    referenceCount: typeof record.referenceCount === "number" ? record.referenceCount : undefined,
    citationCount: typeof record.citationCount === "number" ? record.citationCount : undefined,
  });
}

function retryAfterIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(Date.now() + Math.max(0, value) * 1000).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return new Date(Date.now() + Math.max(0, seconds) * 1000).toISOString();
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function classifyError(error: unknown): {
  status: SourceRunStatus;
  errorCode: PaperLibraryErrorCode;
  retryAfter?: string;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
  const retryAfter = retryAfterIso(
    typeof error === "object" && error !== null && "retryAfter" in error
      ? (error as { retryAfter?: unknown }).retryAfter
      : undefined,
  );
  if (status === 429 || /\b429\b|rate limit|quota/i.test(message)) {
    return { status: "rate_limited", errorCode: "metadata_unavailable", retryAfter, message };
  }
  if (status === 401 || status === 403 || /api[_ -]?key|unauthori[sz]ed|forbidden/i.test(message)) {
    return { status: "auth_unavailable", errorCode: "metadata_unavailable", message };
  }
  return { status: "metadata_unavailable", errorCode: "metadata_unavailable", message };
}

function applyRelations(input: {
  nodes: Map<string, PaperLibraryGraphNode>;
  edges: Map<string, PaperLibraryGraphEdge>;
  localAliasToNodeId: Map<string, string>;
  sourceNodeId: string;
  sourcePaperId: string;
  adapterSource: PaperMetadataSource;
  relations: PaperLibraryGraphRelations;
}): void {
  const addPaper = (
    paper: PaperLibraryExternalPaper,
    kind: "references" | "cited_by" | "bridge_suggestion",
  ): string => {
    const identifiers = normalizePaperIdentifiers(paper.identifiers);
    const localMatch = identifierAliases(identifiers)
      .map((alias) => input.localAliasToNodeId.get(alias))
      .find((nodeId): nodeId is string => Boolean(nodeId));
    if (localMatch) return localMatch;

    const fallback = paper.sourceId
      ? `paper:external:${input.adapterSource}:${paper.sourceId}`
      : `paper:external:${input.adapterSource}:${stableHash(paper)}`;
    const nodeId = deterministicPaperNodeId(identifiers, fallback);
    upsertNode(input.nodes, {
      id: nodeId,
      kind: kind === "bridge_suggestion" ? "bridge_suggestion" : "external_paper",
      paperIds: [],
      title: paper.title,
      authors: paper.authors ?? [],
      year: paper.year,
      venue: paper.venue,
      identifiers,
      local: false,
      suggestion: kind === "bridge_suggestion",
      sources: [input.adapterSource],
      evidence: mergeUnique(paper.evidence, [`${input.adapterSource}:${kind}`]),
      referenceCount: paper.referenceCount,
      citationCount: paper.citationCount,
    });
    return nodeId;
  };

  for (const reference of input.relations.references) {
    const targetNodeId = addPaper(reference, "references");
    addEdge(input.edges, {
      sourceNodeId: input.sourceNodeId,
      targetNodeId,
      kind: "references",
      source: input.adapterSource,
      evidence: [`${input.sourcePaperId} references ${targetNodeId}`],
    });
  }

  for (const citation of input.relations.citations) {
    const citingNodeId = addPaper(citation, "cited_by");
    addEdge(input.edges, {
      sourceNodeId: citingNodeId,
      targetNodeId: input.sourceNodeId,
      kind: "cited_by",
      source: input.adapterSource,
      evidence: [`${citingNodeId} cites ${input.sourcePaperId}`],
    });
  }

  for (const bridgePaper of input.relations.bridgePapers) {
    const targetNodeId = addPaper(bridgePaper, "bridge_suggestion");
    addEdge(input.edges, {
      sourceNodeId: input.sourceNodeId,
      targetNodeId,
      kind: "bridge_suggestion",
      source: input.adapterSource,
      evidence: [`${input.sourcePaperId} may connect through ${targetNodeId}`],
    });
  }
}

function sourceRun(input: Omit<PaperLibraryGraphSourceRun, "id">): PaperLibraryGraphSourceRun {
  return {
    id: `source-run:${stableHash(input)}`,
    ...input,
  };
}

async function enrichSeed(input: {
  seed: PaperGraphSeed;
  adapter: PaperLibraryGraphAdapter;
  useCache: boolean;
  project: string;
  stateRoot: string;
  nodes: Map<string, PaperLibraryGraphNode>;
  edges: Map<string, PaperLibraryGraphEdge>;
  localAliasToNodeId: Map<string, string>;
  sourceRuns: PaperLibraryGraphSourceRun[];
  warnings: string[];
}): Promise<void> {
  const startedAt = nowIso();
  const identifier = input.adapter.lookupIdentifier?.(input.seed.identifiers) ?? cacheIdentifier(input.seed.identifiers);
  if (!identifier) {
    input.sourceRuns.push(sourceRun({
      source: input.adapter.source,
      status: "negative",
      paperId: input.seed.item.paperId,
      attempts: 0,
      fetchedCount: 0,
      cacheHits: 0,
      message: `No supported identifier available for ${input.adapter.source} graph enrichment.`,
      startedAt,
      completedAt: nowIso(),
    }));
    return;
  }

  let cache = await readEnrichmentCache(input.project, input.stateRoot);
  if (isSourcePaused(cache, input.adapter.source)) {
    const health = cache.sourceHealth[input.adapter.source];
    input.sourceRuns.push(sourceRun({
      source: input.adapter.source,
      status: "paused",
      paperId: input.seed.item.paperId,
      identifier,
      attempts: 0,
      fetchedCount: 0,
      cacheHits: 0,
      retryAfter: health?.retryAfter,
      message: "External graph source is paused after repeated failures.",
      startedAt,
      completedAt: nowIso(),
    }));
    return;
  }

  const key = buildEnrichmentCacheKey(input.adapter.source, identifier);
  const cached = input.useCache ? getUsableCacheEntry(cache, key) : null;
  if (cached) {
    const relations = cached.status === "success" ? relationsFromCacheValue(cached.value) : undefined;
    if (relations) {
      applyRelations({
        nodes: input.nodes,
        edges: input.edges,
        localAliasToNodeId: input.localAliasToNodeId,
        sourceNodeId: input.seed.nodeId,
        sourcePaperId: input.seed.item.paperId,
        adapterSource: input.adapter.source,
        relations,
      });
    }
    input.sourceRuns.push(sourceRun({
      source: input.adapter.source,
      status: cached.status,
      paperId: input.seed.item.paperId,
      identifier,
      attempts: cached.attempts,
      fetchedCount: relations ? relationCount(relations) : 0,
      cacheHits: 1,
      retryAfter: cached.retryAfter,
      errorCode: cached.errorCode,
      startedAt,
      completedAt: nowIso(),
    }));
    return;
  }

  try {
    const result = await input.adapter.fetch({
      paperId: input.seed.item.paperId,
      identifiers: input.seed.identifiers,
      title: correctionString(input.seed.item, "title") ?? input.seed.candidate.title,
      authors: correctionAuthors(input.seed.item) ?? input.seed.candidate.authors,
      year: correctionNumber(input.seed.item, "year") ?? input.seed.candidate.year,
      venue: correctionString(input.seed.item, "venue") ?? input.seed.candidate.venue,
    });
    const relations = normalizeRelations(result);
    const fetchedCount = relationCount(relations);
    const status = result.status ?? (fetchedCount > 0 ? "success" : "negative");
    if (status === "success") {
      applyRelations({
        nodes: input.nodes,
        edges: input.edges,
        localAliasToNodeId: input.localAliasToNodeId,
        sourceNodeId: input.seed.nodeId,
        sourcePaperId: input.seed.item.paperId,
        adapterSource: input.adapter.source,
        relations,
      });
    }
    cache = upsertCacheEntry(cache, {
      key,
      source: input.adapter.source,
      status,
      value: status === "success" ? relations : undefined,
      errorCode: result.errorCode,
      retryAfter: retryAfterIso(result.retryAfter),
    });
    cache = updateSourceHealth(cache, {
      source: input.adapter.source,
      status: status === "success" || status === "negative" ? "healthy" : "degraded",
      retryAfter: retryAfterIso(result.retryAfter),
      failure: status !== "success" && status !== "negative",
    });
    await writeEnrichmentCache(input.project, cache, input.stateRoot);

    input.sourceRuns.push(sourceRun({
      source: input.adapter.source,
      status,
      paperId: input.seed.item.paperId,
      identifier,
      attempts: cache.entries[key]?.attempts ?? 1,
      fetchedCount,
      cacheHits: 0,
      retryAfter: retryAfterIso(result.retryAfter),
      errorCode: result.errorCode,
      message: result.message,
      startedAt,
      completedAt: nowIso(),
    }));
  } catch (error) {
    const classified = classifyError(error);
    input.warnings.push(`${input.adapter.source}:${input.seed.item.paperId}:${classified.message}`);
    cache = upsertCacheEntry(cache, {
      key,
      source: input.adapter.source,
      status: classified.status,
      errorCode: classified.errorCode,
      retryAfter: classified.retryAfter,
    });
    cache = updateSourceHealth(cache, {
      source: input.adapter.source,
      status: "degraded",
      retryAfter: classified.retryAfter,
      failure: true,
    });
    await writeEnrichmentCache(input.project, cache, input.stateRoot);
    input.sourceRuns.push(sourceRun({
      source: input.adapter.source,
      status: classified.status,
      paperId: input.seed.item.paperId,
      identifier,
      attempts: cache.entries[key]?.attempts ?? 1,
      fetchedCount: 0,
      cacheHits: 0,
      retryAfter: classified.retryAfter,
      errorCode: classified.errorCode,
      message: classified.message,
      startedAt,
      completedAt: nowIso(),
    }));
  }
}

export async function buildPaperLibraryGraph(input: BuildPaperLibraryGraphInput): Promise<PaperLibraryGraph | null> {
  const review = await readAllPaperReviewItems(input.project, input.scanId, input.brainRoot);
  if (!review) return null;

  const nodes = new Map<string, PaperLibraryGraphNode>();
  const edges = new Map<string, PaperLibraryGraphEdge>();
  const sourceRuns: PaperLibraryGraphSourceRun[] = [];
  const warnings: string[] = [];
  const seeds = review.items
    .map(seedForItem)
    .filter((seed): seed is PaperGraphSeed => Boolean(seed));
  const localAliasToNodeId = new Map<string, string>();

  for (const seed of seeds) {
    upsertNode(nodes, nodeFromSeed(seed));
    for (const alias of identifierAliases(seed.identifiers)) {
      const existingNodeId = localAliasToNodeId.get(alias);
      if (existingNodeId && existingNodeId !== seed.nodeId) {
        addEdge(edges, {
          sourceNodeId: existingNodeId,
          targetNodeId: seed.nodeId,
          kind: "same_identity",
          source: "gbrain",
          evidence: [`shared_identifier:${alias}`],
        });
      }
      localAliasToNodeId.set(alias, existingNodeId ?? seed.nodeId);
    }
  }

  const adapters = input.adapters ?? [createSemanticScholarGraphAdapter()];
  for (const seed of seeds.filter((entry) => hasStableIdentifier(entry.identifiers))) {
    for (const adapter of adapters) {
      await enrichSeed({
        seed,
        adapter,
        useCache: input.useCache ?? true,
        project: input.project,
        stateRoot: review.stateRoot,
        nodes,
        edges,
        localAliasToNodeId,
        sourceRuns,
        warnings,
      });
    }
  }

  const createdAt = nowIso();
  const graph = PaperLibraryGraphSchema.parse({
    version: PAPER_LIBRARY_STATE_VERSION,
    project: input.project,
    scanId: input.scanId,
    createdAt,
    updatedAt: createdAt,
    nodes: Array.from(nodes.values()).sort((left, right) => left.id.localeCompare(right.id)),
    edges: Array.from(edges.values()).sort((left, right) => left.id.localeCompare(right.id)),
    sourceRuns,
    warnings,
  });
  if (input.persist !== false) {
    await writeJsonFile(getPaperLibraryGraphPath(input.project, input.scanId, review.stateRoot), graph);
  }
  return graph;
}

export async function readPaperLibraryGraph(
  project: string,
  scanId: string,
  brainRoot: string,
): Promise<PaperLibraryGraph | null> {
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const parsed = await readPersistedState(
    getPaperLibraryGraphPath(project, scanId, stateRoot),
    PaperLibraryGraphSchema,
    "paper-library graph",
  );
  return parsed.ok ? normalizeGraph(parsed.data) : null;
}

export async function getOrBuildPaperLibraryGraph(input: BuildPaperLibraryGraphInput & { refresh?: boolean }): Promise<PaperLibraryGraph | null> {
  if (!input.refresh) {
    const raw = await readJsonFile<unknown>(
      getPaperLibraryGraphPath(input.project, input.scanId, getProjectStateRootForBrainRoot(input.project, input.brainRoot)),
    );
    if (raw) {
      try {
        const graph = normalizeGraph(raw);
        const scan = await readPaperLibraryScan(input.project, input.scanId, input.brainRoot);
        if (!scan) return null;
        if (Date.parse(graph.updatedAt) >= Date.parse(scan.updatedAt)) return graph;
      } catch {
        // Malformed or version-mismatched graph cache falls through to a rebuild.
      }
    }
  }
  return buildPaperLibraryGraph(input);
}

export function windowPaperLibraryGraph(
  graph: PaperLibraryGraph,
  options: { cursor?: string; limit?: number; focusNodeId?: string },
): PaperLibraryGraphResponse {
  const focus = options.focusNodeId;
  const focusNeighbors = new Set<string>();
  if (focus) {
    focusNeighbors.add(focus);
    for (const edge of graph.edges) {
      if (edge.sourceNodeId === focus) focusNeighbors.add(edge.targetNodeId);
      if (edge.targetNodeId === focus) focusNeighbors.add(edge.sourceNodeId);
    }
  }
  const filteredNodes = focus
    ? graph.nodes.filter((node) => focusNeighbors.has(node.id))
    : graph.nodes;
  const page = readCursorWindow(filteredNodes, { cursor: options.cursor, limit: options.limit });
  const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));
  const primaryIds = new Set(page.items.map((node) => node.id));
  const included = new Set(primaryIds);
  const visibleEdges = graph.edges.filter((edge) => {
    if (!filteredNodeIds.has(edge.sourceNodeId) || !filteredNodeIds.has(edge.targetNodeId)) return false;
    return primaryIds.has(edge.sourceNodeId) || primaryIds.has(edge.targetNodeId);
  });
  for (const edge of visibleEdges) {
    included.add(edge.sourceNodeId);
    included.add(edge.targetNodeId);
  }
  const nodesById = new Map(filteredNodes.map((node) => [node.id, node]));
  const nodes = page.items.slice();
  for (const nodeId of included) {
    if (primaryIds.has(nodeId)) continue;
    const node = nodesById.get(nodeId);
    if (node) nodes.push(node);
  }
  const includeMetadata = !options.cursor;
  return {
    nodes,
    edges: visibleEdges.filter((edge) => included.has(edge.sourceNodeId) && included.has(edge.targetNodeId)),
    totalEdgeCount: graph.edges.length,
    sourceRuns: includeMetadata ? graph.sourceRuns : [],
    warnings: includeMetadata ? graph.warnings : [],
    nextCursor: page.nextCursor,
    totalCount: graph.nodes.length,
    filteredCount: filteredNodes.length,
  };
}

const SEMANTIC_SCHOLAR_GRAPH_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "year",
  "venue",
  "referenceCount",
  "citationCount",
  "references.paperId",
  "references.externalIds",
  "references.title",
  "references.year",
  "references.venue",
  "citations.paperId",
  "citations.externalIds",
  "citations.title",
  "citations.year",
  "citations.venue",
].join(",");

export function createSemanticScholarGraphAdapter(): PaperLibraryGraphAdapter {
  return {
    source: "semantic_scholar",
    lookupIdentifier: semanticScholarLookupId,
    async fetch(seed) {
      const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
      if (!apiKey) {
        return {
          status: "auth_unavailable",
          errorCode: "metadata_unavailable",
          message: "SEMANTIC_SCHOLAR_API_KEY is not configured.",
        };
      }
      const semanticId = semanticScholarLookupId(seed.identifiers);
      if (!semanticId) {
        return { status: "negative", message: "No Semantic Scholar lookup identifier available." };
      }
      const params = new URLSearchParams({ fields: SEMANTIC_SCHOLAR_GRAPH_FIELDS });
      const response = await fetch(
        `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(semanticId)}?${params}`,
        {
          headers: { "x-api-key": apiKey },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status === 429) {
        return {
          status: "rate_limited",
          errorCode: "metadata_unavailable",
          retryAfter: retryAfterIso(response.headers.get("retry-after")),
          message: "Semantic Scholar rate limit reached.",
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          status: "auth_unavailable",
          errorCode: "metadata_unavailable",
          message: "Semantic Scholar credentials were rejected.",
        };
      }
      if (!response.ok) {
        return {
          status: response.status === 404 ? "negative" : "metadata_unavailable",
          errorCode: "metadata_unavailable",
          message: `Semantic Scholar returned HTTP ${response.status}.`,
        };
      }
      let raw: unknown;
      try {
        raw = await response.json();
      } catch (error) {
        return {
          status: "metadata_unavailable",
          errorCode: "metadata_unavailable",
          message: `Malformed Semantic Scholar graph payload: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const relations = parseSemanticScholarGraph(raw);
      return {
        status: relationCount(relations) > 0 ? "success" : "negative",
        ...relations,
      };
    },
  };
}

function semanticScholarLookupId(identifiers: PaperIdentifier): string | null {
  const normalized = normalizePaperIdentifiers(identifiers);
  if (normalized.doi) return `DOI:${normalized.doi}`;
  if (normalized.arxivId) return `ARXIV:${normalized.arxivId}`;
  if (normalized.pmid) return `PMID:${normalized.pmid}`;
  // Semantic Scholar's documented paper lookup examples cover DOI, arXiv, PMID, and Semantic Scholar paper IDs.
  // OpenAlex IDs remain useful as local graph identities, but we do not attempt to query them here.
  return null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseSemanticScholarGraph(raw: unknown): PaperLibraryGraphRelations {
  const record = readRecord(raw);
  return {
    references: readArray(record.references)
      .map(parseSemanticScholarPaper)
      .filter((paper): paper is PaperLibraryExternalPaper => Boolean(paper))
      .slice(0, MAX_RELATIONS_PER_KIND),
    citations: readArray(record.citations)
      .map(parseSemanticScholarPaper)
      .filter((paper): paper is PaperLibraryExternalPaper => Boolean(paper))
      .slice(0, MAX_RELATIONS_PER_KIND),
    bridgePapers: [],
    referenceCount: readNumber(record.referenceCount),
    citationCount: readNumber(record.citationCount),
  };
}

function parseSemanticScholarPaper(value: unknown): PaperLibraryExternalPaper | null {
  const record = readRecord(value);
  const paper = readRecord(record.citedPaper ?? record.citingPaper ?? value);
  const sourceId = readString(paper.paperId);
  const externalIds = readRecord(paper.externalIds);
  const identifiers = normalizePaperIdentifiers({
    doi: readString(externalIds.DOI),
    arxivId: readString(externalIds.ArXiv),
    pmid: readString(externalIds.PubMed),
    openAlexId: readString(externalIds.OpenAlex),
  });
  if (!sourceId && !readString(paper.title) && !hasStableIdentifier(identifiers)) return null;
  return {
    sourceId,
    title: readString(paper.title),
    year: readNumber(paper.year),
    venue: readString(paper.venue),
    identifiers,
    evidence: sourceId ? [`semantic_scholar:${sourceId}`] : ["semantic_scholar"],
  };
}
