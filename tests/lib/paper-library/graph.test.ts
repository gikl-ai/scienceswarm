import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import {
  buildPaperLibraryGraph,
  deterministicPaperNodeId,
  getOrBuildPaperLibraryGraph,
  windowPaperLibraryGraph,
  type PaperLibraryGraphAdapter,
} from "@/lib/paper-library/graph";
import type { PaperIdentifier, PaperReviewItem } from "@/lib/paper-library/contracts";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";
import { getPaperLibraryGraphPath } from "@/lib/paper-library/state";

const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

let dataRoot: string;
let brainRoot: string;

function stateRoot(): string {
  return getProjectStateRootForBrainRoot("project-alpha", brainRoot);
}

function now(): string {
  return new Date().toISOString();
}

function reviewItem(input: {
  paperId: string;
  title: string;
  identifiers: PaperIdentifier;
  state?: PaperReviewItem["state"];
}): PaperReviewItem {
  const candidateId = `candidate-${input.paperId}`;
  return {
    id: `item-${input.paperId}`,
    scanId: "scan-1",
    paperId: input.paperId,
    state: input.state ?? "accepted",
    reasonCodes: [],
    candidates: [{
      id: candidateId,
      identifiers: input.identifiers,
      title: input.title,
      authors: ["Ada Lovelace"],
      year: 2024,
      venue: "Local Proceedings",
      source: "filename",
      confidence: 0.95,
      evidence: [`filename:${input.title}`],
      conflicts: [],
    }],
    selectedCandidateId: candidateId,
    version: 0,
    updatedAt: now(),
  };
}

async function seedReviewState(items: PaperReviewItem[], options: { scanUpdatedAt?: string } = {}): Promise<void> {
  const root = stateRoot();
  const updatedAt = options.scanUpdatedAt ?? now();
  await mkdir(path.join(root, "paper-library", "scans"), { recursive: true });
  await mkdir(path.join(root, "paper-library", "reviews", "scan-1"), { recursive: true });
  await writeFile(path.join(root, "paper-library", "scans", "scan-1.json"), JSON.stringify({
    version: 1,
    id: "scan-1",
    project: "project-alpha",
    rootPath: "/tmp/paper-library",
    rootRealpath: "/tmp/paper-library",
    status: "ready_for_review",
    createdAt: now(),
    updatedAt,
    counters: {
      detectedFiles: items.length,
      identified: items.length,
      needsReview: 0,
      readyForApply: items.length,
      failed: 0,
    },
    warnings: [],
    currentPath: null,
    reviewShardIds: ["0001"],
  }), "utf-8");
  await writeFile(path.join(root, "paper-library", "reviews", "scan-1", "0001.json"), JSON.stringify({
    version: 1,
    scanId: "scan-1",
    items,
  }), "utf-8");
}

