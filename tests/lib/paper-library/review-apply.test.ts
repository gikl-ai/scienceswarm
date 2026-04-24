import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("blocks apply before any rename when an approved source file changes", async () => {
    const alphaPath = path.join(paperRoot, "2024 - Alpha Paper.pdf");
    const betaPath = path.join(paperRoot, "2025 - Beta Paper.pdf");
    await writeFile(alphaPath, "fake pdf alpha", "utf-8");
    await writeFile(betaPath, "fake pdf beta", "utf-8");

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
    expect(reviewPage?.items).toHaveLength(2);
    for (const item of reviewPage?.items ?? []) {
      await updatePaperReviewItem({
        project: "project-alpha",
        scanId: scan.id,
        itemId: item.id,
        action: "accept",
        selectedCandidateId: item.candidates[0]?.id,
        brainRoot,
      });
    }

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

    await writeFile(alphaPath, "mutated after approval", "utf-8");

    await expect(applyApprovedPlan({
      project: "project-alpha",
      applyPlanId: approval?.plan.id ?? "",
      approvalToken: approval?.approvalToken ?? "",
      brainRoot,
    })).rejects.toThrow(/source/i);

    for (const operation of created?.operations ?? []) {
      const destination = path.join(paperRoot, operation.destinationRelativePath);
      expect(await exists(destination)).toBe(false);
    }
    expect(await exists(alphaPath)).toBe(true);
    expect(await exists(betaPath)).toBe(true);
  });

  it("blocks approval when a rendered destination already exists on disk", async () => {
    const originalPath = path.join(paperRoot, "source.pdf");
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
      action: "correct",
      selectedCandidateId: item.candidates[0]?.id,
      correction: {
        year: 2024,
        title: "Collision Paper",
      },
      brainRoot,
    });

    await writeFile(path.join(paperRoot, "2024 - Collision Paper.pdf"), "existing destination", "utf-8");

    const created = await createApplyPlan({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot,
      templateFormat: "{year} - {title}.pdf",
    });
    expect(created?.plan).toMatchObject({
      status: "blocked",
      conflictCount: 1,
    });
    expect(created?.operations[0]?.conflictCodes).toContain("destination_exists");
    await expect(approveApplyPlan({
      project: "project-alpha",
      applyPlanId: created?.plan.id ?? "",
      brainRoot,
    })).rejects.toThrow(/validated/i);
  });

  it("allows valid rename chains by applying blocking source moves first", async () => {
    const firstPath = path.join(paperRoot, "a.pdf");
    const secondPath = path.join(paperRoot, "b.pdf");
    await writeFile(firstPath, "first pdf", "utf-8");
    await writeFile(secondPath, "second pdf", "utf-8");

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
    const firstItem = reviewPage?.items.find((item) => item.source?.relativePath === "a.pdf");
    const secondItem = reviewPage?.items.find((item) => item.source?.relativePath === "b.pdf");
    if (!firstItem || !secondItem) throw new Error("expected review items for rename chain");

    await updatePaperReviewItem({
      project: "project-alpha",
      scanId: scan.id,
      itemId: firstItem.id,
      action: "correct",
      selectedCandidateId: firstItem.candidates[0]?.id,
      correction: { title: "b" },
      brainRoot,
    });
    await updatePaperReviewItem({
      project: "project-alpha",
      scanId: scan.id,
      itemId: secondItem.id,
      action: "correct",
      selectedCandidateId: secondItem.candidates[0]?.id,
      correction: { title: "c" },
      brainRoot,
    });

    const created = await createApplyPlan({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot,
      templateFormat: "{title}.pdf",
    });
    expect(created?.plan).toMatchObject({
      status: "validated",
      conflictCount: 0,
    });
    expect(created?.operations.map((operation) => operation.source?.relativePath)).toEqual(["b.pdf", "a.pdf"]);

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
    });

    expect(applied?.manifest.status).toBe("applied");
    expect(await readFile(secondPath, "utf-8")).toBe("first pdf");
    expect(await readFile(path.join(paperRoot, "c.pdf"), "utf-8")).toBe("second pdf");
    expect(await exists(firstPath)).toBe(false);
  });

  it("treats case-only apply and undo operations as noops", async () => {
    const originalPath = path.join(paperRoot, "Paper.pdf");
    await writeFile(originalPath, "case-only pdf", "utf-8");

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
      action: "correct",
      selectedCandidateId: item.candidates[0]?.id,
      correction: { title: "paper" },
      brainRoot,
    });

    const created = await createApplyPlan({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot,
      templateFormat: "{title}.pdf",
    });
    expect(created?.plan.status).toBe("validated");
    expect(created?.operations[0]).toMatchObject({
      source: { relativePath: "Paper.pdf" },
      destinationRelativePath: "paper.pdf",
      conflictCodes: [],
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
    });
    expect(applied?.manifest.status).toBe("applied");
    expect(await exists(originalPath)).toBe(true);

    const undone = await undoApplyManifest({
      project: "project-alpha",
      manifestId: applied?.manifest.id ?? "",
      brainRoot,
    });
    expect(undone?.manifest.status).toBe("undone");
    expect(undone?.operations[0]?.status).toBe("undone");
    expect(await exists(originalPath)).toBe(true);
  });

  it("does not create directories through symlinked destination parents during apply", async () => {
    const originalPath = path.join(paperRoot, "source.pdf");
    await writeFile(originalPath, "fake pdf", "utf-8");
    const outsideRoot = await mkdtemp(path.join(os.homedir(), "tmp", "scienceswarm-paper-library-outside-"));
    const outsideSubdir = path.join(outsideRoot, "sub");
    await symlink(outsideRoot, path.join(paperRoot, "linked-outside"));

    try {
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
        action: "correct",
        selectedCandidateId: item.candidates[0]?.id,
        correction: {
          title: "Escaping Parent",
        },
        brainRoot,
      });

      const created = await createApplyPlan({
        project: "project-alpha",
        scanId: scan.id,
        brainRoot,
        templateFormat: "linked-outside/sub/{title}.pdf",
      });
      expect(created?.plan.status).toBe("validated");

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
      });

      expect(applied?.manifest.status).toBe("failed");
      expect(applied?.operations[0]?.error).toMatch(/symlink|escapes/i);
      expect(await exists(outsideSubdir)).toBe(false);
      expect(await exists(originalPath)).toBe(true);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
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

  it("repairs zero-operation manifests after a writeback-only failure", async () => {
    const brainRoot = path.join(dataRoot, "brain");
    const scan = await startPaperLibraryScan({
      project: "project-alpha",
      rootPath: paperRoot,
      brainRoot,
    });
    await waitForScan("project-alpha", scan.id);

    const created = await createApplyPlan({
      project: "project-alpha",
      scanId: scan.id,
      brainRoot,
      templateFormat: "{year} - {title}.pdf",
    });
    expect(created?.plan.operationCount).toBe(0);

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
    expect(applied?.operations).toHaveLength(0);

    const repaired = await repairAppliedManifest({
      project: "project-alpha",
      manifestId: applied?.manifest.id ?? "",
      brainRoot,
      persistLocations: async () => {},
    });

    expect(repaired?.repaired).toBe(true);
    expect(repaired?.manifest.status).toBe("applied");
    expect(repaired?.operations).toHaveLength(0);
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
