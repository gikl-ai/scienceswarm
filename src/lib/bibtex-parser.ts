/**
 * Pure BibTeX parser.
 *
 * Accepts a raw BibTeX string and returns a structured
 * { entries, errors } object. Malformed entries are recorded in
 * `errors` and do not prevent neighbouring well-formed entries from
 * being parsed. The parser does no filesystem or network I/O.
 *
 * Supported entry types: @article, @inproceedings, @book, @misc,
 * @phdthesis, @inbook, @techreport, @unpublished. Unknown entry
 * types are also accepted verbatim — the `type` field will contain
 * whatever lowercase identifier followed the `@` sign.
 *
 * Brace policy: outer wrapping `{}` or `""` on field values is
 * stripped, but nested braces inside the value are preserved
 * verbatim. e.g. `title = {The {TeX}book}` → `"The {TeX}book"`.
 */

export interface BibtexEntry {
  key: string;
  type: string;
  title?: string;
  author?: string;
  authors?: string[];
  year?: string;
  doi?: string;
  journal?: string;
  booktitle?: string;
  pages?: string;
  url?: string;
  publisher?: string;
  fields: Record<string, string>;
}

export interface ParseResult {
  entries: BibtexEntry[];
  errors: string[];
}

/**
 * Strip BibTeX comment lines (lines whose first non-whitespace
 * character is `%`). We intentionally do this line-by-line rather
 * than with a regex over the whole file so that a `%` that happens
 * to appear mid-value is not accidentally treated as a comment.
 */
function stripCommentLines(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => !/^\s*%/.test(line))
    .join("\n");
}

/**
 * Split a multi-author string on the whole-word separator ` and `
 * (case-insensitive). Preserves embedded `and` inside names and
 * inside braced groups.
 */
function splitAuthors(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  const lower = raw.toLowerCase();
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "{") {
      depth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      current += ch;
      i += 1;
      continue;
    }
    // Match " and " only at depth 0, as a whole word with whitespace
    // on both sides.
    if (
      depth === 0 &&
      /\s/.test(ch) &&
      lower.slice(i + 1, i + 4) === "and" &&
      i + 4 < raw.length &&
      /\s/.test(raw[i + 4])
    ) {
      parts.push(current.trim());
      current = "";
      i += 5; // skip " and "
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts.filter((p) => p.length > 0);
}

/**
 * Strip one layer of wrapping `{...}` or `"..."` on a field value.
 * Only strips if the wrapper matches and spans the entire trimmed
 * value; otherwise returns the trimmed value as-is.
 */
function unwrapFieldValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      // Only strip if the outer braces are actually a matched pair
      // spanning the whole string (not just "{a} {b}").
      let depth = 0;
      let matchedAtEnd = true;
      for (let i = 0; i < trimmed.length; i += 1) {
        const ch = trimmed[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0 && i < trimmed.length - 1) {
            matchedAtEnd = false;
            break;
          }
        }
      }
      if (matchedAtEnd) {
        return trimmed.slice(1, -1);
      }
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Read a single entry starting at `start`, which must be pointing at
 * the `@` character. Returns the index just past the closing delimiter
 * of the entry, plus the raw body (between the opening delimiter and
 * matching closing delimiter) and the entry type.
 *
 * BibTeX permits either `{...}` or `(...)` as the outer entry
 * delimiter; both are accepted here. For `{...}` we track nesting so
 * that `title = {The {TeX}book}` remains balanced; for `(...)` the
 * BibTeX spec does not nest parentheses at the entry level — the body
 * runs until the next unnested `)` that is not inside a `{...}` or
 * `"..."` field value — so we still respect brace and quote nesting
 * while scanning for the terminator.
 *
 * Throws on unrecoverable structural errors (no delimiter after the
 * type, or unbalanced delimiters).
 */
function readEntry(
  src: string,
  start: number,
): { next: number; body: string; type: string } {
  // src[start] === "@"
  let i = start + 1;
  // Read type name: letters only.
  const typeStart = i;
  while (i < src.length && /[A-Za-z]/.test(src[i])) {
    i += 1;
  }
  const type = src.slice(typeStart, i).toLowerCase();
  if (type.length === 0) {
    throw new Error("missing entry type after '@'");
  }
  // Skip whitespace.
  while (i < src.length && /\s/.test(src[i])) i += 1;
  const opener = src[i];
  if (opener !== "{" && opener !== "(") {
    throw new Error(`expected '{' or '(' after @${type}`);
  }
  const bodyStart = i + 1;

  if (opener === "{") {
    // Brace-delimited entry: walk until the matching closing brace.
    let depth = 1;
    i += 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      i += 1;
    }
    if (depth !== 0) {
      throw new Error(`unbalanced braces in @${type} entry`);
    }
    // i currently points at the closing `}` of the entry.
    const body = src.slice(bodyStart, i);
    return { next: i + 1, body, type };
  }

  // Paren-delimited entry: walk until the first unnested `)` that is
  // not inside a `{...}` or `"..."` field value. BibTeX does not nest
  // `(...)` at the entry level, so we only track `{}` and `""`.
  let braceDepth = 0;
  let inQuote = false;
  i += 1;
  while (i < src.length) {
    const ch = src[i];
    if (!inQuote) {
      if (ch === "{") braceDepth += 1;
      else if (ch === "}") {
        if (braceDepth === 0) {
          throw new Error(`unbalanced braces in @${type} entry`);
        }
        braceDepth -= 1;
      } else if (ch === '"' && braceDepth === 0) {
        inQuote = true;
      } else if (ch === ")" && braceDepth === 0) {
        break;
      }
    } else if (ch === '"') {
      inQuote = false;
    } else if (ch === "\\") {
      i += 1;
    }
    i += 1;
  }
  if (i >= src.length || src[i] !== ")") {
    throw new Error(`unbalanced parentheses in @${type} entry`);
  }
  const body = src.slice(bodyStart, i);
  return { next: i + 1, body, type };
}

