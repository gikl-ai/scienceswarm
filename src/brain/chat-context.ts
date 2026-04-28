/**
 * Second Brain — Chat Context
 *
 * Builds brain context for chat system prompts.
 * Searches wiki for relevant content, trims to token budget,
 * and optionally injects serendipity picks.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import type { BrainConfig, SearchResult } from "./types";
import { isGeneratedArtifactPage } from "./import-registry";
import { isStructuralWikiPage, search } from "./search";
import type { BrainPage, BrainStore } from "./store";

// ── Public Types ──────────────────────────────────────

export interface ChatContext {
  /** Relevant wiki pages to inject into system prompt */
  pages: Array<{ path: string; content: string; relevance: string }>;
  /** Matching page inventory for list/enumeration questions */
  inventory?: Array<{ path: string; title: string; type: string; snippet: string; relevance: number }>;
  /** Total tokens estimated for the injected context */
  estimatedTokens: number;
  /** Whether serendipity injection was triggered */
  serendipityTriggered: boolean;
}

// ── Stop Words ────────────────────────────────────────

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "because",
  "if",
  "when",
  "where",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "myself",
  "we",
  "our",
  "ours",
  "ourselves",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "he",
  "him",
  "his",
  "himself",
  "she",
  "her",
  "hers",
  "herself",
  "it",
  "its",
  "itself",
  "they",
  "them",
  "their",
  "theirs",
  "themselves",
  "about",
  "tell",
  "know",
  "think",
  "make",
  "like",
  "also",
  "best",
  "good",
  "well",
  "much",
  "many",
  "here",
  "there",
  "when",
  "where",
  "while",
  "been",
  "come",
  "came",
  "done",
  "went",
  "goes",
  "going",
  "take",
  "took",
  "give",
  "gave",
  "does",
  "must",
  "work",
  "seem",
  "even",
  "still",
  "really",
]);

const STORE_PAGE_READ_TIMEOUT_MS = 500;
const MAX_INVENTORY_RESULTS = 25;
const INVENTORY_SCAN_LIMIT = 5000;

type ContextSearchResult = Pick<SearchResult, "path" | "title" | "snippet" | "relevance" | "compiledView">;

interface BuildChatContextOptions {
  maxTokens?: number;
  serendipityRate?: number;
  projectId?: string;
  inventoryOnly?: boolean;
  excludeGeneratedArtifacts?: boolean;
}

function isProjectScopedResult(path: string, projectId?: string): boolean {
  if (!projectId) {
    return true;
  }

  const normalizedPath = path.toLowerCase().replace(/^\/+/, "");
  if (!normalizedPath.startsWith("openclaw-web-")) {
    return true;
  }

  const projectRoot = `openclaw-web-${projectId.toLowerCase()}`;
  return normalizedPath === projectRoot
    || normalizedPath === `${projectRoot}.md`
    || normalizedPath.startsWith(`${projectRoot}/`);
}

// ── Keyword Extraction ────────────────────────────────

/**
 * Extract keywords from a user message for wiki search.
 *
 * Improvements over the original:
 * 1. Caps at 8 keywords (was 5)
 * 2. Extracts quoted multi-word phrases and hyphenated terms
 * 3. Preserves technical terms (words with numbers, capitalized sequences)
 * 4. Deduplicates substrings (e.g., "CRISPR" is dropped if "CRISPR-Cas9" exists)
 */
export function extractKeywords(message: string): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();

  // 1. Extract quoted phrases first (preserve as-is, lowercased)
  const quotedPattern = /"([^"]+)"/g;
  let quoteMatch;
  while ((quoteMatch = quotedPattern.exec(message)) !== null) {
    const phrase = quoteMatch[1].trim().toLowerCase();
    if (phrase.length > 2 && !seen.has(phrase)) {
      seen.add(phrase);
      keywords.push(phrase);
    }
  }

  // Remove quoted portions from the message for further processing
  const withoutQuotes = message.replace(/"[^"]*"/g, " ");

  // 2. Extract hyphenated terms and technical terms (words with digits)
  const tokens = withoutQuotes
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    const lower = token.toLowerCase();

    // Skip stop words and short words (unless they contain digits — technical terms)
    const hasDigit = /\d/.test(token);
    if (lower.length <= 3 && !hasDigit) continue;
    if (STOP_WORDS.has(lower)) continue;

    if (!seen.has(lower)) {
      seen.add(lower);
      keywords.push(lower);
    }
  }

  // 3. Detect capitalized multi-word sequences in original message (e.g., "Zhang Lab")
  const capitalizedPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let capMatch;
  while ((capMatch = capitalizedPattern.exec(message)) !== null) {
    const phrase = capMatch[1].toLowerCase();
    if (!seen.has(phrase) && !STOP_WORDS.has(phrase)) {
      seen.add(phrase);
      keywords.push(phrase);
    }
  }

  return dedupeSpecificKeywords(keywords, 8);
}