describe("paper-library graph", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-graph-"));
    brainRoot = path.join(dataRoot, "brain");
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-graph-test";
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    initBrain({ root: brainRoot, name: "Test Researcher" });
  });

  afterEach(async () => {
    if (ORIGINAL_SCIENCESWARM_DIR) process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
    else delete process.env.SCIENCESWARM_DIR;
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    else delete process.env.SCIENCESWARM_USER_HANDLE;
    await import("@/brain/store").then((module) => module.resetBrainStore()).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("links local papers by DOI, arXiv, PMID, and OpenAlex identifiers while keeping external suggestions separate", async () => {
    await seedReviewState([
      reviewItem({ paperId: "source", title: "Source Paper", identifiers: { doi: "10.1000/source" } }),
      reviewItem({ paperId: "doi-target", title: "DOI Target", identifiers: { doi: "10.2000/doi" } }),
      reviewItem({ paperId: "arxiv-target", title: "arXiv Target", identifiers: { arxivId: "2401.00001v2" } }),
      reviewItem({ paperId: "pmid-target", title: "PMID Target", identifiers: { pmid: "12345" } }),
      reviewItem({ paperId: "openalex-target", title: "OpenAlex Target", identifiers: { openAlexId: "https://openalex.org/W123" } }),
    ]);

    const adapter: PaperLibraryGraphAdapter = {
      source: "semantic_scholar",
      fetch: vi.fn(async ({ paperId }) => {
        if (paperId !== "source") return { status: "negative" as const };
        return {
          references: [
            { title: "DOI Target", identifiers: { doi: "https://doi.org/10.2000/doi" } },
            { title: "arXiv Target", identifiers: { arxivId: "2401.00001" } },
            { title: "PMID Target", identifiers: { pmid: "12345" } },
            { title: "OpenAlex Target", identifiers: { openAlexId: "W123" } },
            { title: "External Reference", identifiers: { doi: "10.3000/external" } },
          ],
          bridgePapers: [
            { sourceId: "bridge-1", title: "Bridge Paper", identifiers: { doi: "10.4000/bridge" } },
          ],
        };
      }),
    };

    const graph = await buildPaperLibraryGraph({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      adapters: [adapter],
      useCache: false,
    });

    expect(graph).not.toBeNull();
    const nodes = new Map(graph!.nodes.map((node) => [node.id, node]));
    const sourceNodeId = "paper:doi:10.1000/source";
    for (const targetNodeId of [
      "paper:doi:10.2000/doi",
      "paper:arxiv:2401.00001",
      "paper:pmid:12345",
      "paper:openalex:w123",
    ]) {
      expect(nodes.get(targetNodeId)?.local).toBe(true);
      expect(graph!.edges.some((edge) => (
        edge.sourceNodeId === sourceNodeId &&
        edge.targetNodeId === targetNodeId &&
        edge.kind === "references"
      ))).toBe(true);
    }

    expect(nodes.get("paper:doi:10.3000/external")).toMatchObject({
      kind: "external_paper",
      local: false,
      suggestion: false,
    });
    expect(nodes.get("paper:doi:10.4000/bridge")).toMatchObject({
      kind: "bridge_suggestion",
      local: false,
      suggestion: true,
    });
    expect(graph!.sourceRuns.find((run) => run.paperId === "source")).toMatchObject({
      source: "semantic_scholar",
      status: "success",
      fetchedCount: 6,
      cacheHits: 0,
    });
  });

  it("records failed source runs without blocking the local graph and reuses cached failures", async () => {
    await seedReviewState([
      reviewItem({ paperId: "source", title: "Source Paper", identifiers: { doi: "10.1000/source" } }),
    ]);
    const retryAfter = new Date(Date.now() + 60_000).toISOString();
    const adapter: PaperLibraryGraphAdapter = {
      source: "semantic_scholar",
      fetch: vi.fn(async () => {
        throw Object.assign(new Error("quota exhausted"), { status: 429, retryAfter });
      }),
    };

    const first = await buildPaperLibraryGraph({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      adapters: [adapter],
    });
    const second = await buildPaperLibraryGraph({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      adapters: [adapter],
    });

    expect(adapter.fetch).toHaveBeenCalledTimes(1);
    expect(first?.nodes).toHaveLength(1);
    expect(first?.sourceRuns[0]).toMatchObject({
      status: "rate_limited",
      attempts: 1,
      cacheHits: 0,
      retryAfter,
    });
    expect(second?.sourceRuns[0]).toMatchObject({
      status: "rate_limited",
      attempts: 1,
      cacheHits: 1,
      retryAfter,
    });
  });

  it("windows large graphs and supports focus neighborhoods", async () => {
    await seedReviewState([
      reviewItem({ paperId: "source", title: "Source Paper", identifiers: { doi: "10.1000/source" } }),
      reviewItem({ paperId: "target", title: "Target Paper", identifiers: { doi: "10.2000/target" } }),
      reviewItem({ paperId: "other", title: "Other Paper", identifiers: { doi: "10.2000/other" } }),
    ]);
    const graph = await buildPaperLibraryGraph({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      adapters: [{
        source: "semantic_scholar",
        fetch: async ({ paperId }) => paperId === "source"
          ? { references: [{ identifiers: { doi: "10.2000/target" }, title: "Target Paper" }] }
          : { status: "negative" as const },
      }],
      useCache: false,
    });

    expect(deterministicPaperNodeId({ doi: "https://doi.org/10.1000/source" }, "fallback")).toBe("paper:doi:10.1000/source");
    const firstPage = windowPaperLibraryGraph(graph!, { limit: 2 });
    expect(firstPage.nodes.map((node) => node.id).sort()).toEqual([
      "paper:doi:10.1000/source",
      "paper:doi:10.2000/other",
      "paper:doi:10.2000/target",
    ]);
    expect(firstPage.edges).toHaveLength(1);
    expect(firstPage.loadedNodeCount).toBe(2);
    expect(firstPage.totalEdgeCount).toBe(1);
    expect(firstPage.nextCursor).toBeDefined();
    expect(firstPage.sourceRuns.length).toBeGreaterThan(0);

    const focused = windowPaperLibraryGraph(graph!, { focusNodeId: "paper:doi:10.1000/source", limit: 10 });
    expect(focused.filteredCount).toBe(2);
    expect(focused.nodes.map((node) => node.id).sort()).toEqual([
      "paper:doi:10.1000/source",
      "paper:doi:10.2000/target",
    ]);
    expect(focused.edges).toHaveLength(1);

    const secondPage = windowPaperLibraryGraph(graph!, { cursor: firstPage.nextCursor, limit: 2 });
    expect(secondPage.loadedNodeCount).toBe(1);
    expect(secondPage.sourceRuns).toEqual([]);
    expect(secondPage.warnings).toEqual([]);
  });

  it("rebuilds persisted graphs after review state changes", async () => {
    await seedReviewState([
      reviewItem({ paperId: "source", title: "Old Source Title", identifiers: { doi: "10.1000/source" } }),
    ]);
    const first = await buildPaperLibraryGraph({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      adapters: [],
    });
    expect(first?.nodes[0]?.title).toBe("Old Source Title");

    await seedReviewState([
      reviewItem({ paperId: "source", title: "Corrected Source Title", identifiers: { doi: "10.1000/source" } }),
    ], { scanUpdatedAt: "2999-01-01T00:00:00.000Z" });

    const rebuilt = await getOrBuildPaperLibraryGraph({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      adapters: [],
    });
    expect(rebuilt?.nodes[0]?.title).toBe("Corrected Source Title");
  });

  it("rebuilds instead of throwing when a persisted graph cache is malformed or from an old version", async () => {
    await seedReviewState([
      reviewItem({ paperId: "source", title: "Source", identifiers: { doi: "10.1000/source" } }),
    ]);
    await mkdir(path.dirname(getPaperLibraryGraphPath("project-alpha", "scan-1", stateRoot())), { recursive: true });
    await writeFile(getPaperLibraryGraphPath("project-alpha", "scan-1", stateRoot()), JSON.stringify({
      version: 999,
      project: "project-alpha",
      scanId: "scan-1",
      updatedAt: now(),
    }), "utf-8");

    const graph = await getOrBuildPaperLibraryGraph({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      adapters: [],
    });
    expect(graph?.nodes[0]?.id).toBe("paper:doi:10.1000/source");
  });
});
