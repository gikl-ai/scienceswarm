import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBrainConfig: vi.fn(),
  isLocalRequest: vi.fn(),
  putPage: vi.fn(),
}));

vi.mock("@/app/api/brain/_shared", () => ({
  getBrainConfig: mocks.getBrainConfig,
  isErrorResponse: (value: unknown) => value instanceof Response,
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: mocks.isLocalRequest,
}));

vi.mock("@/brain/in-process-gbrain-client", () => ({
  createInProcessGbrainClient: () => ({
    putPage: mocks.putPage,
  }),
}));

vi.mock("@/lib/setup/gbrain-installer", () => ({
  getCurrentUserHandle: () => "@alice",
}));

let brainRoot: string;

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/brain/decision-update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("decision update route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.getBrainConfig.mockReset();
    mocks.isLocalRequest.mockReset();
    mocks.putPage.mockReset();
    mocks.isLocalRequest.mockResolvedValue(true);

    brainRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-decision-update-"));
    mocks.getBrainConfig.mockReturnValue({ root: brainRoot });
  });

  afterEach(async () => {
    await rm(brainRoot, { recursive: true, force: true });
  });

  it("does not duplicate an Updates section at the top of the decision body", async () => {
    const decisionDir = path.join(brainRoot, "wiki", "decisions");
    await mkdir(decisionDir, { recursive: true });
    const decisionPath = path.join(decisionDir, "project-alpha-decision.md");
    await writeFile(
      decisionPath,
      [
        "---",
        "type: decision",
        "project: project-alpha",
        "source_refs: []",
        "---",
        "## Updates",
        "",
        "### 2026-04-21 10:00 update",
        "",
        "Initial decision update.",
      ].join("\n"),
      "utf-8",
    );

    const { POST } = await import("@/app/api/brain/decision-update/route");
    const response = await POST(request({
      slug: "project-alpha-decision",
      project: "project-alpha",
      content: "Second decision update.",
      sourceRefs: [],
    }));

    expect(response.status).toBe(200);
    const updated = await readFile(decisionPath, "utf-8");
    expect(updated.match(/^## Updates$/gm)).toHaveLength(1);
    expect(updated).toContain("Second decision update.");
    expect(mocks.putPage).toHaveBeenCalledWith(
      "project-alpha-decision",
      expect.stringContaining("Second decision update."),
    );
  });

  it("rejects traversal slugs before filesystem access", async () => {
    const { POST } = await import("@/app/api/brain/decision-update/route");
    const response = await POST(request({
      slug: "../../outside",
      project: "project-alpha",
      content: "Attempted update.",
      sourceRefs: [],
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Could not resolve decision path",
    });
    expect(mocks.putPage).not.toHaveBeenCalled();
  });

  it("rejects invalid project slugs with a clean 400", async () => {
    const { POST } = await import("@/app/api/brain/decision-update/route");
    const response = await POST(request({
      slug: "project-alpha-decision",
      project: "../project-alpha",
      content: "Attempted update.",
      sourceRefs: [],
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "study must be a safe bare slug",
    });
    expect(mocks.putPage).not.toHaveBeenCalled();
  });
});
