import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBrain } from "@/brain/init";
import { startPaperLibraryScan } from "@/lib/paper-library/jobs";
import {
  approveApplyPlan,
  applyApprovedPlan,
  createApplyPlan,
  undoApplyManifest,
} from "@/lib/paper-library/apply";
import {
  listPaperReviewItems,
  updatePaperReviewItem,
} from "@/lib/paper-library/review";

const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

let dataRoot: string;
let paperRoot: string;

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForScan(project: string, scanId: string): Promise<Record<string, unknown>> {
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

describe("paper-library review and apply", () => {
  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-apply-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-apply-test";
    initBrain({ root: path.join(dataRoot, "brain"), name: "Test Researcher" });

    const homeTmp = path.join(os.homedir(), "tmp");
    await mkdir(homeTmp, { recursive: true });
    paperRoot = await mkdtemp(path.join(homeTmp, "scienceswarm-paper-library-apply-source-"));
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

  it("accepts a review item, applies a validated plan, and undoes from the manifest", async () => {
    const originalPath = path.join(paperRoot, "2024 - Interesting Paper.pdf");
    await writeFile(originalPath, "fake pdf", "utf-8");

    const scan = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot: path.join(dataRoot, "brain"),
    });
    await waitForScan("project-alpha", scan.id);

    const reviewPage = await listPaperReviewItems({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot: path.join(dataRoot, "brain"),
      limit: 10,
    });
    expect(reviewPage?.items).toHaveLength(1);
    const item = reviewPage?.items[0];
    if (!item) throw new Error("expected review item");

    const accepted = await updatePaperReviewItem({
      project: "project-alpha",
      scanId: scan.id,
      itemId: item.id,
      action: "accept",
      selectedCandidateId: item.candidates[0]?.id,
      brainRoot: path.join(dataRoot, "brain"),
    });
    expect(accepted?.remainingCount).toBe(0);

    const created = await createApplyPlan({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot: path.join(dataRoot, "brain"),
      templateFormat: "{year} - {title}.pdf",
    });
    expect(created?.plan).toMatchObject({
      status: "validated",
      conflictCount: 0,
      operationCount: 1,
    });

    const approval = await approveApplyPlan({
      project: "project-alpha",
      applyPlanId: created?.plan.id ?? "",
      brainRoot: path.join(dataRoot, "brain"),
    });
    expect(approval?.approvalToken).toBeTruthy();

    const applied = await applyApprovedPlan({
      project: "project-alpha",
      applyPlanId: approval?.plan.id ?? "",
      approvalToken: approval?.approvalToken ?? "",
      brainRoot: path.join(dataRoot, "brain"),
    });
    expect(applied?.manifest.status).toBe("applied");
    expect(await exists(originalPath)).toBe(false);
    const destination = path.join(paperRoot, applied?.operations[0]?.destinationRelativePath ?? "");
    expect(await exists(destination)).toBe(true);

    const undone = await undoApplyManifest({
      project: "project-alpha",
      manifestId: applied?.manifest.id ?? "",
      brainRoot: path.join(dataRoot, "brain"),
    });
    expect(undone?.manifest.status).toBe("undone");
    expect(await exists(originalPath)).toBe(true);
    expect(await exists(destination)).toBe(false);
  });
});
