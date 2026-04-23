import {
  EnrichmentCacheStoreSchema,
  PAPER_LIBRARY_STATE_VERSION,
  type EnrichmentCacheEntry,
  type EnrichmentCacheStore,
  type EnrichmentSourceHealth,
  type PaperMetadataSource,
  type SourceRunStatus,
} from "./contracts";
import { getPaperLibraryEnrichmentCachePath } from "./state";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";

const DEFAULT_NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 15 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function expiresIn(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

export function buildEnrichmentCacheKey(source: PaperMetadataSource, identifier: string): string {
  return `${source}:${identifier.trim().toLowerCase()}`;
}

export async function readEnrichmentCache(project: string, stateRoot?: string): Promise<EnrichmentCacheStore> {
  const raw = await readJsonFile<unknown>(getPaperLibraryEnrichmentCachePath(project, stateRoot));
  if (!raw) return { version: PAPER_LIBRARY_STATE_VERSION, entries: {}, sourceHealth: {} };
  return EnrichmentCacheStoreSchema.parse(raw);
}

export async function writeEnrichmentCache(
  project: string,
  cache: EnrichmentCacheStore,
  stateRoot?: string,
): Promise<EnrichmentCacheStore> {
  const parsed = EnrichmentCacheStoreSchema.parse(cache);
  await writeJsonFile(getPaperLibraryEnrichmentCachePath(project, stateRoot), parsed);
  return parsed;
}

export function getUsableCacheEntry(
  cache: EnrichmentCacheStore,
  key: string,
  now = new Date(),
): EnrichmentCacheEntry | null {
  const entry = cache.entries[key];
  if (!entry) return null;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= now.getTime()) return null;
  return entry;
}

export function upsertCacheEntry(
  cache: EnrichmentCacheStore,
  input: {
    key: string;
    source: PaperMetadataSource;
    status: SourceRunStatus;
    value?: unknown;
    errorCode?: EnrichmentCacheEntry["errorCode"];
    retryAfter?: string;
    ttlMs?: number;
  },
): EnrichmentCacheStore {
  const existing = cache.entries[input.key];
  const defaultTtl = input.status === "negative" ? DEFAULT_NEGATIVE_TTL_MS : DEFAULT_FAILURE_TTL_MS;
  const expiresAt = input.status === "success" ? undefined : expiresIn(input.ttlMs ?? defaultTtl);
  return {
    ...cache,
    entries: {
      ...cache.entries,
      [input.key]: {
        key: input.key,
        source: input.source,
        status: input.status,
        value: input.value,
        errorCode: input.errorCode,
        retryAfter: input.retryAfter,
        attempts: (existing?.attempts ?? 0) + 1,
        fetchedAt: nowIso(),
        expiresAt,
      },
    },
  };
}

export function updateSourceHealth(
  cache: EnrichmentCacheStore,
  input: {
    source: PaperMetadataSource;
    status: EnrichmentSourceHealth["status"];
    retryAfter?: string;
    remainingBudget?: number;
    failure?: boolean;
  },
): EnrichmentCacheStore {
  const existing = cache.sourceHealth[input.source];
  const consecutiveFailures = input.failure ? (existing?.consecutiveFailures ?? 0) + 1 : 0;
  const status = consecutiveFailures >= 3 ? "paused" : input.status;
  return {
    ...cache,
    sourceHealth: {
      ...cache.sourceHealth,
      [input.source]: {
        source: input.source,
        status,
        consecutiveFailures,
        retryAfter: input.retryAfter,
        remainingBudget: input.remainingBudget,
        updatedAt: nowIso(),
      },
    },
  };
}

export function isSourcePaused(cache: EnrichmentCacheStore, source: PaperMetadataSource, now = new Date()): boolean {
  const health = cache.sourceHealth[source];
  if (!health || health.status !== "paused") return false;
  if (!health.retryAfter) return true;
  return Date.parse(health.retryAfter) > now.getTime();
}