function dedupeSpecificKeywords(keywords: string[], limit: number): string[] {
  const deduped: string[] = [];

  for (const keyword of keywords) {
    let replacementIndex: number | null = null;
    let skipKeyword = false;

    for (let index = deduped.length - 1; index >= 0; index -= 1) {
      const existing = deduped[index];
      if (
        existing === keyword
        || (existing.length > keyword.length && containsKeywordPart(existing, keyword))
      ) {
        skipKeyword = true;
        break;
      }

      if (keyword.length > existing.length && containsKeywordPart(keyword, existing)) {
        replacementIndex = index;
        deduped.splice(index, 1);
      }
    }

    if (skipKeyword) continue;
    if (replacementIndex !== null) {
      deduped.splice(replacementIndex, 0, keyword);
      continue;
    }
    deduped.push(keyword);
  }

  return deduped.slice(0, limit);
}

function containsKeywordPart(keyword: string, fragment: string): boolean {
  let startIndex = keyword.indexOf(fragment);
  while (startIndex !== -1) {
    const before = startIndex === 0 ? "" : keyword[startIndex - 1];
    const afterIndex = startIndex + fragment.length;
    const after = afterIndex >= keyword.length ? "" : keyword[afterIndex];
    const leftBoundary = before === "" || /[^a-z0-9]/.test(before);
    const rightBoundary = after === "" || /[^a-z0-9]/.test(after);
    if (leftBoundary && rightBoundary) {
      return true;
    }
    startIndex = keyword.indexOf(fragment, startIndex + 1);
  }
  return false;
}

// ── Token Estimation ──────────────────────────────────

/** Rough token estimate: 4 chars per token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function shouldIncludeInventory(userMessage: string): boolean {
  return /\b(enumerate|list|show|which|what|where|find|located?|locations?|paths?|folders?|directories?)\b/i.test(userMessage)
    && /\b(brain|papers?|pages?|documents?|files?|sources?|imports?|workspace|folders?|directories?)\b/i.test(userMessage);
}

function inventoryQueryTokens(userMessage: string): string[] {
  return extractKeywords(userMessage).filter(
    (token) =>
      ![
        "brain",
        "paper",
        "papers",
        "page",
        "pages",
        "folder",
        "folders",
        "directory",
        "directories",
        "path",
        "paths",
        "file",
        "files",
        "source",
        "sources",
        "workspace",
        "located",
        "location",
        "locations",
        "where",
        "find",
        "show",
        "list",
        "enumerate",
        "what",
        "which",
      ].includes(token),
  );
}

function inventorySnippet(page: BrainPage): string {
  const sourcePath = page.frontmatter.source_path ?? page.frontmatter.sourcePath;
  if (typeof sourcePath === "string" && sourcePath.trim().length > 0) {
    return sourcePath;
  }
  return page.content.trim().slice(0, 220);
}

function scoreInventoryPage(
  page: BrainPage,
  queryTokens: string[],
): number {
  if (queryTokens.length === 0) {
    return 0.5;
  }

  const sourcePath = page.frontmatter.source_path ?? page.frontmatter.sourcePath;
  const haystacks = [
    page.title.toLowerCase(),
    page.path.toLowerCase(),
    page.content.toLowerCase(),
    typeof sourcePath === "string" ? sourcePath.toLowerCase() : "",
  ];

  let score = 0;
  for (const token of queryTokens) {
    if (haystacks[0].includes(token)) score += 0.4;
    if (haystacks[1].includes(token)) score += 0.3;
    if (haystacks[2].includes(token)) score += 0.2;
    if (haystacks[3].includes(token)) score += 0.2;
  }
  return Math.min(1, score);
}

async function listInventoryResults(
  store: BrainStore,
  userMessage: string,
): Promise<NonNullable<ChatContext["inventory"]>> {
  const pages = await store.listPages({ limit: INVENTORY_SCAN_LIMIT });
  const queryTokens = inventoryQueryTokens(userMessage);

  return pages
    .map((page) => ({
      path: page.path,
      title: page.title,
      type: page.type,
      snippet: inventorySnippet(page),
      relevance: scoreInventoryPage(page, queryTokens),
    }))
    .filter((page) => queryTokens.length === 0 || page.relevance > 0)
    .sort((left, right) => {
      if (right.relevance !== left.relevance) {
        return right.relevance - left.relevance;
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, MAX_INVENTORY_RESULTS);
}

// ── Chat Context Builder ──────────────────────────────

/**
 * Build brain context for a chat message.
 * Searches the wiki for content relevant to the user's message,
 * then trims to fit within the token budget (2-8K tokens).
 */
