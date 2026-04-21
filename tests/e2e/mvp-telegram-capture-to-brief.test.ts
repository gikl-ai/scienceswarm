import path from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import { resetBrainStore } from "@/brain/store";
import { writeProjectManifest } from "@/lib/state/project-manifests";
import { createRuntimeEngine } from "@/brain/stores/gbrain-runtime.mjs";
import { resolvePgliteDatabasePath } from "@/lib/capture/materialize-memory";

interface ReaderEngine {
  connect(config: { engine: "pglite"; database_path?: string }): Promise<void>;
  initSchema(): Promise<void>;
  disconnect(): Promise<void>;
  getPage(slug: string): Promise<{ compiled_truth: string } | null>;
}

async function readGbrainPageBody(brainRoot: string, materializedPath: string): Promise<string | null> {
  const slug = (materializedPath.split("/").pop() ?? "").replace(/\.md$/, "");
  // Resolve via the shared helper so the reader and the production
  // writer (`materializeMemory#connectPglite`) can never drift apart.
  const databasePath = resolvePgliteDatabasePath(brainRoot);
  const engine = (await createRuntimeEngine({
    engine: "pglite",
    database_path: databasePath,
  })) as ReaderEngine;
  await engine.connect({ engine: "pglite", database_path: databasePath });
  await engine.initSchema();
  try {
    const page = await engine.getPage(slug);
    return page?.compiled_truth ?? null;
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

const DATA_ROOT = path.join(tmpdir(), "scienceswarm-mvp-telegram-capture");
const BRAIN_ROOT = path.join(DATA_ROOT, "brain");

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

beforeEach(async () => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = DATA_ROOT;
  // Decision 3A: capture writes thread getCurrentUserHandle().
  process.env.SCIENCESWARM_USER_HANDLE = "@test-researcher";
  initBrain({ root: BRAIN_ROOT, name: "Test Researcher" });
  mockLoadBrainConfig.mockReturnValue(makeConfig());
  await writeProjectManifest(
    {
      version: 1,
      projectId: "alpha",
      slug: "alpha",
      title: "Alpha",
      privacy: "cloud-ok",
      status: "active",
      projectPagePath: "wiki/projects/alpha.md",
      sourceRefs: [],
      decisionPaths: [],
      taskPaths: [],
      artifactPaths: [],
      frontierPaths: [],
      activeThreads: [],
      dedupeKeys: [],
      updatedAt: "2026-04-08T00:00:00.000Z",
    },
    path.join(BRAIN_ROOT, "state"),
  );
});

afterEach(async () => {
  await resetBrainStore();
  rmSync(DATA_ROOT, { recursive: true, force: true });
  delete process.env.SCIENCESWARM_DIR;
  delete process.env.SCIENCESWARM_USER_HANDLE;
  mockLoadBrainConfig.mockReset();
});

describe("MVP telegram capture to brief", () => {
  it("captures a telegram task and reflects it in the next brief", async () => {
    const { POST: captureProject } = await import("@/app/api/brain/capture/route");
    const { GET: briefProject } = await import("@/app/api/brain/brief/route");

    const response = await captureProject(
      new Request("http://localhost/api/brain/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Order primers for the alpha sequencing pass.",
          channel: "telegram",
          userId: "telegram-user-1",
          project: "alpha",
          kind: "task",
          privacy: "cloud-ok",
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("saved");
    expect(body.materializedPath).toMatch(/^wiki\/tasks\//);
    await resetBrainStore();
    const captureBody = await readGbrainPageBody(BRAIN_ROOT, body.materializedPath);
    expect(captureBody).not.toBeNull();
    expect(captureBody!).toContain("Order primers for the alpha sequencing pass.");

    const briefResponse = await briefProject(
      new Request("http://localhost/api/brain/brief?project=alpha"),
    );
    expect(briefResponse.status).toBe(200);
    const brief = await briefResponse.json();
    expect(brief.project).toBe("alpha");
    expect(brief.dueTasks[0].title).toContain("Order primers");
    expect(brief.nextMove.recommendation).toContain("Order primers");
  });
});
