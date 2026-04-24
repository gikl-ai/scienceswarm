import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";

const MD_SKILLS = [
  {
    slug: "scienceswarm-md-study-design",
    alias: "md-study",
    assetKind: "md_study_brief",
  },
  {
    slug: "scienceswarm-md-evidence-grounding",
    alias: "md-evidence",
    assetKind: "md_evidence_grounding_packet",
  },
  {
    slug: "scienceswarm-md-system-definition",
    alias: "md-system",
    assetKind: "md_system_definition",
  },
  {
    slug: "scienceswarm-md-parameter-planning",
    alias: "md-parameters",
    assetKind: "md_parameter_decision_ledger",
  },
  {
    slug: "scienceswarm-md-execution-handoff",
    alias: "md-handoff",
    assetKind: "md_execution_handoff_plan",
  },
  {
    slug: "scienceswarm-md-protocol-review",
    alias: "md-review",
    assetKind: "md_protocol_review_note",
  },
  {
    slug: "scienceswarm-md-results-interpretation",
    alias: "md-results",
    assetKind: "md_results_interpretation_note",
  },
  {
    slug: "scienceswarm-md-refinement-planning",
    alias: "md-refine",
    assetKind: "md_refinement_decision_update",
  },
] as const;

const HOSTS = ["openclaw", "claude-code", "codex"] as const;

describe("MD pipeline skill pack", () => {
  it("declares all eight first-party skills with cross-host adapters", () => {
    const repoRoot = process.cwd();
    const publicIndex = JSON.parse(
      readFileSync(path.join(repoRoot, "skills", "public-index.json"), "utf-8"),
    ) as { skills: Array<{ slug: string; hosts: string[] }> };
    const publicBySlug = new Map(publicIndex.skills.map((skill) => [skill.slug, skill]));

    for (const skill of MD_SKILLS) {
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
      expect(manifest.tags).toContain("molecular-dynamics");
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
        expect(raw).not.toMatch(/\/Users\/|\/home\/|clawfarm|project-beta|private planning/i);
      }
    }
  });

  it("syncs OpenClaw projections and short aliases for chat invocation", () => {
    const repoRoot = process.cwd();

    for (const skill of MD_SKILLS) {
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
      expect(parsed.data.tier).toBe("molecular-dynamics-pipeline");
    }
  });
});
