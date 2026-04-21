/**
 * Second Brain — Search (Phase B Track C / Track C.2)
 *
 * Primary path: gbrain's `searchKeyword` via the shared BrainStore
 * singleton (`GbrainEngineAdapter` → PGLite). Track A swapped the writer;
 * Track B deleted the pre-pivot write pipeline; Track C (this file)
 * swaps the reader to prefer gbrain.
 *
 * Filesystem fallback: for legacy call sites that still write pages
 * directly to disk — warmstart / coldstart pipelines, the research
 * briefing tests, the mcp-server test fixture — we retain a scoped
 * `execFile grep` fallback. It only runs when the gbrain store returns
 * zero results; gbrain errors (timeout, backend unavailable) still
 * propagate to the caller so `/api/brain/search` keeps its 503
 * semantics. Track C.2 verified (again) that removing the fallback
 * recreates the warmstart Test 7 hang, and Track C.3 empirically
 * re-verified the same result after briefing.ts migration — with the
 * deadline removed Test 7 hangs past the 60s vitest ceiling. The
 * fallback + deadline pair stays in place until a future track
 * identifies the root cause of the PGLite singleton hang (probably
 * stale connection state bleeding across warmstart test fixtures).
 *
 * Shape preservation:
 *   * `SearchResult.path` remains a stable identifier string. Under
 *     gbrain the path is `<slug>.md`. Callers that regex-match `wiki/…`
 *     prefixes see the same shape from the filesystem fallback.
 *   * `chunkId` / `chunkIndex` are additive evidence handles from
 *     gbrain and are absent on filesystem fallback results.
 *   * `relevance` is clamped to [0, 1].
 *   * `type` is inferred from the slug / path segments.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative, basename, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getScienceSwarmBrainRoot, resolveConfiguredPath } from "@/lib/scienceswarm-paths";
import type { BrainPage } from "./store";
import type { BrainConfig, SearchInput, SearchResult, ContentType } from "./types";

const execFileAsync = promisify(execFile);
const LIST_MODE_SCAN_LIMIT = 5000;
const LIST_QUERY_STOP_WORDS = new Set([
  "brain",
  "enumerate",
  "list",
  "paper",
  "papers",
  "related",
  "show",
  "what",
  "which",
  "your",
]);

/**
 * Resolve `promise` or reject with a `DEADLINE` sentinel after `ms`
 * milliseconds. Used to cap the gbrain primary path so stale PGLite
 * singletons from cross-test state bleed cannot hang the caller.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SEARCH_GBRAIN_DEADLINE")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Search the brain for content matching a query.
 *
 * `config.root` is still used by the filesystem fallback. The gbrain
 * primary path derives its brain root from `BRAIN_ROOT` /
 * `BRAIN_PGLITE_PATH` env vars the same way the writer does
 * (`resolvePgliteDatabasePath` in
 * `src/lib/capture/materialize-memory.ts`).
 */
