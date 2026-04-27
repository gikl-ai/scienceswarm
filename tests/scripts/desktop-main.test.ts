import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveDesktopDiagnostics,
  resolveDesktopLaunchMarkerPath,
  resolveDesktopStartPath,
  resolveDesktopStartUrl,
  resolveStandaloneEntry,
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
      FRONTEND_USE_HTTPS: "false",
    })).toBe("http://0.0.0.0:4100/setup");
  });

  it("resolves desktop diagnostics from the electron app paths", () => {
    expect(resolveDesktopDiagnostics({
      getPath(name) {
        return name === "userData" ? "/tmp/user-data" : "/tmp/logs";
      },
    }, {})).toMatchObject({
      shell: "electron",
      startUrl: "https://127.0.0.1:3001/setup",
      userDataPath: "/tmp/user-data",
      logsPath: "/tmp/logs",
    });
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
