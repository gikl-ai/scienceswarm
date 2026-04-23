import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import { startPaperLibraryScan } from "@/lib/paper-library/jobs";

const { mockExtractPdfText } = vi.hoisted(() => ({
  mockExtractPdfText: vi.fn(),
}));

vi.mock("@/lib/pdf-text-extractor", () => ({
  extractPdfText: mockExtractPdfText,
}));

const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

let dataRoot: string;
let paperRoot: string;

function scanPath(project: string, scanId: string): string {
  return path.join(
    dataRoot,
    "projects",
    project,
    ".brain",
    "state",
    "paper-library",
    "scans",
    `${scanId}.json`,
  );
}

async function waitForScanFile(project: string, scanId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = JSON.parse(await readFile(scanPath(project, scanId), "utf-8")) as Record<string, unknown>;
    if (body.status === "ready_for_review" || body.status === "ready_for_apply" || body.status === "failed") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for scan ${scanId}`);
}

describe("paper-library jobs semantic enrichment", () => {
  beforeEach(async () => {
    mockExtractPdfText.mockReset();
    mockExtractPdfText.mockResolvedValue({
      text: [
        "Graph neural networks improve protein folding structure prediction across residue contacts and conformational ensembles.",
        "This paragraph continues with enough words to avoid thin-text heuristics while keeping the signal realistic for clustering.",
      ].join(" "),
      firstSentence: "Graph neural networks improve protein folding structure prediction across residue contacts and conformational ensembles.",
      pageCount: 12,
      wordCount: 180,
    });

    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-job-semantic-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-job-semantic-test";
    initBrain({ root: path.join(dataRoot, "brain"), name: "Test Researcher" });

    const homeTmp = path.join(os.homedir(), "tmp");
    await mkdir(homeTmp, { recursive: true });
    paperRoot = await mkdtemp(path.join(homeTmp, "scienceswarm-paper-library-semantic-source-"));
  });

  afterEach(async () => {
    if (ORIGINAL_SCIENCESWARM_DIR) process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
    else delete process.env.SCIENCESWARM_DIR;
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    else delete process.env.SCIENCESWARM_USER_HANDLE;
    await import("@/brain/store").then((module) => module.resetBrainStore()).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
    await rm(paperRoot, { recursive: true, force: true });
  });

  it("writes semantic clustering fields into review shards from extracted PDF text", async () => {
    await writeFile(path.join(paperRoot, "2024 - Smith - 10.1000-test.pdf"), "fake pdf", "utf-8");

    const scan = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot: path.join(dataRoot, "brain"),
    });
    await waitForScanFile("project-alpha", scan.id);

    const reviewShard = JSON.parse(await readFile(
      path.join(
        dataRoot,
        "projects",
        "project-alpha",
        ".brain",
        "state",
        "paper-library",
        "reviews",
        scan.id,
        "0001.json",
      ),
      "utf-8",
    )) as {
      items: Array<{
        semanticText?: string;
        semanticTextHash?: string;
        firstSentence?: string;
        pageCount?: number;
        wordCount?: number;
      }>;
    };

    expect(reviewShard.items[0]).toMatchObject({
      firstSentence: "Graph neural networks improve protein folding structure prediction across residue contacts and conformational ensembles.",
      pageCount: 12,
      wordCount: 180,
    });
    expect(reviewShard.items[0]?.semanticText).toContain("Graph neural networks improve protein folding structure prediction");
    expect(reviewShard.items[0]?.semanticTextHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
