import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import type { PaperReviewItem } from "@/lib/paper-library/contracts";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;
const ORIGINAL_SEMANTIC_SCHOLAR_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

let dataRoot: string;
let brainRoot: string;

function stateRoot(): string {
  return getProjectStateRootForBrainRoot("project-alpha", brainRoot);
}

function item(): PaperReviewItem {
  return {
    id: "item-1",
    scanId: "scan-1",
    paperId: "paper-1",
    state: "accepted",
    reasonCodes: [],
    candidates: [{
      id: "candidate-1",
      identifiers: { doi: "10.1000/route" },
      title: "Route Paper",
      authors: ["Grace Hopper"],
      year: 2025,
      venue: "Route Conf",
      source: "filename",
      confidence: 0.98,
      evidence: ["filename:Route Paper"],
      conflicts: [],
    }],
    selectedCandidateId: "candidate-1",
    version: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function seedState(): Promise<void> {
  const root = stateRoot();
  await mkdir(path.join(root, "paper-library", "scans"), { recursive: true });
  await mkdir(path.join(root, "paper-library", "reviews", "scan-1"), { recursive: true });
  await writeFile(path.join(root, "paper-library", "scans", "scan-1.json"), JSON.stringify({
    version: 1,
    id: "scan-1",
    project: "project-alpha",
    rootPath: "/tmp/papers",
    rootRealpath: "/tmp/papers",
    status: "ready_for_review",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    counters: {
      detectedFiles: 1,
      identified: 1,
      needsReview: 0,
      readyForApply: 1,
      failed: 0,
    },
    warnings: [],
    currentPath: null,
    reviewShardIds: ["0001"],
  }), "utf-8");
  await writeFile(path.join(root, "paper-library", "reviews", "scan-1", "0001.json"), JSON.stringify({
    version: 1,
    scanId: "scan-1",
    items: [item()],
  }), "utf-8");
}

describe("paper-library graph route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-graph-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-graph-route-test";
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    brainRoot = path.join(dataRoot, "brain");
    initBrain({ root: brainRoot, name: "Test Researcher" });
    await seedState();
  });

  afterEach(async () => {
    if (ORIGINAL_SCIENCESWARM_DIR) process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
    else delete process.env.SCIENCESWARM_DIR;
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    else delete process.env.SCIENCESWARM_USER_HANDLE;
    if (ORIGINAL_SEMANTIC_SCHOLAR_API_KEY) process.env.SEMANTIC_SCHOLAR_API_KEY = ORIGINAL_SEMANTIC_SCHOLAR_API_KEY;
    else delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    await import("@/brain/store").then((module) => module.resetBrainStore()).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("returns a bounded graph response and records unavailable external enrichment as source metadata", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/graph/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/graph?project=project-alpha&scanId=scan-1&limit=1",
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      nodes: Array<{ id: string; local: boolean }>;
      sourceRuns: Array<{ status: string; source: string; cacheHits: number }>;
      totalCount: number;
    };
    expect(body.ok).toBe(true);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]).toMatchObject({ id: "paper:doi:10.1000/route", local: true });
    expect(body.totalCount).toBe(1);
    expect(body.sourceRuns).toEqual([
      expect.objectContaining({
        source: "semantic_scholar",
        status: "auth_unavailable",
        cacheHits: 0,
      }),
    ]);
  });

  it("rejects malformed graph lookup input before touching state", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/graph/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/graph?project=../bad&scanId=scan-1",
    ));
    expect(response.status).toBe(400);
  });

  it("rejects invalid cursors with a typed paper-library error envelope", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/graph/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/graph?project=project-alpha&scanId=scan-1&cursor=not-base64",
    ));
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: { code: string } };
    expect(body).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("rejects non-local graph requests", async () => {
    mockIsLocal.mockResolvedValue(false);
    const { GET } = await import("@/app/api/brain/paper-library/graph/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/graph?project=project-alpha&scanId=scan-1",
    ));
    expect(response.status).toBe(403);
  });
});
