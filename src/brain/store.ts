/**
 * Second Brain -- BrainStore Interface + Factory
 *
 * Abstraction layer so we can plug in different backends
 * (filesystem grep, gbrain PGLite) behind a
 * single async interface.
 */

import { createHash } from "crypto";
import { join } from "path";
import { getScienceSwarmBrainRoot, resolveConfiguredPath } from "@/lib/scienceswarm-paths";
import {
  getSearchProfileSettings,
  resolveSearchProfile,
  shouldAllowDegradedSearchResults,
} from "./search-profiles";
import type { SearchInput, SearchResult, ContentType, IngestCost } from "./types";
import { GbrainEngineAdapter } from "./stores/gbrain-engine-adapter";

export interface BrainPage {
  path: string;
  title: string;
  type: ContentType;
  content: string;
  frontmatter: Record<string, unknown>;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
  durationMs: number;
  cost?: IngestCost;
}

export interface BrainStoreHealth {
  ok: boolean;
  pageCount: number;
  lastSync?: string;
  brainScore?: number;
  embedCoverage?: number;
  stalePages?: number;
  orphanPages?: number;
  deadLinks?: number;
  missingEmbeddings?: number;
  chunkCount?: number;
  embeddedCount?: number;
  linkCount?: number;
  tagCount?: number;
  timelineEntryCount?: number;
  syncRepoPath?: string | null;
}

export interface BrainTimelineEntry {
  date: string;
  source?: string | null;
  summary: string;
  detail?: string | null;
}

export interface BrainLink {
  slug: string;
  kind: string;
  title: string;
  context?: string | null;
  fromSlug: string;
  toSlug: string;
}

export interface BrainStore {
  search(input: SearchInput): Promise<SearchResult[]>;
  getPage(path: string): Promise<BrainPage | null>;
  getTimeline(path: string, opts?: { limit?: number }): Promise<BrainTimelineEntry[]>;
  getLinks(path: string): Promise<BrainLink[]>;
  getBacklinks(path: string): Promise<BrainLink[]>;
  listPages(filters?: { limit?: number; type?: ContentType }): Promise<BrainPage[]>;
  importCorpus(dirPath: string): Promise<ImportResult>;
  health(): Promise<BrainStoreHealth>;
  dispose(): Promise<void>;
}

export class BrainBackendUnavailableError extends Error {
  constructor(message = "Brain backend unavailable", options?: { cause?: unknown }) {
    super(message);
    this.name = "BrainBackendUnavailableError";
    if (options && "cause" in options) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
  }
}

export class BrainSearchTimeoutError extends Error {
  constructor(message = "Search timeout") {
    super(message);
    this.name = "BrainSearchTimeoutError";
  }
}

export function isBrainBackendUnavailableError(
  error: unknown,
): error is BrainBackendUnavailableError {
  return error instanceof BrainBackendUnavailableError;
}

// ── LRU Search Cache ─────────────────────────────────

interface CacheEntry {
  results: SearchResult[];
  expires: number;
  source: "store" | "fallback";
}

export class SearchCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  get(key: string): SearchResult[] | null {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expires) {
      if (entry) this.cache.delete(key);
      return null;
    }
    return entry.results;
  }

  getSource(key: string): "store" | "fallback" | null {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expires) {
      if (entry) this.cache.delete(key);
      return null;
    }
    return entry.source;
  }

  set(
    key: string,
    results: SearchResult[],
    ttlMs = 30000,
    source: "store" | "fallback" = "store",
  ): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest (first inserted)
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { results, expires: Date.now() + ttlMs, source });
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

function cacheKey(input: SearchInput): string {
  const raw = [
    input.query,
    input.mode ?? "",
    input.limit ?? "",
    input.detail ?? "",
    resolveSearchProfile(input),
    shouldAllowDegradedSearchResults(input),
  ].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

// ── Timeout helper ───────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrainSearchTimeoutError()), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── Singleton + Factory ──────────────────────────────

interface BrainStoreState {
  instance: BrainStore | null;
  adapterInitPromise: Promise<void> | null;
  activeBrainRoot: string | null;
  searchCache: SearchCache;
}

const GLOBAL_STATE_KEY = "__scienceswarmBrainStoreState";

function getBrainStoreState(): BrainStoreState {
  const globalState = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: BrainStoreState;
  };
  globalState[GLOBAL_STATE_KEY] ??= {
    instance: null,
    adapterInitPromise: null,
    activeBrainRoot: null,
    searchCache: new SearchCache(),
  };
  return globalState[GLOBAL_STATE_KEY];
}

const brainStoreState = getBrainStoreState();
const _searchCache = brainStoreState.searchCache;

export function resolveBrainStoreRoot(): string {
  return resolveConfiguredPath(process.env.BRAIN_ROOT) ?? getScienceSwarmBrainRoot();
}

export function resolveBrainStorePglitePath(): string {
  return (
    resolveConfiguredPath(process.env.BRAIN_PGLITE_PATH) ??
    join(resolveBrainStoreRoot(), "brain.pglite")
  );
}

