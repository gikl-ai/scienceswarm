/**
 * Coldstart Scanner
 *
 * Walks directories and enumerates candidate files. Computes content hashes,
 * extracts titles, and pulls keywords. Pure read-side logic — no writes,
 * no classification decisions, no LLM calls.
 *
 * Owned by the coldstart split introduced during the gbrain pivot.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join } from "path";
import { createHash } from "crypto";
import type { ContentType } from "../types";

// ── Constants ─────────────────────────────────────────

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
export const CONTENT_HASH_BYTES = 8192; // Read first 8KB for hashing

export const SCIENCE_EXTENSIONS: Record<string, ContentType> = {
  ".pdf": "paper",
  ".md": "note",
  ".txt": "note",
  ".ipynb": "experiment",
  ".csv": "data",
  ".json": "data",
  ".parquet": "data",
  ".tsv": "data",
  ".py": "data",
  ".r": "data",
  ".jl": "data",
  ".pptx": "note",
  ".docx": "note",
  ".tex": "paper",
  ".bib": "paper",
  ".rmd": "experiment",
};

export const STOP_WORDS = new Set([
  "about", "above", "after", "again", "against", "would", "could", "should",
  "being", "between", "both", "before", "below", "doing", "during", "each",
  "every", "further", "having", "itself", "other", "those", "these", "their",
  "there", "under", "until", "where", "which", "while", "would", "through",
  "import", "export", "function", "return", "const", "class", "define",
  "print", "false", "right", "number", "string", "value",
]);

// ── Directory walking ─────────────────────────────────

/**
 * Recursively walk a directory invoking `callback` for every file.
 * Skips dotfiles, node_modules, __pycache__, and inaccessible entries.
 */
export function walkDirectory(dir: string, callback: (path: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules" || entry === "__pycache__") continue;
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walkDirectory(fullPath, callback);
      } else {
        callback(fullPath);
      }
    } catch {
      // Skip inaccessible files
    }
  }
}

// ── Hashing & title extraction ────────────────────────

/**
 * Hash the first `CONTENT_HASH_BYTES` of a file. Used for duplicate detection.
 */
export function hashFileHead(filePath: string): string {
  try {
    const fd = readFileSync(filePath);
    const chunk = fd.subarray(0, CONTENT_HASH_BYTES);
    return createHash("sha256").update(chunk).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

/**
 * Extract a heuristic title for a file (filename or markdown H1).
 */
export function extractFileTitle(filePath: string, ext: string): string | null {
  if (ext === ".pdf") {
    // Use filename as proxy for title
    const name = basename(filePath, ext);
    return name.replace(/[-_]/g, " ").trim();
  }
  if (ext === ".md" || ext === ".txt") {
    try {
      const content = readFileSync(filePath, "utf-8").slice(0, 2000);
      const match = content.match(/^#\s+(.+)$/m);
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
  }
  return basename(filePath, ext).replace(/[-_]/g, " ").trim();
}

/**
 * Normalize a title for fuzzy comparison.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Keyword extraction ────────────────────────────────

/**
 * Extract keywords from a file's path segments and (for text files) content.
 */
export function extractKeywords(filePath: string, ext: string): string[] {
  const keywords: string[] = [];

  // Extract from path segments
  const parts = filePath.split("/").filter(Boolean);
  for (const part of parts.slice(-3)) {
    const cleaned = part.replace(extname(part), "").toLowerCase();
    const words = cleaned.split(/[-_\s]+/).filter((w) => w.length > 3);
    keywords.push(...words);
  }

  // Extract from content for text files
  if ([".md", ".txt", ".tex", ".py", ".r", ".jl"].includes(ext)) {
    try {
      const content = readFileSync(filePath, "utf-8").slice(0, 5000).toLowerCase();
      const words = content
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 4 && !STOP_WORDS.has(w));
      // Take top unique words by frequency
      const freq = new Map<string, number>();
      for (const w of words) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
      const sorted = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      keywords.push(...sorted.map(([w]) => w));
    } catch {
      // Skip unreadable files
    }
  }

  return [...new Set(keywords)];
}
