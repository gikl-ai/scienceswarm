import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockBrainBackendUnavailableError extends Error {
    detail?: string;
    constructor(message: string, options?: { cause?: unknown; detail?: string }) {
      super(message);
      this.name = "BrainBackendUnavailableError";
      if (options?.detail !== undefined) this.detail = options.detail;
    }
  }
  return {
    ensureBrainStoreReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    healthFn: vi.fn<() => Promise<{
      ok: boolean;
      pageCount: number;
      error?: string;
    }>>().mockResolvedValue({ ok: true, pageCount: 5 }),
    MockBrainBackendUnavailableError,
  };
});

vi.mock("@/brain/store", () => ({
  ensureBrainStoreReady: mocks.ensureBrainStoreReady,
  getBrainStore: () => ({ health: mocks.healthFn }),
  resetBrainStore: vi.fn().mockResolvedValue(undefined),
  describeBrainBackendError: (error: unknown) => {
    if (error instanceof mocks.MockBrainBackendUnavailableError && error.detail) return error.detail;
    if (error instanceof Error && error.message) return error.message;
    return String(error);
  },
  BrainBackendUnavailableError: mocks.MockBrainBackendUnavailableError,
  isBrainBackendUnavailableError: (error: unknown) =>
    error instanceof mocks.MockBrainBackendUnavailableError,
}));

vi.mock("@/brain/cost", () => ({
  getMonthCost: () => 0,
  getRecentEvents: () => [],
}));

let TEMP_ROOT: string;

vi.mock("@/brain/config", () => ({
  loadBrainConfig: () => ({
    root: TEMP_ROOT,
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  }),
}));

import { GET } from "@/app/api/brain/status/route";

describe("GET /api/brain/status", () => {
  beforeEach(() => {
    TEMP_ROOT = mkdtempSync(join(tmpdir(), "scienceswarm-brain-status-"));
    mocks.ensureBrainStoreReady.mockReset().mockResolvedValue(undefined);
    mocks.healthFn.mockReset().mockResolvedValue({ ok: true, pageCount: 5 });
  });

  afterEach(() => {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it("returns ok:true and the engine page count when the store reports healthy", async () => {
    mocks.healthFn.mockResolvedValue({ ok: true, pageCount: 42 });

    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
    expect(body.pageCount).toBe(42);
    expect(body.store).toMatchObject({ ok: true, pageCount: 42 });
  });

  it("returns ok:false with an error string and pageCount:null when the engine init fails", async () => {
    // Regression guard: previously the outer pageCount silently fell
    // back to a filesystem walk that painted over the dead engine.
    // Now the route reports the failure honestly.
    mocks.ensureBrainStoreReady.mockRejectedValue(
      new mocks.MockBrainBackendUnavailableError("Brain backend unavailable", {
        detail: "stale .gbrain-lock file at brain.pglite/0001",
      }),
    );

    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.error).toContain(".gbrain-lock");
    expect(body.pageCount).toBeNull();
    expect(body.store).toMatchObject({
      ok: false,
      pageCount: 0,
      error: expect.stringContaining(".gbrain-lock"),
    });
  });

  it("returns ok:false with an error string when health() reports degraded", async () => {
    mocks.healthFn.mockResolvedValue({
      ok: false,
      pageCount: 0,
      error: "PGLite connection lost mid-query",
    });

    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.error).toContain("connection lost");
    expect(body.pageCount).toBeNull();
  });
});
