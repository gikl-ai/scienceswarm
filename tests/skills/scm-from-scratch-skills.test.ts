import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";

const SCM_SCRATCH_SKILLS = [
  {
    slug: "scienceswarm-scm-scratch-question-design",
    alias: "scm-scratch-question",
    assetKind: "scm_scratch_study_brief",
  },
  {
    slug: "scienceswarm-scm-scratch-data-authoring",
    alias: "scm-scratch-data",
    assetKind: "scm_scratch_data_plan",
  },
  {
    slug: "scienceswarm-scm-scratch-pretreatment-fit",
    alias: "scm-scratch-fit",
    assetKind: "scm_scratch_fit_note",
  },
  {
    slug: "scienceswarm-scm-scratch-method-choice",
    alias: "scm-scratch-methods",
    assetKind: "scm_scratch_method_choice_note",
  },
  {
    slug: "scienceswarm-scm-scratch-inference-placebos",
    alias: "scm-scratch-inference",
    assetKind: "scm_scratch_inference_note",
  },
  {
    slug: "scienceswarm-scm-scratch-results-report",
    alias: "scm-scratch-report",
    assetKind: "scm_scratch_results_report",
  },
] as const;

const HOSTS = ["openclaw", "claude-code", "codex"] as const;

describe("SCM from-scratch skill pack", () => {
  it("declares all six from-scratch skills with approval-gated contracts", () => {
    const repoRoot = process.cwd();
    const publicIndex = JSON.parse(
      readFileSync(path.join(repoRoot, "skills", "public-index.json"), "utf-8"),
    ) as { skills: Array<{ slug: string; hosts: string[] }> };
    const publicBySlug = new Map(publicIndex.skills.map((skill) => [skill.slug, skill]));

    for (const skill of SCM_SCRATCH_SKILLS) {
      const manifestPath = path.join(repoRoot, "skills", skill.slug, "skill.json");
      expect(existsSync(manifestPath), `${skill.slug} manifest`).toBe(true);

      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        slug: string;
        visibility: string;
        status: string;
        tags: string[];
        hosts: string[];
      };
      expect(manifest).toMatchObject({
        slug: skill.slug,
        visibility: "public",
        status: "ready",
      });
      expect(manifest.tags).toContain("synthetic-control");
      expect(manifest.tags).toContain("from-scratch");
      expect(manifest.hosts).toEqual([...HOSTS]);
      const publicEntry = publicBySlug.get(skill.slug);
      expect(publicEntry, `${skill.slug} missing from public index`).toBeDefined();
      expect(publicEntry!.hosts).toEqual([...HOSTS]);

      for (const host of HOSTS) {
        const adapterPath = path.join(
          repoRoot,
          "skills",
          skill.slug,
          "hosts",
          host,
          "SKILL.md",
        );
        expect(existsSync(adapterPath), `${skill.slug} ${host} adapter`).toBe(true);
        const raw = readFileSync(adapterPath, "utf-8");
        const parsed = matter(raw);

        expect(parsed.data.name).toBe(skill.slug);
        expect(parsed.data.tier).toBe("synthetic-control-from-scratch");
        expect(parsed.data.aliases).toContain(skill.alias);
        expect(raw).toContain(skill.assetKind);
        expect(raw).toContain("Execution Gate");
        expect(raw).toContain("gbrain_capture");
        expect(raw).toContain("analysis/scm-from-scratch");
        expect(raw).toContain("Confidence Boundary");
        expect(raw).not.toMatch(/\/Users\/|\/home\/|clawfarm|project-beta|private planning/i);
        if (skill.slug !== "scienceswarm-scm-scratch-question-design") {
          expect(raw).toContain("Dependency Policy");
          expect(raw).toContain("Do not write `install.packages(...)`");
          expect(raw).toContain("must stop with a clear missing-dependency message");
        }
        if (skill.slug === "scienceswarm-scm-scratch-data-authoring") {
          expect(raw).toContain("sparse auxiliary predictors");
          expect(raw).toContain("optional predictor is sparse");
          expect(raw).toContain("do not exclude Madrid, Catalonia, or Navarre");
        }
        if (skill.slug === "scienceswarm-scm-scratch-question-design") {
          expect(raw).toContain("main donor pools comparable to the SCM-IR quickstart");
          expect(raw).toContain("Madrid, Catalonia, or Navarre belong in sensitivity checks");
        }
        if (skill.slug === "scienceswarm-scm-scratch-pretreatment-fit") {
          expect(raw).toContain("SCM-IR quickstart-compatible gate");
          expect(raw).toContain("at most 0.25");
        }
        if (skill.slug === "scienceswarm-scm-scratch-method-choice") {
          expect(raw).toContain("Shape Validation Policy");
          expect(raw).toContain("treated and donor columns must be present");
          expect(raw).toContain("pre/post indices must be non-empty");
          expect(raw).toContain("method-comparison.csv");
        }
        if (skill.slug === "scienceswarm-scm-scratch-inference-placebos") {
          expect(raw).toContain("Refit Validation Policy");
          expect(raw).toContain("treated and donor identifiers");
          expect(raw).toContain("non-empty pre/post windows");
          expect(raw).toContain("placebo-summary.csv");
          expect(raw).toContain("leave-one-out.csv");
        }
      }
    }
  });

  it("syncs OpenClaw projections and short aliases for chat invocation", () => {
    const repoRoot = process.cwd();

    for (const skill of SCM_SCRATCH_SKILLS) {
      const adapterPath = path.join(
        repoRoot,
        "skills",
        skill.slug,
        "hosts",
        "openclaw",
        "SKILL.md",
      );
      const projectionPath = path.join(
        repoRoot,
        ".openclaw",
        "skills",
        skill.slug,
        "SKILL.md",
      );
      const adapter = readFileSync(adapterPath, "utf-8");
      const projection = readFileSync(projectionPath, "utf-8");
      const parsed = matter(projection);

      expect(projection).toBe(adapter);
      expect(parsed.data.aliases).toContain(skill.alias);
      expect(parsed.data.runtime).toBe("in-session");
      expect(parsed.data.tier).toBe("synthetic-control-from-scratch");
    }
  });

  it("documents the UI-only from-scratch walkthrough without relying on prewritten scripts", () => {
    const repoRoot = process.cwd();
    const tutorial = readFileSync(
      path.join(repoRoot, "docs", "tutorials", "scm-from-scratch", "README.md"),
      "utf-8",
    );
    const tutorialIndex = readFileSync(
      path.join(repoRoot, "docs", "tutorials", "README.md"),
      "utf-8",
    );

    expect(tutorialIndex).toContain("scm-from-scratch/README.md");
    expect(tutorial).toContain("No terminal is required");
    expect(tutorial).toMatch(/Do not copy or require existing\s+quickstart scripts/);
    expect(tutorial).toContain("analysis/scm-from-scratch/code/01_acquire_data.R");
    expect(tutorial).toContain("analysis/scm-from-scratch/output/scm-from-scratch-report.html");
    expect(tutorial).toContain("classic Abadie synthetic control");
    expect(tutorial).toContain("method comparison");
    expect(tutorial).toContain("in-space and in-time placebo checks");
    expect(tutorial).toMatch(/should not install packages\s+automatically/);
    expect(tutorial).toContain("sparse auxiliary predictors");
    expect(tutorial).toContain("optional drops");
    expect(tutorial).toContain("Madrid, Catalonia, and Navarre for sensitivity checks");
    expect(tutorial).toMatch(/pre-RMSPE divided by outcome\s+standard deviation should be at most 0\.25/);

    for (const skill of SCM_SCRATCH_SKILLS) {
      expect(tutorial).toContain(`/${skill.alias}`);
      expect(tutorial).toContain(skill.assetKind);
    }

    expect(tutorial).not.toMatch(/Rscript\s+|run scripts\/0[1-6]|open output\//i);
  });
});
