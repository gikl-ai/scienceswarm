/**
 * Semantic Scholar Graph API client.
 *
 * Thin wrapper around
 *   GET https://api.semanticscholar.org/graph/v1/paper/<paperId>
 * that requests the standard field set and maps the response into a
 * typed {@link SemanticScholarPaper} shape.
 *
 * Accepts native Semantic Scholar ids as well as prefixed identifiers
 * such as `DOI:10.1145/12345`, `ARXIV:2301.12345`, `CorpusId:12345`,
 * `MAG:123`, `ACL:...`, `PMID:...`, `PMCID:...`, and `URL:https://...`.
 *
 * Docs: https://api.semanticscholar.org/api-docs/graph
 */

// ── Types ────────────────────────────────────────────────────────

export interface SemanticScholarPaper {
  paperId: string;
  title: string;
  abstract?: string;
  year?: number;
  venue?: string;
  authors: { authorId?: string; name: string }[];
  citationCount?: number;
  influentialCitationCount?: number;
  referenceCount?: number;
  openAccessPdfUrl?: string;
  externalIds?: Record<string, string>;
  tldr?: string;
  url?: string;
}

// ── Config ───────────────────────────────────────────────────────

const BASE_URL = "https://api.semanticscholar.org/graph/v1/paper";

const FIELDS = [
  "title",
  "abstract",
  "year",
  "venue",
  "authors",
  "citationCount",
  "influentialCitationCount",
  "referenceCount",
  "openAccessPdf",
  "externalIds",
  "tldr",
  "url",
].join(",");

const USER_AGENT = "ScienceSwarm/1.0 (https://github.com/gikl-ai/scienceswarm)";

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Validate a paper identifier loosely. Must be a non-empty string without
 * path-traversal sequences or whitespace. DOI identifiers legitimately
 * contain `/` (e.g. `DOI:10.1145/12345`), so a bare `/` is allowed but
 * `..` (parent-directory traversal) and leading `/` (absolute path) are
 * rejected along with any whitespace or backslash. Throws on invalid
 * input.
 */
function validatePaperId(paperId: unknown): asserts paperId is string {
  if (typeof paperId !== "string" || paperId.length === 0) {
    throw new Error("Invalid paper identifier");
  }
  if (
    paperId.includes("..") ||
    paperId.startsWith("/") ||
    paperId.includes("\\") ||
    paperId.includes("?") ||
    paperId.includes("#") ||
    paperId.includes("&") ||
    /\s/.test(paperId)
  ) {
    throw new Error("Invalid paper identifier");
  }
}

interface RawAuthor {
  authorId?: string | null;
  name?: string | null;
}

interface RawPaperResponse {
  paperId?: string | null;
  title?: string | null;
  abstract?: string | null;
  year?: number | null;
  venue?: string | null;
  authors?: RawAuthor[] | null;
  citationCount?: number | null;
  influentialCitationCount?: number | null;
  referenceCount?: number | null;
  openAccessPdf?: { url?: string | null } | null;
  externalIds?: Record<string, string> | null;
  tldr?: { text?: string | null } | null;
  url?: string | null;
}

function mapResponse(raw: RawPaperResponse, fallbackId: string): SemanticScholarPaper {
  const authors = (raw.authors ?? []).map((a) => ({
    authorId: a?.authorId ?? undefined,
    name: a?.name ?? "",
  }));

  const paper: SemanticScholarPaper = {
    paperId: raw.paperId ?? fallbackId,
    title: raw.title ?? "",
    authors,
  };

  if (raw.abstract != null) paper.abstract = raw.abstract;
  if (raw.year != null) paper.year = raw.year;
  if (raw.venue != null) paper.venue = raw.venue;
  if (raw.citationCount != null) paper.citationCount = raw.citationCount;
  if (raw.influentialCitationCount != null) {
    paper.influentialCitationCount = raw.influentialCitationCount;
  }
  if (raw.referenceCount != null) paper.referenceCount = raw.referenceCount;
  if (raw.openAccessPdf?.url != null) paper.openAccessPdfUrl = raw.openAccessPdf.url;
  if (raw.externalIds != null) paper.externalIds = raw.externalIds;
  if (raw.tldr?.text != null) paper.tldr = raw.tldr.text;
  if (raw.url != null) paper.url = raw.url;

  return paper;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Fetch a single paper from the Semantic Scholar Graph API.
 *
 * @throws Error("Invalid paper identifier") on bad input.
 * @throws Error("Semantic Scholar paper <id> not found") on 404.
 * @throws Error("Semantic Scholar rate limit hit") on 429.
 * @throws Error("Semantic Scholar request failed: <status>") on other
 *         non-OK responses.
 */
export async function fetchSemanticScholarPaper(
  paperId: string,
): Promise<SemanticScholarPaper> {
  validatePaperId(paperId);

  const url = `${BASE_URL}/${paperId}?fields=${FIELDS}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) {
    throw new Error(`Semantic Scholar paper ${paperId} not found`);
  }
  if (res.status === 429) {
    throw new Error("Semantic Scholar rate limit hit");
  }
  if (!res.ok) {
    throw new Error(`Semantic Scholar request failed: ${res.status}`);
  }

  const raw = (await res.json()) as RawPaperResponse;
  return mapResponse(raw, paperId);
}
