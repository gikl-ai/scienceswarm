// Thin client for the public ArXiv Atom API.
// Docs: https://info.arxiv.org/help/api/user-manual.html
//
// We purposefully do not pull in a dedicated XML parser. The Atom payload we
// care about is small (one <entry> per paper), well-formed, and stable — a
// handful of scoped regexes is cheaper than another dependency and still
// keeps the boundary between "network" and "parser" explicit.

/**
 * Thrown when the supplied id fails the loose format check. The route layer
 * turns this into a 400.
 */
export class ArxivInvalidIdError extends Error {
  constructor(message = "Invalid arXiv id") {
    super(message);
    this.name = "ArxivInvalidIdError";
  }
}

/**
 * Thrown when the Atom feed is well-formed but contains zero entries for the
 * requested id. The route layer turns this into a 404.
 */
export class ArxivNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArxivNotFoundError";
  }
}

/**
 * Thrown for every other upstream failure (non-2xx, network error, parse
 * failure). The route layer turns this into a 502.
 */
export class ArxivUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArxivUpstreamError";
  }
}

export interface ArxivMetadata {
  /** arXiv id, e.g. "2301.12345" or "cs/0101001" (version suffix preserved) */
  id: string;
  title: string;
  /** Author display names, whitespace-trimmed, in document order. */
  authors: string[];
  /** The Atom <summary> field, with internal whitespace collapsed. */
  abstract: string;
  /** Full category terms, e.g. ["cs.AI", "cs.LG"]. */
  categories: string[];
  /** ISO date string (first submission). */
  published: string;
  /** ISO date string (latest revision). */
  updated: string;
  /** Derived PDF URL on arxiv.org. */
  pdfUrl: string;
  /** Canonical abstract page URL on arxiv.org. */
  arxivUrl: string;
}

// Loose format check: supports both the old scheme ("cs/0101001") and the
// post-2007 scheme ("2301.12345" and version suffixes like "2301.12345v2").
// The parent route relies on the thrown error to turn bad input into a 400.
const ARXIV_ID_PATTERN = /^[a-z\-]*\/?[\d.v]+$/i;

// Use HTTPS so the server-to-arXiv hop is encrypted end-to-end. The plain
// http:// endpoint redirects here anyway, and an unencrypted first hop would
// let an on-path attacker inject a forged Atom feed that the parser would
// accept as genuine metadata.
const ARXIV_ENDPOINT = "https://export.arxiv.org/api/query";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Fetch metadata for a single arXiv id from the Atom API.
 *
 * Throws one of the typed errors exported above:
 *   - {@link ArxivInvalidIdError}  — id fails the loose format check
 *   - {@link ArxivNotFoundError}   — upstream returned zero entries
 *   - {@link ArxivUpstreamError}   — upstream returned a non-2xx status
 */
export async function fetchArxivMetadata(id: string): Promise<ArxivMetadata> {
  if (!id || !ARXIV_ID_PATTERN.test(id)) {
    throw new ArxivInvalidIdError();
  }

  const url = `${ARXIV_ENDPOINT}?id_list=${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new ArxivUpstreamError(`ArXiv request failed: ${res.status}`);
  }

  const xml = await res.text();
  const entry = extractFirstEntry(xml);
  if (!entry) {
    throw new ArxivNotFoundError(`ArXiv id ${id} not found`);
  }

  const title = collapseWhitespace(decodeEntities(extractTag(entry, "title") ?? ""));
  const abstract = collapseWhitespace(
    decodeEntities(extractTag(entry, "summary") ?? ""),
  );
  const published = (extractTag(entry, "published") ?? "").trim();
  const updated = (extractTag(entry, "updated") ?? "").trim();
  const authors = extractAllTags(entry, "name")
    .map((name) => collapseWhitespace(decodeEntities(name)))
    .filter(Boolean);
  const categories = extractCategoryTerms(entry);

  return {
    id,
    title,
    authors,
    abstract,
    categories,
    published,
    updated,
    pdfUrl: `https://arxiv.org/pdf/${id}.pdf`,
    arxivUrl: `https://arxiv.org/abs/${id}`,
  };
}

// --- parsing helpers (intentionally private) -------------------------------

function extractFirstEntry(xml: string): string | null {
  const match = xml.match(/<entry[\s>][\s\S]*?<\/entry>/);
  return match ? match[0] : null;
}

function extractTag(scope: string, tag: string): string | null {
  // Matches <tag ...>body</tag> for a single, non-nested element. Atom uses
  // simple leaf elements here (title, summary, published, updated, name),
  // so greediness is not an issue within a single entry.
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const match = scope.match(re);
  return match ? match[1] : null;
}

function extractAllTags(scope: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g");
  const out: string[] = [];
  for (const m of scope.matchAll(re)) {
    out.push(m[1]);
  }
  return out;
}

function extractCategoryTerms(scope: string): string[] {
  // <category term="cs.AI" scheme="..."/> — term can come before or after
  // other attributes, so we search for the attribute directly.
  const re = /<category\b[^>]*\bterm="([^"]+)"/g;
  const out: string[] = [];
  for (const m of scope.matchAll(re)) {
    out.push(m[1]);
  }
  return out;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  // Decode numeric character references first so that e.g. &#x2019; (right
  // single quotation mark) and &#8212; (em-dash) don't appear verbatim in
  // titles/abstracts. ArXiv summaries legitimately use both forms.
  // Named-entity replacement comes after so we don't double-decode &amp;#38;.
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const codePoint = Number.parseInt(dec, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
