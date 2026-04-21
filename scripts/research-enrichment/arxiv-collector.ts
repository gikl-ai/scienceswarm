#!/usr/bin/env npx tsx
/**
 * arXiv — Deterministic Collector
 *
 * Standalone script that fetches paper metadata from the arXiv API.
 * Can be run via `npx tsx` or imported as a module.
 *
 * Usage:
 *   npx tsx scripts/research-enrichment/arxiv-collector.ts --id "2301.08362"
 *   npx tsx scripts/research-enrichment/arxiv-collector.ts --search "transformer attention mechanism"
 *   npx tsx scripts/research-enrichment/arxiv-collector.ts --category "cs.AI" --recent 7
 *
 * arXiv API: http://export.arxiv.org/api/query
 */

// ── Types ─────────────────────────────────────────────

export interface ArxivPaper {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  published: string; // ISO date
  updated: string; // ISO date
  pdfLink: string;
  doi: string | null;
}

export interface ArxivResult {
  ok: boolean;
  papers: ArxivPaper[];
  totalResults: number;
  error?: string;
}

// ── Configuration ─────────────────────────────────────

const BASE_URL = "http://export.arxiv.org/api/query";

/** Delay between requests (ms). arXiv recommends waiting at least 3s. */
export const DEFAULT_DELAY_MS = 3000;

// ── Rate Limiter ──────────────────────────────────────

let lastRequestTime = 0;

async function rateLimitedFetch(
  url: string,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < delayMs) {
    await sleep(delayMs - elapsed);
  }
  lastRequestTime = Date.now();
  return fetch(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Core Functions ────────────────────────────────────

/**
 * Fetch a specific paper by arXiv ID.
 */
export async function fetchById(
  id: string,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<ArxivResult> {
  const cleanId = id.replace(/^arxiv:/i, "").replace(/v\d+$/, "");
  const url = `${BASE_URL}?id_list=${encodeURIComponent(cleanId)}`;
  return fetchAndParse(url, delayMs);
}

/**
 * Search for papers by query string.
 */
export async function searchPapers(
  query: string,
  maxResults: number = 20,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<ArxivResult> {
  const url = `${BASE_URL}?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
  return fetchAndParse(url, delayMs);
}

/**
 * Fetch recent papers from a category.
 */
export async function fetchCategory(
  category: string,
  maxResults: number = 20,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<ArxivResult> {
  const url = `${BASE_URL}?search_query=cat:${encodeURIComponent(category)}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
  return fetchAndParse(url, delayMs);
}

/**
 * Fetch papers from categories published in the last N days.
 */
export async function fetchRecent(
  categories: string[],
  days: number = 7,
  maxResults: number = 20,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<ArxivResult> {
  const catQuery = categories.map((c) => `cat:${c}`).join("+OR+");
  const url = `${BASE_URL}?search_query=${catQuery}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
  const result = await fetchAndParse(url, delayMs);

  if (!result.ok) return result;

  // Filter to papers within the date window
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();

  result.papers = result.papers.filter((p) => p.published >= cutoffStr);
  result.totalResults = result.papers.length;

  return result;
}

// ── XML Parsing ───────────────────────────────────────

async function fetchAndParse(
  url: string,
  delayMs: number,
): Promise<ArxivResult> {
  try {
    const res = await rateLimitedFetch(url, delayMs);
    if (!res.ok) {
      return {
        ok: false,
        papers: [],
        totalResults: 0,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const xml = await res.text();
    return parseAtomFeed(xml);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, papers: [], totalResults: 0, error: message };
  }
}

/**
 * Parse arXiv Atom XML feed into structured papers.
 * Uses regex-based extraction since we don't want a full XML parser dependency.
 */
export function parseAtomFeed(xml: string): ArxivResult {
  const totalMatch = xml.match(
    /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/,
  );
  const totalResults = totalMatch ? parseInt(totalMatch[1], 10) : 0;

  const papers: ArxivPaper[] = [];
  const entries = xml.split("<entry>").slice(1);

  for (const entry of entries) {
    const paper = parseEntry(entry);
    if (paper) papers.push(paper);
  }

  return { ok: true, papers, totalResults };
}

function parseEntry(entry: string): ArxivPaper | null {
  const id = extractTag(entry, "id");
  const title = extractTag(entry, "title");
  if (!id || !title) return null;

  // Extract arXiv ID from the full URL
  const arxivId = id.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");

  // Authors: multiple <author><name>...</name></author> blocks
  const authorMatches = entry.match(/<author>\s*<name>([^<]+)<\/name>/g) ?? [];
  const authors = authorMatches.map((m) => {
    const nameMatch = m.match(/<name>([^<]+)<\/name>/);
    return nameMatch ? nameMatch[1].trim() : "Unknown";
  });

  const abstract = extractTag(entry, "summary");

  // Categories: <category term="cs.AI" />
  const catMatches = entry.match(/term="([^"]+)"/g) ?? [];
  const categories = catMatches.map((m) => m.replace(/term="|"/g, ""));

  const published = extractTag(entry, "published") ?? "";
  const updated = extractTag(entry, "updated") ?? "";

  // PDF link: <link ... type="application/pdf" href="..." />
  const pdfMatch = entry.match(
    /<link[^>]*type="application\/pdf"[^>]*href="([^"]+)"/,
  );
  const pdfLink = pdfMatch
    ? pdfMatch[1]
    : `https://arxiv.org/pdf/${arxivId}`;

  // DOI: <arxiv:doi> tag
  const doi = extractTag(entry, "arxiv:doi");

  return {
    id: arxivId,
    title: cleanText(title),
    authors,
    abstract: abstract ? cleanText(abstract) : "",
    categories,
    published,
    updated,
    pdfLink,
    doi: doi ?? null,
  };
}

function extractTag(xml: string, tag: string): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`);
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ── CLI Entry Point ───────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--id")) {
    const idx = args.indexOf("--id");
    const id = args[idx + 1];
    if (!id) {
      console.error("Usage: arxiv-collector.ts --id <arxiv-id>");
      process.exit(1);
    }
    const result = await fetchById(id);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (args.includes("--search")) {
    const idx = args.indexOf("--search");
    const query = args[idx + 1];
    if (!query) {
      console.error("Usage: arxiv-collector.ts --search <query>");
      process.exit(1);
    }
    const maxResults = getNumericArg(args, "--max", 20);
    const result = await searchPapers(query, maxResults);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (args.includes("--category")) {
    const idx = args.indexOf("--category");
    const category = args[idx + 1];
    if (!category) {
      console.error("Usage: arxiv-collector.ts --category <cat>");
      process.exit(1);
    }

    if (args.includes("--recent")) {
      const days = getNumericArg(args, "--recent", 7);
      const maxResults = getNumericArg(args, "--max", 20);
      const result = await fetchRecent([category], days, maxResults);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      const maxResults = getNumericArg(args, "--max", 20);
      const result = await fetchCategory(category, maxResults);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }
    return;
  }

  console.error(
    "Usage: arxiv-collector.ts --id <id> | --search <query> | --category <cat> [--recent <days>]",
  );
  process.exit(1);
}

function getNumericArg(
  args: string[],
  flag: string,
  defaultValue: number,
): number {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return defaultValue;
  const val = parseInt(args[idx + 1], 10);
  return Number.isNaN(val) ? defaultValue : val;
}

// Run CLI if executed directly
const isDirectRun =
  typeof require !== "undefined" && require.main === module;
const isRunViaTsx =
  process.argv[1]?.endsWith("arxiv-collector.ts") ?? false;

if (isDirectRun || isRunViaTsx) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
