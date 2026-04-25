import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRuntimeEngine: vi.fn(),
}));

vi.mock("@/brain/stores/gbrain-runtime.mjs", () => ({
  createRuntimeEngine: (...args: unknown[]) =>
    mocks.createRuntimeEngine(...args),
}));

function failingEngine(message = "pglite failed") {
  return {
    connect: vi.fn().mockRejectedValue(new Error(message)),
    initSchema: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe("BrainStore unavailable backend retry cache", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createRuntimeEngine.mockReset();
  });

  afterEach(async () => {
    const store = await import("@/brain/store");
    await store.resetBrainStore();
    vi.useRealTimers();
  });

  it("reuses a recent init failure instead of retrying PGLite on every caller", async () => {
    mocks.createRuntimeEngine.mockResolvedValue(failingEngine());
    const store = await import("@/brain/store");

    await expect(
      store.ensureBrainStoreReady({ root: "/tmp/scienceswarm-failed-brain" }),
    ).rejects.toThrow("Brain backend unavailable");
    await expect(
      store.ensureBrainStoreReady({ root: "/tmp/scienceswarm-failed-brain" }),
    ).rejects.toThrow("Brain backend unavailable");

    expect(mocks.createRuntimeEngine).toHaveBeenCalledTimes(1);
  });

  it("throws the cached init failure for direct getBrainStore callers", async () => {
    mocks.createRuntimeEngine.mockResolvedValue(failingEngine());
    const store = await import("@/brain/store");
    const root = "/tmp/scienceswarm-direct-failed-brain";

    await expect(
      store.ensureBrainStoreReady({ root }),
    ).rejects.toThrow("Brain backend unavailable");

    expect(() => store.getBrainStore({ root })).toThrow("Brain backend unavailable");
    expect(mocks.createRuntimeEngine).toHaveBeenCalledTimes(1);
  });

  it("retries after the unavailable-backend cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mocks.createRuntimeEngine.mockResolvedValue(failingEngine());
    const store = await import("@/brain/store");

    await expect(
      store.ensureBrainStoreReady({ root: "/tmp/scienceswarm-retry-brain" }),
    ).rejects.toThrow("Brain backend unavailable");

    vi.setSystemTime(10_001);
    mocks.createRuntimeEngine.mockResolvedValue(failingEngine("still failed"));

    await expect(
      store.ensureBrainStoreReady({ root: "/tmp/scienceswarm-retry-brain" }),
    ).rejects.toThrow("Brain backend unavailable");

    expect(mocks.createRuntimeEngine).toHaveBeenCalledTimes(2);
  });
});
