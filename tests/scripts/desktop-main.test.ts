import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  isDesktopFirstLaunchComplete,
  isDesktopMainEntrypoint,
  isTrustedDesktopIpcSender,
  logDesktopWindowLoadFailure,
  resolveDesktopConfigRoot,
  resolveDesktopDiagnostics,
  resolveDesktopLaunchMarkerPath,
  resolveDesktopRuntimeEnv,
  resolveDesktopStartPath,
  resolveDesktopStartUrl,
  resolveDesktopWindowOptions,
  shouldForceDesktopSetup,
  resolveStandaloneEntry,
  shouldStartStandaloneServer,
  shouldWaitForDesktopServer,
  waitForDesktopServer,
} from "../../desktop/main.mjs";

describe("desktop main", () => {
  it("prefers an explicit desktop url override", () => {
    expect(resolveDesktopStartUrl({
      SCIENCESWARM_DESKTOP_URL: "https://desktop.local/app",
    })).toBe("https://desktop.local/app");
  });

  it("defaults the desktop shell to the setup route", () => {
    expect(resolveDesktopStartPath({})).toBe("/setup");
  });

  it("defaults returning users to the main route", () => {
    expect(resolveDesktopStartPath({}, { firstLaunchComplete: true })).toBe("/");
  });

  it("can force returning desktop users back through setup", () => {
    const env = {
      SCIENCESWARM_DESKTOP_FORCE_SETUP: "1",
    };

    expect(shouldForceDesktopSetup(env)).toBe(true);
    expect(resolveDesktopStartPath(env, { firstLaunchComplete: true })).toBe("/setup");
  });

  it("keeps an explicit desktop start path ahead of forced setup", () => {
    expect(resolveDesktopStartPath({
      SCIENCESWARM_DESKTOP_FORCE_SETUP: "1",
      SCIENCESWARM_DESKTOP_START_PATH: "runtime/compare",
    }, { firstLaunchComplete: true })).toBe("/runtime/compare");
  });

  it("normalizes a custom desktop start path override", () => {
    expect(resolveDesktopStartPath({
      SCIENCESWARM_DESKTOP_START_PATH: "runtime/compare",
    })).toBe("/runtime/compare");
  });

  it("builds the desktop start url from frontend host, port, and https settings", () => {
    expect(resolveDesktopStartUrl({
      FRONTEND_HOST: "0.0.0.0",
      FRONTEND_PORT: "4100",
      FRONTEND_USE_HTTPS: "true",
    })).toBe("https://0.0.0.0:4100/setup");
  });

  it("defaults the desktop start url to the standalone http server", () => {
    expect(resolveDesktopStartUrl({})).toBe("http://127.0.0.1:3001/setup");
  });

  it("falls back to standalone HOSTNAME and PORT values", () => {
    expect(resolveDesktopStartUrl({
      HOSTNAME: "localhost",
      PORT: "4101",
    })).toBe("http://localhost:4101/setup");
  });

  it("skips the local standalone server for explicit desktop urls", () => {
    expect(shouldStartStandaloneServer({
      SCIENCESWARM_DESKTOP_URL: "https://desktop.local/app",
    })).toBe(false);
    expect(shouldStartStandaloneServer({})).toBe(true);
  });

  it("only waits for http desktop urls", () => {
    expect(shouldWaitForDesktopServer("http://127.0.0.1:3001/setup")).toBe(true);
    expect(shouldWaitForDesktopServer("https://desktop.local/app")).toBe(true);
    expect(shouldWaitForDesktopServer("file:///tmp/index.html")).toBe(false);
  });

  it("resolves desktop diagnostics from the electron app paths", () => {
    expect(resolveDesktopDiagnostics({
      getPath(name: string) {
        return name === "userData" ? "/tmp/user-data" : "/tmp/logs";
      },
    }, {})).toMatchObject({
      shell: "electron",
      startUrl: "http://127.0.0.1:3001/setup",
      userDataPath: "/tmp/user-data",
      configRoot: "/tmp/user-data",
      logsPath: "/tmp/logs",
    });
  });

  it("uses Electron userData as the writable desktop config root", () => {
    const app = {
      getPath(name: string) {
        return name === "userData" ? "/tmp/user-data" : "/tmp/logs";
      },
    };

    expect(resolveDesktopConfigRoot(app)).toBe("/tmp/user-data");
    expect(resolveDesktopRuntimeEnv(app, {})).toMatchObject({
      SCIENCESWARM_CONFIG_ROOT: "/tmp/user-data",
    });
  });

  it("preserves an explicit desktop config root override", () => {
    const app = {
      getPath(name: string) {
        return name === "userData" ? "/tmp/user-data" : "/tmp/logs";
      },
    };

    expect(resolveDesktopRuntimeEnv(app, {
      SCIENCESWARM_CONFIG_ROOT: "/tmp/custom-config",
    })).toMatchObject({
      SCIENCESWARM_CONFIG_ROOT: "/tmp/custom-config",
    });
  });

  it("reports the returning-user start url in desktop diagnostics", () => {
    expect(resolveDesktopDiagnostics({
      getPath(name: string) {
        return name === "userData" ? "/tmp/user-data" : "/tmp/logs";
      },
    }, {}, { firstLaunchComplete: true })).toMatchObject({
      startUrl: "http://127.0.0.1:3001/",
    });
  });

  it("trusts desktop diagnostics IPC from the configured frontend origin", () => {
    expect(isTrustedDesktopIpcSender({
      senderFrame: {
        url: "http://127.0.0.1:3001/settings",
      },
    }, {})).toBe(true);
  });

  it("rejects desktop diagnostics IPC from a different renderer origin", () => {
    expect(isTrustedDesktopIpcSender({
      senderFrame: {
        url: "https://example.com/settings",
      },
    }, {})).toBe(false);
  });

  it("builds one shared desktop window options object", () => {
    expect(resolveDesktopWindowOptions()).toMatchObject({
      width: 1440,
      height: 960,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
      },
    });
  });

  it("waits for the desktop server to accept requests", async () => {
    let attempts = 0;
    await waitForDesktopServer("http://127.0.0.1:3001/setup", {
      intervalMs: 1,
      timeoutMs: 3,
      sleep: async () => {},
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("not ready");
        }
        return new Response("ok");
      },
    });

    expect(attempts).toBe(2);
  });

  it("retries server error responses while waiting for the desktop server", async () => {
    let attempts = 0;
    await waitForDesktopServer("http://127.0.0.1:3001/setup", {
      intervalMs: 1,
      timeoutMs: 3,
      sleep: async () => {},
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response("starting", { status: 503 });
        }
        return new Response("ok");
      },
    });

    expect(attempts).toBe(2);
  });

  it("accepts client error responses as server-ready responses", async () => {
    await expect(waitForDesktopServer("http://127.0.0.1:3001/setup", {
      intervalMs: 1,
      timeoutMs: 1,
      sleep: async () => {},
      fetch: async () => new Response("missing", { status: 404 }),
    })).resolves.toBeUndefined();
  });

  it("bounds each desktop server readiness request with an abort signal", async () => {
    let receivedSignalIsAbortSignal = false;
    let receivedSignalAborted: boolean | null = null;

    await waitForDesktopServer("http://127.0.0.1:3001/setup", {
      intervalMs: 1,
      requestTimeoutMs: 1,
      timeoutMs: 1,
      sleep: async () => {},
      fetch: async (...args: Parameters<typeof fetch>) => {
        const signal = args[1]?.signal;
        receivedSignalIsAbortSignal = signal instanceof AbortSignal;
        receivedSignalAborted = signal instanceof AbortSignal ? signal.aborted : null;
        return new Response("ok");
      },
    });

    expect(receivedSignalIsAbortSignal).toBe(true);
    expect(receivedSignalAborted).toBe(false);
  });

  it("fails when the desktop server never accepts requests", async () => {
    await expect(waitForDesktopServer("http://127.0.0.1:3001/setup", {
      intervalMs: 1,
      timeoutMs: 2,
      sleep: async () => {},
      fetch: async () => {
        throw new Error("connection refused");
      },
    })).rejects.toThrow("Timed out waiting for desktop server");
  });

  it("logs desktop window load failures without throwing", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => logDesktopWindowLoadFailure("reactivated desktop window", new Error("boom")))
        .not.toThrow();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("treats packaged Electron browser processes as the desktop entrypoint", () => {
    expect(isDesktopMainEntrypoint({
      argv: ["/Applications/ScienceSwarm.app/Contents/MacOS/ScienceSwarm"],
      modulePath: "/Applications/ScienceSwarm.app/Contents/Resources/app.asar/desktop/main.mjs",
      versions: { electron: "41.3.0" } as NodeJS.ProcessVersions,
      processType: "browser",
    })).toBe(true);
  });

  it("keeps direct node execution as a desktop entrypoint", () => {
    expect(isDesktopMainEntrypoint({
      argv: ["node", "/repo/desktop/main.mjs"],
      modulePath: "/repo/desktop/main.mjs",
      versions: {} as NodeJS.ProcessVersions,
      processType: undefined,
    })).toBe(true);
  });

  it("does not auto-launch when imported by non-Electron tests", () => {
    expect(isDesktopMainEntrypoint({
      argv: ["node", "/repo/tests/desktop-main.test.ts"],
      modulePath: "/repo/desktop/main.mjs",
      versions: {} as NodeJS.ProcessVersions,
      processType: undefined,
    })).toBe(false);
  });

  it("resolves the desktop first-launch marker path under userData", () => {
    const app = {
      getPath() {
        return "/tmp/user-data";
      },
    };
    expect(resolveDesktopLaunchMarkerPath(app)).toBe(
      path.join("/tmp/user-data", "desktop-first-launch.json"),
    );
  });

  it("detects the first-launch marker from disk", () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), "scienceswarm-user-data-"));
    try {
      const app = {
        getPath() {
          return userDataPath;
        },
      };
      expect(isDesktopFirstLaunchComplete(app)).toBe(false);

      writeFileSync(resolveDesktopLaunchMarkerPath(app), "{}");
      expect(isDesktopFirstLaunchComplete(app)).toBe(true);
    } finally {
      rmSync(userDataPath, { force: true, recursive: true });
    }
  });

  it("resolves the standalone launcher path from the project root", () => {
    expect(resolveStandaloneEntry("/tmp/scienceswarm")).toBe(
      path.join("/tmp/scienceswarm", "scripts", "start-standalone.mjs"),
    );
  });
});