export async function buildChatContext(
  config: BrainConfig,
  userMessage: string,
  options?: BuildChatContextOptions,
): Promise<ChatContext> {
  const maxTokens = Math.max(2000, Math.min(8000, options?.maxTokens ?? 4000));
  const serendipityRate = options?.serendipityRate ?? config.serendipityRate;
  let store: BrainStore | null = null;
  let storeModulePromise: Promise<typeof import("./store")> | null = null;
  const getStoreModule = () => {
    storeModulePromise ??= import("./store");
    return storeModulePromise;
  };
  const resolveStore = async () => {
    store ??= (await getStoreModule()).getBrainStore();
    return store;
  };

  const keywords = extractKeywords(userMessage);
  const inventoryRequested = shouldIncludeInventory(userMessage);

  const matchedPaths = new Set<string>();
  const allResults: ContextSearchResult[] = [];
  let usedStoreSearch = false;

  // Try store search first (PGLite keyword search)
  {
    const { cachedSearchWithSource } = await getStoreModule();
    const { results, fromStore } = await cachedSearchWithSource({
      query: userMessage,
      mode: "qmd",
      limit: 10,
      profile: "interactive",
    });

    for (const result of results) {
      if (isStructuralWikiPage(result.path)) continue;
      if (!isProjectScopedResult(result.path, options?.projectId)) continue;
      if (!await shouldIncludeSearchResult(config, await resolveStore(), result.path, options)) continue;
      if (matchedPaths.has(result.path)) continue;
      matchedPaths.add(result.path);
      allResults.push(result);
    }

    usedStoreSearch = fromStore && allResults.length > 0;
  }

  // Fall back to grep if the store search returned nothing
  if (!usedStoreSearch && !inventoryRequested) {
    for (const keyword of keywords) {
      const results = await search(config, { query: keyword, mode: "grep", limit: 5 });
      for (const result of results) {
        if (isStructuralWikiPage(result.path)) continue;
        if (!isProjectScopedResult(result.path, options?.projectId)) continue;
        if (!await shouldIncludeSearchResult(config, await resolveStore(), result.path, options)) continue;
        if (matchedPaths.has(result.path)) continue;
        matchedPaths.add(result.path);
        allResults.push(result);
      }
    }
  }

  const pageContentCache = new Map<string, Promise<string>>();
  const getContent = (path: string) => {
    if (!pageContentCache.has(path)) {
      pageContentCache.set(
        path,
        (async () => loadPageContent(config, await resolveStore(), path))(),
      );
    }
    return pageContentCache.get(path)!;
  };

  const pathKeywordHits = new Map<string, number>();
  if (!usedStoreSearch) {
    for (const keyword of keywords) {
      for (const result of allResults) {
        const content = await getContent(result.path);
        if (content.toLowerCase().includes(keyword.toLowerCase())) {
          pathKeywordHits.set(result.path, (pathKeywordHits.get(result.path) ?? 0) + 1);
        }
      }
    }

    allResults.sort((a, b) => {
      const hitsA = pathKeywordHits.get(a.path) ?? 0;
      const hitsB = pathKeywordHits.get(b.path) ?? 0;
      return hitsB - hitsA;
    });
  } else {
    allResults.sort((a, b) => b.relevance - a.relevance);
  }

  const pages: ChatContext["pages"] = [];
  let inventory: ChatContext["inventory"] = [];
  let totalTokens = 0;

  if (inventoryRequested || allResults.length === 0) {
    try {
      const wantsPapers = /\bpapers?\b/i.test(userMessage);
      const locationRequested = /\b(where|located?|locations?|paths?|folders?|directories?)\b/i.test(userMessage);
      const listResults = await listInventoryResults(await resolveStore(), userMessage);
      inventory = [];
      for (const result of listResults) {
        if (isStructuralWikiPage(result.path)) continue;
        if (!isProjectScopedResult(result.path, options?.projectId)) continue;
        if (wantsPapers && result.type !== "paper") continue;
        if (!await shouldIncludeSearchResult(config, await resolveStore(), result.path, options)) continue;
        inventory.push({
          path: result.path,
          title: result.title,
          type: result.type,
          snippet: result.snippet,
          relevance: result.relevance,
        });
      }

      if (inventory.length === 0 && wantsPapers && locationRequested) {
        const fallbackResults = await listInventoryResults(await resolveStore(), "");
        inventory = [];
        for (const result of fallbackResults) {
          if (isStructuralWikiPage(result.path)) continue;
          if (!isProjectScopedResult(result.path, options?.projectId)) continue;
          if (result.type !== "paper") continue;
          if (!await shouldIncludeSearchResult(config, await resolveStore(), result.path, options)) continue;
          inventory.push({
            path: result.path,
            title: result.title,
            type: result.type,
            snippet: result.snippet,
            relevance: result.relevance,
          });
        }
      }
    } catch {
      inventory = [];
    }

    if (inventory.length > 0) {
      totalTokens += estimateTokens(formatBrainInventory(inventory));
    }
  }

  if (options?.inventoryOnly) {
    return {
      pages: [],
      inventory,
      estimatedTokens: totalTokens,
      serendipityTriggered: false,
    };
  }

  // Take top 5 results and trim to token budget. If keyword chunks are absent
  // but listPages found matching pages, use those list results to load content
  // for ordinary Q&A. Pure inventory requests only need the list above.
  const contentResults = allResults.length > 0
    ? allResults.slice(0, 5)
    : inventoryRequested
      ? []
      : inventory.slice(0, 5).map((entry) => ({
          path: entry.path,
          title: entry.title,
          snippet: entry.snippet,
          relevance: entry.relevance,
          compiledView: undefined,
        }));

  for (const result of contentResults) {
    const content = result.compiledView
      ? formatCompiledSearchContext(result)
      : await getContent(result.path);
    if (!content) continue;

    const pageTokens = estimateTokens(content);
    const remainingBudget = maxTokens - totalTokens;

    if (remainingBudget <= 0) break;

    let trimmedContent = content;
    if (pageTokens > remainingBudget) {
      // Trim content to fit within remaining budget (account for suffix length)
      const suffixLen = "\n[...trimmed]".length;
      const maxChars = remainingBudget * 4 - suffixLen;
      if (maxChars <= 0) continue; // Nothing meaningful fits; skip this page
      trimmedContent = content.slice(0, maxChars) + "\n[...trimmed]";
    }

    const keywordHits = pathKeywordHits.get(result.path) ?? 0;
    const relevance =
      usedStoreSearch
        ? result.relevance >= 0.75
          ? "high"
          : result.relevance >= 0.45
            ? "medium"
            : "low"
        : keywordHits >= 3
          ? "high"
          : keywordHits >= 2
            ? "medium"
            : "low";

    pages.push({
      path: result.path,
      content: trimmedContent,
      relevance,
    });

    totalTokens += estimateTokens(trimmedContent);
  }

  // Serendipity: inject a random page
  let serendipityTriggered = false;
  if (Math.random() < serendipityRate && totalTokens < maxTokens) {
    const randomPage = pickRandomPage(config, matchedPaths);
    if (randomPage) {
      const remainingBudget = maxTokens - totalTokens;
      let content = randomPage.content;
      if (estimateTokens(content) > remainingBudget) {
        const suffixLen = "\n[...trimmed]".length;
        const maxChars = remainingBudget * 4 - suffixLen;
        if (maxChars <= 0) {
          content = ""; // Nothing meaningful fits; skip serendipity this turn
        } else {
          content = content.slice(0, maxChars) + "\n[...trimmed]";
        }
      }

      if (estimateTokens(content) > 0) {
        pages.push({
          path: randomPage.path,
          content,
          relevance: "serendipity",
        });
        totalTokens += estimateTokens(content);
        serendipityTriggered = true;
      }
    }
  }

  return {
    pages,
    inventory,
    estimatedTokens: totalTokens,
    serendipityTriggered,
  };
}

