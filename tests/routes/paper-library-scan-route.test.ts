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

describe("paper-library scan route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-route-test";
    initBrain({ root: path.join(dataRoot, "brain"), name: "Test Researcher" });

    const homeTmp = path.join(os.homedir(), "tmp");
    await mkdir(homeTmp, { recursive: true });
    paperRoot = await mkdtemp(path.join(homeTmp, "scienceswarm-paper-library-route-source-"));
    await writeFile(path.join(paperRoot, "2024 - Smith - Interesting Paper.pdf"), "fake pdf", "utf-8");
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

  it("starts and polls a dry-run paper library scan", async () => {
    const { GET, POST } = await import("@/app/api/brain/paper-library/scan/route");
    const response = await POST(new Request("http://localhost/api/brain/paper-library/scan", {
      method: "POST",
      body: JSON.stringify({
        action: "start",
        project: "project-alpha",
        rootPath: paperRoot,
        mode: "dry-run",
        idempotencyKey: "route-start",
      }),
    }));

    expect(response.status).toBe(200);
    const started = await response.json() as { ok: boolean; scanId: string; status: string };
    expect(started).toMatchObject({ ok: true, status: "queued" });

    const completed = await waitForReady(GET, "project-alpha", started.scanId);
    expect(completed).toMatchObject({
      id: started.scanId,
      project: "project-alpha",
      counters: {
        detectedFiles: 1,
      },
    });
  });

  it("returns the latest scan for a project", async () => {
    const { GET, POST } = await import("@/app/api/brain/paper-library/scan/route");

    const firstResponse = await POST(new Request("http://localhost/api/brain/paper-library/scan", {
      method: "POST",
      body: JSON.stringify({
        action: "start",
        project: "project-alpha",
        rootPath: paperRoot,
        mode: "dry-run",
        idempotencyKey: "route-latest-1",
      }),
    }));
    const first = await firstResponse.json() as { scanId: string };
    await waitForReady(GET, "project-alpha", first.scanId);

    await writeFile(path.join(paperRoot, "2025 - Jones - Newer Paper.pdf"), "fake pdf", "utf-8");

    const secondResponse = await POST(new Request("http://localhost/api/brain/paper-library/scan", {
      method: "POST",
      body: JSON.stringify({
        action: "start",
        project: "project-alpha",
        rootPath: paperRoot,
        mode: "dry-run",
        idempotencyKey: "route-latest-2",
      }),
    }));
    const second = await secondResponse.json() as { scanId: string };
    await waitForReady(GET, "project-alpha", second.scanId);

    const latestResponse = await GET(new Request("http://localhost/api/brain/paper-library/scan?project=project-alpha&latest=1"));
    expect(latestResponse.status).toBe(200);
    await expect(latestResponse.json()).resolves.toMatchObject({
      ok: true,
      scan: {
        id: second.scanId,
        counters: {
          detectedFiles: 2,
        },
      },
    });
  });

  it("rejects non-local requests", async () => {
    mockIsLocal.mockResolvedValue(false);
    const { POST } = await import("@/app/api/brain/paper-library/scan/route");
    const response = await POST(new Request("http://localhost/api/brain/paper-library/scan", {
      method: "POST",
      body: JSON.stringify({ action: "start", project: "project-alpha", rootPath: paperRoot }),
    }));
    expect(response.status).toBe(403);
  });

  it("validates malformed input", async () => {
    const { POST } = await import("@/app/api/brain/paper-library/scan/route");
    const response = await POST(new Request("http://localhost/api/brain/paper-library/scan", {
      method: "POST",
      body: JSON.stringify({ action: "start", project: "../bad", rootPath: paperRoot }),
    }));
    expect(response.status).toBe(400);
  });

  it("validates lookup project slugs before reading state", async () => {
    const { GET } = await import("@/app/api/brain/paper-library/scan/route");
    const response = await GET(new Request("http://localhost/api/brain/paper-library/scan?project=../bad&id=scan-1"));
    expect(response.status).toBe(400);
  });
});
