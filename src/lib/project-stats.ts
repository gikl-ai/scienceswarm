import * as fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

/**
 * Shape returned by {@link computeProjectStats}. Stats are intentionally
 * flat + JSON-serialisable so they can be returned directly from an API route.
 */
export interface ProjectStats {
  slug: string;
  folderCounts: {
    papers: number;
    code: number;
    data: number;
    docs: number;
    figures: number;
    config: number;
    other: number;
  };
  byExtension: Record<string, number>;
  totals: {
    files: number;
    directories: number;
    bytes: number;
    words: number;
  };
  lastModified?: string;
  computedAt: string;
}

type FolderBucket = keyof ProjectStats["folderCounts"];

const KNOWN_BUCKETS: readonly FolderBucket[] = [
  "papers",
  "code",
  "data",
  "docs",
  "figures",
  "config",
] as const;

/**
 * Extensions whose contents are word-countable text. Lower-cased, leading dot.
 * Anything not in this set (including binary formats such as .pdf) contributes
 * zero words regardless of file size.
 */
const WORD_COUNT_EXTENSIONS = new Set<string>([
  ".md",
  ".txt",
  ".tex",
  ".py",
  ".js",
  ".ts",
  ".json",
]);

/**
 * Directory / file names that must never be walked. Dotfiles are handled
 * separately via a startsWith(".") check so new hidden names don't need to be
 * explicitly listed here.
 */
const EXCLUDED_NAMES = new Set<string>([
  "node_modules",
  ".claude",
  ".references.json",
]);

function isExcluded(name: string): boolean {
  if (name.startsWith(".")) return true;
  return EXCLUDED_NAMES.has(name);
}

function emptyStats(slug: string): ProjectStats {
  return {
    slug,
    folderCounts: {
      papers: 0,
      code: 0,
      data: 0,
      docs: 0,
      figures: 0,
      config: 0,
      other: 0,
    },
    byExtension: {},
    totals: { files: 0, directories: 0, bytes: 0, words: 0 },
    computedAt: new Date().toISOString(),
  };
}

function classifyBucket(relativePath: string): FolderBucket {
  // Normalise to posix separators so tests/consumers on Windows would still
  // see consistent bucket classification.
  const normalized = relativePath.split(path.sep).join("/");
  const topLevel = normalized.split("/", 1)[0];
  if ((KNOWN_BUCKETS as readonly string[]).includes(topLevel)) {
    return topLevel as FolderBucket;
  }
  return "other";
}

function countWordsIn(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Recursively walk {@link projectRoot} and compute aggregate statistics.
 *
 * Missing roots resolve to an empty-but-well-formed {@link ProjectStats} so
 * callers can render "no activity yet" states without branching on errors.
 */
export async function computeProjectStats(
  projectRoot: string,
  slug: string,
): Promise<ProjectStats> {
  const stats = emptyStats(slug);

  try {
    const rootStat = await fs.stat(projectRoot);
    if (!rootStat.isDirectory()) {
      return stats;
    }
  } catch {
    // Missing project root → return all-zero stats without throwing, as the
    // contract requires.
    return stats;
  }

  let latestMtimeMs = 0;

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (isExcluded(entry.name)) continue;

      const absPath = path.join(absDir, entry.name);
      const relPath = relDir ? path.join(relDir, entry.name) : entry.name;

      if (entry.isDirectory()) {
        stats.totals.directories += 1;
        await walk(absPath, relPath);
        continue;
      }

      if (!entry.isFile()) continue;

      let fileStat: Stats;
      try {
        fileStat = await fs.stat(absPath);
      } catch {
        continue;
      }

      stats.totals.files += 1;
      stats.totals.bytes += fileStat.size;

      if (fileStat.mtimeMs > latestMtimeMs) {
        latestMtimeMs = fileStat.mtimeMs;
      }

      const bucket = classifyBucket(relPath);
      stats.folderCounts[bucket] += 1;

      const ext = path.extname(entry.name).toLowerCase();
      stats.byExtension[ext] = (stats.byExtension[ext] ?? 0) + 1;

      if (WORD_COUNT_EXTENSIONS.has(ext)) {
        try {
          const text = await fs.readFile(absPath, "utf-8");
          stats.totals.words += countWordsIn(text);
        } catch {
          // Unreadable text file — skip silently rather than fail the whole walk.
        }
      }
    }
  }

  await walk(projectRoot, "");

  if (stats.totals.files > 0 && latestMtimeMs > 0) {
    stats.lastModified = new Date(latestMtimeMs).toISOString();
  }

  // Refresh computedAt so callers see the true walk-completion timestamp.
  stats.computedAt = new Date().toISOString();
  return stats;
}
