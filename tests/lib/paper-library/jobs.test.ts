import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBrain } from "@/brain/init";
import { startPaperLibraryScan } from "@/lib/paper-library/jobs";

const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

let dataRoot: string;
let paperRoot: string;

async function waitForScanFile(project: string, scanId: string): Promise<Record<string, unknown>> {
  const scanPath = path.join(
    dataRoot,
    "projects",
    project,
    ".brain",
    "state",
    "paper-library",
    "scans",
    `${scanId}.json`,
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = JSON.parse(await readFile(scanPath, "utf-8")) as Record<string, unknown>;
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

  it("rejects roots outside the user's allowed local area", async () => {
    await expect(startPaperLibraryScan({
      project: "project-alpha",
      rootPath: "/etc",
      brainRoot: path.join(dataRoot, "brain"),
    })).rejects.toThrow(/not allowed/i);
  });
});
