import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PublicSkillIndex = {
  generatedAt: string;
  skills: Array<{
    slug: string;
  }>;
};

describe("workspace skill mirror", () => {
  it("mirrors every repo-tracked OpenClaw skill into the canonical workspace tree", () => {
    const repoRoot = process.cwd();
    const openclawRoot = path.join(repoRoot, ".openclaw", "skills");
    const workspaceRoot = path.join(repoRoot, "skills");
    const publicIndex = JSON.parse(
      readFileSync(path.join(workspaceRoot, "public-index.json"), "utf-8"),
    ) as PublicSkillIndex;
    const publicSlugs = new Set(publicIndex.skills.map((skill) => skill.slug));

    const skillSlugs = readdirSync(openclawRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillSlugs.length).toBeGreaterThan(0);

    for (const slug of skillSlugs) {
      const manifestPath = path.join(workspaceRoot, slug, "skill.json");
      const adapterPath = path.join(workspaceRoot, slug, "hosts", "openclaw", "SKILL.md");
      const projectionPath = path.join(openclawRoot, slug, "SKILL.md");

      expect(existsSync(manifestPath)).toBe(true);
      expect(existsSync(adapterPath)).toBe(true);

      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
        slug: string;
        visibility: string;
        hosts: string[];
      };
      expect(manifest.slug).toBe(slug);
      expect(manifest.visibility).toBe("public");
      expect(manifest.hosts).toContain("openclaw");
      expect(publicSlugs.has(slug)).toBe(true);

      expect(readFileSync(adapterPath, "utf-8")).toBe(
        readFileSync(projectionPath, "utf-8"),
      );
    }
  });
});
