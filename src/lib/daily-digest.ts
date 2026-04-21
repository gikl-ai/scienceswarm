import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * Per-project daily activity digest.
 *
 * Walks a project directory and classifies files that have been touched
 * inside a rolling window (default 24 hours). Files whose birthtime falls
 * inside the window are treated as newly added when the platform exposes a
 * usable creation timestamp; otherwise in-window files fall back to modified.
 *
 * Missing project roots return an empty digest instead of throwing so
 * callers don't have to pre-check existence.
 */

export interface DigestFile {
  /** Path relative to the project root, using forward slashes. */
  path: string;
  /** Top-level folder bucket: papers / code / data / docs / figures / config / other. */
  bucket: string;
  /** ISO timestamp of the file's mtime. */
  mtime: string;
  /** File size in bytes. */
  size: number;
}

export interface DailyDigest {
  windowHours: number;
  /** ISO timestamp of the cutoff (now − windowHours). */
  since: string;
  /** ISO timestamp of generation. */
  now: string;
  /** Files whose birthtime falls inside the window (treated as new). */
  added: DigestFile[];
  /** Files with mtime inside the window but no in-window birthtime. */
  modified: DigestFile[];
  /** bucket → total count (added + modified). */
  byBucket: Record<string, number>;
  totals: {
    added: number;
    modified: number;
  };
}

// ── Constants ─────────────────────────────────────────────────

const KNOWN_BUCKETS = new Set([
  "papers",
  "code",
  "data",
  "docs",
  "figures",
  "config",
]);

const SKIP_NAMES = new Set(["node_modules", ".claude", ".references.json"]);

// ── Helpers ───────────────────────────────────────────────────

function bucketForRelPath(relPath: string): string {
  const parts = relPath.split(path.sep).filter(Boolean);
  if (parts.length === 0) return "other";
  const top = parts[0].toLowerCase();
  return KNOWN_BUCKETS.has(top) ? top : "other";
}

function shouldSkipEntry(name: string): boolean {
  // Skip dotfiles, node_modules, .claude, and the references manifest.
  if (SKIP_NAMES.has(name)) return true;
  if (name.startsWith(".")) return true;
  return false;
}

async function walk(
  root: string,
  dir: string,
  out: Array<{ fullPath: string; relPath: string }>,
  visitedDirs = new Set<string>(),
  rootRealPath = root,
  displayDir = dir,
): Promise<void> {
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    return;
  }
  if (visitedDirs.has(realDir)) {
    return;
  }
  visitedDirs.add(realDir);

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const displayPath = path.join(displayDir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, out, visitedDirs, rootRealPath, displayPath);
    } else if (entry.isSymbolicLink()) {
      let targetRealPath: string;
      let targetStat: import("node:fs").Stats;
      try {
        targetRealPath = await fs.realpath(fullPath);
        targetStat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (
        targetRealPath !== rootRealPath &&
        !targetRealPath.startsWith(rootRealPath + path.sep)
      ) {
        continue;
      }

      if (targetStat.isDirectory()) {
        await walk(root, fullPath, out, visitedDirs, rootRealPath, displayPath);
      } else if (targetStat.isFile()) {
        const relPath = path.relative(root, displayPath);
        out.push({ fullPath, relPath });
      }
    } else if (entry.isFile()) {
      const relPath = path.relative(root, displayPath);
      out.push({ fullPath, relPath });
    }
  }
}

function hasRecentBirthtime(
  stats: import("node:fs").Stats,
  sinceMs: number,
  nowMs: number,
): boolean {
  return (
    Number.isFinite(stats.birthtimeMs)
    && stats.birthtimeMs > 0
    && stats.birthtimeMs >= sinceMs
    && stats.birthtimeMs <= nowMs
  );
}

// ── Public API ────────────────────────────────────────────────

export async function computeDailyDigest(
  projectRoot: string,
  opts: { windowHours?: number; now?: Date } = {},
): Promise<DailyDigest> {
  const windowHours = opts.windowHours ?? 24;
  const now = opts.now ?? new Date();
  const sinceMs = now.getTime() - windowHours * 3600 * 1000;

  const baseDigest: DailyDigest = {
    windowHours,
    since: new Date(sinceMs).toISOString(),
    now: now.toISOString(),
    added: [],
    modified: [],
    byBucket: {},
    totals: { added: 0, modified: 0 },
  };

  // Missing project root → empty digest, no throw.
  try {
    const stat = await fs.stat(projectRoot);
    if (!stat.isDirectory()) return baseDigest;
  } catch {
    return baseDigest;
  }

  const files: Array<{ fullPath: string; relPath: string }> = [];
  let rootRealPath: string;
  try {
    rootRealPath = await fs.realpath(projectRoot);
  } catch {
    return baseDigest;
  }
  await walk(projectRoot, projectRoot, files, new Set<string>(), rootRealPath);

  const added: DigestFile[] = [];
  const modified: DigestFile[] = [];

  for (const { fullPath, relPath } of files) {
    let s: import("node:fs").Stats;
    try {
      s = await fs.stat(fullPath);
    } catch {
      continue;
    }

    if (s.mtimeMs < sinceMs) continue;

    // Normalize to forward slashes so the output is stable across platforms.
    const entry: DigestFile = {
      path: relPath.split(path.sep).join("/"),
      bucket: bucketForRelPath(relPath),
      mtime: new Date(s.mtimeMs).toISOString(),
      size: s.size,
    };

    if (hasRecentBirthtime(s, sinceMs, now.getTime())) {
      added.push(entry);
    } else {
      modified.push(entry);
    }
  }

  const sortNewestFirst = (a: DigestFile, b: DigestFile): number => {
    const aMs = Date.parse(a.mtime);
    const bMs = Date.parse(b.mtime);
    if (bMs !== aMs) return bMs - aMs;
    return a.path.localeCompare(b.path);
  };

  added.sort(sortNewestFirst);
  modified.sort(sortNewestFirst);

  const byBucket: Record<string, number> = {};
  for (const f of added) byBucket[f.bucket] = (byBucket[f.bucket] ?? 0) + 1;
  for (const f of modified) byBucket[f.bucket] = (byBucket[f.bucket] ?? 0) + 1;

  return {
    windowHours,
    since: baseDigest.since,
    now: baseDigest.now,
    added,
    modified,
    byBucket,
    totals: { added: added.length, modified: modified.length },
  };
}
