import { createHash } from "node:crypto";

import {
  PAPER_LIBRARY_STATE_VERSION,
  PaperLibraryClustersSchema,
  type PaperIdentityCandidate,
  type PaperLibraryClusterModel,
  type PaperLibraryClusters,
  type PaperLibraryEmbeddingRun,
  type PaperReviewItem,
  type SemanticCluster,
  type SemanticClusterMember,
} from "./contracts";
import {
  buildPaperLibraryEmbeddingCacheKey,
  findPaperLibraryEmbeddingCacheEntry,
  getPaperLibraryEmbeddingCacheEntry,
  readPaperLibraryEmbeddingCache,
  updatePaperLibraryEmbeddingRun,
  upsertPaperLibraryEmbeddingCacheEntry,
  writePaperLibraryEmbeddingCache,
} from "./embedding-cache";
import { paperLibraryPageSlugForPaperId } from "./gbrain-writer";
import { readAllPaperReviewItems } from "./review";
import {
  getPaperLibraryClustersPath,
  readCursorWindow,
  readPersistedState,
} from "./state";
import { sanitizePathSegment } from "./templates";
import { readPaperLibraryScan } from "./jobs";
import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

const DEFAULT_BATCH_SIZE = 25;
const HASH_EMBEDDING_DIMENSIONS = 256;
const HASH_EMBEDDING_MODEL_ID = "paper-library-hash-embedding-v1";
const HASH_EMBEDDING_CHUNKING = "semantic-summary-v1";
const CLUSTER_SIMILARITY_THRESHOLD = 0.34;
const MIN_CLUSTER_SIZE = 2;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "based",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "paper",
  "study",
  "the",
  "to",
  "using",
  "via",
  "with",
]);

type EmbeddingMode = "prefer_gbrain" | "gbrain_only" | "local_hash_only";

interface GbrainChunkLike {
  embedding: Float32Array | number[] | string | null;
  model?: string | null;
}

interface ClusterItem {
  item: PaperReviewItem;
  paperId: string;
  title?: string;
  relativePath?: string;
  semanticText: string;
  semanticTextHash: string;
  embedding: number[];
  tokens: string[];
}

export interface BuildPaperLibraryClustersInput {
  project: string;
  scanId: string;
  brainRoot: string;
  refresh?: boolean;
  batchSize?: number;
  maxNewEmbeddings?: number;
  embeddingMode?: EmbeddingMode;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateForItem(item: PaperReviewItem): PaperIdentityCandidate | undefined {
  return item.candidates.find((candidate) => candidate.id === item.selectedCandidateId) ?? item.candidates[0];
}

function correctedString(item: PaperReviewItem, key: string): string | undefined {
  const value = item.correction?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function titleForItem(item: PaperReviewItem): string | undefined {
  return correctedString(item, "title") ?? candidateForItem(item)?.title;
}

function semanticTextForItem(item: PaperReviewItem): string | undefined {
  if (item.semanticText?.trim()) return item.semanticText.trim();
  const candidate = candidateForItem(item);
  const segments = [
    correctedString(item, "title") ?? candidate?.title,
    item.firstSentence,
    correctedString(item, "venue") ?? candidate?.venue,
    candidate?.identifiers.doi ? `doi ${candidate.identifiers.doi}` : undefined,
    candidate?.identifiers.arxivId ? `arxiv ${candidate.identifiers.arxivId}` : undefined,
    candidate?.identifiers.pmid ? `pmid ${candidate.identifiers.pmid}` : undefined,
  ].filter((segment): segment is string => Boolean(segment && segment.trim().length > 0));
  if (segments.length === 0) return undefined;
  return segments.join(". ").slice(0, 4000);
}

function normalizeClusters(value: unknown): PaperLibraryClusters {
  const parsed = PaperLibraryClustersSchema.parse(value);
  return {
    ...parsed,
    clusters: parsed.clusters ?? [],
    unclusteredPaperIds: parsed.unclusteredPaperIds ?? [],
    warnings: parsed.warnings ?? [],
  };
}

function tokenize(text: string): string[] {
  return Array.from(new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
  ));
}

function hashEmbedding(text: string): number[] {
  const vector = new Array<number>(HASH_EMBEDDING_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt16BE(0) % HASH_EMBEDDING_DIMENSIONS;
    const sign = digest[2] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }
  return normalizeVector(vector);
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) return vector.map(() => 0);
  return vector.map((value) => value / magnitude);
}

