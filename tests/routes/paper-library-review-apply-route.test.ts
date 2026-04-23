import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

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

async function waitForReady(GET: (request: Request) => Promise<Response>, project: string, scanId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await GET(new Request(`http://localhost/api/brain/paper-library/scan?project=${project}&id=${scanId}`));
    expect(response.status).toBe(200);
    const body = await response.json() as { scan: Record<string, unknown> };
    if (body.scan.status === "ready_for_review" || body.scan.status === "ready_for_apply" || body.scan.status === "failed") {
      return body.scan;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for scan ${scanId}`);
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("paper-library review and apply routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-apply-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-apply-route-test";
    initBrain({ root: path.join(dataRoot, "brain"), name: "Test Researcher" });

    const homeTmp = path.join(os.homedir(), "tmp");
    await mkdir(homeTmp, { recursive: true });
    paperRoot = await mkdtemp(path.join(homeTmp, "scienceswarm-paper-library-apply-route-source-"));
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

  it("reviews, approves, applies, and undoes a paper-library move over HTTP", async () => {
    const originalPath = path.join(paperRoot, "2024 - Smith - Interesting Paper.pdf");
    await writeFile(originalPath, "fake pdf", "utf-8");

    const scanRoute = await import("@/app/api/brain/paper-library/scan/route");
    const scanResponse = await scanRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/scan", {
      action: "start",
      project: "project-alpha",
      rootPath: paperRoot,
      mode: "dry-run",
      idempotencyKey: "route-review-apply-start",
    }));
    expect(scanResponse.status).toBe(200);
    const scanStarted = await scanResponse.json() as { scanId: string };
    await waitForReady(scanRoute.GET, "project-alpha", scanStarted.scanId);

    const reviewRoute = await import("@/app/api/brain/paper-library/review/route");
    const reviewResponse = await reviewRoute.GET(new Request(
      `http://localhost/api/brain/paper-library/review?project=project-alpha&scanId=${scanStarted.scanId}&limit=10`,
    ));
    expect(reviewResponse.status).toBe(200);
    const reviewPage = await reviewResponse.json() as {
      items: Array<{ id: string; paperId: string; candidates: Array<{ id: string }> }>;
    };
    expect(reviewPage.items).toHaveLength(1);

    const acceptedResponse = await reviewRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/review", {
      project: "project-alpha",
      scanId: scanStarted.scanId,
      itemId: reviewPage.items[0]?.id,
      action: "accept",
      selectedCandidateId: reviewPage.items[0]?.candidates[0]?.id,
    }));
    expect(acceptedResponse.status).toBe(200);
    await expect(acceptedResponse.json()).resolves.toMatchObject({ ok: true, remainingCount: 0 });

    const applyPlanRoute = await import("@/app/api/brain/paper-library/apply-plan/route");
    const createdResponse = await applyPlanRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/apply-plan", {
      project: "project-alpha",
      scanId: scanStarted.scanId,
      templateFormat: "{year} - {title}.pdf",
    }));
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json() as { applyPlanId: string; status: string };
    expect(created.status).toBe("validated");

    const approveRoute = await import("@/app/api/brain/paper-library/apply-plan/approve/route");
    const approvalResponse = await approveRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/apply-plan/approve", {
      project: "project-alpha",
      applyPlanId: created.applyPlanId,
      userConfirmation: true,
    }));
    expect(approvalResponse.status).toBe(200);
    const approval = await approvalResponse.json() as { approvalToken: string };
    expect(approval.approvalToken).toBeTruthy();

    const applyRoute = await import("@/app/api/brain/paper-library/apply/route");
    const applyResponse = await applyRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/apply", {
      project: "project-alpha",
      applyPlanId: created.applyPlanId,
      approvalToken: approval.approvalToken,
      idempotencyKey: "route-review-apply-manifest",
    }));
    expect(applyResponse.status).toBe(200);
    const applied = await applyResponse.json() as {
      manifestId: string;
      status: string;
      manifest: { appliedCount: number };
    };
    expect(applied).toMatchObject({
      status: "applied",
      manifest: { appliedCount: 1 },
    });
    expect(await exists(originalPath)).toBe(false);
    const { getBrainStore } = await import("@/brain/store");
    const page = await getBrainStore({ root: path.join(dataRoot, "brain") })
      .getPage(`wiki/entities/papers/local-${reviewPage.items[0]?.paperId}`);
    expect(page).toMatchObject({
      title: expect.stringContaining("Interesting"),
      frontmatter: {
        entity_type: "paper",
        paper_library: expect.objectContaining({
          project: "project-alpha",
          apply_manifest_id: applied.manifestId,
        }),
      },
    });

    const repeatedApply = await applyRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/apply", {
      project: "project-alpha",
      applyPlanId: created.applyPlanId,
      approvalToken: approval.approvalToken,
      idempotencyKey: "route-review-apply-manifest",
    }));
    expect(repeatedApply.status).toBe(200);
    await expect(repeatedApply.json()).resolves.toMatchObject({
      manifestId: applied.manifestId,
      status: "applied",
    });

    const manifestRoute = await import("@/app/api/brain/paper-library/manifest/route");
    const manifestResponse = await manifestRoute.GET(new Request(
      `http://localhost/api/brain/paper-library/manifest?project=project-alpha&id=${applied.manifestId}&limit=10`,
    ));
    expect(manifestResponse.status).toBe(200);
    await expect(manifestResponse.json()).resolves.toMatchObject({
      ok: true,
      manifest: {
        id: applied.manifestId,
        status: "applied",
        appliedCount: 1,
      },
      operations: [
        expect.objectContaining({
          sourceRelativePath: "2024 - Smith - Interesting Paper.pdf",
          status: "verified",
        }),
      ],
    });

    const undoRoute = await import("@/app/api/brain/paper-library/undo/route");
    const undoResponse = await undoRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/undo", {
      project: "project-alpha",
      manifestId: applied.manifestId,
    }));
    expect(undoResponse.status).toBe(200);
    await expect(undoResponse.json()).resolves.toMatchObject({
      ok: true,
      status: "undone",
      undoneCount: 1,
    });
    expect(await exists(originalPath)).toBe(true);
  });
});
