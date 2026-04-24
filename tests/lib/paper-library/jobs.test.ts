import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBrain } from "@/brain/init";
import {
  cancelPaperLibraryScan,
  findLatestPaperLibraryScan,
  readPaperLibraryScan,
  reconcileStalePaperLibraryScan,
  startPaperLibraryScan,
} from "@/lib/paper-library/jobs";

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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const body = JSON.parse(await readFile(scanPath(project, scanId), "utf-8")) as Record<string, unknown>;
    if (body.status === "ready_for_review" || body.status === "ready_for_apply" || body.status === "failed") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for scan ${scanId}`);
}

describe("paper-library jobs", () => {
  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-job-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-job-test";
    initBrain({ root: path.join(dataRoot, "brain"), name: "Test Researcher" });

    const homeTmp = path.join(os.homedir(), "tmp");
    await mkdir(homeTmp, { recursive: true });
    paperRoot = await mkdtemp(path.join(homeTmp, "scienceswarm-paper-library-source-"));
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

  it("starts an idempotent durable scan and writes review shards", async () => {
    await writeFile(path.join(paperRoot, "2024 - Smith - 10.1000-test.pdf"), "fake pdf", "utf-8");
    await writeFile(path.join(paperRoot, "notes.txt"), "not a pdf", "utf-8");

    const first = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot: path.join(dataRoot, "brain"),
      idempotencyKey: "same-start",
    });
    const second = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot: path.join(dataRoot, "brain"),
      idempotencyKey: "same-start",
    });

    expect(second.id).toBe(first.id);
    const completed = await waitForScanFile("project-alpha", first.id);
    expect(completed).toMatchObject({
      id: first.id,
      project: "project-alpha",
      counters: {
        detectedFiles: 1,
      },
      reviewShardIds: ["0001"],
    });

    const reviewShard = await readFile(
      path.join(
        dataRoot,
        "projects",
        "project-alpha",
        ".brain",
        "state",
        "paper-library",
        "reviews",
        first.id,
        "0001.json",
      ),
      "utf-8",
    );
    expect(reviewShard).toContain("2024 Smith 10.1000 test");
    expect(reviewShard).toContain("text_layer_too_thin");
  });

  it("streams large scans into review shards instead of waiting for one final in-memory batch", async () => {
    const paperCount = 260;
    for (let index = 0; index < paperCount; index += 1) {
      await writeFile(
        path.join(paperRoot, `2024 - Smith - Streaming Paper ${String(index).padStart(3, "0")}.pdf`),
        `fake pdf ${index}`,
        "utf-8",
      );
    }

    const scan = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot: path.join(dataRoot, "brain"),
      idempotencyKey: "streaming-shards",
    });

    const completed = await waitForScanFile("project-alpha", scan.id);
    expect(completed).toMatchObject({
      counters: {
        detectedFiles: paperCount,
      },
      reviewShardIds: ["0001", "0002"],
    });

    const firstShard = JSON.parse(await readFile(
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
    )) as { items: unknown[] };
    const secondShard = JSON.parse(await readFile(
      path.join(
        dataRoot,
        "projects",
        "project-alpha",
        ".brain",
        "state",
        "paper-library",
        "reviews",
        scan.id,
        "0002.json",
      ),
      "utf-8",
    )) as { items: unknown[] };
    expect(firstShard.items).toHaveLength(250);
    expect(secondShard.items).toHaveLength(10);
  });

  it("rejects roots outside the user's allowed local area", async () => {
    await expect(startPaperLibraryScan({
      project: "project-alpha",
      rootPath: "/etc",
      brainRoot: path.join(dataRoot, "brain"),
    })).rejects.toThrow(/not allowed/i);
  });

  it("keeps reads pure and reconciles stale scans explicitly", async () => {
    const staleScanPath = scanPath("project-alpha", "stale-scan");
    await mkdir(path.dirname(staleScanPath), { recursive: true });
    await writeFile(staleScanPath, JSON.stringify({
      version: 1,
      id: "stale-scan",
      project: "project-alpha",
      rootPath: paperRoot,
      rootRealpath: paperRoot,
      status: "queued",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      claimId: "worker-1",
      counters: {
        detectedFiles: 0,
        identified: 0,
        needsReview: 0,
        readyForApply: 0,
        failed: 0,
      },
      warnings: [],
      currentPath: null,
      reviewShardIds: [],
    }), "utf-8");

    const readOnly = await readPaperLibraryScan("project-alpha", "stale-scan", path.join(dataRoot, "brain"));
    expect(readOnly?.status).toBe("queued");
    expect(JSON.parse(await readFile(staleScanPath, "utf-8"))).toMatchObject({
      status: "queued",
      warnings: [],
    });

    const reconciled = await reconcileStalePaperLibraryScan("project-alpha", "stale-scan", path.join(dataRoot, "brain"));
    expect(reconciled).toMatchObject({
      status: "failed",
      warnings: ["scan_worker_stale"],
    });
  });

  it("skips malformed scan filenames when restoring the latest scan", async () => {
    await writeFile(path.join(paperRoot, "2024 - Smith - Interesting Paper.pdf"), "fake pdf", "utf-8");

    const scan = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot: path.join(dataRoot, "brain"),
      idempotencyKey: "restore-latest-scan",
    });

    await waitForScanFile("project-alpha", scan.id);
    await writeFile(path.join(path.dirname(scanPath("project-alpha", scan.id)), "%E0%.json"), "not json", "utf-8");

    await expect(findLatestPaperLibraryScan("project-alpha", path.join(dataRoot, "brain"))).resolves.toMatchObject({
      id: scan.id,
    });
  });

  it("records cancellation before stale reconciliation so workers can observe it", async () => {
    const staleScanPath = scanPath("project-alpha", "stale-cancel-scan");
    await mkdir(path.dirname(staleScanPath), { recursive: true });
    await writeFile(staleScanPath, JSON.stringify({
      version: 1,
      id: "stale-cancel-scan",
      project: "project-alpha",
      rootPath: paperRoot,
      rootRealpath: paperRoot,
      status: "identifying",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      claimId: "worker-1",
      counters: {
        detectedFiles: 10,
        identified: 1,
        needsReview: 1,
        readyForApply: 0,
        failed: 0,
      },
      warnings: [],
      currentPath: "paper.pdf",
      reviewShardIds: [],
    }), "utf-8");

    const canceled = await cancelPaperLibraryScan("project-alpha", "stale-cancel-scan", path.join(dataRoot, "brain"));
    expect(canceled?.status).toBe("identifying");
    expect(canceled?.claimId).toBeUndefined();
    expect(typeof canceled?.cancelRequestedAt).toBe("string");
    expect(canceled?.warnings).toEqual([]);

    const reconciled = await reconcileStalePaperLibraryScan("project-alpha", "stale-cancel-scan", path.join(dataRoot, "brain"));
    expect(reconciled).toMatchObject({
      status: "canceled",
      warnings: [],
    });
  });

  it("does not add cancel requests to scans that already reached a stable waiting state", async () => {
    await writeFile(path.join(paperRoot, "2024 - Smith - Interesting Paper.pdf"), "fake pdf", "utf-8");
    const scan = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot: path.join(dataRoot, "brain"),
    });

    const completed = await waitForScanFile("project-alpha", scan.id);
    expect(["ready_for_review", "ready_for_apply"]).toContain(completed.status);

    const canceled = await cancelPaperLibraryScan("project-alpha", scan.id, path.join(dataRoot, "brain"));
    expect(canceled?.status).toBe(completed.status);
    expect(canceled?.cancelRequestedAt).toBeUndefined();
  });
});