export async function search(
  config: BrainConfig,
  input: SearchInput,
): Promise<SearchResult[]> {
  const mode = input.mode ?? "grep";
  const limit = input.limit ?? 10;
  const requestBrainRoot = resolve(config.root);

  // Dynamic import so `vi.spyOn(brainStoreModule, "searchStoreWithTimeout")`
  // in the api-routes tests still intercepts the call.
  const storeModule = await import("./store");
  const {
    searchStoreWithTimeout,
    BrainSearchTimeoutError,
    getActiveBrainRoot,
    isBrainBackendUnavailableError,
  } = storeModule;
  const configuredBrainRoot = resolve(
    getActiveBrainRoot()
      ?? resolveConfiguredPath(process.env.BRAIN_ROOT)
      ?? getScienceSwarmBrainRoot(),
  );
  const useConfiguredGbrainStore = mode === "qmd" || requestBrainRoot === configuredBrainRoot;

  if (mode === "list" && useConfiguredGbrainStore) {
    try {
      const pages = await withDeadline(
        listStorePages(input.query, limit),
        2000,
      );
      if (pages.length > 0 || input.query.trim()) {
        return pages;
      }
    } catch (error) {
      if (error instanceof BrainSearchTimeoutError || isBrainBackendUnavailableError(error)) {
        throw error;
      }
    }
  }

  // gbrain primary path. Only `BrainSearchTimeoutError` and
  // `BrainBackendUnavailableError` re-throw so route handlers can map
  // them to 503 for operational visibility. Any other gbrain failure
  // silently degrades to the filesystem fallback.
  //
  // Root-alignment guard: many tests and a few legacy disk-first paths
  // pass an explicit `config.root` that is *not* the same root the
  // process-level BrainStore singleton is configured to read. Probing the
  // singleton first in that situation searches the wrong database and can
  // spend the full 2s deadline before we ever touch the filesystem
  // fallback. When the roots differ, skip the gbrain primary path and go
  // straight to the caller's requested root.
  //
  // We wrap the whole gbrain path in a hard 2s ceiling. Track C.2
  // empirically re-verified (run 2026-04-14 04:30 UTC) that removing
  // the deadline recreates the warmstart Test 7 hang + 6 sibling
  // failures. Track C.3 re-ran the experiment after briefing.ts
  // migrated to gbrain-first reads and Test 7 still hangs past the
  // 60s vitest ceiling without the deadline. Root cause is probably
  // stale PGLite singleton state bleeding across the warmstart
  // fixture, not a briefing side-effect — the deadline stays until
  // a dedicated cleanup track investigates the singleton lifecycle.
  let gbrainResults: SearchResult[] = [];
  if (useConfiguredGbrainStore) {
    try {
      gbrainResults = await withDeadline(
        searchStoreWithTimeout({ ...input, limit }),
        2000,
      );
    } catch (error) {
      if (error instanceof BrainSearchTimeoutError || isBrainBackendUnavailableError(error)) {
        throw error;
      }
      gbrainResults = [];
    }
  }
  if (gbrainResults.length > 0) {
    return gbrainResults;
  }

  // Fallback: disk-first callers still exist under `src/brain/coldstart/*`
  // and several tests write markdown pages into `<brainRoot>/wiki/` without
  // going through `materializeMemory`. Until Track C.3 converts every disk
  // writer to `engine.putPage`, a zero-result gbrain response falls back
  // to the legacy grep so briefings and search keep working.
  switch (mode) {
    case "index":
      return searchIndexFallback(config, input.query, limit);
    case "list":
      return listPagesFallback(config, limit, input.query);
    case "grep":
    case "qmd":
    default:
      return searchGrepFallback(config, input.query, limit);
  }
}

// ── Filesystem fallback helpers (legacy; Phase D cleanup) ──────────

async function listStorePages(query: string, limit: number): Promise<SearchResult[]> {
  const storeModule = await import("./store");
  const { ensureBrainStoreReady, getBrainStore } = storeModule;
  await ensureBrainStoreReady();
  const queryTokens = tokenizeListQuery(query);
  const pages = await getBrainStore().listPages({
    limit: queryTokens.length > 0 ? LIST_MODE_SCAN_LIMIT : limit,
  });
  const scored = pages
    .map((page) => ({
      page,
      score: scoreListedPage(page, queryTokens, query),
    }))
    .filter(({ score }) => queryTokens.length === 0 || score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.page.title.localeCompare(right.page.title);
    });

  return scored.slice(0, limit).map(({ page, score }) =>
    listedPageToSearchResult(page, query, score),
  );
}

function tokenizeListQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !LIST_QUERY_STOP_WORDS.has(token));
  return Array.from(new Set(tokens));
}

function listedPageToSearchResult(
  page: BrainPage,
  query: string,
  score: number,
): SearchResult {
  return {
    path: page.path,
    title: page.title,
    snippet: extractListSnippet(page, query),
    relevance: Math.max(0, Math.min(1, score || 0.5)),
    type: page.type,
  };
}

