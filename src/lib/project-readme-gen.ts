import * as fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

/**
 * Input to {@link generateProjectReadme}. `projectRoot` is the absolute path
 * to the project's on-disk folder (typically
 * `~/.scienceswarm/projects/<slug>/`). `title` and `description` are optional
 * overrides — when omitted the generator derives a title from the slug.
 */
export interface ProjectReadmeInput {
  slug: string;
  title?: string;
  description?: string;
  projectRoot: string;
}

/**
 * Shape returned by {@link generateProjectReadme}. `readme` is the fully
 * assembled markdown string; `sections` exposes each component individually
 * so API callers (or tests) can inspect or re-render parts without re-walking
 * the filesystem. `fileCounts` is a keyed bucket-count map (same ordering as
 * `BUCKET_ORDER`) intended for lightweight UI rendering.
 */
export interface ProjectReadmeResult {
  readme: string;
  sections: {
    header: string;
    overview: string;
    files: string;
    lastActivity: string;
  };
  fileCounts: Record<string, number>;
}

/** Stable ordering used for overview rendering and `fileCounts` key order. */
const BUCKET_ORDER = [
  "papers",
  "code",
  "data",
  "docs",
  "figures",
  "config",
  "other",
] as const;

type Bucket = (typeof BUCKET_ORDER)[number];
const KNOWN_BUCKETS: ReadonlySet<string> = new Set(BUCKET_ORDER.slice(0, -1));

function isExcluded(name: string): boolean {
  if (name.startsWith(".")) return true;
  return false;
}

function sanitizeMarkdownParagraph(value?: string): string | undefined {
  const trimmed = value?.replace(/[\r\n]+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
    .join(" ");
}

function classifyBucket(relativePath: string): Bucket {
  const normalized = relativePath.split(path.sep).join("/");
  const topLevel = normalized.split("/", 1)[0];
  if (KNOWN_BUCKETS.has(topLevel)) {
    return topLevel as Bucket;
  }
  return "other";
}

interface ScannedFile {
  relPath: string;
  mtimeMs: number;
}

function emptyFileCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bucket of BUCKET_ORDER) {
    counts[bucket] = 0;
  }
  return counts;
}

async function walkProject(projectRoot: string): Promise<{
  files: ScannedFile[];
  fileCounts: Record<string, number>;
}> {
  const fileCounts = emptyFileCounts();
  const files: ScannedFile[] = [];

  try {
    const rootStat = await fs.stat(projectRoot);
    if (!rootStat.isDirectory()) {
      return { files, fileCounts };
    }
  } catch {
    return { files, fileCounts };
  }

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

      const bucket = classifyBucket(relPath);
      fileCounts[bucket] += 1;
      files.push({
        relPath: relPath.split(path.sep).join("/"),
        mtimeMs: fileStat.mtimeMs,
      });
    }
  }

  await walk(projectRoot, "");
  return { files, fileCounts };
}

function renderHeader(title: string, description?: string): string {
  const trimmed = description?.trim();
  if (trimmed) {
    return `# ${title}\n\n${trimmed}\n`;
  }
  return `# ${title}\n`;
}

function renderOverview(
  fileCounts: Record<string, number>,
  description?: string,
): string {
  const rows = BUCKET_ORDER.filter((bucket) => (fileCounts[bucket] ?? 0) > 0).map(
    (bucket) => ({ bucket, count: fileCounts[bucket] ?? 0 }),
  );

  const lines: string[] = ["## Overview"];
  const trimmedDescription = description?.trim();
  if (trimmedDescription) {
    lines.push("", trimmedDescription);
  }

  if (rows.length === 0) {
    lines.push("", "_No files yet._");
    return lines.join("\n");
  }

  lines.push("", "| Folder | Files |", "| --- | --- |");
  for (const { bucket, count } of rows) {
    lines.push(`| ${bucket} | ${count} |`);
  }
  return lines.join("\n");
}

function renderFiles(files: ScannedFile[]): string {
  const lines: string[] = ["## Recent Files"];
  if (files.length === 0) {
    lines.push("", "_No files yet._");
    return lines.join("\n");
  }

  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5);
  lines.push("");
  for (const file of sorted) {
    const iso = new Date(file.mtimeMs).toISOString();
    lines.push(`- ${file.relPath} (${iso})`);
  }
  return lines.join("\n");
}

function renderLastActivity(files: ScannedFile[]): string {
  const lines: string[] = ["## Last Activity"];
  if (files.length === 0) {
    lines.push("", "_No activity yet._");
    return lines.join("\n");
  }
  const latest = files.reduce(
    (max, file) => (file.mtimeMs > max ? file.mtimeMs : max),
    0,
  );
  if (latest <= 0) {
    lines.push("", "_No activity yet._");
    return lines.join("\n");
  }
  lines.push("", new Date(latest).toISOString());
  return lines.join("\n");
}

/**
 * Render a standard auto-generated README for a project folder.
 *
 * Missing `projectRoot` paths resolve to an empty-but-well-formed README so
 * callers can render "no files yet" states without branching on errors.
 */
export async function generateProjectReadme(
  input: ProjectReadmeInput,
): Promise<ProjectReadmeResult> {
  const title = sanitizeMarkdownParagraph(input.title) || humanizeSlug(input.slug);
  const description = sanitizeMarkdownParagraph(input.description);
  const { files, fileCounts } = await walkProject(input.projectRoot);

  const sections = {
    header: renderHeader(title, description),
    overview: renderOverview(fileCounts, description),
    files: renderFiles(files),
    lastActivity: renderLastActivity(files),
  };

  const readme =
    [sections.header, sections.overview, sections.files, sections.lastActivity]
      .join("\n\n") + "\n";

  return { readme, sections, fileCounts };
}
