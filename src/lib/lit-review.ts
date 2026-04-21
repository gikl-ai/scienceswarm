import * as fs from "node:fs/promises";
import * as path from "node:path";
import matter from "gray-matter";

// ---------------------------------------------------------------------------
// Automatic literature review
//
// Walks a project's papers/ directory, reads companion .md frontmatter for
// each paper file, groups the results (by tag, year bucket, or not at all),
// and summarises via an injectable summariser.
// ---------------------------------------------------------------------------

export interface PaperMetadata {
  /** Relative path from the scanned papersRoot. */
  file: string;
  title: string;
  authors?: string[];
  year?: number;
  abstract?: string;
  tags?: string[];
  doi?: string;
}

export interface LiteratureReviewGroup {
  /** Group heading — a year range, a tag, or "Uncategorized" / "All papers". */
  heading: string;
  papers: PaperMetadata[];
}

export interface LiteratureReview {
  /** The LLM-generated overview. */
  summary: string;
  totalPapers: number;
  groups: LiteratureReviewGroup[];
  groupBy: "tag" | "year" | "none";
  generatedAt: string;
}

/** Injectable summariser — in tests this is replaced with a stub. */
export type Summarizer = (input: {
  papers: PaperMetadata[];
  groups: LiteratureReviewGroup[];
}) => Promise<string>;

export class LiteratureReviewSummarizerRequiredError extends Error {
  constructor() {
    super("Literature review generation requires an injected summarizer when papers are present.");
    this.name = "LiteratureReviewSummarizerRequiredError";
  }
}

const PAPER_EXTENSIONS = new Set([".pdf", ".bib", ".tex"]);
const SKIP_DIR_NAMES = new Set(["node_modules", ".claude"]);
const SKIP_FILE_NAMES = new Set([".references.json"]);

async function directoryExists(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function walkPaperFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function recurse(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".") && !SKIP_FILE_NAMES.has(name)) {
        // Skip dotfiles and dot-directories entirely (dotfiles before the
        // SKIP_FILE_NAMES set check ensures .references.json is never picked
        // up as a paper even if the extension filter ever changes).
        continue;
      }
      if (SKIP_FILE_NAMES.has(name)) continue;

      const abs = path.join(current, name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        await recurse(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(name).toLowerCase();
      if (!PAPER_EXTENSIONS.has(ext)) continue;

      out.push(abs);
    }
  }

  await recurse(root);
  return out;
}

function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim()))
      .filter((v) => v.length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function toYear(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const match = value.match(/\d{4}/);
    if (match) {
      const year = Number.parseInt(match[0], 10);
      if (Number.isFinite(year)) return year;
    }
  }
  return undefined;
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readCompanionMetadata(
  paperAbs: string,
  relFile: string,
): Promise<PaperMetadata> {
  const dir = path.dirname(paperAbs);
  const base = path.basename(paperAbs, path.extname(paperAbs));
  const companion = path.join(dir, `${base}.md`);

  let raw: string | null = null;
  try {
    raw = await fs.readFile(companion, "utf-8");
  } catch {
    raw = null;
  }

  const fallbackTitle = base;

  if (raw === null) {
    return { file: relFile, title: fallbackTitle };
  }

  let parsed;
  try {
    parsed = matter(raw);
  } catch {
    return { file: relFile, title: fallbackTitle };
  }

  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const meta: PaperMetadata = {
    file: relFile,
    title: toOptionalString(data.title) ?? fallbackTitle,
  };

  const authors = toStringArray(data.authors);
  if (authors) meta.authors = authors;

  const year = toYear(data.year);
  if (year !== undefined) meta.year = year;

  const abstract = toOptionalString(data.abstract);
  if (abstract) meta.abstract = abstract;

  const tags = toStringArray(data.tags);
  if (tags) meta.tags = tags;

  const doi = toOptionalString(data.doi);
  if (doi) meta.doi = doi;

  return meta;
}

function yearBucket(year: number): string {
  // Inclusive 5-year buckets aligned on multiples of 5:
  // 2020→"2020–2024", 2023→"2020–2024", 2019→"2015–2019".
  const start = Math.floor(year / 5) * 5;
  const end = start + 4;
  return `${start}\u2013${end}`;
}

function groupPapers(
  papers: PaperMetadata[],
  groupBy: "tag" | "year" | "none",
): LiteratureReviewGroup[] {
  if (groupBy === "none") {
    const sorted = [...papers].sort((a, b) => a.title.localeCompare(b.title));
    return [{ heading: "All papers", papers: sorted }];
  }

  const buckets = new Map<string, PaperMetadata[]>();

  if (groupBy === "tag") {
    for (const paper of papers) {
      const tags = paper.tags && paper.tags.length > 0 ? paper.tags : null;
      if (!tags) {
        const bucket = buckets.get("Uncategorized") ?? [];
        bucket.push(paper);
        buckets.set("Uncategorized", bucket);
        continue;
      }
      for (const tag of new Set(tags)) {
        const bucket = buckets.get(tag) ?? [];
        bucket.push(paper);
        buckets.set(tag, bucket);
      }
    }
  } else {
    // groupBy === "year"
    for (const paper of papers) {
      const heading = paper.year !== undefined ? yearBucket(paper.year) : "Unknown";
      const bucket = buckets.get(heading) ?? [];
      bucket.push(paper);
      buckets.set(heading, bucket);
    }
  }

  const headings = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
  return headings.map((heading) => ({
    heading,
    papers: (buckets.get(heading) ?? []).sort((a, b) => a.title.localeCompare(b.title)),
  }));
}

/**
 * Scans a project's papers/ folder, reads companion .md frontmatter, groups,
 * and summarises the results.
 */
export async function generateLiteratureReview(opts: {
  papersRoot: string;
  groupBy?: "tag" | "year" | "none";
  summarizer?: Summarizer;
}): Promise<LiteratureReview> {
  const groupBy = opts.groupBy ?? "tag";
  const generatedAt = new Date().toISOString();

  if (!(await directoryExists(opts.papersRoot))) {
    return {
      summary: "",
      totalPapers: 0,
      groups: [],
      groupBy,
      generatedAt,
    };
  }

  const absFiles = await walkPaperFiles(opts.papersRoot);
  const papers: PaperMetadata[] = [];
  for (const abs of absFiles) {
    const rel = path.relative(opts.papersRoot, abs);
    const meta = await readCompanionMetadata(abs, rel);
    papers.push(meta);
  }

  const groups = groupPapers(papers, groupBy);
  if (papers.length === 0) {
    return {
      summary: "",
      totalPapers: 0,
      groups,
      groupBy,
      generatedAt,
    };
  }
  if (!opts.summarizer) {
    throw new LiteratureReviewSummarizerRequiredError();
  }
  const summary = await opts.summarizer({ papers, groups });

  return {
    summary,
    totalPapers: papers.length,
    groups,
    groupBy,
    generatedAt,
  };
}