async function shouldIncludeSearchResult(
  config: BrainConfig,
  store: BrainStore,
  pagePath: string,
  options?: BuildChatContextOptions,
): Promise<boolean> {
  if (!options?.excludeGeneratedArtifacts) {
    return true;
  }

  const page = await loadPageForFiltering(config, store, pagePath);
  return page ? !isGeneratedArtifactPage(page) : true;
}

// ── System Prompt Formatter ───────────────────────────

/**
 * Format brain context into a system prompt section.
 */
export function formatBrainPrompt(context: ChatContext): string {
  if (context.pages.length === 0 && (!context.inventory || context.inventory.length === 0)) {
    return "";
  }

  const lines: string[] = [];
  lines.push("## Research Context (from your Second Brain)");
  lines.push("");

  if (context.inventory && context.inventory.length > 0) {
    lines.push("### Matching Brain Pages");
    lines.push("");
    lines.push("Use this gbrain page inventory when the user asks what is in their brain.");
    lines.push("For path or location questions, prefer each page's gbrain path and source metadata over guessing from a study folder name.");
    lines.push("");
    lines.push(formatBrainInventory(context.inventory));
    lines.push("");
  }

  const relevantPages = context.pages.filter(
    (p) => p.relevance !== "serendipity"
  );
  const serendipityPages = context.pages.filter(
    (p) => p.relevance === "serendipity"
  );

  if (relevantPages.length > 0) {
    lines.push("### Relevant Pages");
    lines.push("");
    for (const page of relevantPages) {
      const wikilink = `[[${page.path}]]`;
      lines.push(`**${wikilink}** (relevance: ${page.relevance})`);
      lines.push("");
      lines.push(page.content);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  if (serendipityPages.length > 0) {
    lines.push("### Serendipity Pick");
    lines.push("_A random page that might spark new connections:_");
    lines.push("");
    for (const page of serendipityPages) {
      const wikilink = `[[${page.path}]]`;
      lines.push(`**${wikilink}**`);
      lines.push("");
      lines.push(page.content);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

function formatBrainInventory(inventory: NonNullable<ChatContext["inventory"]>): string {
  return inventory
    .map((entry) => {
      const snippet = entry.snippet ? ` — ${entry.snippet}` : "";
      return `- [${entry.type}] ${entry.title} — [[${entry.path}]]${snippet}`;
    })
    .join("\n");
}

function formatCompiledSearchContext(result: ContextSearchResult): string {
  if (!result.compiledView) return result.snippet;
  const counts = result.compiledView.sourceCounts;
  const sourceSummary = [
    formatCount(counts.papers, "paper"),
    formatCount(counts.notes, "note"),
    formatCount(counts.experiments, "experiment"),
    formatCount(counts.datasets, "dataset"),
    formatCount(counts.other, "other source"),
  ].filter(Boolean).join(", ");
  const updated = result.compiledView.lastUpdated
    ? `last updated ${result.compiledView.lastUpdated}`
    : "last updated unknown";
  return [
    `Your current view of ${result.title}, synthesized from ${sourceSummary || `${result.compiledView.totalSources} sources`} — ${updated}.`,
    "",
    result.compiledView.summary,
  ].join("\n");
}

function formatCount(count: number, singular: string): string {
  if (count <= 0) return "";
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

// ── Internal Helpers ──────────────────────────────────

async function loadPageContent(
  config: BrainConfig,
  store: BrainStore,
  pagePath: string,
): Promise<string> {
  try {
    const page = await withPageReadTimeout(
      store.getPage(pagePath),
      STORE_PAGE_READ_TIMEOUT_MS,
    );
    if (page?.content) {
      return page.content;
    }
  } catch {
    // Fall back to filesystem reads for derived-index outages.
  }

  return readPageContent(config, pagePath);
}

async function loadPageForFiltering(
  config: BrainConfig,
  store: BrainStore,
  pagePath: string,
): Promise<BrainPage | null> {
  try {
    const page = await withPageReadTimeout(
      store.getPage(pagePath),
      STORE_PAGE_READ_TIMEOUT_MS,
    );
    if (page) {
      return page;
    }
  } catch {
    // Fall back to allowing the result through if the store cannot hydrate it.
  }

  const content = readPageContent(config, pagePath);
  if (!content) {
    return null;
  }

  return {
    path: pagePath,
    title: pagePath,
    type: "note" as const,
    content,
    frontmatter: {},
  };
}

function withPageReadTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Brain page read timeout")), timeoutMs);
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

function readPageContent(config: BrainConfig, pagePath: string): string {
  // pagePath is like "wiki/concepts/foo.md"
  const fullPath = join(config.root, pagePath);
  if (!existsSync(fullPath)) return "";
  try {
    return readFileSync(fullPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Pick a random wiki page that isn't already in the matched set.
 */
function pickRandomPage(
  config: BrainConfig,
  excludePaths: Set<string>
): { path: string; content: string } | null {
  const wikiDir = join(config.root, "wiki");
  if (!existsSync(wikiDir)) return null;

  const allPages = collectMarkdownFiles(wikiDir);
  const candidates = allPages.filter((f) => {
    const relPath = `wiki/${relative(wikiDir, f)}`;
    return !excludePaths.has(relPath);
  });

  if (candidates.length === 0) return null;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const relPath = `wiki/${relative(wikiDir, pick)}`;
  try {
    const content = readFileSync(pick, "utf-8");
    return { path: relPath, content };
  } catch {
    return null;
  }
}

function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectMarkdownFiles(fullPath));
    } else if (entry.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}