function averageVectors(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions === 0) return null;
  const merged = new Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dimensions) continue;
    for (let index = 0; index < dimensions; index += 1) {
      merged[index] += vector[index];
    }
  }
  return normalizeVector(merged);
}

function toNumberVector(value: Float32Array | number[] | string | null): number[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return normalizeVector(value.map((entry) => Number(entry) || 0));
  if (typeof value === "string") {
    try {
      return normalizeVector((JSON.parse(value) as number[]).map((entry) => Number(entry) || 0));
    } catch {
      return null;
    }
  }
  return normalizeVector(Array.from(value, (entry) => Number(entry) || 0));
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return Math.max(0, Math.min(1, score));
}

async function readGbrainEmbedding(input: {
  brainRoot: string;
  pageSlug: string;
}): Promise<{ embedding: number[]; modelId: string } | null> {
  try {
    await ensureBrainStoreReady({ root: input.brainRoot });
    const store = getBrainStore({ root: input.brainRoot }) as unknown as {
      engine?: {
        getChunksWithEmbeddings?: (slug: string) => Promise<GbrainChunkLike[]>;
        getConfig?: (key: string) => Promise<string | null>;
      };
    };
    const chunks = await store.engine?.getChunksWithEmbeddings?.(input.pageSlug);
    if (!chunks || chunks.length === 0) return null;
    const vectors = chunks
      .map((chunk) => toNumberVector(chunk.embedding))
      .filter((vector): vector is number[] => Boolean(vector && vector.length > 0));
    if (vectors.length === 0) return null;
    const averaged = averageVectors(vectors);
    if (!averaged) return null;
    const modelId = await store.engine?.getConfig?.("embedding_model").catch(() => null) ?? "gbrain";
    return { embedding: averaged, modelId };
  } catch {
    return null;
  }
}

function defaultModel(): PaperLibraryClusterModel {
  return {
    id: HASH_EMBEDDING_MODEL_ID,
    provider: "local_hash",
    dimensions: HASH_EMBEDDING_DIMENSIONS,
    chunking: HASH_EMBEDDING_CHUNKING,
    status: "ready",
    cacheHits: 0,
    generatedCount: 0,
    reusedGbrainCount: 0,
    fallbackCount: 0,
  };
}

function modelUnavailableModel(): PaperLibraryClusterModel {
  return {
    ...defaultModel(),
    status: "model_unavailable",
    fallbackCount: 0,
  };
}

function resourceBudgetModel(remainingBudget = 0): PaperLibraryClusterModel {
  return {
    ...defaultModel(),
    status: "resource_budget_exhausted",
    remainingBudget,
  };
}

function setRun(cacheRun: PaperLibraryEmbeddingRun | undefined, input: {
  scanId: string;
  totalCount: number;
  processedCount: number;
  cursor: number;
  batchSize: number;
  model: PaperLibraryClusterModel;
  status?: PaperLibraryClusterModel["status"];
}): PaperLibraryEmbeddingRun {
  return {
    scanId: input.scanId,
    totalCount: input.totalCount,
    processedCount: input.processedCount,
    cursor: input.cursor,
    batchSize: input.batchSize,
    updatedAt: nowIso(),
    cancelRequestedAt: cacheRun?.cancelRequestedAt,
    model: input.model,
    status: input.status ?? input.model.status,
  };
}

