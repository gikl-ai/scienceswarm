/**
 * Second Brain — BibTeX / RIS Reference Import
 *
 * Parses .bib and .ris files into ParsedReference[], deduplicates
 * against existing brain paper pages, and creates new wiki pages.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";
import type {
  BrainConfig,
  ParsedReference,
  DeduplicationResult,
  ReferenceImportResult,
} from "./types";
import type { LLMClient } from "./llm";

// ── LaTeX Escapes ─────────────────────────────────────

const LATEX_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\\"\{u\}/g, "\u00fc"], // u-umlaut
  [/\\"\{o\}/g, "\u00f6"], // o-umlaut
  [/\\"\{a\}/g, "\u00e4"], // a-umlaut
  [/\\"\{U\}/g, "\u00dc"],
  [/\\"\{O\}/g, "\u00d6"],
  [/\\"\{A\}/g, "\u00c4"],
  [/\\'e/g, "\u00e9"],     // e-acute
  [/\\'\{e\}/g, "\u00e9"],
  [/\\'a/g, "\u00e1"],
  [/\\'\{a\}/g, "\u00e1"],
  [/\\'i/g, "\u00ed"],
  [/\\'\{i\}/g, "\u00ed"],
  [/\\'o/g, "\u00f3"],
  [/\\'\{o\}/g, "\u00f3"],
  [/\\'u/g, "\u00fa"],
  [/\\'\{u\}/g, "\u00fa"],
  [/\\`e/g, "\u00e8"],
  [/\\`\{e\}/g, "\u00e8"],
  [/\\~n/g, "\u00f1"],
  [/\\~\{n\}/g, "\u00f1"],
  [/\\c\{c\}/g, "\u00e7"], // c-cedilla
  [/\\c c/g, "\u00e7"],
  [/\\v\{s\}/g, "\u0161"], // s-caron
  [/\\v\{z\}/g, "\u017e"], // z-caron
  [/\\ss\b/g, "\u00df"],   // eszett
  [/\\\{/g, "{"],
  [/\\\}/g, "}"],
  [/\\&/g, "&"],
  [/\\%/g, "%"],
  [/\\#/g, "#"],
  [/\\_/g, "_"],
  [/~/g, "\u00a0"],        // non-breaking space
  [/``/g, "\u201c"],       // left double quote
  [/''/g, "\u201d"],       // right double quote
  [/--/g, "\u2013"],       // en-dash
];

function cleanLatex(text: string): string {
  let result = text;
  for (const [pattern, replacement] of LATEX_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  // Remove remaining braces used for grouping
  result = result.replace(/[{}]/g, "");
  return result.trim();
}

// ── BibTeX Parser ─────────────────────────────────────

/**
 * Parse a BibTeX file into an array of ParsedReference.
 * Handles @article, @inproceedings, @misc, @book, @phdthesis, @techreport, etc.
 */
export function parseBibtex(content: string): ParsedReference[] {
  const entries: ParsedReference[] = [];

  // Match each BibTeX entry: @type{key, ... }
  // We need to handle nested braces properly
  const entryStarts = findBibtexEntries(content);

  for (const { type, key, body, raw } of entryStarts) {
    const fields = parseBibtexFields(body);

    const title = cleanLatex(fields.title ?? "");
    if (!title) continue; // skip entries without titles

    const authors = parseBibtexAuthors(fields.author ?? "");
    const year = parseInt(fields.year ?? "0", 10);
    const venue =
      fields.journal ??
      fields.booktitle ??
      fields.publisher ??
      fields.institution ??
      fields.school ??
      "";

    // Extract arXiv ID from eprint, note, or url fields
    let arxiv: string | undefined;
    const eprintField = fields.eprint ?? fields.arxivid ?? "";
    if (eprintField && /^\d{4}\.\d{4,5}(v\d+)?$/.test(eprintField.trim())) {
      arxiv = eprintField.trim();
    }
    if (!arxiv) {
      // Check note/url for arxiv references
      const noteField = `${fields.note ?? ""} ${fields.url ?? ""}`;
      const arxivMatch = noteField.match(/(\d{4}\.\d{4,5})(v\d+)?/);
      if (arxivMatch) {
        arxiv = arxivMatch[1] + (arxivMatch[2] ?? "");
      }
    }

    const doi = fields.doi?.trim();
    const abstract = fields.abstract ? cleanLatex(fields.abstract) : undefined;
    const keywords = fields.keywords
      ? fields.keywords
          .split(/[,;]/)
          .map((k) => cleanLatex(k.trim()))
          .filter(Boolean)
      : [];

    entries.push({
      bibtexKey: key,
      title: cleanLatex(title),
      authors,
      year: Number.isNaN(year) ? 0 : year,
      venue: cleanLatex(venue),
      doi,
      arxiv,
      abstract,
      keywords,
      entryType: type.toLowerCase(),
      rawEntry: raw,
    });
  }

  return entries;
}

