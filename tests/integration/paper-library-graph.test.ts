import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBrain } from "@/brain/init";
import {
  buildPaperLibraryGraph,
  readPaperLibraryGraph,
  windowPaperLibraryGraph,
  type PaperLibraryGraphAdapter,
} from "@/lib/paper-library/graph";
import type { PaperReviewItem } from "@/lib/paper-library/contracts";

const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

let dataRoot: string;
let brainRoot: string;

function iso(): string {
  return new Date().toISOString();
}

function stateRoot(): string {
  return path.join(dataRoot, "projects", "project-alpha", ".brain", "state");
}

function reviewItem(paperId: string, title: string, doi: string): PaperReviewItem {
  return {
    id: `item-${paperId}`,
    scanId: "scan-1",
    paperId,
    state: "accepted",
    reasonCodes: [],
    candidates: [{
      id: `candidate-${paperId}`,
      identifiers: { doi },
      title,
      authors: ["Integration Author"],
      year: 2026,
      venue: "Integration Venue",
      source: "filename",
      confidence: 0.99,
      evidence: [`filename:${title}`],
      conflicts: [],
    }],
    selectedCandidateId: `candidate-${paperId}`,
    version: 0,
    updatedAt: iso(),
  };
}

async function seedScan(items: PaperReviewItem[]): Promise<void> {
  const root = stateRoot();
  await mkdir(path.join(root, "paper-library", "scans"), { recursive: true });
  await mkdir(path.join(root, "paper-library", "reviews", "scan-1"), { recursive: true });
  await writeFile(path.join(root, "paper-library", "scans", "scan-1.json"), JSON.stringify({
    version: 1,
    id: "scan-1",
    project: "project-alpha",
    rootPath: "/tmp/papers",
    rootRealpath: "/tmp/papers",
    status: "ready_for_apply",
    createdAt: iso(),
    updatedAt: iso(),
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

describe("paper-library graph integration", () => {
  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-graph-integration-"));
    brainRoot = path.join(dataRoot, "brain");
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-graph-integration-test";
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

  it("persists an enriched graph and reopens it through the graph reader", async () => {
    await seedScan([
      reviewItem("source", "Source", "10.1000/source"),
      reviewItem("target", "Target", "10.1000/target"),
    ]);
    const adapter: PaperLibraryGraphAdapter = {
      source: "semantic_scholar",
      fetch: async ({ paperId }) => paperId === "source"
        ? {
          references: [
            { title: "Target", identifiers: { doi: "10.1000/target" } },
            { title: "Outside", identifiers: { doi: "10.1000/outside" } },
          ],
        }
        : { status: "negative" as const },
    };

    const built = await buildPaperLibraryGraph({
      project: "project-alpha",
      scanId: "scan-1",
      brainRoot,
      adapters: [adapter],
      useCache: false,
    });
    const reopened = await readPaperLibraryGraph("project-alpha", "scan-1", brainRoot);
    const focused = windowPaperLibraryGraph(reopened!, {
      focusNodeId: "paper:doi:10.1000/source",
      limit: 10,
    });

    expect(reopened).toEqual(built);
    expect(focused.nodes.map((node) => node.id).sort()).toEqual([
      "paper:doi:10.1000/outside",
      "paper:doi:10.1000/source",
      "paper:doi:10.1000/target",
    ]);
    expect(focused.edges).toHaveLength(2);
  });
});
