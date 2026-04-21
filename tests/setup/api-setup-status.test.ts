import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/openclaw-status", () => ({
  getOpenClawSetupSummary: async () => ({
    installed: false,
    configured: false,
    running: false,
  }),
}));

vi.mock("@/lib/ollama-install", () => ({
  getOllamaInstallStatus: async () => ({
    binaryInstalled: false,
    binaryCompatible: false,
    binaryPath: null,
  }),
}));

vi.mock("@/lib/setup/env-migration", () => ({
  migrateEnvLocalOnce: async () => undefined,
}));

// Each test gets an isolated repoRoot under os.tmpdir() and we
// monkey-patch `process.cwd` to return it, so the handler reads our
// test `.env` rather than whatever lives in the running
// vitest process's cwd.
describe("GET /api/setup/status", () => {
  let repoRoot: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "api-setup-status-"),
    );
    tmpHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "api-setup-status-home-"),
    );
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
  });

  afterEach(async () => {
    cwdSpy?.mockRestore();
    cwdSpy = null;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("returns 200 with ready=true when OpenAI mode has a valid backend and data dir", async () => {
    const dir = path.join(tmpHome, "data");
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "AGENT_BACKEND=openclaw",
        "OPENAI_API_KEY=sk-real-key-abc",
        `SCIENCESWARM_DIR=${dir}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      envFileExists: boolean;
      openaiApiKey: { state: string };
      scienceswarmDir: { state: string };
    };
    expect(body.ready).toBe(true);
    expect(body.envFileExists).toBe(true);
    expect(body.openaiApiKey.state).toBe("ok");
    expect(body.scienceswarmDir.state).toBe("ok");
  });

  it("returns 200 with ready=true for local mode without an OpenAI key", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "AGENT_BACKEND=nanoclaw",
        "LLM_PROVIDER=local",
        "OLLAMA_MODEL=gemma4",
        "",
      ].join("\n"),
      "utf8",
    );

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      openaiApiKey: { state: string };
      scienceswarmDir: { state: string };
      runtimeContract: {
        llmProvider: string;
        capabilities: Array<{ capabilityId: string; status: string }>;
      };
    };
    expect(body.ready).toBe(true);
    expect(body.openaiApiKey.state).toBe("missing");
    expect(body.scienceswarmDir.state).toBe("ok");
    expect(body.runtimeContract.llmProvider).toBe("local");
    expect(body.runtimeContract.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "setup.local",
          status: "ready",
        }),
        expect.objectContaining({
          capabilityId: "chat.local",
          status: "blocked",
        }),
      ]),
    );
  });

  it("uses the default local model in the runtime contract when OLLAMA_MODEL is blank", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "AGENT_BACKEND=nanoclaw",
        "LLM_PROVIDER=local",
        "OLLAMA_MODEL=",
        "",
      ].join("\n"),
      "utf8",
    );

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runtimeContract: {
        configuredLocalModel: string;
        capabilities: Array<{
          capabilityId: string;
          model?: string;
          nextAction?: string;
        }>;
      };
    };

    expect(body.runtimeContract.configuredLocalModel).toBe("gemma4:latest");
    expect(
      body.runtimeContract.capabilities.find(
        (capability) => capability.capabilityId === "chat.local",
      ),
    ).toMatchObject({
      model: "gemma4:latest",
      nextAction: "Start Ollama.",
    });
  });

  it("returns 200 with ready=false when no supported agent backend is configured", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "AGENT_BACKEND=none",
        "LLM_PROVIDER=local",
        "OLLAMA_MODEL=gemma4",
        "",
      ].join("\n"),
      "utf8",
    );

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean };
    expect(body.ready).toBe(false);
  });

  it("returns 200 with envFileExists=false and openaiApiKey=missing when .env is absent", async () => {
    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      envFileExists: boolean;
      openaiApiKey: { state: string };
      scienceswarmDir: { state: string };
    };
    expect(body.envFileExists).toBe(false);
    expect(body.openaiApiKey.state).toBe("missing");
    // Unset SCIENCESWARM_DIR is ok because the app has a default.
    expect(body.scienceswarmDir.state).toBe("ok");
    expect(body.ready).toBe(false);
  });

  it("flags a placeholder OpenAI key with ready=false", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      "AGENT_BACKEND=openclaw\nOPENAI_API_KEY=sk-proj-REPLACE-ME-etc\n",
      "utf8",
    );

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      openaiApiKey: { state: string };
    };
    expect(body.openaiApiKey.state).toBe("placeholder");
    expect(body.ready).toBe(false);
  });

  it("never echoes secret values from .env in the response body", async () => {
    // Direct regression guard for the Greptile "unauthenticated
    // endpoint echoes all secrets" finding. A real-looking OpenAI key
    // plus several other secrets are written to .env; the
    // response body must contain none of those raw values. The
    // sentinel literal is OK; unrelated env keys should be omitted
    // entirely because the route is only for the setup form.
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "OPENAI_API_KEY=sk-live-abcdef1234567890-ZYX",
        "GITHUB_SECRET=gh-super-secret-456",
        "GOOGLE_CLIENT_SECRET=goog-very-secret-789",
        "TELEGRAM_BOT_TOKEN=1234:telegrambotlivetoken",
        "SLACK_BOT_TOKEN=xoxb-live-slack-token",
        "AGENT_API_KEY=agent-live-secret",
      ].join("\n"),
      "utf8",
    );

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const raw = await res.text();

    expect(raw).not.toContain("sk-live-abcdef1234567890-ZYX");
    expect(raw).not.toContain("gh-super-secret-456");
    expect(raw).not.toContain("goog-very-secret-789");
    expect(raw).not.toContain("1234:telegrambotlivetoken");
    expect(raw).not.toContain("xoxb-live-slack-token");
    expect(raw).not.toContain("agent-live-secret");

    const body = JSON.parse(raw) as {
      rawValues: Record<string, string>;
      redactedKeys: string[];
    };
    // Sentinel is what the UI sees — confirm the route forwards it.
    expect(body.rawValues["OPENAI_API_KEY"]).toBe("<configured>");
    expect(body.redactedKeys).toContain("OPENAI_API_KEY");
    expect(body.redactedKeys).toContain("GITHUB_SECRET");
    expect(body.redactedKeys).toContain("GOOGLE_CLIENT_SECRET");
    expect(body.redactedKeys).toContain("TELEGRAM_BOT_TOKEN");
    expect(body.redactedKeys).not.toContain("SLACK_BOT_TOKEN");
    expect(body.rawValues["SLACK_BOT_TOKEN"]).toBeUndefined();
    expect(body.rawValues["AGENT_API_KEY"]).toBeUndefined();
  });

  it("returns a line-numbered parse warning for malformed dotenv syntax", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      'OPENAI_API_KEY="unterminated\nSCIENCESWARM_DIR=/tmp\n',
      "utf8",
    );

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      envFileParseError: string | null;
    };
    expect(body.envFileParseError).toBe(
      "Line 1 of .env could not be parsed. It will be preserved as-is on save.",
    );
  });

  it("returns 200 with a sanitized envFileParseError when fs.readFile throws unexpectedly", async () => {
    // Simulate an unexpected I/O failure on the read path. The raw
    // error text (which would include the file path on a real EACCES
    // kernel error) must NOT flow through to the API body — that
    // would leak host filesystem structure via an unauthenticated
    // endpoint. readEnvFile catches the throw and returns a
    // sanitized parseError; the overall handler still succeeds.
    const fsNode = await import("node:fs");
    const secretMarker = "simulated-secret-path-marker";
    const err = Object.assign(
      new Error(`EACCES: permission denied, open '/secret/${secretMarker}'`),
      { code: "EACCES" },
    );
    const readSpy = vi
      .spyOn(fsNode.promises, "readFile")
      .mockRejectedValueOnce(err);
    // Swallow the expected console.error so the test output stays
    // quiet — we still want to keep server logging enabled in prod.
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      envFileParseError: string | null;
    };
    expect(body.envFileParseError).not.toBeNull();
    // Sanitized: raw exception message must not leak.
    expect(body.envFileParseError).not.toContain(secretMarker);
    expect(body.envFileParseError).not.toContain("EACCES");
    expect(body.envFileParseError).not.toContain("permission denied");
    // But the full detail is available to the developer through the
    // server console.
    expect(consoleSpy).toHaveBeenCalled();
    readSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
