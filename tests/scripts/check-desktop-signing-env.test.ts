import { describe, expect, it } from "vitest";

import {
  checkDesktopSigningEnv,
  formatDesktopSigningEnvResult,
  getMissingDesktopSigningRequirements,
  normalizeDesktopSigningTarget,
  resolveDesktopSigningTarget,
} from "../../scripts/check-desktop-signing-env.mjs";

describe("check-desktop-signing-env", () => {
  it("normalizes runner and platform names", () => {
    expect(normalizeDesktopSigningTarget("Darwin")).toBe("macos");
    expect(normalizeDesktopSigningTarget("macos-latest")).toBe("macos");
    expect(normalizeDesktopSigningTarget("Windows")).toBe("windows");
    expect(normalizeDesktopSigningTarget("windows-latest")).toBe("windows");
    expect(normalizeDesktopSigningTarget("linux")).toBe("linux");
    expect(normalizeDesktopSigningTarget("ubuntu-latest")).toBe("linux");
    expect(resolveDesktopSigningTarget({ RUNNER_OS: "macOS" }, "linux")).toBe("macos");
    expect(resolveDesktopSigningTarget({
      SCIENCESWARM_DESKTOP_SIGNING_TARGET: "windows",
      RUNNER_OS: "macOS",
    }, "linux")).toBe("windows");
  });

  it("allows unsigned builds unless signing is explicitly required", () => {
    const result = checkDesktopSigningEnv({
      env: {},
      target: "macos",
    });

    expect(result.ok).toBe(true);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(formatDesktopSigningEnvResult(result)).toContain("unsigned installer builds are allowed");
  });

  it("fails macOS when required secrets are missing", () => {
    const result = checkDesktopSigningEnv({
      env: { SCIENCESWARM_REQUIRE_DESKTOP_SIGNING: "1" },
      target: "macos",
    });

    expect(result.ok).toBe(false);
    expect(formatDesktopSigningEnvResult(result)).toContain("Apple Developer account");
    expect(formatDesktopSigningEnvResult(result)).toContain("macOS signing certificate");
  });

  it("accepts complete macOS signing env", () => {
    expect(checkDesktopSigningEnv({
      env: {
        APPLE_APP_SPECIFIC_PASSWORD: "app-password",
        APPLE_ID: "developer@example.com",
        APPLE_TEAM_ID: "TEAMID",
        CSC_KEY_PASSWORD: "cert-password",
        CSC_LINK: "base64-cert",
        SCIENCESWARM_REQUIRE_DESKTOP_SIGNING: "true",
      },
      target: "macos",
    }).ok).toBe(true);
  });

  it("accepts either Windows-specific or shared certificate variables", () => {
    expect(getMissingDesktopSigningRequirements("windows", {
      WIN_CSC_LINK: "base64-cert",
      WIN_CSC_KEY_PASSWORD: "cert-password",
    })).toEqual([]);
    expect(getMissingDesktopSigningRequirements("windows", {
      CSC_LINK: "base64-cert",
      CSC_KEY_PASSWORD: "cert-password",
    })).toEqual([]);
  });

  it("does not require Linux signing secrets", () => {
    expect(checkDesktopSigningEnv({
      env: { SCIENCESWARM_REQUIRE_DESKTOP_SIGNING: "required" },
      target: "linux",
    })).toMatchObject({
      ok: true,
      missing: [],
      target: "linux",
    });
  });
});
