import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

let sandboxRoot: string;
let fakeHome: string;

async function loadConnectModule() {
  vi.resetModules();

  const resetBrainStore = vi.fn();
  const ensureBrainStoreReady = vi.fn().mockResolvedValue(undefined);

  vi.doMock("@/brain/store", () => ({
    resetBrainStore,
    ensureBrainStoreReady,
  }));

  const connectModule = await import("@/brain/connect-gbrain");
  return { ...connectModule, resetBrainStore, ensureBrainStoreReady };
}

describe("connectGbrain", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sandboxRoot = mkdtempSync(path.join(tmpdir(), "scienceswarm-connect-gbrain-"));
    fakeHome = path.join(sandboxRoot, "home");
    mkdirSync(fakeHome, { recursive: true });

    process.env = {
      ...originalEnv,
      HOME: fakeHome,
    };
    delete process.env.SCIENCESWARM_DIR;
    delete process.env.BRAIN_ROOT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock("@/brain/store");
    vi.resetModules();
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("creates a research brain and resets the store singleton", async () => {
    const brainRoot = path.join(fakeHome, "ScienceSwarm", "brain");
    process.env.SCIENCESWARM_DIR = path.join(fakeHome, "ScienceSwarm");

    const { connectGbrain, resetBrainStore, ensureBrainStoreReady } = await loadConnectModule();
    const result = await connectGbrain();

    expect(result.success).toBe(true);
    expect(result.brainRoot).toBe(brainRoot);
    expect(result.wikiCreated).toBe(true);
    expect(existsSync(path.join(brainRoot, "BRAIN.md"))).toBe(true);
    expect(resetBrainStore).toHaveBeenCalledTimes(1);
    expect(ensureBrainStoreReady).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second call reports wiki already exists", async () => {
    const brainRoot = path.join(fakeHome, "ScienceSwarm", "brain");
    process.env.SCIENCESWARM_DIR = path.join(fakeHome, "ScienceSwarm");

    const { connectGbrain } = await loadConnectModule();
    const first = await connectGbrain();
    expect(first.wikiCreated).toBe(true);

    const second = await connectGbrain();
    expect(second.success).toBe(true);
    expect(second.wikiCreated).toBe(false);
    expect(second.message).toContain("already exists");
    expect(existsSync(path.join(brainRoot, "BRAIN.md"))).toBe(true);
  });

  it("prefers BRAIN_ROOT over SCIENCESWARM_DIR when both are configured", async () => {
    const customBrainRoot = path.join(fakeHome, "custom-brain-root");
    process.env.SCIENCESWARM_DIR = path.join(fakeHome, "scienceswarm-data");
    process.env.BRAIN_ROOT = customBrainRoot;

    const { connectGbrain, resetBrainStore, ensureBrainStoreReady } = await loadConnectModule();
    const result = await connectGbrain();

    expect(result.success).toBe(true);
    expect(result.brainRoot).toBe(customBrainRoot);
    expect(existsSync(path.join(customBrainRoot, "BRAIN.md"))).toBe(true);
    expect(resetBrainStore).toHaveBeenCalledTimes(1);
    expect(ensureBrainStoreReady).toHaveBeenCalledTimes(1);
  });

  it("returns a setup-specific failure result when store initialization fails", async () => {
    const customBrainRoot = path.join(fakeHome, "custom-brain-root");
    process.env.BRAIN_ROOT = customBrainRoot;

    vi.resetModules();

    const resetBrainStore = vi.fn();
    const ensureBrainStoreReady = vi.fn().mockRejectedValue(new Error("PGLite init failed"));

    vi.doMock("@/brain/store", () => ({
      resetBrainStore,
      ensureBrainStoreReady,
    }));

    const { connectGbrain } = await import("@/brain/connect-gbrain");
    const result = await connectGbrain();

    expect(result).toEqual({
      success: false,
      message: "PGLite init failed",
      brainRoot: customBrainRoot,
    });
    expect(resetBrainStore).toHaveBeenCalledTimes(1);
    expect(ensureBrainStoreReady).toHaveBeenCalledTimes(1);
  });
});