interface BibtexRawEntry {
  type: string;
  key: string;
  body: string;
  raw: string;
}

function findBibtexEntries(content: string): BibtexRawEntry[] {
  const results: BibtexRawEntry[] = [];
  // Pattern: @type{key,
  const entryPattern = /@(\w+)\s*\{\s*([^,\s]*)\s*,/g;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(content)) !== null) {
    const type = match[1];
    const key = match[2];
    const bodyStart = match.index + match[0].length;

    // Find the matching closing brace, counting nesting
    let depth = 1;
    let i = bodyStart;
    while (i < content.length && depth > 0) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
      i++;
    }

    if (depth === 0) {
      const body = content.slice(bodyStart, i - 1);
      const raw = content.slice(match.index, i);
      results.push({ type, key, body, raw });
    }
  }

  return results;
}

function parseBibtexFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};

  // Match field = value patterns where value can be {braced} or "quoted" or bare
  const fieldPattern = /(\w+)\s*=\s*/g;
  let match: RegExpExecArray | null;

  while ((match = fieldPattern.exec(body)) !== null) {
    const fieldName = match[1].toLowerCase();
    const valueStart = match.index + match[0].length;
    const value = extractFieldValue(body, valueStart);
    if (value !== null) {
      fields[fieldName] = value;
    }
  }

  return fields;
}

function extractFieldValue(body: string, start: number): string | null {
  let i = start;
  // Skip whitespace
  while (i < body.length && /\s/.test(body[i])) i++;

  if (i >= body.length) return null;

  if (body[i] === "{") {
    // Brace-delimited value
    let depth = 1;
    let j = i + 1;
    while (j < body.length && depth > 0) {
      if (body[j] === "{") depth++;
      else if (body[j] === "}") depth--;
      j++;
    }
    return body.slice(i + 1, j - 1).trim();
  } else if (body[i] === '"') {
    // Quote-delimited value
    let j = i + 1;
    while (j < body.length && body[j] !== '"') {
      if (body[j] === "\\") j++; // skip escaped chars
      j++;
    }
    return body.slice(i + 1, j).trim();
  } else {
    // Bare value (number or string constant)
    let j = i;
    while (j < body.length && body[j] !== "," && body[j] !== "}" && body[j] !== "\n") {
      j++;
    }
    return body.slice(i, j).trim();
  }
}

/**
 * Parse BibTeX author string into individual author names.
 * Handles "Last, First and Last, First" and "First Last and First Last" formats.
 */
export function parseBibtexAuthors(authorField: string): string[] {
  if (!authorField.trim()) return [];

  const cleaned = cleanLatex(authorField);
  // Split on " and " (case-insensitive)
  const parts = cleaned.split(/\s+and\s+/i);

  return parts
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return "";

      // "Last, First" format -> "First Last"
      if (trimmed.includes(",")) {
        const [last, ...rest] = trimmed.split(",").map((s) => s.trim());
        const first = rest.join(" ").trim();
        return first ? `${first} ${last}` : last;
      }

      // Already "First Last" format
      return trimmed;
    })
    .filter(Boolean);
}

// ── RIS Parser ────────────────────────────────────────

/**
 * Parse an RIS file into an array of ParsedReference.
 * Entries delimited by TY - ... ER -
 */
