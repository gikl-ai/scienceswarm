/**
 * Pure .bbl parser.
 *
 * Accepts a raw .bbl-format string (the compiled bibliography that
 * BibTeX/biber produces from a .bib database, embedded in or shipped
 * alongside an arXiv LaTeX source tarball) and returns a structured
 * { entries, errors } object. Malformed entries are recorded in
 * `errors` and do not prevent neighbouring well-formed entries from
 * being parsed. The parser does no filesystem or network I/O.
 *
 * Why prefer .bbl over .bib for arXiv-source ingestion: a .bib file
 * is the *database* the author maintained (often shared across many
 * papers; can be hundreds of MB for community templates). The .bbl
 * is the *post-citation* output — exactly what the paper cited, with
 * BibTeX's resolution and formatting already applied. For the
 * Paper Library graph we care about which references the paper used,
 * not which references the author had on hand, so .bbl is the
 * canonical source.
 *
 * The .bbl format is style-dependent (plain.bst, abbrv.bst,
 * acl_natbib.bst, neurips.bst, biblatex variants, ...) but the
 * skeleton is consistent across the common natbib/biblatex styles:
 *
 *   \begin{thebibliography}{<widest-label>}
 *   \bibitem[<short label>]{<citation key>}
 *   <author line>
 *   \newblock <title>.
 *   \newblock <venue>, <pages>, <year>.
 *   \newblock <urls, dois>
 *
 *   \bibitem[<short label>]{<citation key>}
 *   ...
 *   \end{thebibliography}
 *
 * Some styles put the title in `\emph{...}` and the venue plain;
 * others do the opposite. We prefer the `\newblock`-segment split
 * because it is consistent across more styles, and fall back to
 * `\emph{}` when there are fewer than two `\newblock` segments in
 * an entry. Identifiers (DOI, arXiv ID, PMID) are extracted via
 * regex search across the whole entry text.
 */

export interface BblEntry {
  /** The citation key as it appears in `\bibitem{<key>}`. */
  key: string;
  /** Best-effort title extracted from the `\newblock` segments. */
  title?: string;
  /** Best-effort author list. */
  authors: string[];
  /** Year as a number when one was found. */
  year?: number;
  /** Venue (journal, booktitle, publisher) when distinguishable. */
  venue?: string;
  /** DOI without the `https://doi.org/` prefix. */
  doi?: string;
  /** arXiv identifier in `YYMM.NNNNN` form (no `arXiv:` prefix). */
  arxiv?: string;
  /** PubMed ID. */
  pmid?: string;
  /** Verbatim entry block (everything between `\bibitem{...}` and the
   * next `\bibitem` or `\end{thebibliography}`), trimmed. Useful as a
   * fallback when the heuristic title/author split is wrong. */
  rawEntry: string;
}

export interface ParseResult {
  entries: BblEntry[];
  errors: string[];
}

const ARXIV_RE =
  /(?:arxiv\s*[:/]?\s*|abs\/|arxiv\.org\/abs\/)\s*(\d{4}\.\d{4,5})/i;
const DOI_RE =
  /\b(?:doi[:\s]*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d+\/[^\s,;]+)/i;
