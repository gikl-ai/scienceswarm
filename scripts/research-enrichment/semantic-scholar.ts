#!/usr/bin/env npx tsx
/**
 * Semantic Scholar — Deterministic Collector
 *
 * Standalone script that fetches paper metadata from the Semantic Scholar API.
 * Can be run via `npx tsx` or imported as a module.
 *
 * Usage:
 *   npx tsx scripts/research-enrichment/semantic-scholar.ts "Attention Is All You Need"
 *   npx tsx scripts/research-enrichment/semantic-scholar.ts --doi "10.48550/arXiv.1706.03762"
 *   npx tsx scripts/research-enrichment/semantic-scholar.ts --arxiv "1706.03762"
 *   echo '[{"query":"..."}]' | npx tsx scripts/research-enrichment/semantic-scholar.ts --batch
 *
 * Rate limit: max 100 requests per 5 minutes (Semantic Scholar free tier).
 */

// ── Types ─────────────────────────────────────────────

export interface SemanticScholarPaper {
  paperId: string;
  title: string;
  authors: Array<{ authorId: string | null; name: string }>;
  year: number | null;
  venue: string;
  abstract: string | null;
  citationCount: number;
  referenceCount: number;
  doi: string | null;
  arxivId: string | null;
  url: string;
  citations: Array<{
    title: string;
    year: number | null;
    authors: Array<{ name: string }>;
  }>;
  references: Array<{
    title: string;
    year: number | null;
    authors: Array<{ name: string }>;
  }>;
}

export interface SemanticScholarQuery {
  query?: string;
  doi?: string;
  arxivId?: string;
}

export interface SemanticScholarResult {
  ok: boolean;
  paper: SemanticScholarPaper | null;
  error?: string;
  query: SemanticScholarQuery;
}

// ── Configuration ─────────────────────────────────────

const BASE_URL = "https://api.semanticscholar.org/graph/v1/paper";
const DETAIL_FIELDS = [
  "title",
  "authors",
  "year",
  "venue",
  "abstract",
  "citationCount",
  "referenceCount",
  "citations.title",
  "citations.year",
  "citations.authors",
  "references.title",
  "references.year",
  "references.authors",
  "externalIds",
  "url",
].join(",");

/** Configurable delay between requests (ms). Default 500ms for rate safety. */
export const DEFAULT_DELAY_MS = 500;

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
 * Search for a paper by title query and return the best match.
 */
export async function searchPaper(
  query: string,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<string | null> {
  const url = `${BASE_URL}/search?query=${encodeURIComponent(query)}&limit=3&fields=title,paperId`;
  const res = await rateLimitedFetch(url, delayMs);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    data?: Array<{ paperId: string; title: string }>;
  };
  if (!data.data || data.data.length === 0) return null;
  return data.data[0].paperId;
}

/**
 * Get full paper details by paper ID.
 */
