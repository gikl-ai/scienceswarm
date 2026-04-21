import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSkillRecord } from "@/lib/skills/schema";

const { isLocalRequestMock } = vi.hoisted(() => ({
  isLocalRequestMock: vi.fn(),
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: isLocalRequestMock,
}));

import { GET as listSkills, POST as createSkill } from "@/app/api/skills/route";
import { POST as importSkill } from "@/app/api/skills/import/route";
import { PUT as saveSkill } from "@/app/api/skills/[skill]/route";
import { POST as promoteSkill } from "@/app/api/skills/[skill]/promote/route";
import { POST as syncSkill } from "@/app/api/skills/[skill]/sync/route";
import * as workspaceLib from "@/lib/skills/workspace";

describe("workspace skills routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    isLocalRequestMock.mockReset();
  });

  it("lists workspace skills and host definitions", async () => {
    const repoRoot = createWorkspaceRepo({
      slug: "db-pubmed",
      description: "Fetch papers from PubMed",
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await listSkills(new Request("http://localhost/api/skills"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]).toMatchObject({
      slug: "db-pubmed",
      description: "Fetch papers from PubMed",
    });
    expect(body.hosts.some((host: { host: string }) => host.host === "openclaw")).toBe(true);
  });

  it("rejects remote workspace skill listings", async () => {
    isLocalRequestMock.mockResolvedValue(false);

    const response = await listSkills(new Request("https://example.com/api/skills"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: "Forbidden" });
  });

  it("degrades invalid adapters instead of failing the full workspace listing", async () => {
    const repoRoot = createWorkspaceRepo({
      slug: "db-pubmed",
      description: "Fetch papers from PubMed",
      markdown: "# invalid-adapter\n",
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await listSkills(new Request("http://localhost/api/skills"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skills[0].adapters[0]).toMatchObject({
      host: "openclaw",
      syncState: "missing-adapter",
      rawMarkdown: "",
    });
  });

  it("creates a new workspace skill on local requests", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "workspace-skill-route-create-"));
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await createSkill(
      new Request("http://localhost/api/skills", {
        method: "POST",
        body: JSON.stringify({
          slug: "claim-checker",
          name: "Claim Checker",
          description: "Cross-check scientific claims.",
          hosts: ["openclaw", "codex"],
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.skill).toMatchObject({
      slug: "claim-checker",
      name: "Claim Checker",
      visibility: "private",
      hosts: ["openclaw", "codex"],
    });
    expect(
      existsSync(path.join(repoRoot, "skills", "claim-checker", "hosts", "openclaw", "SKILL.md")),
    ).toBe(true);
    expect(
      existsSync(path.join(repoRoot, "skills", "claim-checker", "hosts", "codex", "SKILL.md")),
    ).toBe(true);
  });

  it("saves manifest changes, clears owner metadata, and updates adapter markdown", async () => {
    const repoRoot = createWorkspaceRepo({
      slug: "db-pubmed",
      description: "Fetch papers from PubMed",
      owner: "scienceswarm",
      summary: "Old summary",
      visibility: "public",
      markdown: `---
name: db-pubmed
description: Fetch papers from PubMed
---

# db-pubmed
`,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await saveSkill(
      new Request("http://localhost/api/skills/db-pubmed", {
        method: "PUT",
        body: JSON.stringify({
          manifest: {
            visibility: "private",
            owner: "",
            summary: "",
          },
          adapterHost: "openclaw",
          markdown: `---
name: db-pubmed
description: Updated PubMed description
---

# db-pubmed
`,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ skill: "db-pubmed" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skill).toMatchObject({
      slug: "db-pubmed",
      visibility: "private",
      owner: null,
      summary: null,
    });
    expect(body.skill.adapters[0].rawMarkdown).toContain("Updated PubMed description");
  });

  it("rejects direct publication through the generic save route", async () => {
    const repoRoot = createWorkspaceRepo({
      slug: "db-pubmed",
      description: "Fetch papers from PubMed",
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await saveSkill(
      new Request("http://localhost/api/skills/db-pubmed", {
        method: "PUT",
        body: JSON.stringify({
          manifest: {
            visibility: "public",
          },
        }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ skill: "db-pubmed" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Use the promote flow");
  });

  it("syncs host outputs from the workspace source of truth", async () => {
    const repoRoot = createWorkspaceRepo({
      slug: "db-pubmed",
      description: "Fetch papers from PubMed",
      markdown: `---
name: db-pubmed
description: Fetch papers from PubMed
---

# db-pubmed
`,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await syncSkill(
      new Request("http://localhost/api/skills/db-pubmed/sync", {
        method: "POST",
        body: JSON.stringify({ hosts: ["openclaw"] }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ skill: "db-pubmed" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skill.adapters[0].syncState).toBe("synced");
    expect(
      readFileSync(path.join(repoRoot, ".openclaw", "skills", "db-pubmed", "SKILL.md"), "utf-8"),
    ).toContain("Fetch papers from PubMed");
  });

  it("rejects invalid JSON in the sync route instead of syncing all hosts", async () => {
    const repoRoot = createWorkspaceRepo({
      slug: "db-pubmed",
      description: "Fetch papers from PubMed",
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await syncSkill(
      new Request("http://localhost/api/skills/db-pubmed/sync", {
        method: "POST",
        body: "{",
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ skill: "db-pubmed" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("valid JSON");
    expect(existsSync(path.join(repoRoot, ".openclaw", "skills", "db-pubmed", "SKILL.md"))).toBe(false);
  });

  it("promotes a ready private skill into the public catalog and syncs host outputs", async () => {
    const repoRoot = createWorkspaceRepo({
      slug: "claim-checker",
      description: "Cross-check scientific claims",
      status: "ready",
      tags: ["science"],
      summary: "Compares claims against supporting and conflicting evidence before publication.",
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await promoteSkill(
      new Request("http://localhost/api/skills/claim-checker/promote", {
        method: "POST",
      }),
      { params: Promise.resolve({ skill: "claim-checker" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.skill).toMatchObject({
      slug: "claim-checker",
      visibility: "public",
    });
    expect(body.skill.adapters[0].syncState).toBe("synced");
    expect(
      readFileSync(path.join(repoRoot, ".openclaw", "skills", "claim-checker", "SKILL.md"), "utf-8"),
    ).toContain("Cross-check scientific claims");

    const publicIndex = JSON.parse(
      readFileSync(path.join(repoRoot, "skills", "public-index.json"), "utf-8"),
    ) as { skills: Array<{ slug: string }> };
    expect(publicIndex.skills.some((skill) => skill.slug === "claim-checker")).toBe(true);
  });

  it("rejects promotion when required public metadata is missing", async () => {
    const repoRoot = createWorkspaceRepo({
      slug: "claim-checker",
      description: "Cross-check scientific claims",
      status: "draft",
      tags: [],
      summary: null,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    isLocalRequestMock.mockResolvedValue(true);

    const response = await promoteSkill(
      new Request("http://localhost/api/skills/claim-checker/promote", {
        method: "POST",
      }),
      { params: Promise.resolve({ skill: "claim-checker" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('mark the skill status as "ready"');
    expect(body.error).toContain("add at least one catalog tag");
    expect(body.error).toContain("add a public summary");
  });

  it("delegates imports through the workspace importer", async () => {
    isLocalRequestMock.mockResolvedValue(true);
    vi.spyOn(workspaceLib, "importWorkspaceSkillFromGitHub").mockResolvedValue(
      buildWorkspaceSkillRecord("imported-skill"),
    );

    const response = await importSkill(
      new Request("http://localhost/api/skills/import", {
        method: "POST",
        body: JSON.stringify({
          repo: "owner/repo",
          path: "skills/imported-skill",
          host: "openclaw",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.skill.slug).toBe("imported-skill");
    expect(workspaceLib.importWorkspaceSkillFromGitHub).toHaveBeenCalledWith({
      repo: "owner/repo",
      path: "skills/imported-skill",
      host: "openclaw",
      ref: "main",
      slug: undefined,
      visibility: "private",
      status: "draft",
      owner: null,
      tags: [],
      summary: null,
    });
  });

  it("rejects invalid import repo slugs before attempting a clone", async () => {
    isLocalRequestMock.mockResolvedValue(true);

    const response = await importSkill(
      new Request("http://localhost/api/skills/import", {
        method: "POST",
        body: JSON.stringify({
          repo: "user@evil.com/path",
          path: "skills/imported-skill",
          host: "openclaw",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('Expected "owner/name"');
  });
});

function createWorkspaceRepo(input: {
  slug: string;
  description: string;
  markdown?: string;
  visibility?: "public" | "private";
  status?: "draft" | "ready";
  tags?: string[];
  owner?: string | null;
  summary?: string | null;
}): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "workspace-skill-route-"));
  const skillRoot = path.join(repoRoot, "skills", input.slug);
  mkdirSync(path.join(skillRoot, "hosts", "openclaw"), { recursive: true });

  writeFileSync(
    path.join(skillRoot, "skill.json"),
    JSON.stringify({
      slug: input.slug,
      name: input.slug,
      description: input.description,
      visibility: input.visibility ?? "private",
      status: input.status ?? "draft",
      tags: input.tags ?? [],
      hosts: ["openclaw"],
      owner: input.owner ?? null,
      summary: input.summary ?? null,
      source: { kind: "local" },
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    }, null, 2) + "\n",
    "utf-8",
  );

  writeFileSync(
    path.join(skillRoot, "hosts", "openclaw", "SKILL.md"),
    input.markdown ?? `---
name: ${input.slug}
description: ${input.description}
---

# ${input.slug}
`,
    "utf-8",
  );

  return repoRoot;
}

function buildWorkspaceSkillRecord(slug: string): WorkspaceSkillRecord {
  return {
    slug,
    name: slug,
    description: `Description for ${slug}`,
    visibility: "private",
    status: "draft",
    tags: [],
    hosts: ["openclaw"],
    owner: null,
    summary: null,
    source: { kind: "local" },
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    adapters: [
      {
        host: "openclaw",
        relativePath: `skills/${slug}/hosts/openclaw/SKILL.md`,
        syncTargetPath: `.openclaw/skills/${slug}/SKILL.md`,
        syncState: "pending",
        rawMarkdown: `---
name: ${slug}
description: Description for ${slug}
---

# ${slug}
`,
      },
    ],
  };
}
