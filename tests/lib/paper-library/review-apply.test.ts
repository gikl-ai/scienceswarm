import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBrain } from "@/brain/init";
import { getBrainStore } from "@/brain/store";
import {
  readPaperLibraryScan,
  startPaperLibraryScan,
} from "@/lib/paper-library/jobs";
import {
  approveApplyPlan,
  applyApprovedPlan,
  createApplyPlan,
  repairAppliedManifest,
  undoApplyManifest,
} from "@/lib/paper-library/apply";
import {
  listPaperReviewItems,
  updatePaperReviewItem,
} from "@/lib/paper-library/review";
import { persistAppliedPaperLocations } from "@/lib/paper-library/gbrain-writer";

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
      idempotencyKey: "apply-review-test",
      brainRoot: path.join(dataRoot, "brain"),
    });
    expect(applied?.manifest.status).toBe("applied");
    expect(await exists(originalPath)).toBe(false);
    const destination = path.join(paperRoot, applied?.operations[0]?.destinationRelativePath ?? "");
    expect(await exists(destination)).toBe(true);
    await expect(readFile(path.join(
      dataRoot,
      "projects",
      "project-alpha",
      ".brain",
      "state",
      "paper-library",
      "apply-idempotency",
      "apply-review-test.json",
    ), "utf-8")).resolves.toContain(applied?.manifest.id ?? "");

    await expect(applyApprovedPlan({
      project: "project-alpha",
      applyPlanId: approval?.plan.id ?? "",
      approvalToken: "wrong-approval-token",
      brainRoot: path.join(dataRoot, "brain"),
    })).rejects.toThrow(/token/i);

    const undone = await undoApplyManifest({
      project: "project-alpha",
      manifestId: applied?.manifest.id ?? "",
      brainRoot: path.join(dataRoot, "brain"),
    });
    expect(undone?.manifest.status).toBe("undone");
    expect(await exists(originalPath)).toBe(true);
    expect(await exists(destination)).toBe(false);
  });

  it("clears the active apply plan when a reviewed item changes", async () => {
    const originalPath = path.join(paperRoot, "2024 - Interesting Paper.pdf");
    await writeFile(originalPath, "fake pdf", "utf-8");

    const brainRoot = path.join(dataRoot, "brain");
    const scan = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot,
    });
    await waitForScan("project-alpha", scan.id);

    const reviewPage = await listPaperReviewItems({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot,
      limit: 10,
    });
    const item = reviewPage?.items[0];
    if (!item) throw new Error("expected review item");

    await updatePaperReviewItem({
      project: "project-alpha",
      scanId: scan.id,
      itemId: item.id,
      action: "accept",
      selectedCandidateId: item.candidates[0]?.id,
      brainRoot,
    });

    const created = await createApplyPlan({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot,
      templateFormat: "{year} - {title}.pdf",
    });
    expect(created?.plan.id).toBeTruthy();

    const afterPlan = await readPaperLibraryScan("project-alpha", scan.id, brainRoot);
    expect(afterPlan?.applyPlanId).toBe(created?.plan.id);

    await updatePaperReviewItem({
      project: "project-alpha",
      scanId: scan.id,
      itemId: item.id,
      action: "correct",
      selectedCandidateId: item.candidates[0]?.id,
      correction: {
        title: "Interesting Paper Revised",
      },
      brainRoot,
    });

    const afterCorrection = await readPaperLibraryScan("project-alpha", scan.id, brainRoot);
    expect(afterCorrection?.applyPlanId).toBeUndefined();
    expect(afterCorrection?.status).toBe("ready_for_apply");
  });

  it("repairs an applied manifest after gbrain writeback fails", async () => {
    const originalPath = path.join(paperRoot, "2024 - Interesting Paper.pdf");
    await writeFile(originalPath, "fake pdf", "utf-8");

    const brainRoot = path.join(dataRoot, "brain");
    const scan = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot,
    });
    await waitForScan("project-alpha", scan.id);

    const reviewPage = await listPaperReviewItems({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot,
      limit: 10,
    });
    const item = reviewPage?.items[0];
    if (!item) throw new Error("expected review item");

    await updatePaperReviewItem({
      project: "project-alpha",
      scanId: scan.id,
      itemId: item.id,
      action: "accept",
      selectedCandidateId: item.candidates[0]?.id,
      brainRoot,
    });

    const created = await createApplyPlan({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot,
      templateFormat: "{year} - {title}.pdf",
    });
    const approval = await approveApplyPlan({
      project: "project-alpha",
      applyPlanId: created?.plan.id ?? "",
      brainRoot,
    });

    const applied = await applyApprovedPlan({
      project: "project-alpha",
      applyPlanId: approval?.plan.id ?? "",
      approvalToken: approval?.approvalToken ?? "",
      brainRoot,
      persistLocations: async () => {
        throw new Error("gbrain writer offline");
      },
    });
    expect(applied?.manifest.status).toBe("applied_with_repair_required");
    expect(applied?.manifest.warnings).toContain("gbrain writer offline");

    const destination = path.join(paperRoot, applied?.operations[0]?.destinationRelativePath ?? "");
    expect(await exists(originalPath)).toBe(false);
    expect(await exists(destination)).toBe(true);

    let repairedCalls = 0;
    const repaired = await repairAppliedManifest({
      project: "project-alpha",
      manifestId: applied?.manifest.id ?? "",
      brainRoot,
      persistLocations: async () => {
        repairedCalls += 1;
      },
    });
    expect(repairedCalls).toBe(1);
    expect(repaired?.repaired).toBe(true);
    expect(repaired?.manifest.status).toBe("applied");
    expect(repaired?.manifest.warnings).toEqual([]);
    expect(await exists(originalPath)).toBe(false);
    expect(await exists(destination)).toBe(true);
  });

  it("repairs with the metadata captured at apply time even if the review item changes later", async () => {
    const originalPath = path.join(paperRoot, "2024 - Interesting Paper.pdf");
    await writeFile(originalPath, "fake pdf", "utf-8");

    const brainRoot = path.join(dataRoot, "brain");
    const scan = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot,
    });
    await waitForScan("project-alpha", scan.id);

    const reviewPage = await listPaperReviewItems({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot,
      limit: 10,
    });
    const item = reviewPage?.items[0];
    if (!item) throw new Error("expected review item");

    await updatePaperReviewItem({
      project: "project-alpha",
      scanId: scan.id,
      itemId: item.id,
      action: "accept",
      selectedCandidateId: item.candidates[0]?.id,
      brainRoot,
    });

    const created = await createApplyPlan({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot,
      templateFormat: "{year} - {title}.pdf",
    });
    const approval = await approveApplyPlan({
      project: "project-alpha",
      applyPlanId: created?.plan.id ?? "",
      brainRoot,
    });

    const applied = await applyApprovedPlan({
      project: "project-alpha",
      applyPlanId: approval?.plan.id ?? "",
      approvalToken: approval?.approvalToken ?? "",
      brainRoot,
      persistLocations: async () => {
        throw new Error("gbrain writer offline");
      },
    });
    expect(applied?.manifest.status).toBe("applied_with_repair_required");
    const capturedTitle = applied?.operations[0]?.appliedMetadata?.title;
    expect(capturedTitle).toBeTruthy();

    await updatePaperReviewItem({
      project: "project-alpha",
      scanId: scan.id,
      itemId: item.id,
      action: "correct",
      selectedCandidateId: item.candidates[0]?.id,
      correction: {
        title: "Retitled After Apply Failure",
      },
      brainRoot,
    });

    const repaired = await repairAppliedManifest({
      project: "project-alpha",
      manifestId: applied?.manifest.id ?? "",
      brainRoot,
      persistLocations: persistAppliedPaperLocations,
    });

    expect(repaired?.repaired).toBe(true);
    expect(repaired?.operations[0]?.appliedMetadata?.title).toBe(capturedTitle);

    const pageSlug = repaired?.operations[0]?.appliedMetadata?.pageSlug;
    if (!pageSlug) throw new Error("expected applied metadata page slug");
    const page = await getBrainStore({ root: brainRoot }).getPage(pageSlug);
    expect(page?.title).toBe(capturedTitle);
    expect(page?.title).not.toBe("Retitled After Apply Failure");
  });
});
