import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFINITIONS_DIR = join(
  process.cwd(),
  "src/lib/jobs/definitions",
);

function loadDefinition(kind: string): string | null {
  const filePath = join(DEFINITIONS_DIR, `${kind}.md`);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf8");
}

function assertHasFooter(body: string): void {
  expect(body).toMatch(/```json\s*\n\{[^]*"slugs"[^]*\n```/);
}

describe("revise_paper job definition", () => {
  const body = loadDefinition("revise_paper") ?? "";

  it("ships at src/lib/jobs/definitions/revise_paper.md", () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it("references the paper/plan/critique input refs the orchestrator substitutes", () => {
    expect(body).toContain("{{paper}}");
    expect(body).toContain("{{plan}}");
    expect(body).toContain("{{critique}}");
  });

  it("mandates the sandbox boundary and diff-scope discipline", () => {
    const normalized = body.replace(/\s+/g, " ");
    expect(normalized).toMatch(/Heavy compute stays in the sandbox/i);
    expect(normalized).toMatch(/targeted unified diff|targeted.*diff/i);
    expect(normalized).toMatch(/< 30% of the source lines/);
  });

  it("ends with a fenced JSON footer listing the revision slug", () => {
    assertHasFooter(body);
    expect(body).toContain('"slugs": ["{{paper}}-revision"]');
  });
});

describe("write_cover_letter job definition", () => {
  const body = loadDefinition("write_cover_letter") ?? "";

  it("ships at src/lib/jobs/definitions/write_cover_letter.md", () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it("references revision, paper, critique, and target_journal refs", () => {
    expect(body).toContain("{{revision}}");
    expect(body).toContain("{{paper}}");
    expect(body).toContain("{{critique}}");
    expect(body).toContain("{{target_journal}}");
  });

  it("enforces no overclaiming against the revision body", () => {
    const normalized = body.replace(/\s+/g, " ");
    expect(normalized).toMatch(/overclaiming|overclaim/i);
    expect(normalized).toMatch(/verifiable against the revision body/i);
  });

  it("ends with a fenced JSON footer listing the cover-letter slug", () => {
    assertHasFooter(body);
    expect(body).toContain('"slugs": ["{{revision}}-cover-letter"]');
  });
});

describe("rerun_stats_and_regenerate_figure job definition", () => {
  const body = loadDefinition("rerun_stats_and_regenerate_figure") ?? "";

  it("ships at src/lib/jobs/definitions/rerun_stats_and_regenerate_figure.md", () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it("references paper, data, and code input refs", () => {
    expect(body).toContain("{{paper}}");
    expect(body).toContain("{{data}}");
    expect(body).toContain("{{code}}");
  });

  it("mandates a fixed random seed for reproducibility", () => {
    expect(body).toMatch(/seed\s*=?\s*42/);
  });

  it("enforces every provenance field from plan §5.5", () => {
    expect(body).toContain("inputs");
    expect(body).toContain("code");
    expect(body).toContain("results");
    expect(body).toContain("seed");
    expect(body).toContain("env");
  });

  it("mandates PyMC for the Bayesian posterior path", () => {
    expect(body).toMatch(/PyMC|pymc/);
  });

  it("ends with a fenced JSON footer that lists stats-rerun slugs + figure file", () => {
    assertHasFooter(body);
    expect(body).toContain('{{paper}}-stats-rerun');
    expect(body).toContain('{{paper}}-stats-rerun-code');
  });
});

describe("translate_paper job definition", () => {
  const body = loadDefinition("translate_paper") ?? "";

  it("ships at src/lib/jobs/definitions/translate_paper.md", () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it("references paper, source_lang, and target_lang refs", () => {
    expect(body).toContain("{{paper}}");
    expect(body).toContain("{{source_lang}}");
    expect(body).toContain("{{target_lang}}");
  });

  it("mandates preserving numerical values verbatim", () => {
    expect(body).toMatch(/numerical values verbatim|numerical value.*verbatim/i);
  });

  it("requires back-translation similarity recorded in frontmatter", () => {
    expect(body).toContain("back_translation_similarity");
  });

  it("ends with a fenced JSON footer listing the translation slug", () => {
    assertHasFooter(body);
    expect(body).toContain('"slugs": ["{{paper}}-translation-{{target_lang}}"]');
  });
});

describe("job-definition markdown shape invariants", () => {
  it.each([
    "revise_paper",
    "write_cover_letter",
    "rerun_stats_and_regenerate_figure",
    "translate_paper",
  ])(
    "%s opens with 'You are running inside the ScienceSwarm custom sandbox' so the model knows the boundary",
    (kind) => {
      const body = loadDefinition(kind) ?? "";
      expect(body).toMatch(
        /You are running inside the ScienceSwarm custom sandbox/i,
      );
    },
  );

  it.each([
    "revise_paper",
    "write_cover_letter",
    "rerun_stats_and_regenerate_figure",
    "translate_paper",
  ])("%s ends with a JSON-in-fence footer", (kind) => {
    const body = loadDefinition(kind) ?? "";
    assertHasFooter(body);
  });
});
