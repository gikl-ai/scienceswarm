import { promises as fs } from "node:fs";
import path from "node:path";

export interface PaperCandidate {
  /** Relative path under the scan root. */
  file: string;
  /** From companion .md frontmatter if available, else filename. */
  title?: string;
  /** From companion .md frontmatter if available. */
  doi?: string;
}

export interface DuplicatePair {
  a: string;
  b: string;
  reason: "shared-doi" | "title-similarity";
  /** 1.0 for exact DOI match, else the title similarity in [0, 1]. */
  similarity: number;
}

export interface DedupeResult {
  candidates: PaperCandidate[];
  duplicates: DuplicatePair[];
  scannedAt: string;
}

const PAPER_EXTENSIONS = new Set([".pdf", ".bib", ".tex"]);
const SKIP_DIR_NAMES = new Set(["node_modules", ".claude"]);
const TITLE_SIMILARITY_THRESHOLD = 0.85;

/**
 * Lowercase, strip non-alphanumeric characters to single spaces,
 * trim, and collapse internal whitespace runs.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Jaccard similarity on normalized word sets in [0, 1].
 * If both inputs are empty (after tokenization) returns 0.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/\s+/).filter((t) => t.length > 0));
  const tokensB = new Set(b.split(/\s+/).filter((t) => t.length > 0));
  if (tokensA.size === 0 && tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const unionSize = tokensA.size + tokensB.size - intersection;
  if (unionSize === 0) return 0;
  return intersection / unionSize;
}

interface FrontmatterFields {
  title?: string;
  doi?: string;
}

/**
 * Minimal YAML frontmatter extractor: supports either a fenced block
 * (`---` ... `---`) at the top of the file, or inline `key: value` lines
 * anywhere in the file. Only `title` and `doi` keys are honoured.
 */
function parseFrontmatter(content: string): FrontmatterFields {
  const result: FrontmatterFields = {};
  const lines = content.split(/\r?\n/);
  let block: string[] | null = null;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
    if (end > 0) {
      block = lines.slice(1, end);
    }
  }
  const scan = block ?? lines;
  for (const raw of scan) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/.exec(raw);
    if (!match) continue;
    const key = match[1].toLowerCase();
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "title" && !result.title && value.length > 0) {
      result.title = value;
    } else if (key === "doi" && !result.doi && value.length > 0) {
      result.doi = value;
    }
  }
  return result;
}

async function walkPaperFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!PAPER_EXTENSIONS.has(ext)) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  await walk(root);
  return out;
}

async function buildCandidate(
  absPath: string,
  papersRoot: string,
): Promise<PaperCandidate> {
  const rel = path.relative(papersRoot, absPath);
  const parsed = path.parse(absPath);
  const companionPath = path.join(parsed.dir, `${parsed.name}.md`);
  let title: string | undefined;
  let doi: string | undefined;
  try {
    const content = await fs.readFile(companionPath, "utf-8");
    const fm = parseFrontmatter(content);
    if (fm.title) title = fm.title;
    if (fm.doi) doi = fm.doi;
  } catch {
    // No companion .md; fall through to filename-as-title.
  }
  if (!title) {
    title = parsed.name;
  }
  const candidate: PaperCandidate = { file: rel, title };
  if (doi) candidate.doi = doi;
  return candidate;
}

export function detectDuplicatePaperCandidates(
  candidates: PaperCandidate[],
  scannedAt = new Date().toISOString(),
): DedupeResult {
  const normalizedCandidates = [...candidates].sort((a, b) => (
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0
  ));

  const duplicates: DuplicatePair[] = [];
  for (let i = 0; i < normalizedCandidates.length; i += 1) {
    for (let j = i + 1; j < normalizedCandidates.length; j += 1) {
      const a = normalizedCandidates[i];
      const b = normalizedCandidates[j];
      const doiA = a.doi?.trim().toLowerCase() ?? "";
      const doiB = b.doi?.trim().toLowerCase() ?? "";
      if (doiA.length > 0 && doiB.length > 0 && doiA === doiB) {
        duplicates.push({
          a: a.file,
          b: b.file,
          reason: "shared-doi",
          similarity: 1,
        });
        continue;
      }
      if (doiA.length > 0 && doiB.length > 0 && doiA !== doiB) {
        continue;
      }
      const normA = normalizeTitle(a.title ?? "");
      const normB = normalizeTitle(b.title ?? "");
      const score = titleSimilarity(normA, normB);
      if (score >= TITLE_SIMILARITY_THRESHOLD) {
        duplicates.push({
          a: a.file,
          b: b.file,
          reason: "title-similarity",
          similarity: score,
        });
      }
    }
  }

  return {
    candidates: normalizedCandidates,
    duplicates,
    scannedAt,
  };
}

/**
 * Scan `papersRoot` recursively for .pdf/.bib/.tex files and flag
 * duplicate pairs by shared DOI or normalized-title Jaccard similarity.
 * A missing `papersRoot` returns an empty result instead of throwing.
 */
export async function detectDuplicatePapers(
  papersRoot: string,
): Promise<DedupeResult> {
  const scannedAt = new Date().toISOString();
  let rootStat;
  try {
    rootStat = await fs.stat(papersRoot);
  } catch {
    return { candidates: [], duplicates: [], scannedAt };
  }
  if (!rootStat.isDirectory()) {
    return { candidates: [], duplicates: [], scannedAt };
  }

  const files = await walkPaperFiles(papersRoot);
  const candidates = await Promise.all(files.map((abs) => buildCandidate(abs, papersRoot)));
  return detectDuplicatePaperCandidates(candidates, scannedAt);
}
