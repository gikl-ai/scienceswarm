import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractResearchQuestions,
  scanProjectResearchQuestions,
} from "@/lib/research-questions";

describe("extractResearchQuestions", () => {
  it("extracts an `RQ1: text` prefix with id RQ1", () => {
    const questions = extractResearchQuestions(
      "RQ1: Does the retrieval layer help?",
      "notes.md",
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("RQ1");
    expect(questions[0].text).toBe("Does the retrieval layer help?");
    expect(questions[0].line).toBe(1);
    expect(questions[0].file).toBe("notes.md");
    expect(questions[0].section).toBeUndefined();
  });

  it("extracts an `RQ2a: text` prefix with id RQ2a", () => {
    const questions = extractResearchQuestions(
      "RQ2a: Under what conditions does it degrade?",
      "notes.md",
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("RQ2a");
    expect(questions[0].text).toBe(
      "Under what conditions does it degrade?",
    );
  });

  it("extracts `Research question: text` with empty id", () => {
    const questions = extractResearchQuestions(
      "Research question: How do we measure recall?",
      "notes.md",
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("");
    expect(questions[0].text).toBe("How do we measure recall?");
  });

  it("matches lowercase `research question:` case-insensitively", () => {
    const questions = extractResearchQuestions(
      "research question: does lowercase also match?",
      "notes.md",
    );
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("");
    expect(questions[0].text).toBe("does lowercase also match?");
  });

  it("extracts bullets inside a `## Research questions` section", () => {
    const text = [
      "# Title",
      "",
      "## Research questions",
      "- What is the latency budget?",
      "- How do we define success?",
      "",
      "## Notes",
      "- This is unrelated bullet text.",
    ].join("\n");

    const questions = extractResearchQuestions(text, "plan.md");
    expect(questions).toHaveLength(2);
    expect(questions.map((q) => q.text)).toEqual([
      "What is the latency budget?",
      "How do we define success?",
    ]);
    for (const q of questions) {
      expect(q.id).toBe("");
      expect(q.section).toBe("## Research questions");
    }
  });

  it("does not drag lines outside the section into the extraction", () => {
    const text = [
      "# Preamble",
      "Something something outside the section ends with a question?",
      "",
      "## Research questions",
      "- Does the seed matter?",
      "",
      "## Conclusion",
      "- Another bullet not in scope.",
    ].join("\n");

    const questions = extractResearchQuestions(text, "plan.md");
    // The trailing-? line outside the section must NOT be extracted.
    expect(questions).toHaveLength(1);
    expect(questions[0].text).toBe("Does the seed matter?");
    expect(questions[0].section).toBe("## Research questions");
  });

  it("skips fenced code blocks", () => {
    const text = [
      "## Research questions",
      "- Real question inside the section?",
      "",
      "```",
      "RQ9: fake question in a code block",
      "Research question: also ignored",
      "- Bullet in a code block inside the section?",
      "```",
      "",
      "RQ2: Outside the fence and still valid?",
    ].join("\n");

    const questions = extractResearchQuestions(text, "plan.md");
    const ids = questions.map((q) => q.id).sort();
    const texts = questions.map((q) => q.text);
    expect(ids).toEqual(["", "RQ2"]);
    expect(texts).toContain("Real question inside the section?");
    expect(texts).toContain("Outside the fence and still valid?");
    expect(texts.some((t) => t.includes("fake question"))).toBe(false);
  });

  it("scans a 3-file temp dir with scanProjectResearchQuestions", async () => {
    const root = path.join(
      tmpdir(),
      `scienceswarm-rq-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      mkdirSync(path.join(root, "sub"), { recursive: true });
      writeFileSync(
        path.join(root, "a.md"),
        "RQ1: What is the research question A1?",
        "utf-8",
      );
      writeFileSync(
        path.join(root, "b.md"),
        [
          "## Research questions",
          "- Bullet question B1?",
          "- Bullet question B2?",
        ].join("\n"),
        "utf-8",
      );
      writeFileSync(
        path.join(root, "sub", "c.md"),
        "Research question: nested question C?",
        "utf-8",
      );
      // Non-md should not be counted.
      writeFileSync(path.join(root, "skipme.txt"), "RQ1: ignore me", "utf-8");

      const scan = await scanProjectResearchQuestions(root);
      expect(scan.scannedFiles).toBe(3);
      expect(scan.questions).toHaveLength(4);
      expect(
        scan.questions.some(
          (q) => q.id === "RQ1" && q.file === "a.md",
        ),
      ).toBe(true);
      expect(
        scan.questions.filter((q) => q.file === "b.md"),
      ).toHaveLength(2);
      expect(
        scan.questions.some(
          (q) => q.file === path.join("sub", "c.md") && q.id === "",
        ),
      ).toBe(true);
      expect(typeof scan.scannedAt).toBe("string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty scan for a missing root (no throw)", async () => {
    const root = path.join(
      tmpdir(),
      `scienceswarm-rq-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const scan = await scanProjectResearchQuestions(root);
    expect(scan.questions).toEqual([]);
    expect(scan.scannedFiles).toBe(0);
    expect(typeof scan.scannedAt).toBe("string");
  });

  it("preserves the RQ id on a form-1 match inside a research-questions section", () => {
    const text = [
      "## Research questions",
      "RQ1: Does the section-plus-id combo keep the id?",
      "- A plain bullet question?",
    ].join("\n");

    const questions = extractResearchQuestions(text, "plan.md");
    expect(questions).toHaveLength(2);
    const idMatch = questions.find((q) => q.id === "RQ1");
    expect(idMatch).toBeDefined();
    expect(idMatch?.text).toBe(
      "Does the section-plus-id combo keep the id?",
    );
    expect(idMatch?.section).toBe("## Research questions");
    const bullet = questions.find((q) => q.id === "");
    expect(bullet?.text).toBe("A plain bullet question?");
  });

  it("deduplicates same (id, text) on the same line", () => {
    const text = "RQ1: duplicate text";
    const first = extractResearchQuestions(text, "a.md");
    expect(first).toHaveLength(1);
    // Calling twice on the same text does not magically double, but also
    // check we don't emit the same question via two rules on one line.
    const compound = [
      "## Research questions",
      "RQ1: combined question?",
    ].join("\n");
    const combined = extractResearchQuestions(compound, "b.md");
    // Only the RQ1 id match should be emitted — not also a form-3 trailing-`?`
    // dupe on the same line.
    expect(combined).toHaveLength(1);
    expect(combined[0].id).toBe("RQ1");
  });

  it("handles `Research Questions` with capital R in the heading", () => {
    const text = [
      "## Research Questions",
      "- Capitalized heading still triggers the section?",
    ].join("\n");
    const questions = extractResearchQuestions(text, "plan.md");
    expect(questions).toHaveLength(1);
    expect(questions[0].text).toBe(
      "Capitalized heading still triggers the section?",
    );
  });

  it("stops the section at a new H1 heading", () => {
    const text = [
      "## Research questions",
      "- In scope question?",
      "",
      "# New top-level heading",
      "- Out of scope bullet?",
    ].join("\n");

    const questions = extractResearchQuestions(text, "plan.md");
    expect(questions).toHaveLength(1);
    expect(questions[0].text).toBe("In scope question?");
  });

  it("keeps nested headings inside the research-questions section", () => {
    const text = [
      "## Research questions",
      "### Retrieval",
      "- Does the subsection stay in scope?",
    ].join("\n");

    const questions = extractResearchQuestions(text, "plan.md");
    expect(questions).toHaveLength(1);
    expect(questions[0].text).toBe("Does the subsection stay in scope?");
    expect(questions[0].section).toBe("## Research questions");
  });
});

describe("scanProjectResearchQuestions filesystem traversal", () => {
  const ROOT = path.join(
    tmpdir(),
    `scienceswarm-rq-walk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("skips dotfiles, node_modules, and .claude", async () => {
    mkdirSync(path.join(ROOT, "node_modules"), { recursive: true });
    mkdirSync(path.join(ROOT, ".claude"), { recursive: true });
    mkdirSync(path.join(ROOT, ".hidden"), { recursive: true });
    writeFileSync(
      path.join(ROOT, "node_modules", "skip.md"),
      "RQ9: should not appear",
      "utf-8",
    );
    writeFileSync(
      path.join(ROOT, ".claude", "skip.md"),
      "RQ9: should not appear",
      "utf-8",
    );
    writeFileSync(
      path.join(ROOT, ".hidden", "skip.md"),
      "RQ9: should not appear",
      "utf-8",
    );
    writeFileSync(
      path.join(ROOT, "real.md"),
      "RQ1: visible question?",
      "utf-8",
    );

    const scan = await scanProjectResearchQuestions(ROOT);
    expect(scan.scannedFiles).toBe(1);
    expect(scan.questions).toHaveLength(1);
    expect(scan.questions[0].id).toBe("RQ1");
  });

  it("accepts a single markdown file root", async () => {
    const filePath = path.join(ROOT, "project-alpha.md");
    writeFileSync(
      filePath,
      ["## Research questions", "- Does file-mode scanning work?"].join("\n"),
      "utf-8",
    );

    const scan = await scanProjectResearchQuestions(filePath);
    expect(scan.scannedFiles).toBe(1);
    expect(scan.questions).toHaveLength(1);
    expect(scan.questions[0].file).toBe("project-alpha.md");
    expect(scan.questions[0].text).toBe("Does file-mode scanning work?");
  });
});
