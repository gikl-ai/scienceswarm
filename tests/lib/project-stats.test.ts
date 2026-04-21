import path from "node:path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeProjectStats } from "@/lib/project-stats";

const ROOT = path.join(tmpdir(), "scienceswarm-project-stats-lib");

function seed(rel: string, contents: string | Buffer = ""): string {
  const absPath = path.join(ROOT, rel);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents);
  return absPath;
}

function slugRoot(slug: string): string {
  return path.join(ROOT, slug);
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("computeProjectStats", () => {
  it("classifies folder counts from top-level directory names", async () => {
    const slug = "project-alpha-1";
    seed(`${slug}/papers/one.pdf`, "%PDF-1.4");
    seed(`${slug}/papers/two.pdf`, "%PDF-1.4");
    seed(`${slug}/papers/three.pdf`, "%PDF-1.4");
    seed(`${slug}/code/main.py`, "print('hi')");
    seed(`${slug}/code/util.ts`, "export const x = 1;");
    seed(`${slug}/data/points.csv`, "a,b\n1,2");

    const stats = await computeProjectStats(slugRoot(slug), slug);

    expect(stats.slug).toBe(slug);
    expect(stats.folderCounts.papers).toBe(3);
    expect(stats.folderCounts.code).toBe(2);
    expect(stats.folderCounts.data).toBe(1);
    expect(stats.folderCounts.docs).toBe(0);
    expect(stats.folderCounts.figures).toBe(0);
    expect(stats.folderCounts.config).toBe(0);
    expect(stats.folderCounts.other).toBe(0);
    expect(stats.totals.files).toBe(6);
  });

  it("groups byExtension with lowercase keys including the dot", async () => {
    const slug = "ext-check";
    seed(`${slug}/papers/One.PDF`, "%PDF-1.4");
    seed(`${slug}/papers/two.pdf`, "%PDF-1.4");
    seed(`${slug}/code/a.PY`, "print('a')");
    seed(`${slug}/code/b.py`, "print('b')");
    seed(`${slug}/docs/notes.md`, "hello world");
    seed(`${slug}/README`, "no ext file");

    const stats = await computeProjectStats(slugRoot(slug), slug);

    expect(stats.byExtension[".pdf"]).toBe(2);
    expect(stats.byExtension[".py"]).toBe(2);
    expect(stats.byExtension[".md"]).toBe(1);
    expect(stats.byExtension[""]).toBe(1);
    // Keys must all be lowercase.
    for (const key of Object.keys(stats.byExtension)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("sums file sizes into totals.bytes", async () => {
    const slug = "size-check";
    seed(`${slug}/data/a.bin`, Buffer.alloc(100));
    seed(`${slug}/data/b.bin`, Buffer.alloc(250));
    seed(`${slug}/code/c.py`, "x"); // 1 byte

    const stats = await computeProjectStats(slugRoot(slug), slug);
    expect(stats.totals.bytes).toBe(351);
  });

  it("counts exactly 100 words for a 100-word .md file", async () => {
    const slug = "word-check";
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    seed(`${slug}/docs/hundred.md`, words);

    const stats = await computeProjectStats(slugRoot(slug), slug);
    expect(stats.totals.words).toBe(100);
  });

  it("does not count .pdf files toward totals.words", async () => {
    const slug = "pdf-words";
    // Content that would otherwise parse to 4 words if treated as text.
    seed(`${slug}/papers/paper.pdf`, "one two three four");
    seed(`${slug}/docs/note.md`, "alpha beta");

    const stats = await computeProjectStats(slugRoot(slug), slug);
    // Only the .md words should be counted.
    expect(stats.totals.words).toBe(2);
  });

  it("returns all-zero stats for an empty project directory", async () => {
    const slug = "empty";
    mkdirSync(slugRoot(slug), { recursive: true });

    const stats = await computeProjectStats(slugRoot(slug), slug);
    expect(stats.totals.files).toBe(0);
    expect(stats.totals.directories).toBe(0);
    expect(stats.totals.bytes).toBe(0);
    expect(stats.totals.words).toBe(0);
    expect(stats.byExtension).toEqual({});
    expect(stats.folderCounts.papers).toBe(0);
    expect(stats.lastModified).toBeUndefined();
  });

  it("returns all-zero stats and does not throw when the project root is missing", async () => {
    const slug = "missing-slug";
    const ghostRoot = path.join(ROOT, "definitely-not-there", slug);

    const stats = await computeProjectStats(ghostRoot, slug);
    expect(stats.slug).toBe(slug);
    expect(stats.totals.files).toBe(0);
    expect(stats.totals.directories).toBe(0);
    expect(stats.totals.bytes).toBe(0);
    expect(stats.totals.words).toBe(0);
    expect(stats.byExtension).toEqual({});
    expect(stats.lastModified).toBeUndefined();
  });

  it("excludes the auto-generated .references.json from the scan", async () => {
    const slug = "refs-excluded";
    seed(`${slug}/.references.json`, JSON.stringify({ hello: "world" }));
    seed(`${slug}/papers/p.pdf`, "%PDF");

    const stats = await computeProjectStats(slugRoot(slug), slug);
    expect(stats.totals.files).toBe(1);
    expect(stats.byExtension[".json"]).toBeUndefined();
    expect(stats.folderCounts.other).toBe(0);
  });

  it("excludes dotfiles like .DS_Store", async () => {
    const slug = "dotfiles";
    seed(`${slug}/.DS_Store`, "ds");
    seed(`${slug}/papers/.DS_Store`, "ds");
    seed(`${slug}/papers/paper.pdf`, "%PDF");

    const stats = await computeProjectStats(slugRoot(slug), slug);
    expect(stats.totals.files).toBe(1);
    expect(stats.folderCounts.papers).toBe(1);
  });

  it("reports lastModified as the ISO string of the most recent mtime", async () => {
    const slug = "mtime-check";
    const older = seed(`${slug}/code/a.py`, "print('a')");
    const newer = seed(`${slug}/code/b.py`, "print('b')");

    // Force deterministic mtimes: older 1e9s ago, newer 2e9s ago from epoch.
    const olderTime = new Date("2021-01-01T00:00:00Z");
    const newerTime = new Date("2024-06-15T12:34:56Z");
    utimesSync(older, olderTime, olderTime);
    utimesSync(newer, newerTime, newerTime);

    const stats = await computeProjectStats(slugRoot(slug), slug);
    expect(stats.lastModified).toBe(newerTime.toISOString());
  });

  it("keeps nested files inside papers/ classified under folderCounts.papers", async () => {
    const slug = "nested-papers";
    seed(`${slug}/papers/2024/q1/draft.pdf`, "%PDF");
    seed(`${slug}/papers/2024/q1/notes.md`, "alpha beta gamma");
    seed(`${slug}/papers/legacy/archive/old.pdf`, "%PDF");

    const stats = await computeProjectStats(slugRoot(slug), slug);
    expect(stats.folderCounts.papers).toBe(3);
    expect(stats.folderCounts.other).toBe(0);
    // Nested directory walking must also populate totals.directories.
    expect(stats.totals.directories).toBeGreaterThanOrEqual(4);
  });

  it("buckets unknown top-level folders into 'other'", async () => {
    const slug = "other-bucket";
    seed(`${slug}/scratch/note.txt`, "hello world");
    seed(`${slug}/misc/file.bin`, Buffer.alloc(4));
    seed(`${slug}/papers/p.pdf`, "%PDF");

    const stats = await computeProjectStats(slugRoot(slug), slug);
    expect(stats.folderCounts.other).toBe(2);
    expect(stats.folderCounts.papers).toBe(1);
  });

  it("skips node_modules anywhere in the tree", async () => {
    const slug = "nm-skip";
    seed(`${slug}/code/index.ts`, "export {};");
    seed(`${slug}/node_modules/pkg/index.js`, "module.exports = {};");
    seed(`${slug}/code/node_modules/pkg/index.js`, "module.exports = {};");

    const stats = await computeProjectStats(slugRoot(slug), slug);
    expect(stats.totals.files).toBe(1);
    expect(stats.byExtension[".ts"]).toBe(1);
    expect(stats.byExtension[".js"]).toBeUndefined();
  });
});
