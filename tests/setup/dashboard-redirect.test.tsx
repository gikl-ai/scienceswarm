// @vitest-environment node
//
// Verifies that `DashboardLayout` (a React Server Component) redirects
// unready users to `/setup` and renders the real shell only when the
// on-disk config is valid.
//
// Server components are just async functions that return JSX, so we
// test them by calling the function directly with a mocked
// `getConfigStatus` and a mocked `redirect`. We don't mount them in
// jsdom because the production path doesn't mount them there either —
// Next.js invokes the function on the server and streams the result.

import type { ConfigStatus } from "@/lib/setup/config-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `redirect` throws a special `NEXT_REDIRECT` sentinel in real
// Next.js; we mock it as a plain spy that records the call and
// throws so the rest of the layout body doesn't run.
const redirectMock = vi.fn<(target: string) => never>(() => {
  throw new Error("NEXT_REDIRECT");
});

vi.mock("next/navigation", () => ({
  redirect: (target: string) => redirectMock(target),
}));

// Mock the config-status probe so each test can dial its result.
const getConfigStatusMock = vi.fn();
vi.mock("@/lib/setup/config-status", () => ({
  getConfigStatus: (...args: unknown[]) => getConfigStatusMock(...args),
}));

// Mock the Sidebar to a trivial element — the dashboard layout pulls
// in the full sidebar tree which itself imports client-only modules.
// We only need a non-null identity to assert "layout rendered children".
vi.mock("@/components/sidebar", () => ({
  Sidebar: () => null,
}));

// Import after the mocks so the module resolves against the mocked
// versions.
import DashboardLayout from "@/app/dashboard/layout";

function okStatus(overrides: Partial<ConfigStatus> = {}): ConfigStatus {
  return {
    openaiApiKey: { state: "ok" },
    scienceswarmDir: { state: "ok" },
    envFileExists: true,
    envFileParseError: null,
    ready: true,
    rawValues: {},
    redactedKeys: [],
    ...overrides,
  };
}

function notReadyStatus(overrides: Partial<ConfigStatus> = {}): ConfigStatus {
  return {
    openaiApiKey: { state: "missing" },
    scienceswarmDir: { state: "ok" },
    envFileExists: false,
    envFileParseError: null,
    ready: false,
    rawValues: {},
    redactedKeys: [],
    ...overrides,
  };
}

describe("DashboardLayout redirect", () => {
  beforeEach(() => {
    redirectMock.mockClear();
    getConfigStatusMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children and does not redirect when config is ready", async () => {
    getConfigStatusMock.mockResolvedValue(okStatus());

    const marker = { __marker: "children-slot" } as unknown as React.ReactNode;
    const element = await DashboardLayout({ children: marker });

    expect(redirectMock).not.toHaveBeenCalled();
    // The layout returned real JSX (a div). If we had redirected,
    // the function would have thrown before returning anything.
    expect(element).toBeDefined();
    expect(element).not.toBeNull();
  });

  it("calls redirect('/setup') when config is not ready", async () => {
    getConfigStatusMock.mockResolvedValue(notReadyStatus());

    await expect(
      DashboardLayout({ children: null }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirectMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/setup");
  });

  it("redirects to /setup when getConfigStatus throws (safer default) without leaking err.message", async () => {
    // The layout deliberately does NOT log the thrown error's
    // message string. Node I/O errors (`Error: ENOENT: no such file,
    // open '/Users/alice/secret/.env.local'`) routinely embed
    // absolute filesystem paths that reveal the user's home dir
    // layout, so we log only a fixed category + `err.name`.
    //
    // Use a distinctive sentinel for the error message and a
    // recognisable error name so we can tell which one (if any) the
    // implementation is echoing.
    class ProbeError extends Error {
      override name = "ProbeError";
    }
    const SECRET_MARKER = "SECRET-PATH-/Users/alice/.env.local";
    getConfigStatusMock.mockRejectedValue(new ProbeError(SECRET_MARKER));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      DashboardLayout({ children: null }),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/setup");
    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls[0]?.join(" ") ?? "";
    expect(logged).toContain("[dashboard-redirect]");
    // The raw error message (with any filesystem path it embeds)
    // must not appear anywhere in the logged output. Logging the
    // error's `name` is OK and helps debugging.
    expect(logged).not.toContain(SECRET_MARKER);
    expect(logged).toContain("ProbeError");

    warnSpy.mockRestore();
  });

  it("passes process.cwd() to getConfigStatus and opts into runtime readiness fallback", async () => {
    getConfigStatusMock.mockResolvedValue(okStatus());
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/fake-root");

    await DashboardLayout({ children: null });

    expect(getConfigStatusMock).toHaveBeenCalledWith("/tmp/fake-root", {
      includeRuntimeEnv: true,
    });
    cwdSpy.mockRestore();
  });
});
