import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureOpenClawGatewayAuthConfig,
  getOpenClawGatewayAuthStatus,
  readOpenClawGatewayToken,
} from "@/lib/openclaw/gateway-auth";

describe("OpenClaw gateway auth config", () => {
  let tempRoot = "";
  let tempHome = "";

  beforeEach(() => {
    vi.unstubAllEnvs();
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    tempHome = mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-home-"));
    vi.stubEnv("SCIENCESWARM_DIR", tempRoot);
    vi.stubEnv("HOME", tempHome);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("reports missing auth when no searched config has a gateway token", () => {
    expect(getOpenClawGatewayAuthStatus()).toMatchObject({
      configured: false,
      configPath: null,
    });
    expect(() => readOpenClawGatewayToken()).toThrow(
      "Cannot read OpenClaw gateway token",
    );
  });

  it("reads the state-dir gateway token without exposing it in status", () => {
    const configPath = path.join(tempRoot, "openclaw", "openclaw.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      [
        "// JSON5 comments and unquoted keys are valid upstream config",
        "{",
        "  gateway: {",
        '    auth: { token: "state-token" },',
        "  },",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(readOpenClawGatewayToken()).toBe("state-token");
    expect(getOpenClawGatewayAuthStatus()).toMatchObject({
      configured: true,
      configPath,
    });
    expect(getOpenClawGatewayAuthStatus()).not.toHaveProperty("token");
  });

  it("writes a minimal state-dir config with a stable gateway token", () => {
    ensureOpenClawGatewayAuthConfig({ port: 19002 });
    const configPath = path.join(tempRoot, "openclaw", "openclaw.json");
    const firstConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
      gateway?: { port?: number; auth?: { token?: string } };
    };

    ensureOpenClawGatewayAuthConfig({ port: 19002 });
    const secondConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
      gateway?: { port?: number; auth?: { token?: string } };
    };

    expect(firstConfig.gateway?.port).toBe(19002);
    expect(firstConfig.gateway?.auth?.token).toEqual(expect.any(String));
    expect(secondConfig.gateway?.auth?.token).toBe(
      firstConfig.gateway?.auth?.token,
    );
  });

  it("preserves existing config fields while adding gateway auth", () => {
    const configPath = path.join(tempRoot, "openclaw", "openclaw.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      [
        "{",
        '  agents: { defaults: { workspace: "/tmp/project-alpha" } },',
        "  gateway: {",
        '    bind: "loopback",',
        "  },",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    ensureOpenClawGatewayAuthConfig({ port: 19003 });

    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      agents?: { defaults?: { workspace?: string } };
      gateway?: {
        bind?: string;
        port?: number;
        auth?: { token?: string };
      };
    };
    expect(config.agents?.defaults?.workspace).toBe("/tmp/project-alpha");
    expect(config.gateway?.bind).toBe("loopback");
    expect(config.gateway?.port).toBe(19003);
    expect(config.gateway?.auth?.token).toEqual(expect.any(String));
  });

  it("does not overwrite malformed state-dir config", () => {
    const configPath = path.join(tempRoot, "openclaw", "openclaw.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{not-json", "utf8");

    expect(() =>
      ensureOpenClawGatewayAuthConfig({ port: 19003 }),
    ).toThrow("is not valid JSON5");
    expect(readFileSync(configPath, "utf8")).toBe("{not-json");
  });
});
