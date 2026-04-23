import {
  PAPER_LIBRARY_STATE_VERSION,
  PaperLibraryEmbeddingCacheStoreSchema,
  type PaperLibraryEmbeddingCacheEntry,
  type PaperLibraryEmbeddingCacheStore,
  type PaperLibraryEmbeddingSource,
  type PaperLibraryEmbeddingRun,
} from "./contracts";
import { getPaperLibraryEmbeddingCachePath } from "./state";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";

function defaultStore(): PaperLibraryEmbeddingCacheStore {
  return {
    version: PAPER_LIBRARY_STATE_VERSION,
    entries: {},
    runs: {},
  };
}

export function buildPaperLibraryEmbeddingCacheKey(input: {
  paperId: string;
  textHash: string;
  modelId: string;
  provider: string;
  dimensions: number;
  chunking: string;
}): string {
  return [
    input.paperId.trim(),
    input.textHash.trim(),
    input.modelId.trim(),
    input.provider.trim(),
    String(input.dimensions),
    input.chunking.trim(),
  ].join(":");
}

export async function readPaperLibraryEmbeddingCache(
  project: string,
  stateRoot?: string,
): Promise<PaperLibraryEmbeddingCacheStore> {
  const raw = await readJsonFile<unknown>(getPaperLibraryEmbeddingCachePath(project, stateRoot));
  if (!raw) return defaultStore();
  return PaperLibraryEmbeddingCacheStoreSchema.parse(raw);
}

export async function writePaperLibraryEmbeddingCache(
  project: string,
  cache: PaperLibraryEmbeddingCacheStore,
  stateRoot?: string,
): Promise<PaperLibraryEmbeddingCacheStore> {
  const parsed = PaperLibraryEmbeddingCacheStoreSchema.parse(cache);
  await writeJsonFile(getPaperLibraryEmbeddingCachePath(project, stateRoot), parsed);
  return parsed;
}

export function getPaperLibraryEmbeddingCacheEntry(
  cache: PaperLibraryEmbeddingCacheStore,
  key: string,
): PaperLibraryEmbeddingCacheEntry | null {
  return cache.entries[key] ?? null;
}

export function findPaperLibraryEmbeddingCacheEntry(
  cache: PaperLibraryEmbeddingCacheStore,
  input: {
    paperId: string;
    textHash: string;
    providers?: PaperLibraryEmbeddingSource[];
  },
): PaperLibraryEmbeddingCacheEntry | null {
  const providerOrder = new Map((input.providers ?? []).map((provider, index) => [provider, index]));
  const matches = Object.values(cache.entries).filter((entry) => (
    entry.paperId === input.paperId
    && entry.textHash === input.textHash
    && (!input.providers || input.providers.includes(entry.provider))
  ));
  if (matches.length === 0) return null;
  matches.sort((left, right) => {
    const leftRank = providerOrder.get(left.provider) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = providerOrder.get(right.provider) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
  return matches[0];
}

export function upsertPaperLibraryEmbeddingCacheEntry(
  cache: PaperLibraryEmbeddingCacheStore,
  entry: PaperLibraryEmbeddingCacheEntry,
): PaperLibraryEmbeddingCacheStore {
  return {
    ...cache,
    entries: {
      ...cache.entries,
      [entry.key]: entry,
    },
  };
}

export function updatePaperLibraryEmbeddingRun(
  cache: PaperLibraryEmbeddingCacheStore,
  run: PaperLibraryEmbeddingRun,
): PaperLibraryEmbeddingCacheStore {
  return {
    ...cache,
    runs: {
      ...cache.runs,
      [run.scanId]: run,
    },
  };
}

export function requestPaperLibraryEmbeddingRunCancel(
  cache: PaperLibraryEmbeddingCacheStore,
  scanId: string,
  nowIso = new Date().toISOString(),
): PaperLibraryEmbeddingCacheStore {
  const existing = cache.runs[scanId];
  if (!existing) return cache;
  return updatePaperLibraryEmbeddingRun(cache, {
    ...existing,
    cancelRequestedAt: existing.cancelRequestedAt ?? nowIso,
    updatedAt: nowIso,
  });
}
