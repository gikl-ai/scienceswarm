/**
 * Verifies that POST /api/brain/capture surfaces a non-empty `detail`
 * field in its 500 body when the brain backend is unavailable. The
 * pre-fix behavior was a bare `{"error":"Brain backend unavailable"}`
 * with no clue about the underlying init failure (stale PGLite lock,
 * missing native module, schema-init crash). This regression guard
 * forces processCapture to throw a `BrainBackendUnavailableError` with
 * a `detail` payload and asserts the route surfaces it verbatim.
 *
 * The disk-fallback in /api/projects (commit ae621df) is intentional
 * and preserved — capture has no safe disk fallback so we lean on
 * diagnostics here.
 */
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
    processCapture: vi.fn(),
    MockBrainBackendUnavailableError,
  };
});

vi.mock("@/lib/capture", () => ({
  processCapture: mocks.processCapture,
  isCaptureChannel: (value: unknown) =>
    value === "web" || value === "telegram" || value === "openclaw",
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/brain/store", () => ({
  describeBrainBackendError: (error: unknown) => {
    if (error instanceof mocks.MockBrainBackendUnavailableError && error.detail) return error.detail;
    if (error instanceof Error && error.message) return error.message;
    return String(error);
  },
  BrainBackendUnavailableError: mocks.MockBrainBackendUnavailableError,
  isBrainBackendUnavailableError: (error: unknown) =>
    error instanceof mocks.MockBrainBackendUnavailableError,
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

import { POST } from "@/app/api/brain/capture/route";

describe("POST /api/brain/capture init-failure surface", () => {
  beforeEach(() => {
    TEMP_ROOT = mkdtempSync(join(tmpdir(), "scienceswarm-brain-capture-fail-"));
    mocks.processCapture.mockReset();
  });

  afterEach(() => {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  });

  it("surfaces the underlying init failure as a `detail` field on the 500 body", async () => {
    mocks.processCapture.mockRejectedValue(
      new mocks.MockBrainBackendUnavailableError("Brain backend unavailable", {
        detail: "stale .gbrain-lock prevented PGLite engine startup",
      }),
    );

    const request = new Request("http://localhost/api/brain/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "test capture",
        channel: "web",
        userId: "test-user",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);
    const body = await response.json();

    expect(body.error).toBe("Brain backend unavailable");
    // The new contract: the 500 body carries a non-empty `detail`
    // string so operators can tell whether it is a stale lock, a
    // missing native module, a permission issue, or schema-init.
    expect(body.detail).toBeTruthy();
    expect(typeof body.detail).toBe("string");
    expect(body.detail).toContain(".gbrain-lock");
  });

  it("preserves `detail` shape for a non-Error rejection", async () => {
    // Defensive guard: even if a thrown value lacks `message`, the
    // route must still emit a non-empty detail rather than nothing.
    mocks.processCapture.mockRejectedValue(
      new mocks.MockBrainBackendUnavailableError("Brain backend unavailable", {
        detail: "ENOENT: brain.pglite/PG_VERSION",
      }),
    );

    const request = new Request("http://localhost/api/brain/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "another capture",
        channel: "web",
        userId: "test-user",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);
    const body = await response.json();

    expect(body.detail).toContain("ENOENT");
  });

  it("does not add `detail` to non-brain-backend errors", async () => {
    // The detail field is only meaningful for brain-backend init
    // failures. A generic capture failure (e.g. bad project) keeps the
    // bare `{error}` shape so route consumers don't mistake it for an
    // init issue.
    mocks.processCapture.mockRejectedValue(new Error("disk write refused"));

    const request = new Request("http://localhost/api/brain/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "yet another capture",
        channel: "web",
        userId: "test-user",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);
    const body = await response.json();

    expect(body.error).toBe("disk write refused");
    expect(body.detail).toBeUndefined();
  });
});
