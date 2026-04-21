import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectDuplicatePaperCandidates,
  detectDuplicatePapers,
  normalizeTitle,
  titleSimilarity,
} from "@/lib/paper-dedupe";

const ROOT = path.join(tmpdir(), "scienceswarm-paper-dedupe-unit");

function writePaper(
  rel: string,
  opts: { title?: string; doi?: string; body?: string } = {},
): void {
  const abs = path.join(ROOT, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, opts.body ?? "%PDF-1.4 fake");
  if (opts.title !== undefined || opts.doi !== undefined) {
    const parsed = path.parse(abs);
    const mdPath = path.join(parsed.dir, `${parsed.name}.md`);
    const lines = ["---"];
    if (opts.title !== undefined) lines.push(`title: ${opts.title}`);
    if (opts.doi !== undefined) lines.push(`doi: ${opts.doi}`);
    lines.push("---", "", "Body text.");
    writeFileSync(mdPath, lines.join("\n"));
  }
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("normalizeTitle", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeTitle("Hello, World!")).toBe("hello world");
  });

  it("collapses internal whitespace runs", () => {
    expect(normalizeTitle("  Foo   Bar\tBaz  ")).toBe("foo bar baz");
  });

  it("turns numerals into tokens alongside words", () => {
    expect(normalizeTitle("GPT-4 is here (2024)")).toBe("gpt 4 is here 2024");
  });
});

