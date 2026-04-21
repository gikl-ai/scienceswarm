// Thin CrossRef API client for DOI metadata.
//
// CrossRef's public Works API is free and unauthenticated but asks that
// callers identify themselves via a User-Agent header so operators can
// contact us if we start hammering the service. We honour that and also
// bound every request with a 10s abort signal so a stalled upstream can
// never block a route handler indefinitely.
//
// The upstream response is generous with optional fields — almost every
// property may be missing. Treat all extractions as best-effort and fall
// back to sensible defaults rather than throwing.

// Typed errors so callers (e.g. the /api/doi route) can distinguish
// validation failures and upstream misses without string-matching the
// message. Keeping the message text stable is a nice-to-have; the
// class identity is the contract.
export class InvalidDoiError extends Error {
  constructor(message = "Invalid DOI") {
    super(message);
    this.name = "InvalidDoiError";
  }
}

export class DoiNotFoundError extends Error {
  constructor(doi: string) {
    super(`DOI ${doi} not found`);
    this.name = "DoiNotFoundError";
  }
}

export interface DoiMetadata {
  doi: string;
  title: string;
  authors: string[];
  journal?: string;
  publisher?: string;
  year?: string;
  type?: string;
  url?: string;
  issn?: string[];
}

// Loose DOI validation: must start with the "10." registrant prefix, at
// least four digits, a slash, and at least one non-whitespace character
// as the object identifier. This rejects obvious garbage (including a
// bare prefix like "10.1234/") without trying to mirror the full (and
// fuzzy) DOI spec.
const DOI_PATTERN = /^10\.\d{4,}\/\S+$/;

const USER_AGENT = "ScienceSwarm/1.0 (https://github.com/gikl-ai/scienceswarm)";
const CROSSREF_BASE = "https://api.crossref.org/works";
const REQUEST_TIMEOUT_MS = 10_000;

interface CrossRefAuthor {
  given?: string;
  family?: string;
}

interface CrossRefMessage {
  title?: string[];
  author?: CrossRefAuthor[];
  "container-title"?: string[];
  publisher?: string;
  published?: { "date-parts"?: unknown[][] };
  "published-print"?: { "date-parts"?: unknown[][] };
  "published-online"?: { "date-parts"?: unknown[][] };
  issued?: { "date-parts"?: unknown[][] };
  type?: string;
  URL?: string;
  ISSN?: string[];
  DOI?: string;
}

interface CrossRefResponse {
  status?: string;
  message?: CrossRefMessage;
}

export async function fetchDoiMetadata(doi: string): Promise<DoiMetadata> {
  if (!DOI_PATTERN.test(doi)) {
    throw new InvalidDoiError();
  }

  const url = `${CROSSREF_BASE}/${encodeURIComponent(doi)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 404) {
    throw new DoiNotFoundError(doi);
  }
  if (!response.ok) {
    throw new Error(`CrossRef request failed: ${response.status}`);
  }

  const payload = (await response.json()) as CrossRefResponse;
  const message = payload?.message ?? {};

  const title = message.title?.[0] ?? "";

  // An author record where both `given` and `family` are missing would
  // otherwise collapse to an empty string after the trim; drop those so
  // downstream consumers don't have to guard against blank entries.
  const authors =
    message.author
      ?.map((a) => `${a.given ?? ""} ${a.family ?? ""}`.trim())
      .filter((name) => name.length > 0) ?? [];

  const journal = message["container-title"]?.[0] || undefined;
  const publisher = message.publisher || undefined;
  const type = message.type || undefined;
  const resolvedUrl = message.URL || undefined;
  const issn =
    Array.isArray(message.ISSN) && message.ISSN.length > 0 ? [...message.ISSN] : undefined;

  // Year can live in several shapes; prefer `published`, then print/online,
  // then `issued`. Each is `{ "date-parts": [[year, month?, day?]] }`.
  const year = extractYear(message);

  return {
    doi,
    title,
    authors,
    journal,
    publisher,
    year,
    type,
    url: resolvedUrl,
    issn,
  };
}

function extractYear(message: CrossRefMessage): string | undefined {
  const candidates = [
    message.published,
    message["published-print"],
    message["published-online"],
    message.issued,
  ];
  for (const candidate of candidates) {
    const parts = candidate?.["date-parts"];
    if (!parts || parts.length === 0) continue;
    const first = parts[0];
    if (!Array.isArray(first) || first.length === 0) continue;
    const year = first[0];
    if (typeof year === "number" && Number.isFinite(year)) {
      return String(year);
    }
    if (typeof year === "string" && year.length > 0) {
      return year;
    }
  }
  return undefined;
}
