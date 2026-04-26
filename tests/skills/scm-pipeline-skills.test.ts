import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";

const SCM_SKILLS = [
  {
    slug: "scienceswarm-scm-question-design",
    alias: "scm-question",
    assetKind: "scm_study_brief",
  },
  {
    slug: "scienceswarm-scm-data-acquisition",
    alias: "scm-data",
    assetKind: "scm_data_manifest",
  },
  {
    slug: "scienceswarm-scm-pretreatment-fit",
    alias: "scm-fit",
    assetKind: "scm_pretreatment_fit_note",
  },
  {
    slug: "scienceswarm-scm-method-comparison",
    alias: "scm-methods",
    assetKind: "scm_method_comparison_note",
  },
  {
    slug: "scienceswarm-scm-inference-and-placebos",
    alias: "scm-inference",
    assetKind: "scm_inference_note",
  },
  {
    slug: "scienceswarm-scm-results-rendering",
    alias: "scm-report",
    assetKind: "scm_results_report",
  },
] as const;

const HOSTS = ["openclaw", "claude-code", "codex"] as const;

describe("SCM pipeline skill pack", () => {
  it("declares all six first-party skills with cross-host adapters", () => {
    const repoRoot = process.cwd();
    const publicIndex = JSON.parse(
      readFileSync(path.join(repoRoot, "skills", "public-index.json"), "utf-8"),
    ) as { skills: Array<{ slug: string; hosts: string[] }> };
    const publicBySlug = new Map(publicIndex.skills.map((skill) => [skill.slug, skill]));

    for (const skill of SCM_SKILLS) {
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
      expect(manifest.hosts).toEqual([...HOSTS]);
      expect(publicBySlug.get(skill.slug)?.hosts).toEqual([...HOSTS]);

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
        expect(parsed.data.description).toEqual(expect.any(String));
        expect(raw).toContain(skill.assetKind);
        expect(raw).toContain("Confidence Boundary");
        expect(raw).toContain("gbrain_capture");
        expect(raw).not.toMatch(/\/Users\/|\/home\/|clawfarm|project-beta|private planning/i);
      }
    }
  });

  it("syncs OpenClaw projections and short aliases for chat invocation", () => {
    const repoRoot = process.cwd();

    for (const skill of SCM_SKILLS) {
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
      expect(parsed.data.tier).toBe("synthetic-control-pipeline");
    }
  });
});
