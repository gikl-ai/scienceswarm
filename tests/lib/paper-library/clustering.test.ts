import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import {
  buildPaperLibraryClusters,
  getOrBuildPaperLibraryClusters,
  windowPaperLibraryClusters,
} from "@/lib/paper-library/clustering";
import type { PaperIdentifier, PaperReviewItem } from "@/lib/paper-library/contracts";
import {
  getPaperLibraryClustersPath,
  getPaperLibraryEmbeddingCachePath,
} from "@/lib/paper-library/state";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

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
  identifiers?: PaperIdentifier;
  semanticText: string;
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
      identifiers: input.identifiers ?? {},
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
    semanticText: input.semanticText,
    semanticTextHash: `hash-${input.paperId}`,
    firstSentence: input.semanticText.split(".")[0],
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

describe("paper-library clustering", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-clustering-"));
    brainRoot = path.join(dataRoot, "brain");
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-clustering-test";
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

  it("builds semantic clusters, tracks unclustered papers, and windows the cluster list", async () => {
    await seedReviewState([
      reviewItem({
        paperId: "paper-1",
        title: "Protein Folding With Graph Networks",
        identifiers: { doi: "10.1000/paper-1" },
        semanticText: "Protein folding with graph neural networks for structure prediction and residue contacts.",
      }),
      reviewItem({
        paperId: "paper-2",
        title: "Graph Models For Protein Structure",
        identifiers: { doi: "10.1000/paper-2" },
        semanticText: "Graph neural networks improve protein folding structure prediction and residue contact recovery.",
      }),
      reviewItem({
        paperId: "paper-3",
        title: "Marine Microbial Ecology Survey",
        identifiers: { doi: "10.1000/paper-3" },
        semanticText: "Marine microbial ecology survey for coastal nutrient cycling and plankton metabolism.",
      }),
    ]);

    const clusters = await buildPaperLibraryClusters({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      embeddingMode: "local_hash_only",
    });

    expect(clusters).not.toBeNull();
    expect(clusters?.model).toMatchObject({
      provider: "local_hash",
      status: "ready",
      generatedCount: 3,
      fallbackCount: 3,
    });
    expect(clusters?.clusters).toHaveLength(1);
    expect(clusters?.clusters[0]).toMatchObject({
      memberCount: 2,
      representativePaperId: expect.stringMatching(/^paper-/),
    });
    expect(clusters?.clusters[0]?.members.map((member) => member.paperId).sort()).toEqual(["paper-1", "paper-2"]);
    expect(clusters?.unclusteredPaperIds).toEqual(["paper-3"]);

    const firstPage = windowPaperLibraryClusters(clusters!, { limit: 1 });
    expect(firstPage.clusters).toHaveLength(1);
    expect(firstPage.unclusteredCount).toBe(1);
    expect(firstPage.totalCount).toBe(1);
  });

  it("rebuilds persisted clusters after review state changes", async () => {
    await seedReviewState([
      reviewItem({
        paperId: "paper-1",
        title: "Old Cluster Title",
        semanticText: "Graph neural networks for protein folding and residue contact prediction.",
      }),
      reviewItem({
        paperId: "paper-2",
        title: "Supporting Cluster Title",
        semanticText: "Protein folding prediction with graph neural networks and residue contact learning.",
      }),
    ]);

    const first = await buildPaperLibraryClusters({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      embeddingMode: "local_hash_only",
    });
    expect(first?.clusters[0]?.members[0]?.title ?? first?.clusters[0]?.members[1]?.title).toContain("Title");

    await seedReviewState([
      reviewItem({
        paperId: "paper-1",
        title: "Corrected Cluster Title",
        semanticText: "Quantum materials clustering for correlated electron phases and superconducting transport.",
      }),
      reviewItem({
        paperId: "paper-2",
        title: "Corrected Supporting Title",
        semanticText: "Correlated quantum materials clustering for superconducting transport and phase transitions.",
      }),
    ], { scanUpdatedAt: "2999-01-01T00:00:00.000Z" });

    const rebuilt = await getOrBuildPaperLibraryClusters({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      embeddingMode: "local_hash_only",
    });

    expect(rebuilt?.clusters[0]?.members.map((member) => member.title).sort()).toEqual([
      "Corrected Cluster Title",
      "Corrected Supporting Title",
    ]);
  });

  it("rebuilds malformed cluster caches instead of throwing", async () => {
    await seedReviewState([
      reviewItem({
        paperId: "paper-1",
        title: "Source Paper",
        semanticText: "Local semantic clustering should recover from malformed persisted caches cleanly.",
      }),
      reviewItem({
        paperId: "paper-2",
        title: "Neighbor Paper",
        semanticText: "Persisted cluster caches can be malformed and still rebuild cleanly with local clustering.",
      }),
    ]);
    await mkdir(path.dirname(getPaperLibraryClustersPath("project-alpha", "scan-1", stateRoot())), { recursive: true });
    await writeFile(getPaperLibraryClustersPath("project-alpha", "scan-1", stateRoot()), JSON.stringify({
      version: 999,
      project: "project-alpha",
      scanId: "scan-1",
      updatedAt: now(),
    }), "utf-8");

    const rebuilt = await getOrBuildPaperLibraryClusters({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      embeddingMode: "local_hash_only",
    });

    expect(rebuilt?.clusters).toHaveLength(1);
  });

  it("surfaces resource budget exhaustion before generating local embeddings", async () => {
    await seedReviewState([
      reviewItem({
        paperId: "paper-1",
        title: "Budget Paper",
        semanticText: "Local embedding budget handling for semantic clustering should pause safely.",
      }),
    ]);

    const clusters = await buildPaperLibraryClusters({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      embeddingMode: "local_hash_only",
      maxNewEmbeddings: 0,
    });

    expect(clusters?.model.status).toBe("resource_budget_exhausted");
    expect(clusters?.warnings).toContain("Paper library clustering paused because the local embedding budget was exhausted.");
    expect(clusters?.clusters).toEqual([]);
  });

  it("reports model_unavailable when only gbrain embeddings are allowed and none exist", async () => {
    await seedReviewState([
      reviewItem({
        paperId: "paper-1",
        title: "Gbrain Missing",
        semanticText: "No gbrain embedding is available for this local-only clustering test.",
      }),
    ]);

    const clusters = await buildPaperLibraryClusters({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      embeddingMode: "gbrain_only",
    });

    expect(clusters?.model.status).toBe("model_unavailable");
    expect(clusters?.warnings).toContain("Compatible gbrain embeddings are unavailable for this scan.");
    expect(clusters?.clusters).toEqual([]);
  });

  it("reuses provider-aware cached gbrain embeddings on later gbrain-only runs", async () => {
    await seedReviewState([
      reviewItem({
        paperId: "paper-1",
        title: "Cached Gbrain Paper",
        semanticText: "Cached gbrain embeddings should be reusable by semantic clustering without fallback.",
      }),
    ]);
    await writeFile(getPaperLibraryEmbeddingCachePath("project-alpha", stateRoot()), JSON.stringify({
      version: 1,
      entries: {
        "paper-1:hash-paper-1:gbrain-model:gbrain:3:semantic-summary-v1": {
          key: "paper-1:hash-paper-1:gbrain-model:gbrain:3:semantic-summary-v1",
          paperId: "paper-1",
          textHash: "hash-paper-1",
          modelId: "gbrain-model",
          provider: "gbrain",
          dimensions: 3,
          chunking: "semantic-summary-v1",
          embedding: [0.9, 0.1, 0.3],
          sourcePageSlug: "paper-library-paper-1",
          updatedAt: now(),
        },
      },
      runs: {},
    }), "utf-8");

    const clusters = await buildPaperLibraryClusters({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      embeddingMode: "gbrain_only",
    });

    expect(clusters?.model).toMatchObject({
      provider: "gbrain",
      id: "gbrain-model",
      dimensions: 3,
      status: "ready",
      cacheHits: 1,
    });
    expect(clusters?.unclusteredPaperIds).toEqual(["paper-1"]);
  });
});
