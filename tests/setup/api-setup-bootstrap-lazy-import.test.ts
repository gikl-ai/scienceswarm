import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

describe("POST /api/setup/bootstrap lazy import", () => {
  beforeEach(() => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    delete process.env.SCIENCESWARM_CONFIG_ROOT;
  });

  it("keeps the orchestrator unloaded until a valid request starts streaming", async () => {
    const runBootstrap = vi.fn(async function* () {
      yield {
        type: "summary",
        status: "done",
        failed: [],
        skipped: [],
      };
    });
    const loadOrchestrator = vi.fn(() => ({
      runBootstrap,
    }));
    vi.doMock("@/lib/setup/bootstrap-orchestrator", loadOrchestrator);

    const { POST } = await import("@/app/api/setup/bootstrap/route");
    expect(loadOrchestrator).not.toHaveBeenCalled();

    const invalidResponse = await POST(
      new Request("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(invalidResponse.status).toBe(400);
    expect(loadOrchestrator).not.toHaveBeenCalled();

    const validResponse = await POST(
      new Request("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "alice" }),
      }),
    );

    expect(validResponse.status).toBe(200);
    await expect(validResponse.text()).resolves.toContain('"status":"done"');
    expect(loadOrchestrator).toHaveBeenCalledTimes(1);
    expect(runBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: "alice",
        repoRoot: process.cwd(),
      }),
    );
  });

  it("passes the writable desktop config root to the orchestrator", async () => {
    process.env.SCIENCESWARM_CONFIG_ROOT = "/tmp/scienceswarm-user-data";
    const runBootstrap = vi.fn(async function* () {
      yield {
        type: "summary",
        status: "done",
        failed: [],
        skipped: [],
      };
    });
    vi.doMock("@/lib/setup/bootstrap-orchestrator", () => ({
      runBootstrap,
    }));

    const { POST } = await import("@/app/api/setup/bootstrap/route");
    const response = await POST(
      new Request("http://localhost/api/setup/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "alice" }),
      }),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(runBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/tmp/scienceswarm-user-data",
      }),
    );
  });
});