export function parseRIS(content: string): ParsedReference[] {
  const entries: ParsedReference[] = [];
  const lines = content.split(/\r?\n/);

  let currentEntry: Record<string, string[]> = {};
  let inEntry = false;
  let rawLines: string[] = [];

  for (const line of lines) {
    const tagMatch = line.match(/^([A-Z][A-Z0-9])\s{2}-\s?(.*)/);

    if (tagMatch) {
      const [, tag, value] = tagMatch;

      if (tag === "TY") {
        inEntry = true;
        currentEntry = {};
        rawLines = [line];
        pushTag(currentEntry, tag, value.trim());
        continue;
      }

      if (tag === "ER") {
        rawLines.push(line);
        const ref = risEntryToReference(currentEntry, rawLines.join("\n"));
        if (ref) entries.push(ref);
        inEntry = false;
        currentEntry = {};
        rawLines = [];
        continue;
      }

      if (inEntry) {
        rawLines.push(line);
        pushTag(currentEntry, tag, value.trim());
      }
    } else if (inEntry) {
      rawLines.push(line);
    }
  }

  return entries;
}

function pushTag(entry: Record<string, string[]>, tag: string, value: string): void {
  if (!entry[tag]) entry[tag] = [];
  entry[tag].push(value);
}

function risEntryToReference(
  entry: Record<string, string[]>,
  raw: string
): ParsedReference | null {
  // TI or T1 = title
  const title = (entry.TI?.[0] ?? entry.T1?.[0] ?? "").trim();
  if (!title) return null;

  // AU or A1 = authors (one per tag)
  const authors = (entry.AU ?? entry.A1 ?? []).map((a) => {
    const trimmed = a.trim();
    // RIS uses "Last, First" format
    if (trimmed.includes(",")) {
      const [last, ...rest] = trimmed.split(",").map((s) => s.trim());
      const first = rest.join(" ").trim();
      return first ? `${first} ${last}` : last;
    }
    return trimmed;
  });

  // PY or Y1 = year
  const yearStr = entry.PY?.[0] ?? entry.Y1?.[0] ?? "";
  const year = parseInt(yearStr.split("/")[0], 10) || 0;

  // JO, T2, JF = venue
  const venue = (entry.JO?.[0] ?? entry.T2?.[0] ?? entry.JF?.[0] ?? "").trim();

  // DO = DOI
  const doi = entry.DO?.[0]?.trim();

  // AB = abstract
  const abstract = entry.AB?.[0]?.trim();

  // KW = keywords
  const keywords = (entry.KW ?? []).map((k) => k.trim()).filter(Boolean);

  // TY = entry type
  const entryType = (entry.TY?.[0] ?? "GEN").trim().toLowerCase();

  // Check for arXiv in various fields
  let arxiv: string | undefined;
  const allValues = Object.values(entry).flat().join(" ");
  const arxivMatch = allValues.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (arxivMatch) {
    arxiv = arxivMatch[1] + (arxivMatch[2] ?? "");
  }

  return {
    title,
    authors,
    year,
    venue,
    doi,
    arxiv,
    abstract: abstract || undefined,
    keywords,
    entryType: mapRISType(entryType),
    rawEntry: raw,
  };
}

function mapRISType(risType: string): string {
  const map: Record<string, string> = {
    jour: "article",
    jfull: "article",
    abst: "article",
    conf: "inproceedings",
    cpaper: "inproceedings",
    book: "book",
    chap: "incollection",
    thes: "phdthesis",
    rprt: "techreport",
    gen: "misc",
    unpb: "misc",
    elec: "misc",
    web: "misc",
  };
  return map[risType] ?? "misc";
}

// ── Deduplication ─────────────────────────────────────

/**
 * Compute Jaccard similarity on word sets of two strings.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Scan existing paper pages for DOI, arXiv ID, and title.
 * Returns a list of { path, doi, arxiv, title }.
 */