describe("titleSimilarity", () => {
  it("returns 1 for identical normalized inputs", () => {
    expect(titleSimilarity("foo bar", "foo bar")).toBe(1);
  });

  it("returns a value strictly between 0 and 1 for partial overlap", () => {
    const score = titleSimilarity("foo bar", "foo baz");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("returns 0 for disjoint word sets", () => {
    expect(titleSimilarity("alpha beta", "gamma delta")).toBe(0);
  });

  it("returns 0 when both inputs are empty", () => {
    expect(titleSimilarity("", "")).toBe(0);
  });
});

describe("detectDuplicatePapers", () => {
  it("can detect duplicates from prebuilt paper candidates without scanning the filesystem", () => {
    const result = detectDuplicatePaperCandidates([
      { file: "papers/a.pdf", title: "Attention Is All You Need", doi: "10.1000/abc" },
      { file: "papers/b.pdf", title: "Completely different title", doi: "10.1000/abc" },
      { file: "papers/c.pdf", title: "Distinct paper title" },
    ]);

    expect(result.candidates.map((candidate) => candidate.file)).toEqual([
      "papers/a.pdf",
      "papers/b.pdf",
      "papers/c.pdf",
    ]);
    expect(result.duplicates).toEqual([
      expect.objectContaining({
        a: "papers/a.pdf",
        b: "papers/b.pdf",
        reason: "shared-doi",
      }),
    ]);
  });

  it("returns an empty result when the papers root is missing", async () => {
    const result = await detectDuplicatePapers(path.join(ROOT, "does-not-exist"));
    expect(result.candidates).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(typeof result.scannedAt).toBe("string");
  });

  it("flags two pdfs with identical frontmatter titles as title-similarity", async () => {
    writePaper("a.pdf", { title: "Attention Is All You Need" });
    writePaper("b.pdf", { title: "Attention Is All You Need" });
    const result = await detectDuplicatePapers(ROOT);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].reason).toBe("title-similarity");
    expect(result.duplicates[0].similarity).toBe(1);
  });

  it("flags two pdfs with identical DOIs as shared-doi with similarity 1", async () => {
    writePaper("x.pdf", { title: "Very Different Title Alpha", doi: "10.1000/xyz" });
    writePaper("y.pdf", {
      title: "Completely Unrelated Ideas Beta",
      doi: "10.1000/xyz",
    });
    const result = await detectDuplicatePapers(ROOT);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].reason).toBe("shared-doi");
    expect(result.duplicates[0].similarity).toBe(1);
  });

  it("lets DOI match take precedence over title similarity", async () => {
    writePaper("one.pdf", { title: "A Shared Title Here", doi: "10.9999/abc" });
    writePaper("two.pdf", { title: "A Shared Title Here", doi: "10.9999/abc" });
    const result = await detectDuplicatePapers(ROOT);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].reason).toBe("shared-doi");
  });

  it("does not flag title-similarity duplicates when both papers have different DOIs", async () => {
    writePaper("one.pdf", { title: "A Shared Title Here", doi: "10.9999/one" });
    writePaper("two.pdf", { title: "A Shared Title Here", doi: "10.9999/two" });

    const result = await detectDuplicatePapers(ROOT);
    expect(result.duplicates).toEqual([]);
  });

  it("reports no duplicates when titles are distinct", async () => {
    writePaper("a.pdf", { title: "Transformer Architectures" });
    writePaper("b.pdf", { title: "Diffusion Models Revisited" });
    const result = await detectDuplicatePapers(ROOT);
    expect(result.duplicates).toEqual([]);
    expect(result.candidates).toHaveLength(2);
  });

  it("does not treat companion .md files as candidates themselves", async () => {
    writePaper("only.pdf", { title: "Solo Paper Title" });
    const result = await detectDuplicatePapers(ROOT);
    const files = result.candidates.map((c) => c.file);
    expect(files).toContain("only.pdf");
    expect(files).not.toContain("only.md");
    expect(files).toHaveLength(1);
  });

  it("flags a pair whose Jaccard similarity is exactly at the 0.85 threshold", async () => {
    // A = 17 shared + 3 extra, B = 17 shared → |A∩B| = 17, |A∪B| = 20,
    // Jaccard = 17/20 = 0.85 exactly.
    const shared = Array.from({ length: 17 }, (_, i) => `w${i}`).join(" ");
    writePaper("a.pdf", { title: `${shared} x1 x2 x3` });
    writePaper("b.pdf", { title: shared });
    const result = await detectDuplicatePapers(ROOT);
    const titleHits = result.duplicates.filter(
      (d) => d.reason === "title-similarity",
    );
    expect(titleHits).toHaveLength(1);
    expect(titleHits[0].similarity).toBeCloseTo(0.85, 10);
    expect(titleHits[0].similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("does NOT flag a pair whose similarity is below the 0.85 threshold", async () => {
    // 3 shared / 5 union = 0.6
    writePaper("a.pdf", { title: "alpha beta gamma delta" });
    writePaper("b.pdf", { title: "alpha beta gamma epsilon zeta" });
    const result = await detectDuplicatePapers(ROOT);
    expect(result.duplicates).toEqual([]);
  });

  it("uses the filename as the title when no companion .md is present", async () => {
    writePaper("lonely-paper-title.pdf");
    const result = await detectDuplicatePapers(ROOT);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].title).toBe("lonely-paper-title");
    expect(result.candidates[0].doi).toBeUndefined();
  });

  it("deduplicates pairs so (a,b) and (b,a) are reported only once", async () => {
    writePaper("a.pdf", { title: "Exact Same Title" });
    writePaper("b.pdf", { title: "Exact Same Title" });
    writePaper("c.pdf", { title: "Exact Same Title" });
    const result = await detectDuplicatePapers(ROOT);
    // 3 candidates sharing a title → C(3,2) = 3 unique unordered pairs.
    expect(result.duplicates).toHaveLength(3);
    const seen = new Set<string>();
    for (const dup of result.duplicates) {
      const key = [dup.a, dup.b].sort().join("|");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("walks .bib and .tex files alongside .pdf", async () => {
    writePaper("paper.pdf", { title: "Some Study" });
    writePaper("refs.bib", { body: "@article{foo}" });
    writePaper("draft.tex", { body: "\\documentclass{article}" });
    const result = await detectDuplicatePapers(ROOT);
    const files = result.candidates.map((c) => c.file).sort();
    expect(files).toEqual(["draft.tex", "paper.pdf", "refs.bib"]);
  });

  it("returns candidates in stable sort order by path", async () => {
    writePaper("zeta.pdf");
    writePaper("alpha.pdf");
    writePaper("nested/mu.pdf");
    const result = await detectDuplicatePapers(ROOT);
    const files = result.candidates.map((c) => c.file);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });
});
