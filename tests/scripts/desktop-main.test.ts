import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isTrustedDesktopIpcSender,
  resolveDesktopDiagnostics,
  resolveDesktopLaunchMarkerPath,
  resolveDesktopStartPath,
  resolveDesktopStartUrl,
  resolveDesktopWindowOptions,
  resolveStandaloneEntry,
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

  it("resolves desktop diagnostics from the electron app paths", () => {
    expect(resolveDesktopDiagnostics({
      getPath(name: string) {
        return name === "userData" ? "/tmp/user-data" : "/tmp/logs";
      },
    }, {})).toMatchObject({
      shell: "electron",
      startUrl: "http://127.0.0.1:3001/setup",
      userDataPath: "/tmp/user-data",
      logsPath: "/tmp/logs",
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

  it("resolves the desktop first-launch marker path under userData", () => {
    expect(resolveDesktopLaunchMarkerPath({
      getPath() {
        return "/tmp/user-data";
      },
    })).toBe(path.join("/tmp/user-data", "desktop-first-launch.json"));
  });

  it("resolves the standalone launcher path from the project root", () => {
    expect(resolveStandaloneEntry("/tmp/scienceswarm")).toBe(
      path.join("/tmp/scienceswarm", "scripts", "start-standalone.mjs"),
    );
  });
});
