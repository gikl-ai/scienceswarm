import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import type { ProjectManifest } from "@/brain/types";
import { getAuditLogPath } from "@/lib/state/audit-log";
import { readProjectManifest, writeProjectManifest } from "@/lib/state/project-manifests";

const { runArtifact } = vi.hoisted(() => ({
  runArtifact: vi.fn(),
}));

vi.mock("@/lib/artifacts/run-artifact", () => ({
  runArtifact,
}));

const TEST_ROOT = path.join(tmpdir(), "scienceswarm-api-artifacts-create");

import { POST } from "@/app/api/artifacts/create/route";

let originalScienceSwarmDir: string | undefined;
let originalBrainRoot: string | undefined;

beforeEach(() => {
  originalScienceSwarmDir = process.env.SCIENCESWARM_DIR;
  originalBrainRoot = process.env.BRAIN_ROOT;
  rmSync(TEST_ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = TEST_ROOT;
  delete process.env.BRAIN_ROOT;
  initBrain({ root: path.join(TEST_ROOT, "brain"), name: "Artifact Tester" });
  runArtifact.mockReset();
  runArtifact.mockResolvedValue({
    conversationId: "conv-1",
    title: "Primer Design Memo",
    fileName: "primer-design-memo.md",
    content: "# Memo\n\nDraft memo body.",
    assumptions: ["Assumes the imported assay notes are current."],
    reviewFirst: ["Verify the assay constraints against the latest notebook."],
    rawResponse: [
      "```json",
      JSON.stringify({
        title: "Primer Design Memo",
        fileName: "primer-design-memo.md",
        content: "# Memo\n\nDraft memo body.",
        assumptions: ["Assumes the imported assay notes are current."],
        reviewFirst: ["Verify the assay constraints against the latest notebook."],
      }),
      "```",
    ].join("\n"),
  });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  if (originalScienceSwarmDir === undefined) {
    delete process.env.SCIENCESWARM_DIR;
  } else {
    process.env.SCIENCESWARM_DIR = originalScienceSwarmDir;
  }

  if (originalBrainRoot === undefined) {
    delete process.env.BRAIN_ROOT;
  } else {
    process.env.BRAIN_ROOT = originalBrainRoot;
  }
});

describe("POST /api/artifacts/create", () => {
  it("validates intent, builds context, saves the artifact, and links it into project memory", async () => {
    await seedProjectManifest();

    const response = await POST(
      artifactRequest({
        project: "Project Alpha",
        artifactType: "memo",
        intent: "Create a memo summarizing the primer design tradeoffs from the latest discussion.",
        conversationId: "conv-seed",
        messageIds: ["msg-2", "msg-1"],
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("completed");
    expect(body.savePath).toMatch(/^project-alpha\/artifacts\/memo\//);
    expect(body.artifactPage).toMatch(/^wiki\/entities\/artifacts\//);
    expect(body.assumptions).toEqual(["Assumes the imported assay notes are current."]);
    expect(body.reviewFirst).toEqual(["Verify the assay constraints against the latest notebook."]);

    expect(runArtifact).toHaveBeenCalledTimes(1);
    const bundle = runArtifact.mock.calls[0][0];
    expect(bundle.projectTitle).toBe("Project Alpha");
    expect(bundle.decisions).toHaveLength(1);
    expect(bundle.tasks).toHaveLength(1);
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.sourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "import", ref: "raw/imports/project-alpha" }),
        expect.objectContaining({ kind: "conversation", ref: "conv-seed" }),
        expect.objectContaining({ kind: "conversation", ref: "msg-1" }),
        expect.objectContaining({ kind: "conversation", ref: "msg-2" }),
      ]),
    );
    expect(bundle.prompt).toContain("Study page");
    expect(bundle.prompt).toContain("Recent decisions");

    const savedArtifact = path.join(TEST_ROOT, "workspace", body.savePath);
    expect(readFileSync(savedArtifact, "utf-8")).toContain("Draft memo body.");

    const artifactPage = path.join(TEST_ROOT, "brain", body.artifactPage);
    const artifactPageContent = readFileSync(artifactPage, "utf-8");
    expect(artifactPageContent).toContain("## Assumptions");
    expect(artifactPageContent).toContain("## Review First");
    expect(artifactPageContent).toContain("project-alpha/artifacts/memo");

    const projectPage = readFileSync(
      path.join(TEST_ROOT, "brain", "wiki", "projects", "project-alpha.md"),
      "utf-8",
    );
    expect(projectPage).toContain("## Artifacts");
    expect(projectPage).toContain(body.artifactPage);

    const manifest = await readProjectManifest("project-alpha", path.join(TEST_ROOT, "brain", "state"));
    expect(manifest?.artifactPaths).toEqual(
      expect.arrayContaining([
        "wiki/entities/artifacts/2026-04-07-existing-artifact.md",
        body.artifactPage,
      ]),
    );
  });

  it("reuses the same job for duplicate requests instead of re-running execution", async () => {
    await seedProjectManifest();

    const payload = {
      project: "Project Alpha",
      artifactType: "memo",
      intent: "Create a memo summarizing the primer design tradeoffs from the latest discussion.",
      conversationId: "conv-seed",
    };

    const firstResponse = await POST(artifactRequest(payload));
    const firstBody = await firstResponse.json();
    const secondResponse = await POST(artifactRequest(payload));
    const secondBody = await secondResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(runArtifact).toHaveBeenCalledTimes(1);
    expect(secondBody).toEqual(firstBody);
  });

  it("reserves one running job for concurrent duplicate requests", async () => {
    await seedProjectManifest();

    let releaseRunArtifact!: () => void;
    runArtifact.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRunArtifact = () =>
            resolve({
              conversationId: "conv-1",
              title: "Primer Design Memo",
              fileName: "primer-design-memo.md",
              content: "# Memo\n\nDraft memo body.",
              assumptions: ["Assumes the imported assay notes are current."],
              reviewFirst: ["Verify the assay constraints against the latest notebook."],
              rawResponse: "```json\n{\"title\":\"Primer Design Memo\",\"content\":\"# Memo\"}\n```",
            });
        }),
    );

    const payload = {
      project: "Project Alpha",
      artifactType: "memo",
      intent: "Create a memo summarizing the primer design tradeoffs from the latest discussion.",
      conversationId: "conv-seed",
    };

    const firstResponsePromise = POST(artifactRequest(payload));
    await vi.waitFor(() => expect(runArtifact).toHaveBeenCalledTimes(1));
    const secondResponsePromise = POST(artifactRequest(payload));
    const secondResponse = await secondResponsePromise;
    const secondBody = await secondResponse.json();
    expect(secondResponse.status).toBe(200);
    expect(secondBody.status).toBe("running");

    releaseRunArtifact();

    const firstResponse = await firstResponsePromise;
    const firstBody = await firstResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(runArtifact).toHaveBeenCalledTimes(1);
    expect(firstBody.status).toBe("completed");
  });

  it("blocks local-only projects before execution and records an audit event", async () => {
    await seedProjectManifest({ privacy: "local-only" });

    const response = await POST(
      artifactRequest({
        project: "Project Alpha",
        artifactType: "plan",
        intent: "Create a project plan for the next wet-lab validation pass.",
      }),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("execution-ok privacy");
    expect(runArtifact).not.toHaveBeenCalled();

    const auditLines = readFileSync(getAuditLogPath(path.join(TEST_ROOT, "brain", "state")), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(auditLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "policy",
          action: "deny",
          route: "/api/artifacts/create",
          privacy: "local-only",
        }),
      ]),
    );
  });

  it("rejects vague brainstorming prompts that are not explicit artifact requests", async () => {
    await seedProjectManifest();

    const response = await POST(
      artifactRequest({
        project: "Project Alpha",
        artifactType: "memo",
        intent: "brainstorm ideas",
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("explicit make-the-artifact request");
    expect(runArtifact).not.toHaveBeenCalled();
  });

  it("creates the artifact page directory on fresh installs", async () => {
    await seedProjectManifest();
    rmSync(path.join(TEST_ROOT, "brain", "wiki", "entities", "artifacts"), { recursive: true, force: true });

    const response = await POST(
      artifactRequest({
        project: "Project Alpha",
        artifactType: "memo",
        intent: "Create a memo summarizing the primer design tradeoffs from the latest discussion.",
        conversationId: "conv-seed",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(readFileSync(path.join(TEST_ROOT, "brain", body.artifactPage), "utf-8")).toContain("Primer Design Memo");
  });

  it("returns 400 for malformed JSON bodies", async () => {
    const response = await POST(
      new Request("http://localhost/api/artifacts/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "{invalid",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
  });
});

async function seedProjectManifest(overrides: Partial<ProjectManifest> = {}) {
  mkdirSync(path.join(TEST_ROOT, "brain", "wiki", "projects"), { recursive: true });
  mkdirSync(path.join(TEST_ROOT, "brain", "wiki", "decisions"), { recursive: true });
  mkdirSync(path.join(TEST_ROOT, "brain", "wiki", "tasks"), { recursive: true });
  mkdirSync(path.join(TEST_ROOT, "brain", "wiki", "entities", "artifacts"), { recursive: true });

  writeFileSync(
    path.join(TEST_ROOT, "brain", "wiki", "projects", "project-alpha.md"),
    [
      "---",
      "date: 2026-04-08",
      "type: study",
      "para: projects",
      "title: Project Alpha",
      "tags: [alpha]",
      "---",
      "",
      "# Project Alpha",
      "",
      "## Summary",
      "Core assay optimization project.",
    ].join("\n"),
  );

  writeFileSync(
    path.join(TEST_ROOT, "brain", "wiki", "decisions", "2026-04-08-primer-decision.md"),
    "# Primer Decision\n\nUse the low-temperature primer set for validation.",
  );
  writeFileSync(
    path.join(TEST_ROOT, "brain", "wiki", "tasks", "2026-04-08-verify-assay.md"),
    "# Verify Assay\n\nConfirm assay temperature constraints.",
  );
  writeFileSync(
    path.join(TEST_ROOT, "brain", "wiki", "entities", "artifacts", "2026-04-07-existing-artifact.md"),
    "# Existing Artifact\n\nEarlier artifact context.",
  );

  const manifest: ProjectManifest = {
    version: 1,
    projectId: "project-alpha",
    slug: "project-alpha",
    title: "Project Alpha",
    privacy: "execution-ok",
    status: "active",
    projectPagePath: "wiki/projects/project-alpha.md",
    sourceRefs: [{ kind: "import", ref: "raw/imports/project-alpha" }],
    decisionPaths: ["wiki/decisions/2026-04-08-primer-decision.md"],
    taskPaths: ["wiki/tasks/2026-04-08-verify-assay.md"],
    artifactPaths: ["wiki/entities/artifacts/2026-04-07-existing-artifact.md"],
    frontierPaths: [],
    activeThreads: [],
    dedupeKeys: [],
    updatedAt: "2026-04-08T00:00:00.000Z",
    ...overrides,
  };

  await writeProjectManifest(manifest, path.join(TEST_ROOT, "brain", "state"));
}

function artifactRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/artifacts/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
