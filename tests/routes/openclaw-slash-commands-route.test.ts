import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as listSlashCommands } from "@/app/api/openclaw/slash-commands/route";
import * as skillRegistry from "@/lib/openclaw/skill-registry";

describe("openclaw slash commands route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists built-in and repo-backed chat slash commands", async () => {
    const repoRoot = createSkillRepo({
      "scienceswarm-capture": `---
name: scienceswarm-capture
description: Capture notes
---

# Capture
`,
      "db-pubmed": `---
name: db-pubmed
description: Search PubMed
runtime: in-session
---

# PubMed
`,
      "research-radar": `---
name: research-radar
description: Scheduled radar
runtime: separate-node-process
---

# Radar
`,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);

    const response = await listSlashCommands();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.commands).toHaveLength(3);
    expect(body.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "help", kind: "builtin" }),
        expect.objectContaining({
          command: "capture",
          kind: "skill",
          skillSlug: "scienceswarm-capture",
        }),
        expect.objectContaining({
          command: "pubmed",
          kind: "skill",
          skillSlug: "db-pubmed",
        }),
      ]),
    );
  });

  it("returns a generic error when slash-command loading fails", async () => {
    vi.spyOn(skillRegistry, "listScienceSwarmOpenClawSlashCommandSkills").mockRejectedValueOnce(
      new Error("private/path"),
    );

    const response = await listSlashCommands();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to load OpenClaw slash commands.");
  });
});

function createSkillRepo(skills: Record<string, string>): string {
  const repoRoot = mkdtempSync(
    path.join(tmpdir(), "openclaw-slash-command-route-"),
  );
  mkdirSync(path.join(repoRoot, ".openclaw", "skills"), { recursive: true });

  for (const [slug, markdown] of Object.entries(skills)) {
    const skillDir = path.join(repoRoot, ".openclaw", "skills", slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), markdown, "utf-8");
  }

  return repoRoot;
}
