import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveDesktopStartUrl,
  resolveStandaloneEntry,
} from "../../desktop/main.mjs";

describe("desktop main", () => {
  it("prefers an explicit desktop url override", () => {
    expect(resolveDesktopStartUrl({
      SCIENCESWARM_DESKTOP_URL: "https://desktop.local/app",
    })).toBe("https://desktop.local/app");
  });

  it("builds the desktop start url from frontend host, port, and https settings", () => {
    expect(resolveDesktopStartUrl({
      FRONTEND_HOST: "0.0.0.0",
      FRONTEND_PORT: "4100",
      FRONTEND_USE_HTTPS: "false",
    })).toBe("http://0.0.0.0:4100");
  });

  it("resolves the standalone launcher path from the project root", () => {
    expect(resolveStandaloneEntry("/tmp/scienceswarm")).toBe(
      path.join("/tmp/scienceswarm", "scripts", "start-standalone.mjs"),
    );
  });
});
