import path from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import { getAuditLogPath } from "@/lib/state/audit-log";
import { writeProjectManifest } from "@/lib/state/project-manifests";
import type { ProjectManifest } from "@/brain/types";

const DATA_ROOT = path.join(tmpdir(), "scienceswarm-mvp-conversation-artifact");
const BRAIN_ROOT = path.join(DATA_ROOT, "brain");

const { runArtifact } = vi.hoisted(() => ({
  runArtifact: vi.fn(),
}));

vi.mock("@/lib/artifacts/run-artifact", () => ({
  runArtifact,
}));

const mockLoadBrainConfig = vi.fn();
vi.mock("@/brain/config", () => ({
  loadBrainConfig: () => mockLoadBrainConfig(),
  resolveBrainRoot: () => BRAIN_ROOT,
  brainExists: () => true,
}));

function makeConfig() {
  return {
    root: BRAIN_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function seedProjectManifest(): Promise<ProjectManifest> {
  mkdirSync(path.join(BRAIN_ROOT, "wiki", "projects"), { recursive: true });
  mkdirSync(path.join(BRAIN_ROOT, "wiki", "entities", "decisions"), { recursive: true });
  mkdirSync(path.join(BRAIN_ROOT, "wiki", "entities", "tasks"), { recursive: true });
  mkdirSync(path.join(BRAIN_ROOT, "wiki", "entities", "artifacts"), { recursive: true });

  writeFileSync(
    path.join(BRAIN_ROOT, "wiki", "projects", "alpha.md"),
    "# Alpha\n\n## Summary\nAlpha project summary.",
  );
  writeFileSync(
    path.join(BRAIN_ROOT, "wiki", "entities", "decisions", "alpha-decision.md"),
    "---\ntype: decision\nstatus: open\n---\n# Decide primer strategy\n",
  );
  writeFileSync(
    path.join(BRAIN_ROOT, "wiki", "entities", "tasks", "alpha-task.md"),
    "---\ntype: task\nstatus: open\n---\n# Review assay notes\n",
  );

  return writeProjectManifest(
    {
      version: 1,
      projectId: "alpha",
      slug: "alpha",
      title: "Alpha",
      privacy: "execution-ok",
      status: "active",
      projectPagePath: "wiki/projects/alpha.md",
      sourceRefs: [{ kind: "import", ref: "raw/imports/alpha" }],
      decisionPaths: ["wiki/decisions/alpha-decision.md"],
      taskPaths: ["wiki/tasks/alpha-task.md"],
      artifactPaths: [],
      frontierPaths: [],
      activeThreads: [],
      dedupeKeys: [],
      updatedAt: "2026-04-08T00:00:00.000Z",
    },
    path.join(BRAIN_ROOT, "state"),
  );
}

beforeEach(async () => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = DATA_ROOT;
  initBrain({ root: BRAIN_ROOT, name: "Test Researcher" });
  mockLoadBrainConfig.mockReturnValue(makeConfig());
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
  await seedProjectManifest();
});

afterEach(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
  delete process.env.SCIENCESWARM_DIR;
  mockLoadBrainConfig.mockReset();
});

describe("MVP conversation to artifact", () => {
  it("creates an artifact page and back-links it into project memory", async () => {
    const { POST: createArtifact } = await import("@/app/api/artifacts/create/route");

    const response = await createArtifact(
      new Request("http://localhost/api/artifacts/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: "Alpha",
          artifactType: "memo",
          intent: "Create a memo summarizing the primer design tradeoffs from the latest discussion.",
          conversationId: "conv-seed",
          messageIds: ["msg-1", "msg-2"],
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("completed");
    expect(body.savePath).toMatch(/^alpha\/artifacts\/memo\//);
    expect(body.artifactPage).toMatch(/^wiki\/entities\/artifacts\//);
    expect(readFileSync(path.join(DATA_ROOT, "workspace", body.savePath), "utf-8")).toContain("Draft memo body.");
    expect(readFileSync(path.join(BRAIN_ROOT, body.artifactPage), "utf-8")).toContain("## Assumptions");

    const projectPage = readFileSync(path.join(BRAIN_ROOT, "wiki", "projects", "alpha.md"), "utf-8");
    expect(projectPage).toContain("## Artifacts");
    expect(projectPage).toContain(body.artifactPage);

    const auditLog = readFileSync(getAuditLogPath(path.join(BRAIN_ROOT, "state")), "utf-8");
    expect(auditLog).toContain('"route":"/api/artifacts/create"');
    expect(runArtifact).toHaveBeenCalledTimes(1);
  });
});