function initializeBrainStore(adapter: GbrainEngineAdapter): Promise<void> {
  const brainRoot = resolveBrainStoreRoot();
  const initPromise = adapter.initialize({
    engine: "pglite",
    database_path: resolveBrainStorePglitePath(),
  }).catch((error) => {
    if (brainStoreState.instance === adapter) {
      brainStoreState.instance = null;
    }
    if (brainStoreState.activeBrainRoot === brainRoot) {
      brainStoreState.activeBrainRoot = null;
    }
    throw new BrainBackendUnavailableError("Brain backend unavailable", {
      cause: error,
    });
  });

  const trackedPromise = initPromise.finally(() => {
    if (brainStoreState.adapterInitPromise === trackedPromise) {
      brainStoreState.adapterInitPromise = null;
    }
  });

  brainStoreState.adapterInitPromise = trackedPromise;
  brainStoreState.activeBrainRoot = brainRoot;
  return trackedPromise;
}

export function getBrainStore(): BrainStore {
  if (!brainStoreState.instance) {
    const adapter = new GbrainEngineAdapter();
    brainStoreState.instance = adapter;
    void initializeBrainStore(adapter).catch(() => {});
  }
  return brainStoreState.instance;
}

/**
 * Cached + timeout-wrapped search.
 *
 * - LRU cache: key = hash(query + mode + limit + detail + profile + degrade mode)
 * - Profile-aware timeout/cache behavior:
 *   - `interactive`: short timeout, longer cache, degraded empty-result fallback
 *   - `synthesis`: longer timeout, shorter cache, throws on backend degradation
 *   The pre-pivot filesystem grep fallback was removed in Phase B Track C
 *   because `src/brain/search.ts` now delegates back into this module; any
 *   disk-level fallback lives there, not here.
 */
export async function cachedSearch(input: SearchInput): Promise<SearchResult[]> {
  const result = await cachedSearchWithSource(input);
  return result.results;
}

export async function cachedSearchWithSource(
  input: SearchInput,
): Promise<{ results: SearchResult[]; fromStore: boolean }> {
  const settings = getSearchProfileSettings(input);
  const normalizedInput: SearchInput = {
    ...input,
    limit: input.limit ?? settings.defaultLimit,
    profile: resolveSearchProfile(input),
  };
  const allowDegradedResults = shouldAllowDegradedSearchResults(input);
  const key = cacheKey(normalizedInput);

  // Check cache
  const cached = _searchCache.get(key);
  if (cached) {
    return {
      results: cached,
      fromStore: _searchCache.getSource(key) !== "fallback",
    };
  }

  try {
    await ensureBrainStoreReady();
    const results = await withTimeout(
      getBrainStore().search(normalizedInput),
      settings.storeTimeoutMs,
    );
    _searchCache.set(key, results, settings.cacheTtlMs, "store");
    return { results, fromStore: true };
  } catch (error) {
    // Phase B Track C: the pre-pivot filesystem grep fallback has been
    // removed. `src/brain/search.ts` now delegates back into this module,
    // so re-importing it from the catch would create an infinite loop.
    // When gbrain is unavailable we surface an empty result rather than
    // fabricate one from disk — callers (chat context, briefings) already
    // handle empty results gracefully and the `fromStore: false` flag
    // tells them this came from the degraded path.
    if (
      !(error instanceof BrainSearchTimeoutError)
      && !isBrainBackendUnavailableError(error)
    ) {
      throw error;
    }

    if (!allowDegradedResults) {
      throw error;
    }

    _searchCache.set(key, [], settings.cacheTtlMs, "fallback");
    return { results: [], fromStore: false };
  }
}

export async function searchStoreWithTimeout(
  input: SearchInput,
  timeoutMs?: number,
): Promise<SearchResult[]> {
  const settings = getSearchProfileSettings(input);
  const normalizedInput: SearchInput = {
    ...input,
    limit: input.limit ?? settings.defaultLimit,
    profile: resolveSearchProfile(input),
  };
  await ensureBrainStoreReady();
  return withTimeout(
    getBrainStore().search(normalizedInput),
    timeoutMs ?? settings.storeTimeoutMs,
  );
}

/**
 * Await PGLite adapter initialization (if still pending).
 * Call before using getBrainStore() methods directly (outside cachedSearch).
 */
export async function ensureBrainStoreReady(): Promise<void> {
  getBrainStore(); // ensure singleton created
  if (brainStoreState.adapterInitPromise) {
    await brainStoreState.adapterInitPromise;
  }
}

export function getActiveBrainRoot(): string | null {
  return brainStoreState.activeBrainRoot;
}

// For tests
export async function resetBrainStore(): Promise<void> {
  const instance = brainStoreState.instance;
  const initPromise = brainStoreState.adapterInitPromise;
  brainStoreState.instance = null;
  brainStoreState.adapterInitPromise = null;
  brainStoreState.activeBrainRoot = null;
  _searchCache.clear();

  if (instance) {
    await instance.dispose().catch(() => {});
    return;
  }

  if (initPromise) {
    await initPromise.catch(() => {});
  }
}

// Export cache for testing
export { _searchCache as searchCache };