const PMID_RE = /\bPMID\s*:?\s*(\d{6,9})\b/i;
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/;
const PAREN_YEAR_RE = /\((\d{4})/;
const BIBITEM_HEAD_RE =
  /\\bibitem(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g;

/**
 * Extract an arXiv ID from `value` if one is present.
 * Tolerates `arXiv:1234.56789`, `abs/1234.56789`, and bare ids
 * inside `\url{}`. Returns the bare numeric id with no prefix.
 */
function findArxiv(value: string): string | undefined {
  return value.match(ARXIV_RE)?.[1];
}

function findDoi(value: string): string | undefined {
  const raw = value.match(DOI_RE)?.[1];
  if (!raw) return undefined;
  // The DOI regex tolerates broad characters; trim a trailing period
  // that is almost always sentence punctuation, not part of the DOI.
  return raw.replace(/[.,;]$/, "");
}

function findPmid(value: string): string | undefined {
  return value.match(PMID_RE)?.[1];
}

function findYear(value: string): number | undefined {
  // Prefer a year inside parentheses (typical natbib short-label
  // style); otherwise take the first standalone 4-digit year that
  // looks like a publication year.
  const paren = value.match(PAREN_YEAR_RE)?.[1];
  if (paren) {
    const year = Number(paren);
    if (Number.isInteger(year) && year >= 1500 && year <= 3000) return year;
  }
  const any = value.match(YEAR_RE)?.[1];
  if (any) {
    const year = Number(any);
    if (Number.isInteger(year) && year >= 1500 && year <= 3000) return year;
  }
  return undefined;
}

/**
 * Strip common LaTeX wrappers from a single field value.
 * Handles `\emph{x}`, `\textit{x}`, `\textbf{x}`, `\url{x}`,
 * `\href{url}{text}`, escaped `\&` and `\#`, and tilde-as-NBSP.
 * Leaves nested unbalanced macros alone.
 */
function stripLatex(text: string): string {
  if (!text) return "";
  return text
    .replace(/\\(?:emph|textit|textbf|textsc|texttt|mathrm)\{([^{}]*)\}/g, "$1")
    .replace(/\\url\{([^{}]*)\}/g, "$1")
    .replace(/\\href\{[^{}]*\}\{([^{}]*)\}/g, "$1")
    .replace(/~/g, " ")
    .replace(/\\&/g, "&")
    .replace(/\\\$/g, "$")
    .replace(/\{([^{}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+\b\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a `\newblock`-delimited entry body into its segments. The
 * leading segment (before the first `\newblock`) is the author line
 * in the natbib/plain conventions. Empty segments are dropped.
 */
function splitNewblocks(block: string): string[] {
  return block
    .split(/\\newblock/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Heuristic author splitter. Treats `" and "` and `, ` as equivalent
 * separators after first replacing the former with the latter. The
 * result is filtered to drop bare `et al.` markers and empty strings.
 */
function splitAuthors(line: string): string[] {
  const cleaned = stripLatex(line).replace(/\.$/, "").trim();
  if (!cleaned) return [];
  // `, and ` and `, & ` are a single comma-and separator; collapse to
  // `, ` first so the comma split below doesn't leave a trailing one.
  const normalized = cleaned
    .replace(/,\s+(?:and|&)\s+/gi, ", ")
    .replace(/\s+(?:and|&)\s+/gi, ", ");
  return normalized
    .split(/,\s+/)
    .map((author) => author.replace(/[,]$/, "").trim())
    .filter((author) => {
      if (!author) return false;
      const lower = author.toLowerCase();
      return lower !== "et~al" && lower !== "et al." && lower !== "et al";
    });
}

/**
 * Pull a best-effort title and venue from the `\newblock` segments.
 * Convention: `parts[0]` is authors, `parts[1]` is the title, and
 * `parts[2..]` typically contain the venue followed by pages/year.
 *
 * Some `.bst` styles wrap the title in `\emph{...}` rather than a
 * `\newblock`; in that case we fall back to whatever the first
 * `\emph` returns.
 */
function extractTitleAndVenue(
  block: string,
  segments: string[],
): { title?: string; venue?: string } {
  let title: string | undefined;
  let venue: string | undefined;

  if (segments.length >= 2) {
    // Title block, with trailing year/period stripping.
    const rawTitle = segments[1].replace(/,?\s*\d{4}\.?\s*$/, "").trim();
    const cleanedTitle = stripLatex(rawTitle).replace(/\.$/, "").trim();
    if (cleanedTitle) title = cleanedTitle;

    if (segments.length >= 3) {
      const venueBlock = segments[2];
      const emphMatch = venueBlock.match(
        /\\emph\{([^{}]+(?:\{[^{}]*\}[^{}]*)*)\}/,
      );
      const venueRaw = emphMatch ? emphMatch[1] : venueBlock;
      const cleanedVenue = stripLatex(venueRaw).replace(/[,.]+$/, "").trim();
      if (cleanedVenue) venue = cleanedVenue;
    }
  } else {
    // No clean newblock structure (rare). Try \emph{...} for title.
    const emphMatch = block.match(/\\emph\{([^{}]+(?:\{[^{}]*\}[^{}]*)*)\}/);
    if (emphMatch) {
      const cleaned = stripLatex(emphMatch[1]).replace(/\.$/, "").trim();
      if (cleaned) title = cleaned;
    }
  }

  return { title, venue };
}

/**
 * Parse a single `\bibitem{key}` block into a normalized entry.
 * Returns null when the block has no extractable signal (no title,
 * no identifier, no authors).
 */
function parseEntry(key: string, block: string): BblEntry | null {
  const rawEntry = block.trim();
  if (!rawEntry) return null;

  const arxiv = findArxiv(rawEntry);
  const doi = findDoi(rawEntry);
  const pmid = findPmid(rawEntry);
  const year = findYear(rawEntry);

  const segments = splitNewblocks(rawEntry);
  const authorLine = segments[0] ?? "";
  const authors = splitAuthors(authorLine);
  const { title, venue } = extractTitleAndVenue(rawEntry, segments);

  if (!title && !arxiv && !doi && !pmid && authors.length === 0) {
    return null;
  }

  return {
    key,
    title,
    authors,
    year,
    venue,
    doi,
    arxiv,
    pmid,
    rawEntry,
  };
}

/**
 * Parse a .bbl-format string into normalized entries.
 *
 * Iterates `\bibitem` declarations and slices each entry's body
 * between successive `\bibitem` markers (or up to
 * `\end{thebibliography}` for the final entry). Each block is fed
 * through `parseEntry`; unrecoverable per-entry failures are
 * collected into `errors` so that a malformed entry does not kill
 * the rest of the parse.
 */
export function parseBbl(input: string): ParseResult {
  const entries: BblEntry[] = [];
  const errors: string[] = [];

  // Find all \bibitem header positions first, then carve bodies
  // between consecutive header starts.
  const heads: Array<{ key: string; bodyStart: number; bodyHeadStart: number }> = [];
  for (const match of input.matchAll(BIBITEM_HEAD_RE)) {
    if (match.index === undefined) continue;
    heads.push({
      key: match[1].trim(),
      bodyStart: match.index + match[0].length,
      bodyHeadStart: match.index,
    });
  }

  if (heads.length === 0) {
    return { entries, errors };
  }

  // Find the bibliography end marker so the final entry has a clean
  // upper bound; default to end-of-input if no marker is present.
  const endMarker = input.indexOf("\\end{thebibliography}");
  const endIdx = endMarker === -1 ? input.length : endMarker;

  for (let i = 0; i < heads.length; i += 1) {
    const head = heads[i];
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].bodyHeadStart : endIdx;
    const block = input.slice(head.bodyStart, bodyEnd);

    try {
      const parsed = parseEntry(head.key, block);
      if (parsed) entries.push(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`bibitem '${head.key}': ${message}`);
    }
  }

  return { entries, errors };
}
