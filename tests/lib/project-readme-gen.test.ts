import path from "node:path";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateProjectReadme } from "@/lib/project-readme-gen";

const ROOT = path.join(tmpdir(), "scienceswarm-project-readme-lib");

function seed(rel: string, contents: string | Buffer = ""): string {
  const absPath = path.join(ROOT, rel);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents);
  return absPath;
}

function slugRoot(slug: string): string {
  return path.join(ROOT, slug);
}

function touch(absPath: string, when: Date): void {
  utimesSync(absPath, when, when);
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("generateProjectReadme", () => {
  it("renders a header, overview table, and file list for a seeded project", async () => {
    const slug = "alpha-beta";
    seed(`${slug}/papers/one.pdf`, "%PDF-1.4");
    seed(`${slug}/papers/two.pdf`, "%PDF-1.4");
    seed(`${slug}/papers/three.pdf`, "%PDF-1.4");
    seed(`${slug}/code/main.py`, "print('hi')");
    seed(`${slug}/code/util.ts`, "export const x = 1;");

    const result = await generateProjectReadme({
      slug,
      projectRoot: slugRoot(slug),
    });

    // Header: humanised title, no description blank line.
    expect(result.sections.header).toBe("# Alpha Beta\n");

    // Overview: stable-ordered table limited to non-empty buckets.
    expect(result.sections.overview).toContain("## Overview");
    expect(result.sections.overview).toContain("| Folder | Files |");
    expect(result.sections.overview).toContain("| papers | 3 |");
    expect(result.sections.overview).toContain("| code | 2 |");
    expect(result.sections.overview).not.toContain("| docs |");

    // Files section lists each of the 5 seeded files.
    expect(result.sections.files).toContain("## Recent Files");
    expect(result.sections.files).toContain("papers/one.pdf");
    expect(result.sections.files).toContain("papers/two.pdf");
    expect(result.sections.files).toContain("papers/three.pdf");
    expect(result.sections.files).toContain("code/main.py");
    expect(result.sections.files).toContain("code/util.ts");

    // Counts mirror the scan.
    expect(result.fileCounts.papers).toBe(3);
    expect(result.fileCounts.code).toBe(2);
    expect(result.fileCounts.data).toBe(0);
  });

  it("humanises the default title from the slug", async () => {
    const slug = "project-alpha";
    mkdirSync(slugRoot(slug), { recursive: true });

    const result = await generateProjectReadme({
      slug,
      projectRoot: slugRoot(slug),
    });

    expect(result.sections.header.startsWith("# Project Alpha")).toBe(true);
  });

  it("respects a custom title override", async () => {
    const slug = "misc";
    mkdirSync(slugRoot(slug), { recursive: true });

    const result = await generateProjectReadme({
      slug,
      title: "My Cool Project",
      projectRoot: slugRoot(slug),
    });

    expect(result.sections.header.startsWith("# My Cool Project")).toBe(true);
    expect(result.sections.header).not.toContain("Misc");
  });

  it("strips embedded newlines from title and description overrides", async () => {
    const slug = "sanitized";
    seed(`${slug}/papers/p.pdf`, "%PDF");

    const result = await generateProjectReadme({
      slug,
      title: "My Project\n## Injected heading",
      description: "Line one.\r\n- injected bullet",
      projectRoot: slugRoot(slug),
    });

    expect(result.sections.header).toContain("# My Project ## Injected heading");
    expect(result.sections.header).toContain("Line one. - injected bullet");
    expect(result.readme).not.toContain("\n## Injected heading");
    expect(result.readme).not.toContain("\n- injected bullet");
  });

  it("surfaces a description override in the header and overview", async () => {
    const slug = "desc-check";
    seed(`${slug}/papers/p.pdf`, "%PDF");

    const result = await generateProjectReadme({
      slug,
      description: "Exploring the boundary of X and Y.",
      projectRoot: slugRoot(slug),
    });

    expect(result.sections.header).toContain("Exploring the boundary of X and Y.");
    // Header keeps a blank line between title and description.
    expect(result.sections.header).toBe(
      "# Desc Check\n\nExploring the boundary of X and Y.\n",
    );
    expect(result.sections.overview).toContain("Exploring the boundary of X and Y.");
    // Full readme should include the description too.
    expect(result.readme).toContain("Exploring the boundary of X and Y.");
  });

  it("reports lastActivity as the ISO string of the most recent mtime", async () => {
    const slug = "mtime-check";
    const older = seed(`${slug}/code/a.py`, "print('a')");
    const newer = seed(`${slug}/code/b.py`, "print('b')");

    const olderTime = new Date("2021-01-01T00:00:00Z");
    const newerTime = new Date("2024-06-15T12:34:56Z");
    touch(older, olderTime);
    touch(newer, newerTime);

    const result = await generateProjectReadme({
      slug,
      projectRoot: slugRoot(slug),
    });

    expect(result.sections.lastActivity).toContain(newerTime.toISOString());
    expect(result.sections.lastActivity).not.toContain(olderTime.toISOString());
  });

  it("lists up to 5 files by mtime descending", async () => {
    const slug = "recent-5";
    const paths: { absPath: string; when: Date }[] = [];
    for (let i = 0; i < 7; i += 1) {
      const absPath = seed(`${slug}/code/file-${i}.ts`, `export const x${i} = ${i};`);
      const when = new Date(Date.UTC(2024, 0, i + 1));
      touch(absPath, when);
      paths.push({ absPath, when });
    }

    const result = await generateProjectReadme({
      slug,
      projectRoot: slugRoot(slug),
    });

    const lines = result.sections.files
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(5);

    // The 5 newest are indices 2..6 inclusive, in descending order.
    const expectedRelOrder = [6, 5, 4, 3, 2].map((i) => `code/file-${i}.ts`);
    for (let i = 0; i < expectedRelOrder.length; i += 1) {
      expect(lines[i]).toContain(expectedRelOrder[i]);
    }
    // Oldest files (0, 1) must not appear.
    expect(result.sections.files).not.toContain("code/file-0.ts");
    expect(result.sections.files).not.toContain("code/file-1.ts");
  });

  it("renders _No files yet._ for an empty project", async () => {
    const slug = "empty";
    mkdirSync(slugRoot(slug), { recursive: true });

    const result = await generateProjectReadme({
      slug,
      projectRoot: slugRoot(slug),
    });

    expect(result.sections.files).toContain("_No files yet._");
    expect(result.sections.overview).toContain("_No files yet._");
    expect(result.sections.lastActivity).toContain("_No activity yet._");
    expect(result.fileCounts.papers).toBe(0);
    expect(result.fileCounts.other).toBe(0);
  });

  it("returns an empty README without throwing when the project root is missing", async () => {
    const slug = "ghost";
    const ghostRoot = path.join(ROOT, "definitely-not-there", slug);

    const result = await generateProjectReadme({
      slug,
      projectRoot: ghostRoot,
    });

    expect(result.readme).toContain("# Ghost");
    expect(result.sections.files).toContain("_No files yet._");
    expect(result.sections.lastActivity).toContain("_No activity yet._");
    for (const bucket of Object.keys(result.fileCounts)) {
      expect(result.fileCounts[bucket]).toBe(0);
    }
  });

  it("excludes the auto-generated .references.json", async () => {
    const slug = "refs-excluded";
    seed(`${slug}/.references.json`, JSON.stringify({ hello: "world" }));
    seed(`${slug}/papers/p.pdf`, "%PDF");

    const result = await generateProjectReadme({
      slug,
      projectRoot: slugRoot(slug),
    });

    expect(result.sections.files).not.toContain(".references.json");
    expect(result.fileCounts.other).toBe(0);
    expect(result.fileCounts.papers).toBe(1);
  });

  it("excludes dotfiles like .DS_Store", async () => {
    const slug = "dotfiles";
    seed(`${slug}/.DS_Store`, "ds");
    seed(`${slug}/papers/.DS_Store`, "ds");
    seed(`${slug}/papers/paper.pdf`, "%PDF");

    const result = await generateProjectReadme({
      slug,
      projectRoot: slugRoot(slug),
    });

    expect(result.sections.files).not.toContain(".DS_Store");
    expect(result.fileCounts.papers).toBe(1);
    expect(result.fileCounts.other).toBe(0);
  });

  it("populates fileCounts with the raw per-bucket totals", async () => {
    const slug = "buckets";
    seed(`${slug}/papers/a.pdf`, "%PDF");
    seed(`${slug}/papers/b.pdf`, "%PDF");
    seed(`${slug}/code/main.py`, "print('x')");
    seed(`${slug}/data/points.csv`, "a,b\n1,2");
    seed(`${slug}/docs/readme.md`, "hello");
    seed(`${slug}/figures/plot.png`, Buffer.alloc(4));
    seed(`${slug}/config/env.json`, '{"a":1}');
    seed(`${slug}/scratch/random.txt`, "something else");

    const result = await generateProjectReadme({
      slug,
      projectRoot: slugRoot(slug),
    });

    expect(result.fileCounts).toEqual({
      papers: 2,
      code: 1,
      data: 1,
      docs: 1,
      figures: 1,
      config: 1,
      other: 1,
    });
  });

  it("concatenates sections with blank separators and a trailing newline", async () => {
    const slug = "shape";
    seed(`${slug}/papers/one.pdf`, "%PDF");

    const result = await generateProjectReadme({
      slug,
      projectRoot: slugRoot(slug),
    });

    const expected =
      [
        result.sections.header,
        result.sections.overview,
        result.sections.files,
        result.sections.lastActivity,
      ].join("\n\n") + "\n";
    expect(result.readme).toBe(expected);
    expect(result.readme.endsWith("\n")).toBe(true);
  });
});
