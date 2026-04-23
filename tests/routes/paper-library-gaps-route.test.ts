import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import { getPaperLibraryClustersPath, getPaperLibraryGapsPath, getPaperLibraryGraphPath } from "@/lib/paper-library/state";
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

async function seedState(): Promise<void> {
  const root = stateRoot();
  await mkdir(path.join(root, "paper-library", "scans"), { recursive: true });
  await mkdir(path.dirname(getPaperLibraryGraphPath("project-alpha", "scan-1", root)), { recursive: true });
  await mkdir(path.dirname(getPaperLibraryClustersPath("project-alpha", "scan-1", root)), { recursive: true });

  await writeFile(path.join(root, "paper-library", "scans", "scan-1.json"), JSON.stringify({
    version: 1,
    id: "scan-1",
    project: "project-alpha",
    rootPath: "/tmp/papers",
    rootRealpath: "/tmp/papers",
    status: "ready_for_apply",
    createdAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:00:00.000Z",
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

  await writeFile(getPaperLibraryGraphPath("project-alpha", "scan-1", root), JSON.stringify({
    version: 1,
    project: "project-alpha",
    scanId: "scan-1",
    createdAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:00:00.000Z",
    nodes: [
      {
        id: "paper:doi:10.1000/local-a",
        kind: "local_paper",
        paperIds: ["paper-a"],
        title: "Local Paper A",
        authors: ["Ada"],
        year: 2024,
        venue: "Local Conf",
        identifiers: { doi: "10.1000/local-a" },
        local: true,
        suggestion: false,
        sources: ["filename"],
        evidence: [],
      },
      {
        id: "paper:doi:10.1000/local-b",
        kind: "local_paper",
        paperIds: ["paper-b"],
        title: "Local Paper B",
        authors: ["Grace"],
        year: 2025,
        venue: "Local Conf",
        identifiers: { doi: "10.1000/local-b" },
        local: true,
        suggestion: false,
        sources: ["filename"],
        evidence: [],
      },
      {
        id: "paper:doi:10.2000/missing",
        kind: "external_paper",
        paperIds: [],
        title: "Missing Seminal Route Paper",
        authors: ["Barbara"],
        year: 2025,
        venue: "Route Journal",
        identifiers: { doi: "10.2000/missing" },
        local: false,
        suggestion: false,
        sources: ["semantic_scholar"],
        evidence: [],
      },
      {
        id: "paper:doi:10.3000/side",
        kind: "external_paper",
        paperIds: [],
        title: "Side Suggestion",
        authors: ["Katherine"],
        year: 2020,
        venue: "Route Journal",
        identifiers: { doi: "10.3000/side" },
        local: false,
        suggestion: false,
        sources: ["openalex"],
        evidence: [],
      },
    ],
    edges: [
      {
        id: "edge-1",
        sourceNodeId: "paper:doi:10.1000/local-a",
        targetNodeId: "paper:doi:10.2000/missing",
        kind: "references",
        source: "semantic_scholar",
        evidence: [],
      },
      {
        id: "edge-2",
        sourceNodeId: "paper:doi:10.1000/local-b",
        targetNodeId: "paper:doi:10.2000/missing",
        kind: "references",
        source: "semantic_scholar",
        evidence: [],
      },
      {
        id: "edge-3",
        sourceNodeId: "paper:doi:10.1000/local-b",
        targetNodeId: "paper:doi:10.3000/side",
        kind: "references",
        source: "openalex",
        evidence: [],
      },
    ],
    sourceRuns: [],
    warnings: [],
  }), "utf-8");

  await writeFile(getPaperLibraryClustersPath("project-alpha", "scan-1", root), JSON.stringify({
    version: 1,
    project: "project-alpha",
    scanId: "scan-1",
    createdAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:00:00.000Z",
    model: {
      id: "paper-library-hash-embedding-v1",
      provider: "local_hash",
      dimensions: 256,
      chunking: "semantic-summary-v1",
      status: "ready",
      cacheHits: 0,
      generatedCount: 2,
      reusedGbrainCount: 0,
      fallbackCount: 2,
    },
    clusters: [
      {
        id: "cluster-route",
        label: "Route Cluster",
        folderName: "route-cluster",
        keywords: ["route"],
        memberCount: 2,
        confidence: 0.74,
        representativePaperId: "paper-a",
        members: [
          { itemId: "item-a", paperId: "paper-a", title: "Local Paper A", confidence: 0.9, score: 0.8 },
          { itemId: "item-b", paperId: "paper-b", title: "Local Paper B", confidence: 0.9, score: 0.8 },
        ],
      },
    ],
    unclusteredPaperIds: [],
    warnings: [],
  }), "utf-8");
}

describe("paper-library gaps route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-gaps-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-gaps-route-test";
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

  it("returns a bounded gap response with state counts", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/gaps/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/gaps?project=project-alpha&scanId=scan-1&limit=1",
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      suggestions: Array<{ title: string }>;
      totalCount: number;
      filteredCount: number;
      stateCounts: { open: number };
    };
    expect(body.ok).toBe(true);
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]).toMatchObject({ title: "Missing Seminal Route Paper" });
    expect(body.totalCount).toBe(2);
    expect(body.filteredCount).toBe(2);
    expect(body.stateCounts.open).toBe(2);
  });

  it("updates suggestion state and filters by state", async () => {
    const route = await import("@/app/api/brain/paper-library/gaps/route");
    const firstResponse = await route.GET(new Request(
      "http://localhost/api/brain/paper-library/gaps?project=project-alpha&scanId=scan-1&limit=10",
    ));
    const firstBody = await firstResponse.json() as { suggestions: Array<{ id: string }> };

    const updateResponse = await route.POST(new Request("http://localhost/api/brain/paper-library/gaps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "project-alpha",
        scanId: "scan-1",
        suggestionId: firstBody.suggestions[0]?.id,
        action: "watch",
      }),
    }));
    expect(updateResponse.status).toBe(200);

    const filteredResponse = await route.GET(new Request(
      "http://localhost/api/brain/paper-library/gaps?project=project-alpha&scanId=scan-1&state=watching&limit=10",
    ));
    const filteredBody = await filteredResponse.json() as {
      suggestions: Array<{ state: string }>;
      filteredCount: number;
      stateCounts: { watching: number };
    };
    expect(filteredBody.filteredCount).toBe(1);
    expect(filteredBody.suggestions[0]).toMatchObject({ state: "watching" });
    expect(filteredBody.stateCounts.watching).toBe(1);
  });

  it("rejects malformed gap lookup input before touching state", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/gaps/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/gaps?project=../bad&scanId=scan-1",
    ));
    expect(response.status).toBe(400);
  });

  it("rejects invalid cursors with a typed paper-library error envelope", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/gaps/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/gaps?project=project-alpha&scanId=scan-1&cursor=not-base64",
    ));
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: { code: string } };
    expect(body).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("rejects non-local gap requests", async () => {
    mockIsLocal.mockResolvedValue(false);
    const { GET } = await import("@/app/api/brain/paper-library/gaps/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/gaps?project=project-alpha&scanId=scan-1",
    ));
    expect(response.status).toBe(403);
  });

  it("rebuilds stale or malformed cached gap files instead of surfacing a 400", async () => {
    await mkdir(path.dirname(getPaperLibraryGapsPath("project-alpha", "scan-1", stateRoot())), { recursive: true });
    await writeFile(getPaperLibraryGapsPath("project-alpha", "scan-1", stateRoot()), JSON.stringify({
      version: 999,
      project: "project-alpha",
      scanId: "scan-1",
      updatedAt: "2026-04-23T12:00:00.000Z",
    }), "utf-8");

    const { GET } = await import("@/app/api/brain/paper-library/gaps/route");
    const response = await GET(new Request(
      "http://localhost/api/brain/paper-library/gaps?project=project-alpha&scanId=scan-1",
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; suggestions: Array<{ title: string }> };
    expect(body.ok).toBe(true);
    expect(body.suggestions[0]?.title).toBe("Missing Seminal Route Paper");
  });
});
