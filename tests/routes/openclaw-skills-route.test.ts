import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { isLocalRequestMock } = vi.hoisted(() => ({
  isLocalRequestMock: vi.fn(),
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: isLocalRequestMock,
}));

import { GET as listSkills } from "@/app/api/openclaw/skills/route";
import { PUT as saveSkill } from "@/app/api/openclaw/skills/[skill]/route";
import * as skillCatalog from "@/lib/openclaw/skill-catalog";

describe("openclaw skills routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    isLocalRequestMock.mockReset();
  });

  it("lists parsed OpenClaw skills", async () => {
    const repoRoot = createSkillRepo({
      "db-pubmed": `---
name: db-pubmed
description: Fetch papers from PubMed
---

# PubMed
`,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await listSkills();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]).toMatchObject({
      slug: "db-pubmed",
      description: "Fetch papers from PubMed",
    });
  });

  it("returns an empty list when the repo has no skills directory yet", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-skill-route-empty-"));
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await listSkills();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skills).toEqual([]);
  });

  it("returns a generic error when listing skills fails internally", async () => {
    vi.spyOn(skillCatalog, "listOpenClawSkills").mockRejectedValueOnce(new Error("private/path"));

    const response = await listSkills();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to load OpenClaw skills.");
  });

  it("saves validated markdown and rejects malformed frontmatter", async () => {
    const repoRoot = createSkillRepo({
      "db-pubmed": `---
name: db-pubmed
description: Fetch papers from PubMed
---

# PubMed
`,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const successResponse = await saveSkill(
      new Request("http://localhost/api/openclaw/skills/db-pubmed", {
        method: "PUT",
        body: JSON.stringify({
          markdown: `---
name: db-pubmed
description: Updated description
---

# PubMed
`,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ skill: "db-pubmed" }) },
    );
    const successBody = await successResponse.json();

    expect(successResponse.status).toBe(200);
    expect(successBody.skill.description).toBe("Updated description");

    const failureResponse = await saveSkill(
      new Request("http://localhost/api/openclaw/skills/db-pubmed", {
        method: "PUT",
        body: JSON.stringify({
          markdown: "# Missing frontmatter",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ skill: "db-pubmed" }) },
    );
    const failureBody = await failureResponse.json();

    expect(failureResponse.status).toBe(400);
    expect(failureBody.error).toMatch(/frontmatter/i);
  });

  it("rejects non-local write requests", async () => {
    isLocalRequestMock.mockResolvedValue(false);

    const response = await saveSkill(
      new Request("http://localhost/api/openclaw/skills/db-pubmed", {
        method: "PUT",
        body: JSON.stringify({ markdown: "# Blocked" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ skill: "db-pubmed" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe("Forbidden");
  });

  it("rejects null JSON payloads with a validation error", async () => {
    isLocalRequestMock.mockResolvedValue(true);

    const response = await saveSkill(
      new Request("http://localhost/api/openclaw/skills/db-pubmed", {
        method: "PUT",
        body: "null",
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ skill: "db-pubmed" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Request body must include markdown.");
  });

  it("returns 404 when a skill slug does not exist on disk", async () => {
    const repoRoot = createSkillRepo({
      "db-pubmed": `---
name: db-pubmed
description: Fetch papers from PubMed
---

# PubMed
`,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await saveSkill(
      new Request("http://localhost/api/openclaw/skills/db-does-not-exist", {
        method: "PUT",
        body: JSON.stringify({
          markdown: `---
name: db-does-not-exist
description: Missing skill
---

# Missing
`,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ skill: "db-does-not-exist" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toMatch(/db-does-not-exist/);
  });

  it("returns a generic error when saving fails unexpectedly", async () => {
    isLocalRequestMock.mockResolvedValue(true);
    vi.spyOn(skillCatalog, "saveOpenClawSkill").mockRejectedValueOnce(new Error("private/path"));

    const response = await saveSkill(
      new Request("http://localhost/api/openclaw/skills/db-pubmed", {
        method: "PUT",
        body: JSON.stringify({
          markdown: `---
name: db-pubmed
description: Updated description
---

# PubMed
`,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ skill: "db-pubmed" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to save OpenClaw skill.");
  });
});

function createSkillRepo(skills: Record<string, string>): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "openclaw-skill-route-"));
  mkdirSync(path.join(repoRoot, ".openclaw", "skills"), { recursive: true });

  for (const [slug, markdown] of Object.entries(skills)) {
    const skillDir = path.join(repoRoot, ".openclaw", "skills", slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), markdown, "utf-8");
  }

  return repoRoot;
}