function extractListSnippet(page: BrainPage, query: string): string {
  const content = page.content.trim();
  if (!content) {
    const sourcePath = page.frontmatter.source_path ?? page.frontmatter.sourcePath;
    return typeof sourcePath === "string" ? sourcePath : page.path;
  }

  const queryTokens = tokenizeListQuery(query);
  const lowerContent = content.toLowerCase();
  const firstHit = queryTokens
    .map((token) => lowerContent.indexOf(token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const start = firstHit === undefined ? 0 : Math.max(0, firstHit - 60);
  const end = Math.min(content.length, start + 220);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

function scoreListedPage(
  page: BrainPage,
  queryTokens: string[],
  rawQuery: string,
): number {
  if (queryTokens.length === 0) return 0.5;

  const title = page.title.toLowerCase();
  const path = page.path.toLowerCase();
  const content = page.content.toLowerCase();
  const frontmatter = JSON.stringify(page.frontmatter ?? {}).toLowerCase();
  const phrase = rawQuery.trim().toLowerCase();
  let score = 0;

  if (phrase && title.includes(phrase)) score += 0.6;
  if (phrase && path.includes(phrase)) score += 0.5;
  if (phrase && frontmatter.includes(phrase)) score += 0.35;
  if (phrase && content.includes(phrase)) score += 0.3;

  for (const token of queryTokens) {
    if (title.includes(token)) score += 0.22;
    if (path.includes(token)) score += 0.2;
    if (frontmatter.includes(token)) score += 0.14;
    if (content.includes(token)) score += 0.1;
  }

  if (score > 0 && page.type === "paper" && /\bpapers?\b/i.test(rawQuery)) {
    score += 0.08;
  }

  return Math.min(1, score);
}

/**
 * Walk `<config.root>/wiki/index.md` looking for wikilinks that contain
 * the query. Preserves the pre-pivot `index` mode semantics for the
 * handful of tests that still exercise it.
 */
function searchIndexFallback(
  config: BrainConfig,
  query: string,
  limit: number,
): SearchResult[] {
  const indexPath = join(config.root, "wiki/index.md");
  if (!existsSync(indexPath)) return [];

  const content = readFileSync(indexPath, "utf-8");
  const lines = content.split("\n");
  const queryLower = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const line of lines) {
    if (line.toLowerCase().includes(queryLower)) {
      const linkMatch = line.match(/\[\[([^\]]+)\]\]/);
      if (linkMatch) {
        results.push({
          path: linkMatch[1],
          title: linkMatch[1].split("/").pop() ?? linkMatch[1],
          snippet: line.trim(),
          relevance: 0.7,
          type: inferTypeFromPath(linkMatch[1]),
        });
      }
    }
    if (results.length >= limit) break;
  }

  return results;
}

async function searchGrepFallback(
  config: BrainConfig,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const wikiDir = join(config.root, "wiki");
  if (!existsSync(wikiDir)) return [];
  if (!query) return listPagesFallback(config, limit);

  try {
    const { stdout } = await execFileAsync(
      "grep",
      ["-ril", "--include=*.md", "--", query, wikiDir],
      { encoding: "utf-8", timeout: 5000 },
    );
    const output = stdout.trim();
    if (!output) return [];

    const files = output.split("\n");
    const results = files.map((filePath) => {
      const content = readFileSync(filePath, "utf-8");
      const relPath = relative(join(config.root, "wiki"), filePath);
      const title = extractTitle(content) ?? basename(filePath, ".md");
      const snippet = extractSnippet(content, query);
      const path = `wiki/${relPath}`;

      return {
        path,
        title,
        snippet,
        relevance: scoreGrepResult(path, content, query),
        type: inferTypeFromPath(relPath),
      };
    });

    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit);
  } catch {
    return [];
  }
}

function listPagesFallback(config: BrainConfig, limit: number, query = ""): SearchResult[] {
  const wikiDir = join(config.root, "wiki");
  if (!existsSync(wikiDir)) return [];

  const results: SearchResult[] = [];
  const queryTokens = tokenizeListQuery(query);
  walkDir(wikiDir, (filePath) => {
    if (!filePath.endsWith(".md")) return;

    const relPath = relative(wikiDir, filePath);
    const content = readFileSync(filePath, "utf-8");
    const title = extractTitle(content) ?? basename(filePath, ".md");
    const path = `wiki/${relPath}`;
    const relevance = scoreListFallbackResult(
      { path, title, snippet: content },
      queryTokens,
      query,
    );
    if (queryTokens.length > 0 && relevance <= 0) return;

    results.push({
      path,
      title,
      snippet: content.slice(0, 100).trim(),
      relevance,
      type: inferTypeFromPath(relPath),
    });
  });

  return results
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, limit);
}

function scoreListFallbackResult(
  result: { path: string; title: string; snippet: string },
  queryTokens: string[],
  rawQuery: string,
): number {
  if (queryTokens.length === 0) return 0.5;

  const title = result.title.toLowerCase();
  const path = result.path.toLowerCase();
  const snippet = result.snippet.toLowerCase();
  const phrase = rawQuery.trim().toLowerCase();
  let score = 0;

  if (phrase && title.includes(phrase)) score += 0.6;
  if (phrase && path.includes(phrase)) score += 0.5;
  if (phrase && snippet.includes(phrase)) score += 0.3;

  for (const token of queryTokens) {
    if (title.includes(token)) score += 0.22;
    if (path.includes(token)) score += 0.2;
    if (snippet.includes(token)) score += 0.1;
  }

  return Math.min(1, score);
}

