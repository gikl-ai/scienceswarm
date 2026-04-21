import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateLiteratureReview,
  LiteratureReviewSummarizerRequiredError,
  type PaperMetadata,
  type LiteratureReviewGroup,
  type Summarizer,
} from "@/lib/lit-review";

const ROOT = path.join(tmpdir(), "scienceswarm-lit-review-lib");
const TEST_SUMMARY = "LLM_SUMMARY";
const TEST_SUMMARIZER: Summarizer = async () => TEST_SUMMARY;

function generateTestReview(
  opts: Parameters<typeof generateLiteratureReview>[0],
) {
  return generateLiteratureReview({
    ...opts,
    summarizer: opts.summarizer ?? TEST_SUMMARIZER,
  });
}

function writePaper(
  relPath: string,
  options: {
    content?: string;
    companion?: Record<string, unknown> | string | null;
  } = {},
): void {
  const abs = path.join(ROOT, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, options.content ?? "%PDF-1.4 fake");

  if (options.companion === undefined) return;
  if (options.companion === null) return;

  const base = path.basename(abs, path.extname(abs));
  const companionAbs = path.join(path.dirname(abs), `${base}.md`);

  if (typeof options.companion === "string") {
    writeFileSync(companionAbs, options.companion);
    return;
  }

  const data = options.companion;
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${JSON.stringify(item)}`);
      }
    } else if (typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---", "", "Body content.");
  writeFileSync(companionAbs, lines.join("\n"));
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("generateLiteratureReview", () => {
  it("groups 3 seeded papers by tag from frontmatter", async () => {
    writePaper("alpha.pdf", {
      companion: { title: "Alpha paper", tags: ["ml", "vision"] },
    });
    writePaper("beta.pdf", {
      companion: { title: "Beta paper", tags: ["ml"] },
    });
    writePaper("gamma.pdf", {
      companion: { title: "Gamma paper", tags: ["nlp"] },
    });

    const review = await generateTestReview({ papersRoot: ROOT });

    expect(review.groupBy).toBe("tag");
    expect(review.totalPapers).toBe(3);
    const headings = review.groups.map((g) => g.heading);
    expect(headings).toEqual(["ml", "nlp", "vision"]);
    const mlGroup = review.groups.find((g) => g.heading === "ml");
    expect(mlGroup?.papers.map((p) => p.title)).toEqual(["Alpha paper", "Beta paper"]);
  });

  it("groupBy: 'year' places papers in 5-year buckets", async () => {
    writePaper("a.pdf", { companion: { title: "A", year: 2023 } });
    writePaper("b.pdf", { companion: { title: "B", year: 2019 } });
    writePaper("c.pdf", { companion: { title: "C", year: 2014 } });

    const review = await generateTestReview({
      papersRoot: ROOT,
      groupBy: "year",
    });

    const headings = review.groups.map((g) => g.heading);
    expect(headings).toEqual(["2010\u20132014", "2015\u20132019", "2020\u20132024"]);
    expect(review.groupBy).toBe("year");
  });

  it("year bucket: a paper from 2023 lands in '2020–2024'", async () => {
    writePaper("only.pdf", { companion: { title: "Only", year: 2023 } });
    const review = await generateTestReview({
      papersRoot: ROOT,
      groupBy: "year",
    });
    expect(review.groups).toHaveLength(1);
    expect(review.groups[0].heading).toBe("2020\u20132024");
    expect(review.groups[0].papers[0].year).toBe(2023);
  });

  it("groupBy: 'none' returns a single 'All papers' group", async () => {
    writePaper("a.pdf", { companion: { title: "Zeta" } });
    writePaper("b.pdf", { companion: { title: "Alpha" } });

    const review = await generateTestReview({
      papersRoot: ROOT,
      groupBy: "none",
    });

    expect(review.groups).toHaveLength(1);
    expect(review.groups[0].heading).toBe("All papers");
    // Papers still sorted by title within the group.
    expect(review.groups[0].papers.map((p) => p.title)).toEqual(["Alpha", "Zeta"]);
  });

  it("papers without a companion .md fall back to filename as title", async () => {
    writePaper("naked-paper.pdf", { companion: null });

    const review = await generateTestReview({
      papersRoot: ROOT,
      groupBy: "none",
    });

    expect(review.totalPapers).toBe(1);
    expect(review.groups[0].papers[0].title).toBe("naked-paper");
  });

  it("papers with multiple tags appear in multiple groups", async () => {
    writePaper("multi.pdf", {
      companion: { title: "Multi paper", tags: ["ml", "vision", "survey"] },
    });

    const review = await generateTestReview({ papersRoot: ROOT });

    expect(review.totalPapers).toBe(1);
    expect(review.groups.map((g) => g.heading)).toEqual(["ml", "survey", "vision"]);
    for (const group of review.groups) {
      expect(group.papers.map((p) => p.title)).toEqual(["Multi paper"]);
    }
  });

  it("deduplicates repeated tags within one paper before bucketing", async () => {
    writePaper("repeat.pdf", {
      companion: { title: "Repeated tags", tags: ["ml", "ml", "vision"] },
    });

    const review = await generateTestReview({ papersRoot: ROOT });
    const mlGroup = review.groups.find((group) => group.heading === "ml");

    expect(mlGroup?.papers.map((paper) => paper.title)).toEqual(["Repeated tags"]);
  });

  it("untagged papers go into the 'Uncategorized' group", async () => {
    writePaper("loose.pdf", { companion: { title: "Loose paper" } });
    writePaper("tagged.pdf", {
      companion: { title: "Tagged paper", tags: ["theory"] },
    });

    const review = await generateTestReview({ papersRoot: ROOT });

    const headings = review.groups.map((g) => g.heading);
    expect(headings).toContain("Uncategorized");
    const uncategorized = review.groups.find((g) => g.heading === "Uncategorized");
    expect(uncategorized?.papers.map((p) => p.title)).toEqual(["Loose paper"]);
  });

  it("custom injected summariser is called with papers and groups", async () => {
    writePaper("x.pdf", { companion: { title: "X", tags: ["a"] } });
    writePaper("y.pdf", { companion: { title: "Y", tags: ["b"] } });

    let captured: { papers: PaperMetadata[]; groups: LiteratureReviewGroup[] } | null = null;
    const stub: Summarizer = async (input) => {
      captured = input;
      return "STUB_SUMMARY";
    };

    const review = await generateLiteratureReview({
      papersRoot: ROOT,
      summarizer: stub,
    });

    expect(review.summary).toBe("STUB_SUMMARY");
    expect(captured).not.toBeNull();
    expect(captured!.papers).toHaveLength(2);
    expect(captured!.groups.length).toBeGreaterThan(0);
  });

  it("requires an injected summarizer when papers are present", async () => {
    writePaper("a.pdf", { companion: { title: "A", tags: ["ml"] } });
    writePaper("b.pdf", { companion: { title: "B", tags: ["ml"] } });
    writePaper("c.pdf", { companion: { title: "C", tags: ["nlp"] } });

    await expect(generateLiteratureReview({ papersRoot: ROOT })).rejects.toThrow(
      LiteratureReviewSummarizerRequiredError,
    );
  });

  it("missing papersRoot → empty review, no throw", async () => {
    const ghost = path.join(ROOT, "does-not-exist");
    const review = await generateLiteratureReview({ papersRoot: ghost });

    expect(review.totalPapers).toBe(0);
    expect(review.groups).toEqual([]);
    expect(review.summary).toBe("");
    expect(review.groupBy).toBe("tag");
  });

  it("sort order: group headings alphabetical, papers within groups by title", async () => {
    writePaper("zeta.pdf", { companion: { title: "Zeta", tags: ["xray"] } });
    writePaper("alpha.pdf", { companion: { title: "Alpha", tags: ["xray"] } });
    writePaper("mid.pdf", { companion: { title: "Mid", tags: ["alpha-tag"] } });

    const review = await generateTestReview({ papersRoot: ROOT });

    expect(review.groups.map((g) => g.heading)).toEqual(["alpha-tag", "xray"]);
    const xray = review.groups.find((g) => g.heading === "xray");
    expect(xray?.papers.map((p) => p.title)).toEqual(["Alpha", "Zeta"]);
  });

  it("recursively scans subdirectories and skips dotfiles / node_modules", async () => {
    writePaper("nested/deep/paper.pdf", {
      companion: { title: "Nested paper", tags: ["deep"] },
    });
    writePaper(".hidden.pdf", { companion: null });
    writePaper("node_modules/ignored.pdf", { companion: null });

    const review = await generateTestReview({
      papersRoot: ROOT,
      groupBy: "none",
    });

    expect(review.totalPapers).toBe(1);
    expect(review.groups[0].papers[0].title).toBe("Nested paper");
    expect(review.groups[0].papers[0].file).toBe(
      path.join("nested", "deep", "paper.pdf"),
    );
  });

  it("picks up .bib and .tex files alongside .pdf", async () => {
    writePaper("refs.bib", { companion: { title: "Refs", tags: ["bib"] } });
    writePaper("draft.tex", { companion: { title: "Draft", tags: ["tex"] } });
    writePaper("report.pdf", { companion: { title: "Report", tags: ["pdf"] } });
    // Non-paper extension must be ignored.
    writeFileSync(path.join(ROOT, "notes.txt"), "ignore me");

    const review = await generateTestReview({
      papersRoot: ROOT,
      groupBy: "none",
    });

    expect(review.totalPapers).toBe(3);
    expect(review.groups[0].papers.map((p) => p.title).sort()).toEqual([
      "Draft",
      "Refs",
      "Report",
    ]);
  });

  it("papers without a year go into the 'Unknown' bucket in year mode", async () => {
    writePaper("dated.pdf", { companion: { title: "Dated", year: 2021 } });
    writePaper("undated.pdf", { companion: { title: "Undated" } });

    const review = await generateTestReview({
      papersRoot: ROOT,
      groupBy: "year",
    });

    const unknown = review.groups.find((g) => g.heading === "Unknown");
    expect(unknown?.papers.map((p) => p.title)).toEqual(["Undated"]);
  });
});