function labelTokens(items: ClusterItem[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const token of item.tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([token]) => token);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildClusterLabel(items: ClusterItem[]): { label: string; folderName: string; keywords: string[] } {
  const keywords = labelTokens(items);
  const label = keywords.length > 0
    ? keywords.map(titleCase).join(" ")
    : "General Research";
  return {
    label,
    folderName: sanitizePathSegment(label.toLowerCase()),
    keywords,
  };
}

function clusterConfidence(indices: number[], items: ClusterItem[]): number {
  if (indices.length <= 1) return 0;
  let total = 0;
  let comparisons = 0;
  for (let left = 0; left < indices.length; left += 1) {
    for (let right = left + 1; right < indices.length; right += 1) {
      total += cosineSimilarity(items[indices[left]].embedding, items[indices[right]].embedding);
      comparisons += 1;
    }
  }
  return comparisons === 0 ? 0 : Math.max(0, Math.min(1, total / comparisons));
}

function representativeIndex(indices: number[], items: ClusterItem[]): number {
  if (indices.length === 1) return indices[0];
  let best = indices[0];
  let bestScore = -1;
  for (const index of indices) {
    let score = 0;
    for (const other of indices) {
      if (other === index) continue;
      score += cosineSimilarity(items[index].embedding, items[other].embedding);
    }
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

function groupClusterItems(items: ClusterItem[]): {
  clusters: SemanticCluster[];
  unclusteredPaperIds: string[];
} {
  if (items.length === 0) return { clusters: [], unclusteredPaperIds: [] };

  const parent = items.map((_, index) => index);

  function find(index: number): number {
    if (parent[index] === index) return index;
    parent[index] = find(parent[index]);
    return parent[index];
  }

  function union(left: number, right: number): void {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  }

  const tokenIndex = new Map<string, number[]>();
  for (const [index, item] of items.entries()) {
    for (const token of item.tokens.slice(0, 12)) {
      const bucket = tokenIndex.get(token) ?? [];
      bucket.push(index);
      tokenIndex.set(token, bucket);
    }
  }

  for (let index = 0; index < items.length; index += 1) {
    const neighbors = new Set<number>();
    for (const token of items[index].tokens.slice(0, 12)) {
      for (const neighbor of tokenIndex.get(token) ?? []) {
        if (neighbor !== index) neighbors.add(neighbor);
      }
    }
    for (const neighbor of neighbors) {
      if (neighbor <= index) continue;
      const score = cosineSimilarity(items[index].embedding, items[neighbor].embedding);
      if (score >= CLUSTER_SIMILARITY_THRESHOLD) union(index, neighbor);
    }
  }

  const groups = new Map<number, number[]>();
  for (let index = 0; index < items.length; index += 1) {
    const root = find(index);
    const bucket = groups.get(root) ?? [];
    bucket.push(index);
    groups.set(root, bucket);
  }

  const clusters: SemanticCluster[] = [];
  const unclusteredPaperIds: string[] = [];

  for (const indices of groups.values()) {
    if (indices.length < MIN_CLUSTER_SIZE) {
      for (const index of indices) unclusteredPaperIds.push(items[index].paperId);
      continue;
    }
    const members = indices.map((index) => {
      const item = items[index];
      return {
        itemId: item.item.id,
        paperId: item.paperId,
        title: item.title,
        relativePath: item.relativePath,
        confidence: candidateForItem(item.item)?.confidence ?? 0,
        score: indices.length <= 1
          ? 1
          : Math.max(
            0,
            Math.min(
              1,
              indices
                .filter((other) => other !== index)
                .reduce((sum, other) => sum + cosineSimilarity(item.embedding, items[other].embedding), 0)
              / Math.max(indices.length - 1, 1),
            ),
          ),
      } satisfies SemanticClusterMember;
    });
    const { label, folderName, keywords } = buildClusterLabel(indices.map((index) => items[index]));
    const confidence = clusterConfidence(indices, items);
    const representative = items[representativeIndex(indices, items)];
    clusters.push({
      id: `cluster:${stableHash(indices.map((index) => items[index].paperId).sort())}`,
      label,
      folderName,
      keywords,
      memberCount: members.length,
      confidence,
      representativePaperId: representative.paperId,
      members,
    });
  }

  clusters.sort((left, right) =>
    right.memberCount - left.memberCount
    || right.confidence - left.confidence
    || left.label.localeCompare(right.label),
  );

  return { clusters, unclusteredPaperIds: Array.from(new Set(unclusteredPaperIds)).sort() };
}

async function buildClusterItems(input: BuildPaperLibraryClustersInput): Promise<{
  model: PaperLibraryClusterModel;
  warnings: string[];
  clusterItems: ClusterItem[];
}> {
  const review = await readAllPaperReviewItems(input.project, input.scanId, input.brainRoot);
  if (!review) {
    return { model: modelUnavailableModel(), warnings: [], clusterItems: [] };
  }

  const stateRoot = review.stateRoot;
  let cache = await readPaperLibraryEmbeddingCache(input.project, stateRoot);
  const batchSize = Math.max(1, Math.min(250, input.batchSize ?? DEFAULT_BATCH_SIZE));
  const maxNewEmbeddings = input.maxNewEmbeddings ?? Number.POSITIVE_INFINITY;
  const embeddingMode = input.embeddingMode ?? "prefer_gbrain";
  const warnings = new Set<string>();
  const model = defaultModel();
  const clusterItems: ClusterItem[] = [];
  const clusterableItems = review.items.filter((item) => item.state !== "ignored");
  const existingRun = cache.runs[input.scanId];

  let processedCount = 0;
  let cursor = existingRun?.cursor ?? 0;
  let generatedCount = 0;

  for (let index = 0; index < clusterableItems.length; index += 1) {
    const item = clusterableItems[index];
    const semanticText = semanticTextForItem(item);
    if (!semanticText) {
      warnings.add(`No semantic text available for ${item.paperId}.`);
      processedCount += 1;
      continue;
    }

    const semanticTextHash = item.semanticTextHash ?? hashText(semanticText);
    const candidate = candidateForItem(item);
    const pageSlug = paperLibraryPageSlugForPaperId(item.paperId, candidate);
    const preferredProviders = embeddingMode === "gbrain_only"
      ? ["gbrain"] as const
      : embeddingMode === "local_hash_only"
        ? ["local_hash"] as const
        : ["gbrain", "local_hash"] as const;
    const localKey = buildPaperLibraryEmbeddingCacheKey({
      paperId: item.paperId,
      textHash: semanticTextHash,
      modelId: HASH_EMBEDDING_MODEL_ID,
      provider: "local_hash",
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      chunking: HASH_EMBEDDING_CHUNKING,
    });
    let entry = findPaperLibraryEmbeddingCacheEntry(cache, {
      paperId: item.paperId,
      textHash: semanticTextHash,
      providers: [...preferredProviders],
    }) ?? getPaperLibraryEmbeddingCacheEntry(cache, localKey);

    if (entry) {
      model.cacheHits += 1;
      if (entry.provider === "gbrain") {
        model.provider = "gbrain";
        model.id = entry.modelId;
        model.dimensions = entry.dimensions;
      }
    } else {
      const gbrainResult = embeddingMode === "local_hash_only"
        ? null
        : await readGbrainEmbedding({ brainRoot: input.brainRoot, pageSlug });

      if (gbrainResult) {
        const gbrainKey = buildPaperLibraryEmbeddingCacheKey({
          paperId: item.paperId,
          textHash: semanticTextHash,
          modelId: gbrainResult.modelId,
          provider: "gbrain",
          dimensions: gbrainResult.embedding.length,
          chunking: HASH_EMBEDDING_CHUNKING,
        });
        entry = {
          key: gbrainKey,
          paperId: item.paperId,
          textHash: semanticTextHash,
          modelId: gbrainResult.modelId,
          provider: "gbrain",
          dimensions: gbrainResult.embedding.length,
          chunking: HASH_EMBEDDING_CHUNKING,
          embedding: gbrainResult.embedding,
          sourcePageSlug: pageSlug,
          updatedAt: nowIso(),
        };
        cache = upsertPaperLibraryEmbeddingCacheEntry(cache, entry);
        model.reusedGbrainCount += 1;
        model.provider = "gbrain";
        model.id = gbrainResult.modelId;
        model.dimensions = gbrainResult.embedding.length;
      } else if (embeddingMode === "gbrain_only") {
        model.status = "model_unavailable";
        warnings.add("Compatible gbrain embeddings are unavailable for this scan.");
        cache = updatePaperLibraryEmbeddingRun(cache, setRun(existingRun, {
          scanId: input.scanId,
          totalCount: clusterableItems.length,
          processedCount,
          cursor,
          batchSize,
          model,
          status: "model_unavailable",
        }));
        await writePaperLibraryEmbeddingCache(input.project, cache, stateRoot);
        return {
          model,
          warnings: [...warnings],
          clusterItems,
        };
      } else {
        if (generatedCount >= maxNewEmbeddings) {
          const budgetModel = resourceBudgetModel(0);
          budgetModel.cacheHits = model.cacheHits;
          budgetModel.generatedCount = model.generatedCount;
          budgetModel.reusedGbrainCount = model.reusedGbrainCount;
          budgetModel.fallbackCount = model.fallbackCount;
          warnings.add("Paper library clustering paused because the local embedding budget was exhausted.");
          cache = updatePaperLibraryEmbeddingRun(cache, setRun(existingRun, {
            scanId: input.scanId,
            totalCount: clusterableItems.length,
            processedCount,
            cursor,
            batchSize,
            model: budgetModel,
            status: "resource_budget_exhausted",
          }));
          await writePaperLibraryEmbeddingCache(input.project, cache, stateRoot);
          return {
            model: budgetModel,
            warnings: [...warnings],
            clusterItems,
          };
        }

        entry = {
          key: localKey,
          paperId: item.paperId,
          textHash: semanticTextHash,
          modelId: HASH_EMBEDDING_MODEL_ID,
          provider: "local_hash",
          dimensions: HASH_EMBEDDING_DIMENSIONS,
          chunking: HASH_EMBEDDING_CHUNKING,
          embedding: hashEmbedding(semanticText),
          sourcePageSlug: gbrainResult ? pageSlug : undefined,
          updatedAt: nowIso(),
        };
        cache = upsertPaperLibraryEmbeddingCacheEntry(cache, entry);
        model.generatedCount += 1;
        model.fallbackCount += 1;
        generatedCount += 1;
      }
    }

    clusterItems.push({
      item,
      paperId: item.paperId,
      title: titleForItem(item),
      relativePath: item.source?.relativePath,
      semanticText,
      semanticTextHash,
      embedding: normalizeVector(entry.embedding),
      tokens: tokenize(semanticText),
    });
    processedCount += 1;
    cursor = index + 1;

    if ((index + 1) % batchSize === 0 || index === clusterableItems.length - 1) {
      cache = updatePaperLibraryEmbeddingRun(cache, setRun(existingRun, {
        scanId: input.scanId,
        totalCount: clusterableItems.length,
        processedCount,
        cursor,
        batchSize,
        model,
      }));
      await writePaperLibraryEmbeddingCache(input.project, cache, stateRoot);
    }
  }

  cache = updatePaperLibraryEmbeddingRun(cache, setRun(existingRun, {
    scanId: input.scanId,
    totalCount: clusterableItems.length,
    processedCount,
    cursor,
    batchSize,
    model,
  }));
  await writePaperLibraryEmbeddingCache(input.project, cache, stateRoot);
  return { model, warnings: [...warnings], clusterItems };
}

export async function readPaperLibraryClusters(
  project: string,
  scanId: string,
  brainRoot: string,
): Promise<PaperLibraryClusters | null> {
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const parsed = await readPersistedState(
    getPaperLibraryClustersPath(project, scanId, stateRoot),
    PaperLibraryClustersSchema,
    "paper-library clusters",
  );
  return parsed.ok ? normalizeClusters(parsed.data) : null;
}

export async function buildPaperLibraryClusters(
  input: BuildPaperLibraryClustersInput,
): Promise<PaperLibraryClusters | null> {
  const review = await readAllPaperReviewItems(input.project, input.scanId, input.brainRoot);
  if (!review) return null;

  const stateRoot = review.stateRoot;
  const updatedAt = nowIso();
  const existing = await readJsonFile<unknown>(getPaperLibraryClustersPath(input.project, input.scanId, stateRoot));
  let existingClusters: PaperLibraryClusters | null = null;
  if (existing) {
    try {
      existingClusters = normalizeClusters(existing);
    } catch {
      existingClusters = null;
    }
  }
  const { model, warnings, clusterItems } = await buildClusterItems(input);
  const { clusters, unclusteredPaperIds } = groupClusterItems(clusterItems);

  const persisted = PaperLibraryClustersSchema.parse({
    version: PAPER_LIBRARY_STATE_VERSION,
    project: input.project,
    scanId: input.scanId,
    createdAt: existingClusters?.createdAt ?? updatedAt,
    updatedAt,
    model,
    clusters,
    unclusteredPaperIds,
    warnings,
  });
  await writeJsonFile(getPaperLibraryClustersPath(input.project, input.scanId, stateRoot), persisted);
  return persisted;
}

export async function getOrBuildPaperLibraryClusters(
  input: BuildPaperLibraryClustersInput,
): Promise<PaperLibraryClusters | null> {
  if (!input.refresh) {
    const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
    const raw = await readJsonFile<unknown>(getPaperLibraryClustersPath(input.project, input.scanId, stateRoot));
    if (raw) {
      try {
        const clusters = normalizeClusters(raw);
        const scan = await readPaperLibraryScan(input.project, input.scanId, input.brainRoot);
        if (!scan) return null;
        if (Date.parse(clusters.updatedAt) >= Date.parse(scan.updatedAt)) return clusters;
      } catch {
        // Malformed or version-mismatched cluster cache falls through to a rebuild.
      }
    }
  }
  return buildPaperLibraryClusters(input);
}

export function windowPaperLibraryClusters(
  clusters: PaperLibraryClusters,
  options: { cursor?: string; limit?: number },
) {
  const page = readCursorWindow(clusters.clusters, options);
  return {
    clusters: page.items,
    nextCursor: page.nextCursor,
    totalCount: page.totalCount,
    filteredCount: page.filteredCount,
    unclusteredCount: clusters.unclusteredPaperIds.length,
    model: clusters.model,
    warnings: clusters.warnings,
  };
}