export async function getPaperDetails(
  paperId: string,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<SemanticScholarPaper | null> {
  const url = `${BASE_URL}/${encodeURIComponent(paperId)}?fields=${DETAIL_FIELDS}`;
  const res = await rateLimitedFetch(url, delayMs);
  if (!res.ok) return null;

  const raw = (await res.json()) as Record<string, unknown>;
  return normalizePaper(raw);
}

/**
 * Look up a paper by DOI.
 */
export async function lookupByDoi(
  doi: string,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<SemanticScholarPaper | null> {
  const url = `${BASE_URL}/DOI:${encodeURIComponent(doi)}?fields=${DETAIL_FIELDS}`;
  const res = await rateLimitedFetch(url, delayMs);
  if (!res.ok) return null;

  const raw = (await res.json()) as Record<string, unknown>;
  return normalizePaper(raw);
}

/**
 * Look up a paper by arXiv ID.
 */
export async function lookupByArxiv(
  arxivId: string,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<SemanticScholarPaper | null> {
  const cleanId = arxivId.replace(/^arxiv:/i, "").replace(/v\d+$/, "");
  const url = `${BASE_URL}/ARXIV:${encodeURIComponent(cleanId)}?fields=${DETAIL_FIELDS}`;
  const res = await rateLimitedFetch(url, delayMs);
  if (!res.ok) return null;

  const raw = (await res.json()) as Record<string, unknown>;
  return normalizePaper(raw);
}

/**
 * Resolve a query (title, DOI, or arXiv ID) to full paper details.
 */
export async function resolvePaper(
  query: SemanticScholarQuery,
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<SemanticScholarResult> {
  try {
    let paper: SemanticScholarPaper | null = null;

    if (query.doi) {
      paper = await lookupByDoi(query.doi, delayMs);
    } else if (query.arxivId) {
      paper = await lookupByArxiv(query.arxivId, delayMs);
    } else if (query.query) {
      const paperId = await searchPaper(query.query, delayMs);
      if (paperId) {
        paper = await getPaperDetails(paperId, delayMs);
      }
    }

    return { ok: paper !== null, paper, query };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, paper: null, error: message, query };
  }
}

/**
 * Batch resolve multiple queries.
 */
export async function batchResolve(
  queries: SemanticScholarQuery[],
  delayMs: number = DEFAULT_DELAY_MS,
): Promise<SemanticScholarResult[]> {
  const results: SemanticScholarResult[] = [];
  for (const q of queries) {
    results.push(await resolvePaper(q, delayMs));
  }
  return results;
}

// ── Normalize API Response ────────────────────────────

function normalizePaper(raw: Record<string, unknown>): SemanticScholarPaper {
  const externalIds = (raw.externalIds ?? {}) as Record<string, string>;
  const authors = (raw.authors ?? []) as Array<{
    authorId: string | null;
    name: string;
  }>;
  const citations = (raw.citations ?? []) as Array<{
    title: string;
    year: number | null;
    authors: Array<{ name: string }>;
  }>;
  const references = (raw.references ?? []) as Array<{
    title: string;
    year: number | null;
    authors: Array<{ name: string }>;
  }>;

  return {
    paperId: String(raw.paperId ?? ""),
    title: String(raw.title ?? ""),
    authors: authors.map((a) => ({
      authorId: a.authorId ?? null,
      name: a.name ?? "Unknown",
    })),
    year: typeof raw.year === "number" ? raw.year : null,
    venue: String(raw.venue ?? ""),
    abstract: typeof raw.abstract === "string" ? raw.abstract : null,
    citationCount: typeof raw.citationCount === "number" ? raw.citationCount : 0,
    referenceCount:
      typeof raw.referenceCount === "number" ? raw.referenceCount : 0,
    doi: externalIds.DOI ?? (typeof raw.doi === "string" ? raw.doi : null),
    arxivId: externalIds.ArXiv ?? null,
    url: String(raw.url ?? ""),
    citations: (citations ?? [])
      .filter((c) => c && c.title)
      .slice(0, 10)
      .map((c) => ({
        title: c.title,
        year: c.year ?? null,
        authors: (c.authors ?? []).map((a) => ({ name: a.name })),
      })),
    references: (references ?? [])
      .filter((r) => r && r.title)
      .slice(0, 10)
      .map((r) => ({
        title: r.title,
        year: r.year ?? null,
        authors: (r.authors ?? []).map((a) => ({ name: a.name })),
      })),
  };
}

// ── CLI Entry Point ───────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--batch")) {
    // Read JSON array from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const input = Buffer.concat(chunks).toString("utf-8").trim();
    const queries: SemanticScholarQuery[] = JSON.parse(input);
    const results = await batchResolve(queries);
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return;
  }

  const query: SemanticScholarQuery = {};

  if (args.includes("--doi")) {
    const idx = args.indexOf("--doi");
    query.doi = args[idx + 1];
  } else if (args.includes("--arxiv")) {
    const idx = args.indexOf("--arxiv");
    query.arxivId = args[idx + 1];
  } else if (args[0]) {
    query.query = args[0];
  } else {
    console.error(
      "Usage: semantic-scholar.ts <title> | --doi <doi> | --arxiv <id> | --batch",
    );
    process.exit(1);
  }

  const result = await resolvePaper(query);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

// Run CLI if executed directly
const isDirectRun =
  typeof require !== "undefined" && require.main === module;
const isRunViaTsx =
  process.argv[1]?.endsWith("semantic-scholar.ts") ?? false;

if (isDirectRun || isRunViaTsx) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
