import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function waitForReady(GET: (request: Request) => Promise<Response>, project: string, scanId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await GET(new Request(`http://localhost/api/brain/paper-library/scan?project=${project}&id=${scanId}`));
    expect(response.status).toBe(200);
    const body = await response.json() as { scan: { status: string } };
    if (body.scan.status === "ready_for_review" || body.scan.status === "ready_for_apply" || body.scan.status === "failed") {
      return;
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

describe("paper-library repair route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-repair-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-repair-route-test";
    initBrain({ root: path.join(dataRoot, "brain"), name: "Test Researcher" });

    const homeTmp = path.join(os.homedir(), "tmp");
    await mkdir(homeTmp, { recursive: true });
    paperRoot = await mkdtemp(path.join(homeTmp, "scienceswarm-paper-library-repair-source-"));
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

  it("repairs a manifest that only failed during gbrain persistence", async () => {
    const originalPath = path.join(paperRoot, "2024 - Smith - Interesting Paper.pdf");
    await writeFile(originalPath, "fake pdf", "utf-8");

    const scanRoute = await import("@/app/api/brain/paper-library/scan/route");
    const scanResponse = await scanRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/scan", {
      action: "start",
      project: "project-alpha",
      rootPath: paperRoot,
      mode: "dry-run",
    }));
    expect(scanResponse.status).toBe(200);
    const scanStarted = await scanResponse.json() as { scanId: string };
    await waitForReady(scanRoute.GET, "project-alpha", scanStarted.scanId);

    const reviewRoute = await import("@/app/api/brain/paper-library/review/route");
    const reviewResponse = await reviewRoute.GET(new Request(
      `http://localhost/api/brain/paper-library/review?project=project-alpha&scanId=${scanStarted.scanId}&limit=10`,
    ));
    const reviewPage = await reviewResponse.json() as {
      items: Array<{ id: string; candidates: Array<{ id: string }> }>;
    };

    const acceptedResponse = await reviewRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/review", {
      project: "project-alpha",
      scanId: scanStarted.scanId,
      itemId: reviewPage.items[0]?.id,
      action: "accept",
      selectedCandidateId: reviewPage.items[0]?.candidates[0]?.id,
    }));
    expect(acceptedResponse.status).toBe(200);

    const applyPlanRoute = await import("@/app/api/brain/paper-library/apply-plan/route");
    const createdResponse = await applyPlanRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/apply-plan", {
      project: "project-alpha",
      scanId: scanStarted.scanId,
      templateFormat: "{year} - {title}.pdf",
    }));
    const created = await createdResponse.json() as { applyPlanId: string };

    const approveRoute = await import("@/app/api/brain/paper-library/apply-plan/approve/route");
    const approvalResponse = await approveRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/apply-plan/approve", {
      project: "project-alpha",
      applyPlanId: created.applyPlanId,
      userConfirmation: true,
    }));
    const approval = await approvalResponse.json() as { approvalToken: string };

    const writerModule = await import("@/lib/paper-library/gbrain-writer");
    const persistSpy = vi.spyOn(writerModule, "persistAppliedPaperLocations")
      .mockRejectedValueOnce(new Error("gbrain offline"))
      .mockResolvedValueOnce();

    const applyRoute = await import("@/app/api/brain/paper-library/apply/route");
    const applyResponse = await applyRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/apply", {
      project: "project-alpha",
      applyPlanId: created.applyPlanId,
      approvalToken: approval.approvalToken,
    }));
    expect(applyResponse.status).toBe(200);
    const applied = await applyResponse.json() as {
      manifestId: string;
      status: string;
      manifest: { status: string; warnings: string[] };
    };
    expect(applied.status).toBe("applied_with_repair_required");
    expect(applied.manifest.warnings).toContain("gbrain offline");

    const repairRoute = await import("@/app/api/brain/paper-library/repair/route");
    const repairResponse = await repairRoute.POST(jsonRequest("http://localhost/api/brain/paper-library/repair", {
      project: "project-alpha",
      manifestId: applied.manifestId,
    }));
    expect(repairResponse.status).toBe(200);
    await expect(repairResponse.json()).resolves.toMatchObject({
      ok: true,
      repaired: true,
      status: "applied",
      manifest: {
        id: applied.manifestId,
        status: "applied",
        warnings: [],
      },
    });
    expect(persistSpy).toHaveBeenCalledTimes(2);
  });
});
