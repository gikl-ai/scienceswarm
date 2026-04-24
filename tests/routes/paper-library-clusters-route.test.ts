import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import type { PaperReviewItem } from "@/lib/paper-library/contracts";
import { getPaperLibraryClustersPath } from "@/lib/paper-library/state";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

let dataRoot: string;
let brainRoot: string;

function stateRoot(): string {
  return getProjectStateRootForBrainRoot("project-alpha", brainRoot);
}

function now(): string {
  return new Date().toISOString();
}

function item(input: {
  id: string;
  paperId: string;
  title: string;
  semanticText: string;
}): PaperReviewItem {
  return {
    id: input.id,
    scanId: "scan-1",
    paperId: input.paperId,
    state: "accepted",
    reasonCodes: [],
    candidates: [{
      id: `candidate-${input.id}`,
      identifiers: { doi: `10.1000/${input.paperId}` },
      title: input.title,
      authors: ["Grace Hopper"],
      year: 2025,
      venue: "Route Conf",
      source: "filename",
      confidence: 0.98,
      evidence: [`filename:${input.title}`],
      conflicts: [],
    }],
    selectedCandidateId: `candidate-${input.id}`,
    semanticText: input.semanticText,
    semanticTextHash: `hash-${input.id}`,
    firstSentence: input.semanticText.split(".")[0],
    version: 0,
    updatedAt: now(),
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
    createdAt: now(),
    updatedAt: now(),
    counters: {
      detectedFiles: 3,
      identified: 3,
      needsReview: 0,
      readyForApply: 3,
      failed: 0,
    },
    warnings: [],
    currentPath: null,
    reviewShardIds: ["0001"],
  }), "utf-8");
  await writeFile(path.join(root, "paper-library", "reviews", "scan-1", "0001.json"), JSON.stringify({
    version: 1,
    scanId: "scan-1",
    items: [
      item({
        id: "item-1",
        paperId: "paper-1",
        title: "Protein Folding Route Paper",
        semanticText: "Protein folding with graph neural networks for structure prediction and residue contacts.",
      }),
      item({
        id: "item-2",
        paperId: "paper-2",
        title: "Graph Protein Route Paper",
        semanticText: "Graph neural networks improve protein folding structure prediction and residue contact recovery.",
      }),
      item({
        id: "item-3",
        paperId: "paper-3",
        title: "Ecology Route Paper",
        semanticText: "Marine microbial ecology survey for coastal nutrient cycling and plankton metabolism.",
      }),
    ],
  }), "utf-8");
}

describe("paper-library clusters route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-clusters-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-clusters-route-test";
    brainRoot = path.join(dataRoot, "brain");
    initBrain({ root: brainRoot, name: "Test Researcher" });
    await seedState();
  });

  afterEach(async () => {
    if (ORIGINAL_SCIENCESWARM_DIR) process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
    else delete process.env.SCIENCESWARM_DIR;
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    else delete process.env.SCIENCESWARM_USER_HANDLE;
    await import("@/brain/store").then((module) => module.resetBrainStore()).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("returns a bounded clusters response with model metadata and unclustered counts", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/clusters/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/clusters?project=project-alpha&scanId=scan-1&limit=1",
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      clusters: Array<{ memberCount: number }>;
      unclusteredCount: number;
      totalCount: number;
      model: { status: string };
    };
    expect(body.ok).toBe(true);
    expect(body.clusters).toHaveLength(1);
    expect(body.clusters[0]).toMatchObject({ memberCount: 2 });
    expect(body.unclusteredCount).toBe(1);
    expect(body.totalCount).toBe(1);
    expect(body.model.status).toBe("ready");
  });

  it("rejects malformed cluster lookup input before touching state", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/clusters/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/clusters?project=../bad&scanId=scan-1",
    ));
    expect(response.status).toBe(400);
  });

  it("rejects invalid cursors with a typed paper-library error envelope", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/clusters/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/clusters?project=project-alpha&scanId=scan-1&cursor=not-base64",
    ));
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: { code: string } };
    expect(body).toMatchObject({ ok: false, error: { code: "invalid_cursor" } });
  });

  it("rejects non-local cluster requests", async () => {
    mockIsLocal.mockResolvedValue(false);
    const { GET } = await import("@/app/api/brain/paper-library/clusters/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/clusters?project=project-alpha&scanId=scan-1",
    ));
    expect(response.status).toBe(403);
  });

  it("rebuilds stale or malformed cached cluster files instead of surfacing a 400", async () => {
    await mkdir(path.dirname(getPaperLibraryClustersPath("project-alpha", "scan-1", stateRoot())), { recursive: true });
    await writeFile(getPaperLibraryClustersPath("project-alpha", "scan-1", stateRoot()), JSON.stringify({
      version: 999,
      project: "project-alpha",
      scanId: "scan-1",
      updatedAt: now(),
    }), "utf-8");

    const { GET } = await import("@/app/api/brain/paper-library/clusters/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/clusters?project=project-alpha&scanId=scan-1",
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; clusters: Array<{ memberCount: number }> };
    expect(body.ok).toBe(true);
    expect(body.clusters[0]?.memberCount).toBe(2);
  });
});