/**
 * Parse the body of an entry (the text between the outer braces)
 * into a citation key and a verbatim field map. The body looks like:
 *   key, field1 = {value}, field2 = "value", field3 = bareword
 */
function parseEntryBody(
  body: string,
  type: string,
): { key: string; fields: Record<string, string> } {
  // First token up to the first comma at depth 0 is the citation key.
  let i = 0;
  while (i < body.length && /\s/.test(body[i])) i += 1;
  const keyStart = i;
  while (i < body.length && body[i] !== ",") i += 1;
  if (i >= body.length) {
    throw new Error(`@${type}: missing comma after citation key`);
  }
  const key = body.slice(keyStart, i).trim();
  if (key.length === 0) {
    throw new Error(`@${type}: empty citation key`);
  }
  i += 1; // skip the comma.

  const fields: Record<string, string> = {};

  while (i < body.length) {
    // Skip leading whitespace / stray commas.
    while (i < body.length && /[\s,]/.test(body[i])) i += 1;
    if (i >= body.length) break;

    // Read field name.
    const nameStart = i;
    while (i < body.length && /[A-Za-z0-9_-]/.test(body[i])) i += 1;
    const name = body.slice(nameStart, i).toLowerCase();
    if (name.length === 0) {
      // Nothing left that looks like a field; trailing garbage is
      // tolerated rather than errored.
      break;
    }
    // Skip whitespace then expect `=`.
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (body[i] !== "=") {
      throw new Error(`@${type}: expected '=' after field '${name}'`);
    }
    i += 1;
    while (i < body.length && /\s/.test(body[i])) i += 1;

    // Read the value: braced, quoted, or bare.
    let value = "";
    if (body[i] === "{") {
      let depth = 1;
      const start = i;
      i += 1;
      while (i < body.length && depth > 0) {
        const ch = body[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        i += 1;
      }
      if (depth !== 0) {
        throw new Error(`@${type}: unbalanced braces in field '${name}'`);
      }
      value = body.slice(start, i + 1);
      i += 1; // consume closing brace
    } else if (body[i] === '"') {
      const start = i;
      i += 1;
      while (i < body.length) {
        if (body[i] === "\\") {
          i += 2;
          continue;
        }
        if (body[i] === '"') {
          break;
        }
        i += 1;
      }
      if (body[i] !== '"') {
        throw new Error(`@${type}: unterminated quoted value in field '${name}'`);
      }
      value = body.slice(start, i + 1);
      i += 1; // consume closing quote
    } else {
      const start = i;
      while (i < body.length && body[i] !== "," && body[i] !== "\n") i += 1;
      value = body.slice(start, i);
    }

    fields[name] = unwrapFieldValue(value);
  }

  return { key, fields };
}

/**
 * Build a `BibtexEntry` from a raw type + key + field map. Promotes
 * common fields (title, author, year, doi, journal, booktitle, pages,
 * url, publisher) into typed properties, and derives `authors[]`.
 */
function buildEntry(
  type: string,
  key: string,
  fields: Record<string, string>,
): BibtexEntry {
  const entry: BibtexEntry = {
    key,
    type,
    fields,
  };

  if (fields.title !== undefined) entry.title = fields.title;
  if (fields.author !== undefined) {
    entry.author = fields.author;
    entry.authors = splitAuthors(fields.author);
  }
  if (fields.year !== undefined) entry.year = fields.year;
  if (fields.doi !== undefined) entry.doi = fields.doi;
  if (fields.journal !== undefined) entry.journal = fields.journal;
  if (fields.booktitle !== undefined) entry.booktitle = fields.booktitle;
  if (fields.pages !== undefined) entry.pages = fields.pages;
  if (fields.url !== undefined) entry.url = fields.url;
  if (fields.publisher !== undefined) entry.publisher = fields.publisher;

  return entry;
}

export function parseBibtex(input: string): ParseResult {
  const entries: BibtexEntry[] = [];
  const errors: string[] = [];

  if (!input || input.trim().length === 0) {
    return { entries, errors };
  }

  const src = stripCommentLines(input);
  let i = 0;

  while (i < src.length) {
    // Advance to the next '@'.
    const at = src.indexOf("@", i);
    if (at === -1) break;

    // `next` is updated inside the try once readEntry has successfully
    // located the end of the entry. If readEntry itself throws, it stays
    // at `at + 1` so the next iteration advances past the current `@`.
    let next = at + 1;
    try {
      const result = readEntry(src, at);
      next = result.next;
      const { body, type } = result;
      // Skip pseudo-entries like @string / @preamble / @comment —
      // they are not citations and have no key/field structure.
      if (
        type === "string" ||
        type === "preamble" ||
        type === "comment"
      ) {
        i = next;
        continue;
      }
      const { key, fields } = parseEntryBody(body, type);
      entries.push(buildEntry(type, key, fields));
      i = next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      // If readEntry already located the end of the entry, skip to it
      // so we don't rescan inside a body that may contain `@` characters
      // (e.g. `url = {mailto:foo@bar.com}`). If readEntry itself threw,
      // `next` is still at + 1 — just past the offending `@`.
      i = next;
    }
  }

  return { entries, errors };
}
