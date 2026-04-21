import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const mockAccess = vi.fn();
const mockMkdir = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();
const { nanoclawUrl } = vi.hoisted(() => ({
  nanoclawUrl: { value: "http://127.0.0.1:3002" },
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

vi.mock("@/lib/nanoclaw", () => ({
  get NANOCLAW_URL() {
    return nanoclawUrl.value;
  },
}));

vi.mock("node:fs/promises", () => ({
  access: (...args: unknown[]) => mockAccess(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

describe("GET /api/settings/nanoclaw", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockIsLocal.mockResolvedValue(true);
    mockAccess.mockRejectedValue(new Error("missing"));
    mockMkdir.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(new Error("missing"));
    mockWriteFile.mockResolvedValue(undefined);
    nanoclawUrl.value = "http://127.0.0.1:3002";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === `${nanoclawUrl.value}/health`) {
        return Response.json({ status: "connected" });
      }
      throw new Error(`Unhandled fetch: ${String(input)}`);
    }));
  });

  it("hooks into an already running external NanoClaw instance", async () => {
    const { GET } = await import("@/app/api/settings/nanoclaw/route");
    const response = await GET();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toMatchObject({
      cloned: false,
      installed: true,
      configured: true,
      running: true,
      managed: false,
      source: "external",
      url: "http://127.0.0.1:3002",
      steps: {
        install: true,
        configure: true,
        start: true,
      },
    });
  });

  it("keeps an attached runtime marked external when a local checkout exists but is not actually installed", async () => {
    mockAccess.mockImplementation(async (path: string) => {
      if (path.endsWith("/nanoclaw")) {
        return;
      }
      throw new Error("missing");
    });

    const { GET } = await import("@/app/api/settings/nanoclaw/route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cloned: true,
      installed: true,
      configured: true,
      running: true,
      managed: false,
      source: "external",
    });
  });

  it("checks the configured NanoClaw URL instead of a hard-coded default port", async () => {
    nanoclawUrl.value = "http://127.0.0.1:4311";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "http://127.0.0.1:4311/health") {
        return Response.json({ status: "connected" });
      }
      throw new Error(`Unhandled fetch: ${String(input)}`);
    }));

    const { GET } = await import("@/app/api/settings/nanoclaw/route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      running: true,
      source: "external",
      url: "http://127.0.0.1:4311",
    });
  });

  it("treats install as a no-op when an external NanoClaw runtime is already attached", async () => {
    const { POST } = await import("@/app/api/settings/nanoclaw/route");
    const request = new Request("http://localhost/api/settings/nanoclaw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "install" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      alreadyInstalled: true,
      status: {
        source: "external",
        running: true,
      },
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("treats start as a no-op when an external NanoClaw runtime is already attached", async () => {
    const { POST } = await import("@/app/api/settings/nanoclaw/route");
    const request = new Request("http://localhost/api/settings/nanoclaw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      running: true,
      alreadyRunning: true,
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