function scanExistingPapers(
  config: BrainConfig
): Array<{ path: string; doi?: string; arxiv?: string; title: string }> {
  const papersDir = join(config.root, "wiki/entities/papers");
  if (!existsSync(papersDir)) return [];

  const results: Array<{ path: string; doi?: string; arxiv?: string; title: string }> = [];
  const files = readdirSync(papersDir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const absPath = join(papersDir, file);
    try {
      const content = readFileSync(absPath, "utf-8");
      const parsed = matter(content);
      const fm = parsed.data;
      results.push({
        path: `wiki/entities/papers/${file}`,
        doi: fm.doi as string | undefined,
        arxiv: fm.arxiv as string | undefined,
        title: (fm.title as string) ?? basename(file, ".md"),
      });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

/**
 * Deduplicate parsed references against existing brain paper pages.
 * Checks: (1) exact DOI match, (2) arXiv ID match, (3) fuzzy title similarity.
 */
export async function deduplicateReferences(
  refs: ParsedReference[],
  config: BrainConfig
): Promise<DeduplicationResult> {
  const existing = scanExistingPapers(config);

  const newRefs: ParsedReference[] = [];
  const matchedRefs: DeduplicationResult["matchedRefs"] = [];

  for (const ref of refs) {
    let matched = false;

    // 1. Exact DOI match
    if (ref.doi) {
      const doiNorm = ref.doi.toLowerCase().trim();
      const doiMatch = existing.find(
        (e) => e.doi && e.doi.toLowerCase().trim() === doiNorm
      );
      if (doiMatch) {
        matchedRefs.push({
          ref,
          existingPath: doiMatch.path,
          matchType: "doi",
        });
        matched = true;
        continue;
      }
    }

    // 2. arXiv ID match
    if (ref.arxiv) {
      const arxivNorm = ref.arxiv.trim();
      const arxivMatch = existing.find(
        (e) => e.arxiv && e.arxiv.trim() === arxivNorm
      );
      if (arxivMatch) {
        matchedRefs.push({
          ref,
          existingPath: arxivMatch.path,
          matchType: "arxiv",
        });
        matched = true;
        continue;
      }
    }

    // 3. Fuzzy title similarity (Jaccard on word sets, threshold 0.8)
    if (!matched) {
      const titleMatch = existing.find(
        (e) => jaccardSimilarity(ref.title, e.title) >= 0.8
      );
      if (titleMatch) {
        matchedRefs.push({
          ref,
          existingPath: titleMatch.path,
          matchType: "title",
        });
        matched = true;
        continue;
      }
    }

    if (!matched) {
      newRefs.push(ref);
    }
  }

  return {
    newRefs,
    matchedRefs,
    stats: {
      total: refs.length,
      new: newRefs.length,
      matched: matchedRefs.length,
    },
  };
}

// ── Import ────────────────────────────────────────────

/**
 * Generate a deterministic paper page slug: {first-author-last}-{year}-{first-3-words}
 */
function generatePaperSlug(ref: ParsedReference): string {
  const firstAuthorLast = (ref.authors[0] ?? "unknown")
    .toLowerCase()
    .split(/\s+/)
    .pop() ?? "unknown";

  const words = ref.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join("-");

  const year = ref.year || new Date().getFullYear();
  return `${firstAuthorLast}-${year}-${words}`;
}

/**
 * Create a wiki page for a parsed reference.
 */
function createPaperPage(config: BrainConfig, ref: ParsedReference): string {
  const slug = generatePaperSlug(ref);
  const papersDir = join(config.root, "wiki/entities/papers");
  mkdirSync(papersDir, { recursive: true });

  const wikiPath = `wiki/entities/papers/${slug}.md`;
  const absPath = join(config.root, wikiPath);

  // Don't overwrite existing file (in case of slug collision)
  if (existsSync(absPath)) {
    // Append a hash suffix
    const suffix = Math.random().toString(36).slice(2, 6);
    const altSlug = `${slug}-${suffix}`;
    const altPath = `wiki/entities/papers/${altSlug}.md`;
    const altAbs = join(config.root, altPath);
    writeFileSync(altAbs, buildPaperMarkdown(ref));
    return altPath;
  }

  writeFileSync(absPath, buildPaperMarkdown(ref));
  return wikiPath;
}

function buildPaperMarkdown(ref: ParsedReference): string {
  const date = new Date().toISOString().slice(0, 10);
  const tags = ref.keywords.length > 0 ? ref.keywords : ["imported"];

  const frontmatter: Record<string, unknown> = {
    title: ref.title,
    date,
    type: "paper",
    para: "resources",
    tags,
    authors: ref.authors,
    year: ref.year,
    venue: ref.venue,
  };

  if (ref.doi) frontmatter.doi = ref.doi;
  if (ref.arxiv) frontmatter.arxiv = ref.arxiv;
  if (ref.bibtexKey) {
    if (!frontmatter.source_refs) frontmatter.source_refs = [];
    (frontmatter.source_refs as Array<{ kind: string; ref: string }>).push({
      kind: "import",
      ref: `bibtex:${ref.bibtexKey}`,
    });
  }

  const bodyParts: string[] = [
    `# ${ref.title}`,
    "",
    `**Authors**: ${ref.authors.join(", ")}`,
    `**Year**: ${ref.year}`,
    ref.venue ? `**Venue**: ${ref.venue}` : "",
    ref.doi ? `**DOI**: ${ref.doi}` : "",
    ref.arxiv ? `**arXiv**: ${ref.arxiv}` : "",
  ].filter(Boolean);

  if (ref.abstract) {
    bodyParts.push("", "## Abstract", "", ref.abstract);
  }

  bodyParts.push("", "## Notes", "", "<!-- Add your notes here -->");

  const body = bodyParts.join("\n");
  return matter.stringify(body, frontmatter);
}

/**
 * Enrich an existing paper page with new metadata from a reference.
 * Adds tags and fills in missing fields.
 */
function enrichExistingPage(
  config: BrainConfig,
  existingPath: string,
  ref: ParsedReference
): boolean {
  const absPath = join(config.root, existingPath);
  if (!existsSync(absPath)) return false;

  const content = readFileSync(absPath, "utf-8");
  const parsed = matter(content);
  let changed = false;

  // Add missing DOI
  if (!parsed.data.doi && ref.doi) {
    parsed.data.doi = ref.doi;
    changed = true;
  }

  // Add missing arXiv
  if (!parsed.data.arxiv && ref.arxiv) {
    parsed.data.arxiv = ref.arxiv;
    changed = true;
  }

  // Merge keywords into tags
  if (ref.keywords.length > 0) {
    const existingTags = new Set((parsed.data.tags as string[]) ?? []);
    for (const kw of ref.keywords) {
      if (!existingTags.has(kw)) {
        existingTags.add(kw);
        changed = true;
      }
    }
    parsed.data.tags = Array.from(existingTags);
  }

  // Add abstract if page body doesn't already have one
  if (ref.abstract && !parsed.content.includes("## Abstract")) {
    parsed.content =
      parsed.content.trimEnd() + "\n\n## Abstract\n\n" + ref.abstract + "\n";
    changed = true;
  }

  if (changed) {
    writeFileSync(absPath, matter.stringify(parsed.content, parsed.data));
  }

  return changed;
}

/**
 * Import parsed references into the brain.
 * Creates paper pages for new refs, optionally enriches matched refs.
 */
export async function importReferences(
  config: BrainConfig,
  _llm: LLMClient,
  refs: ParsedReference[],
  options?: { enrichMatches?: boolean }
): Promise<ReferenceImportResult> {
  const startTime = Date.now();
  const pagesCreated: string[] = [];
  const pagesEnriched: string[] = [];
  let pagesSkipped = 0;
  const errors: Array<{ ref: string; error: string }> = [];

  const dedup = await deduplicateReferences(refs, config);

  // Create pages for new refs
  for (const ref of dedup.newRefs) {
    try {
      const path = createPaperPage(config, ref);
      pagesCreated.push(path);
    } catch (err) {
      errors.push({
        ref: ref.title,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  // Handle matched refs
  for (const { ref, existingPath } of dedup.matchedRefs) {
    if (options?.enrichMatches) {
      try {
        const enriched = enrichExistingPage(config, existingPath, ref);
        if (enriched) {
          pagesEnriched.push(existingPath);
        } else {
          pagesSkipped++;
        }
      } catch (err) {
        errors.push({
          ref: ref.title,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    } else {
      pagesSkipped++;
    }
  }

  return {
    pagesCreated,
    pagesEnriched,
    pagesSkipped,
    errors,
    durationMs: Date.now() - startTime,
  };
}
