import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  OpenClawSkillNotFoundError,
  OpenClawSkillValidationError,
  listOpenClawSkills,
  readOpenClawSkill,
  saveOpenClawSkill,
} from "@/lib/openclaw/skill-catalog";

describe("openclaw skill catalog", () => {
  it("lists repo-backed skills and sorts product skills before database skills", async () => {
    const repoRoot = createSkillRepo({
      "brain-maintenance": `---
name: brain-maintenance
description: Keep the brain healthy
runtime: in-session
---

# Brain maintenance
`,
      "db-pubmed": `---
name: db-pubmed
description: Query PubMed
tier: database
tools:
  - pubmed_fetch
---

# PubMed
`,
    });

    const skills = await listOpenClawSkills(repoRoot);

    expect(skills.map((skill) => skill.slug)).toEqual([
      "brain-maintenance",
      "db-pubmed",
    ]);
    expect(skills[1]).toMatchObject({
      name: "db-pubmed",
      tools: ["pubmed_fetch"],
      tier: "database",
    });
  });

  it("saves normalized markdown back to SKILL.md", async () => {
    const repoRoot = createSkillRepo({
      "db-pubmed": `---
name: db-pubmed
description: Query PubMed
---

# PubMed
`,
    });

    const saved = await saveOpenClawSkill(
      "db-pubmed",
      `---\r\nname: db-pubmed\r\ndescription: Updated PubMed description\r\ntools:\r\n  - pubmed_fetch\r\n---\r\n\r\n# Updated\r\n
`,
      repoRoot,
    );

    expect(saved.description).toBe("Updated PubMed description");
    expect(readFileSync(path.join(repoRoot, ".openclaw/skills/db-pubmed/SKILL.md"), "utf-8")).toContain(
      "description: Updated PubMed description\n",
    );
  });

  it("returns an empty catalog when the skills directory has not been created yet", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "skill-catalog-empty-"));

    await expect(listOpenClawSkills(repoRoot)).resolves.toEqual([]);
  });

  it("skips invalid skills without dropping the whole catalog", async () => {
    const repoRoot = createSkillRepo({
      "db-pubmed": `---
name: db-pubmed
description: Query PubMed
---

# PubMed
`,
      "broken-skill": `---
name: broken-skill
description: Broken: unquoted colon
---

# Broken
`,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const skills = await listOpenClawSkills(repoRoot);

      expect(skills.map((skill) => skill.slug)).toEqual(["db-pubmed"]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[openclaw] skipping invalid skill broken-skill:"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("surfaces missing skills as not found when saving", async () => {
    const repoRoot = createSkillRepo({
      "db-pubmed": `---
name: db-pubmed
description: Query PubMed
---

# PubMed
`,
    });

    await expect(
      saveOpenClawSkill(
        "db-does-not-exist",
        `---
name: db-does-not-exist
description: Missing skill
---

# Missing
`,
        repoRoot,
      ),
    ).rejects.toBeInstanceOf(OpenClawSkillNotFoundError);
  });

  it("rejects skill files that resolve outside the skills root", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "skill-catalog-symlink-"));
    const externalRoot = mkdtempSync(path.join(tmpdir(), "skill-catalog-external-"));
    const skillDir = path.join(repoRoot, ".openclaw", "skills", "db-pubmed");
    mkdirSync(skillDir, { recursive: true });

    const externalSkillFile = path.join(externalRoot, "SKILL.md");
    writeFileSync(
      externalSkillFile,
      `---
name: db-pubmed
description: Query PubMed
---

# PubMed
`,
      "utf-8",
    );
    symlinkSync(externalSkillFile, path.join(skillDir, "SKILL.md"));

    await expect(readOpenClawSkill("db-pubmed", repoRoot)).rejects.toBeInstanceOf(
      OpenClawSkillValidationError,
    );
  });

  it("rejects markdown without valid required frontmatter", async () => {
    const repoRoot = createSkillRepo({
      "db-pubmed": `---
name: db-pubmed
description: Query PubMed
---

# PubMed
`,
    });

    await expect(
      saveOpenClawSkill(
        "db-pubmed",
        `---
name: not-the-folder
description:
---

# Broken
`,
        repoRoot,
      ),
    ).rejects.toBeInstanceOf(OpenClawSkillValidationError);
  });
});

function createSkillRepo(skills: Record<string, string>): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "skill-catalog-"));
  mkdirSync(path.join(repoRoot, ".openclaw", "skills"), { recursive: true });

  for (const [slug, markdown] of Object.entries(skills)) {
    const skillDir = path.join(repoRoot, ".openclaw", "skills", slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), markdown, "utf-8");
  }

  return repoRoot;
}
