import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installerModuleLoaded: vi.fn(),
  isLocalRequest: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  defaultInstallerEnvironment: vi.fn(async () => ({ marker: "env" })),
  runInstaller: vi.fn(async function* () {
    yield { type: "summary", status: "ok" } as const;
  }),
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: (request: Request) => mocks.isLocalRequest(request),
}));

vi.mock("@/lib/setup/gbrain-installer", async () => {
  mocks.installerModuleLoaded();
  return {
    defaultInstallerEnvironment: (...args: unknown[]) =>
      mocks.defaultInstallerEnvironment(...args),
    runInstaller: (...args: unknown[]) => mocks.runInstaller(...args),
  };
});

describe("POST /api/setup/install-brain", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.isLocalRequest.mockResolvedValue(true);
    mocks.defaultInstallerEnvironment.mockResolvedValue({ marker: "env" });
    mocks.runInstaller.mockImplementation(async function* () {
      yield { type: "summary", status: "ok" } as const;
    });
  });

  it("does not evaluate the installer module when the route is imported", async () => {
    const route = await import("@/app/api/setup/install-brain/route");

    expect(route.POST).toBeTypeOf("function");
    expect(mocks.installerModuleLoaded).not.toHaveBeenCalled();
  });

  it("loads the installer module only when handling a local POST", async () => {
    const { POST } = await import("@/app/api/setup/install-brain/route");

    const response = await POST(
      new Request("http://localhost/api/setup/install-brain", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(mocks.installerModuleLoaded).toHaveBeenCalledTimes(1);
    expect(mocks.defaultInstallerEnvironment).toHaveBeenCalledTimes(1);
    expect(mocks.runInstaller).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: process.cwd() }),
      { marker: "env" },
    );
    await expect(response.text()).resolves.toContain("event: summary");
  });
});