function extractTitle(content: string): string | null {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1].trim() : null;
}

function extractSnippet(content: string, query: string): string {
  const queryLower = query.toLowerCase();
  const idx = content.toLowerCase().indexOf(queryLower);
  if (idx === -1) return content.slice(0, 120).trim();

  const start = Math.max(0, idx - 40);
  const end = Math.min(content.length, idx + query.length + 80);
  return content.slice(start, end).trim();
}

function scoreGrepResult(path: string, content: string, query: string): number {
  const tokens = query
    .toLowerCase()
    .split(/[\s|\\]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const haystack = content.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      hits += 1;
    }
  }

  const structuralPenalty = isStructuralWikiPage(path) ? 0.25 : 0;
  return Math.max(0, Math.min(1, 0.5 + hits * 0.15 - structuralPenalty));
}

function walkDir(dir: string, callback: (path: string) => void): void {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkDir(fullPath, callback);
    } else {
      callback(fullPath);
    }
  }
}

function countMarkdownFiles(dir: string): number {
  let count = 0;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      count += countMarkdownFiles(fullPath);
    } else if (entry.endsWith(".md")) {
      count++;
    }
  }
  return count;
}

// ── Public helpers ────────────────────────────────────────────

/**
 * Returns true for pages that are structural (home/index/log/overview).
 * These are typically noise in briefings and chat context — callers
 * deprioritize them.
 */
export function isStructuralWikiPage(path: string): boolean {
  return (
    path.endsWith("/log.md") ||
    path.endsWith("/index.md") ||
    path.endsWith("/home.md") ||
    path.endsWith("/overview.md") ||
    path === "log.md" ||
    path === "index.md" ||
    path === "home.md" ||
    path === "overview.md"
  );
}

/**
 * Count brain pages. Prefers the gbrain-backed `brainStore.health()`
 * (Track C); falls back to a filesystem walk of `<root>/wiki/` when the
 * store is unavailable or reports zero, so legacy disk-first callers
 * (coldstart, warmstart tests) still get a plausible count.
 */
export async function countPages(config: BrainConfig): Promise<number> {
  try {
    const { getBrainStore, ensureBrainStoreReady } = await import("./store");
    await ensureBrainStoreReady();
    const health = await getBrainStore().health();
    if (health.ok && health.pageCount > 0) {
      return health.pageCount;
    }
  } catch {
    // Fall through to filesystem fallback.
  }

  return countPagesFromDisk(config);
}

/**
 * Filesystem-only page count. Used by `/api/brain/status` to avoid a
 * second `brainStore.health()` round-trip when the route has already
 * fetched the store health inline.
 */
export function countPagesFromDisk(config: BrainConfig): number {
  const wikiDir = join(config.root, "wiki");
  if (!existsSync(wikiDir)) return 0;
  return countMarkdownFiles(wikiDir);
}

/**
 * Infer a `ContentType` from a slug or path string.
 */
export function inferTypeFromPath(path: string): ContentType {
  if (matchesPathSegment(path, "entities/papers") || matchesPathSegment(path, "papers")) return "paper";
  if (matchesPathSegment(path, "entities/people") || matchesPathSegment(path, "people")) return "person";
  if (matchesPathSegment(path, "resources/data") || matchesPathSegment(path, "datasets")) return "data";
  if (matchesPathSegment(path, "experiments")) return "experiment";
  if (matchesPathSegment(path, "hypotheses")) return "hypothesis";
  if (matchesPathSegment(path, "concepts")) return "concept";
  if (matchesPathSegment(path, "projects")) return "project";
  if (matchesPathSegment(path, "decisions")) return "decision";
  if (matchesPathSegment(path, "tasks")) return "task";
  if (matchesPathSegment(path, "entities/artifacts") || matchesPathSegment(path, "artifacts")) return "artifact";
  if (matchesPathSegment(path, "entities/frontier") || matchesPathSegment(path, "frontier")) return "frontier_item";
  if (matchesPathSegment(path, "observations")) return "observation";
  return "note";
}

function matchesPathSegment(path: string, segment: string): boolean {
  return (
    path === segment ||
    path.startsWith(`${segment}/`) ||
    path.includes(`/${segment}/`)
  );
}
