import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REDACTED_SECRET_SENTINEL,
  getConfigStatus,
  readEnvFile,
  validateOpenAiKey,
  validateScienceSwarmDir,
} from "@/lib/setup/config-status";

// Each test gets an isolated repoRoot under os.tmpdir() so we can write
// `.env` without interfering with sibling tests or the real repo.
// We also point HOME at a per-test dir so `~/...` expansion is
// deterministic and doesn't depend on the real home dir layout.
async function makeTempRepoRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "config-status-repo-"));
}

async function makeTempHomeDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "config-status-home-"));
}

async function writeEnvLocal(
  repoRoot: string,
  contents: string,
): Promise<void> {
  await fs.writeFile(path.join(repoRoot, ".env"), contents, "utf8");
}

async function createReadyBrainRoot(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "brain.pglite"), { recursive: true });
  await fs.writeFile(path.join(root, "RESOLVER.md"), "# Resolver\n", "utf8");
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

const RUNTIME_CONFIG_TEST_KEYS = [
  "OPENAI_API_KEY",
  "SCIENCESWARM_DIR",
  "AGENT_BACKEND",
  "LLM_PROVIDER",
  "OLLAMA_MODEL",
] as const;

describe("readEnvFile", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot();
  });

  afterEach(async () => {
    await rmrf(repoRoot);
  });

  it("returns { contents: null, parseError: null } when .env is missing", async () => {
    const result = await readEnvFile(repoRoot);
    expect(result).toEqual({ contents: null, parseError: null });
  });

  it("returns file contents with no parseError for a valid file", async () => {
    await writeEnvLocal(repoRoot, "OPENAI_API_KEY=sk-abc\n");
    const result = await readEnvFile(repoRoot);
    expect(result.contents).toBe("OPENAI_API_KEY=sk-abc\n");
    expect(result.parseError).toBeNull();
  });

  it("sanitizes non-ENOENT read failures so no raw path or exception text leaks through parseError", async () => {
    // Simulate a read failure that isn't ENOENT (e.g. EACCES). The
    // raw error typically carries the full file path in its message
    // — `readEnvFile` must not pass that through to the API. We
    // silence console.error to keep the test output clean while
    // still asserting the returned parseError is a sanitized string.
    const secretPath = "/secret/host/path/.env-marker";
    const err = Object.assign(new Error(`EACCES: permission denied, open '${secretPath}'`), {
      code: "EACCES",
      path: secretPath,
    });
    const spy = vi
      .spyOn(fs, "readFile")
      .mockImplementationOnce(async () => {
        throw err;
      });
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const result = await readEnvFile(repoRoot);
      expect(result.contents).toBeNull();
      expect(result.parseError).not.toBeNull();
      expect(result.parseError).not.toContain(secretPath);
      expect(result.parseError).not.toContain("EACCES");
      expect(result.parseError).not.toContain("permission denied");
      // Full detail DOES get logged to the server console so a
      // developer can still diagnose.
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});

describe("validateOpenAiKey", () => {
  it("returns missing for undefined", () => {
    expect(validateOpenAiKey(undefined)).toEqual({ state: "missing" });
  });

  it("returns missing for empty string", () => {
    expect(validateOpenAiKey("")).toEqual({ state: "missing" });
  });

  it("returns missing for whitespace-only string", () => {
    expect(validateOpenAiKey("   ")).toEqual({ state: "missing" });
  });

  it("returns placeholder for sk-proj-REPLACE-ME", () => {
    const result = validateOpenAiKey("sk-proj-REPLACE-ME-etc");
    expect(result.state).toBe("placeholder");
    if (result.state === "placeholder") {
      expect(result.reason).toMatch(/placeholder/i);
    }
  });

  it("returns invalid for values that don't start with sk-", () => {
    const result = validateOpenAiKey("gh-ghp_token_12345");
    expect(result.state).toBe("invalid");
    if (result.state === "invalid") {
      expect(result.reason).toMatch(/sk-/);
    }
  });

  it("returns ok for a plausible sk- key", () => {
    expect(validateOpenAiKey("sk-abcdef1234567890")).toEqual({ state: "ok" });
  });

  it("trims before classifying so paste-whitespace doesn't poison the check", () => {
    expect(validateOpenAiKey("  sk-abcdef  ")).toEqual({ state: "ok" });
  });
});

describe("validateScienceSwarmDir", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    tmpHome = await makeTempHomeDir();
    // Override the shell-level HOME so os.homedir() returns our tmpHome
    // — expandHomeDir delegates to os.homedir(). We restore afterEach.
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(async () => {
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
    await rmrf(tmpHome);
  });

  it("returns ok for undefined (default fallback)", async () => {
    expect(await validateScienceSwarmDir(undefined)).toEqual({ state: "ok" });
  });

  it("returns ok for empty string (default fallback)", async () => {
    expect(await validateScienceSwarmDir("")).toEqual({ state: "ok" });
  });

  it("returns placeholder for /path/to/scienceswarm-data", async () => {
    const result = await validateScienceSwarmDir("/path/to/scienceswarm-data");
    expect(result.state).toBe("placeholder");
  });

  it("returns ok for an existing directory", async () => {
    const existing = path.join(tmpHome, "exists");
    await fs.mkdir(existing);
    expect(await validateScienceSwarmDir(existing)).toEqual({ state: "ok" });
  });

  it("expands ~ and validates a real directory under the home dir", async () => {
    const realSub = path.join(tmpHome, "some", "real", "path");
    await fs.mkdir(realSub, { recursive: true });
    const result = await validateScienceSwarmDir("~/some/real/path");
    expect(result).toEqual({ state: "ok" });
  });

  it("returns invalid when the path exists but is a file", async () => {
    const file = path.join(tmpHome, "not-a-dir");
    await fs.writeFile(file, "hello");
    const result = await validateScienceSwarmDir(file);
    expect(result.state).toBe("invalid");
    if (result.state === "invalid") {
      expect(result.reason).toMatch(/not a directory/);
      // Sanitized: no raw path should leak through to the API body.
      expect(result.reason).not.toContain(file);
      expect(result.reason).not.toContain("/");
    }
  });

  it("returns ok when the path does not exist but its parent is writable", async () => {
    const target = path.join(tmpHome, "subdir-that-does-not-exist-yet");
    const result = await validateScienceSwarmDir(target);
    expect(result).toEqual({ state: "ok" });
  });

  it("returns invalid when the parent directory does not exist", async () => {
    const target = path.join(
      tmpHome,
      "missing-parent",
      "missing-child",
      "deep",
    );
    const result = await validateScienceSwarmDir(target);
    expect(result.state).toBe("invalid");
    if (result.state === "invalid") {
      expect(result.reason).toMatch(/does not exist/);
      // Sanitized: no raw path or parent path leaks through.
      expect(result.reason).not.toContain(target);
      expect(result.reason).not.toContain(path.dirname(target));
      expect(result.reason).not.toContain("/");
    }
  });

  it("returns ok when the path is a symlink to an existing directory", async () => {
    const realDir = path.join(tmpHome, "real-dir");
    await fs.mkdir(realDir);
    const link = path.join(tmpHome, "link-to-dir");
    await fs.symlink(realDir, link);
    const result = await validateScienceSwarmDir(link);
    expect(result).toEqual({ state: "ok" });
  });

  it("returns invalid for a dangling symlink (regression)", async () => {
    // A dangling symlink makes `fs.stat` raise ENOENT, which, if left
    // to the plain "path doesn't exist" branch, would fall through to
    // the parent-directory check — and the parent (tmpHome) is always
    // writable, so we'd mis-report the dangling link as `ok`. Use
    // `lstat` first so we see the link node and can refuse it.
    const link = path.join(tmpHome, "dangling");
    await fs.symlink(path.join(tmpHome, "does-not-exist"), link);
    const result = await validateScienceSwarmDir(link);
    expect(result.state).toBe("invalid");
    if (result.state === "invalid") {
      expect(result.reason).toMatch(/symlink/);
      // Sanitized: no raw path leaks through.
      expect(result.reason).not.toContain(link);
      expect(result.reason).not.toContain("/");
    }
  });

  it("returns invalid when the path is a symlink to a file", async () => {
    const realFile = path.join(tmpHome, "real-file");
    await fs.writeFile(realFile, "hello");
    const link = path.join(tmpHome, "link-to-file");
    await fs.symlink(realFile, link);
    const result = await validateScienceSwarmDir(link);
    expect(result.state).toBe("invalid");
    if (result.state === "invalid") {
      expect(result.reason).toMatch(/not a directory|non-directory/);
      // Sanitized: no raw path leaks through.
      expect(result.reason).not.toContain(link);
      expect(result.reason).not.toContain(realFile);
      expect(result.reason).not.toContain("/");
    }
  });

  it("never leaks a filesystem path in any invalid-state reason string (guard)", async () => {
    // Exercise every branch that can return an `invalid` state from
    // validateScienceSwarmDir and assert none of the reasons contain
    // a `/` character. The reasons are surfaced through the
    // unauthenticated `/api/setup/status` endpoint — leaking absolute
    // paths would expose the host's directory structure to any
    // network-reachable caller.
    const reasons: string[] = [];

    // (1) Path exists but is a file.
    const file = path.join(tmpHome, "guard-file");
    await fs.writeFile(file, "hello");
    const r1 = await validateScienceSwarmDir(file);
    if (r1.state === "invalid") reasons.push(r1.reason);

    // (2) Parent directory does not exist.
    const deep = path.join(tmpHome, "guard-missing-parent", "child");
    const r2 = await validateScienceSwarmDir(deep);
    if (r2.state === "invalid") reasons.push(r2.reason);

    // (3) Dangling symlink.
    const dangling = path.join(tmpHome, "guard-dangling");
    await fs.symlink(path.join(tmpHome, "no-such-target"), dangling);
    const r3 = await validateScienceSwarmDir(dangling);
    if (r3.state === "invalid") reasons.push(r3.reason);

    // (4) Symlink to a non-directory.
    const linkTarget = path.join(tmpHome, "guard-link-target");
    await fs.writeFile(linkTarget, "x");
    const linkToFile = path.join(tmpHome, "guard-link-to-file");
    await fs.symlink(linkTarget, linkToFile);
    const r4 = await validateScienceSwarmDir(linkToFile);
    if (r4.state === "invalid") reasons.push(r4.reason);

    // We should have exercised every invalid branch above.
    expect(reasons.length).toBeGreaterThanOrEqual(4);
    for (const reason of reasons) {
      expect(reason).not.toContain("/");
      expect(reason).not.toContain(tmpHome);
    }
  });
});

describe("getConfigStatus", () => {
  let repoRoot: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalRuntimeEnv: Partial<
    Record<(typeof RUNTIME_CONFIG_TEST_KEYS)[number], string>
  >;

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot();
    tmpHome = await makeTempHomeDir();
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalRuntimeEnv = {};
    for (const key of RUNTIME_CONFIG_TEST_KEYS) {
      originalRuntimeEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(async () => {
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
    for (const key of RUNTIME_CONFIG_TEST_KEYS) {
      const value = originalRuntimeEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rmrf(repoRoot);
    await rmrf(tmpHome);
  });

  it("reports envFileExists=false and missing fields when no .env exists", async () => {
    const status = await getConfigStatus(repoRoot);
    expect(status.envFileExists).toBe(false);
    expect(status.envFileParseError).toBeNull();
    expect(status.openaiApiKey.state).toBe("missing");
    // An unset SCIENCESWARM_DIR is fine — default fallback applies.
    expect(status.scienceswarmDir.state).toBe("ok");
    expect(status.ready).toBe(false);
    expect(status.rawValues).toEqual({});
    expect(status.redactedKeys).toEqual([]);
    expect(status.persistedSetup).toEqual({
      hasUserHandle: false,
      hasEmail: false,
      hasTelegramBotToken: false,
      brainRootReady: false,
      complete: false,
    });
  });

  it("reports ready=true when OpenAI mode has a valid backend and data dir", async () => {
    const dir = path.join(tmpHome, "data");
    await fs.mkdir(dir);
    await writeEnvLocal(
      repoRoot,
      [
        "AGENT_BACKEND=openclaw",
        "OPENAI_API_KEY=sk-real-key-123",
        `SCIENCESWARM_DIR=${dir}`,
        "",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.envFileExists).toBe(true);
    expect(status.openaiApiKey).toEqual({ state: "ok" });
    expect(status.scienceswarmDir).toEqual({ state: "ok" });
    expect(status.ready).toBe(true);
  });

  it("reports ready=true for local mode with a valid backend and model, without an OpenAI key", async () => {
    await writeEnvLocal(
      repoRoot,
      [
        "AGENT_BACKEND=nanoclaw",
        "LLM_PROVIDER=local",
        "OLLAMA_MODEL=gemma4",
        "",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.openaiApiKey.state).toBe("missing");
    expect(status.scienceswarmDir).toEqual({ state: "ok" });
    expect(status.ready).toBe(true);
  });

  it("reports persisted setup complete when a saved user handle and initialized brain exist", async () => {
    const brainRoot = path.join(tmpHome, "brain");
    await createReadyBrainRoot(brainRoot);
    await writeEnvLocal(
      repoRoot,
      [
        "SCIENCESWARM_USER_HANDLE=testuser",
        "GIT_USER_EMAIL=testuser@example.com",
        "TELEGRAM_BOT_TOKEN=123456789:abcdefghijklmnopqrstuvwxyzABCDE",
        `BRAIN_ROOT=${brainRoot}`,
        "AGENT_BACKEND=none",
        "",
      ].join("\n"),
    );

    const status = await getConfigStatus(repoRoot);

    expect(status.ready).toBe(false);
    expect(status.persistedSetup).toEqual({
      hasUserHandle: true,
      hasEmail: true,
      hasTelegramBotToken: true,
      brainRootReady: true,
      complete: true,
    });
    expect(JSON.stringify(status)).not.toContain(
      "123456789:abcdefghijklmnopqrstuvwxyzABCDE",
    );
    expect(status.rawValues["TELEGRAM_BOT_TOKEN"]).toBe(
      REDACTED_SECRET_SENTINEL,
    );
  });

  it("does not report persisted setup complete for a saved handle without an initialized brain", async () => {
    await writeEnvLocal(
      repoRoot,
      [
        "SCIENCESWARM_USER_HANDLE=testuser",
        "GIT_USER_EMAIL=testuser@example.com",
        "",
      ].join("\n"),
    );

    const status = await getConfigStatus(repoRoot);

    expect(status.persistedSetup).toMatchObject({
      hasUserHandle: true,
      hasEmail: true,
      brainRootReady: false,
      complete: false,
    });
  });

  it("does not treat a placeholder Telegram token as configured setup data", async () => {
    const brainRoot = path.join(tmpHome, "brain");
    await createReadyBrainRoot(brainRoot);
    await writeEnvLocal(
      repoRoot,
      [
        "SCIENCESWARM_USER_HANDLE=testuser",
        "TELEGRAM_BOT_TOKEN=replace-me",
        `BRAIN_ROOT=${brainRoot}`,
        "",
      ].join("\n"),
    );

    const status = await getConfigStatus(repoRoot);

    expect(status.persistedSetup).toMatchObject({
      hasUserHandle: true,
      hasTelegramBotToken: false,
      brainRootReady: true,
      complete: true,
    });
  });

  it("reports ready=false for local mode when the agent backend is missing", async () => {
    await writeEnvLocal(
      repoRoot,
      [
        "LLM_PROVIDER=local",
        "OLLAMA_MODEL=gemma4",
        "",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.ready).toBe(false);
  });

  it("reports ready=false for local mode when the local model is missing", async () => {
    await writeEnvLocal(
      repoRoot,
      [
        "AGENT_BACKEND=openclaw",
        "LLM_PROVIDER=local",
        "",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.ready).toBe(false);
  });

  it("does not let a saved OpenAI key satisfy readiness when local mode has no model", async () => {
    await writeEnvLocal(
      repoRoot,
      [
        "AGENT_BACKEND=openclaw",
        "LLM_PROVIDER=local",
        "OPENAI_API_KEY=sk-real-key-123",
        "",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.openaiApiKey.state).toBe("ok");
    expect(status.ready).toBe(false);
  });

  it("reports ready=false when AGENT_BACKEND is set to none", async () => {
    await writeEnvLocal(
      repoRoot,
      [
        "AGENT_BACKEND=none",
        "OPENAI_API_KEY=sk-real-key-123",
        "",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.ready).toBe(false);
  });

  it("can satisfy readiness from runtime env without echoing runtime secrets when opted in", async () => {
    const runtimeDir = path.join(tmpHome, "runtime-data");
    await fs.mkdir(runtimeDir);
    await writeEnvLocal(
      repoRoot,
      [
        "AGENT_BACKEND=none",
        "LLM_PROVIDER=local",
        "OPENAI_API_KEY=",
        "",
      ].join("\n"),
    );

    process.env.AGENT_BACKEND = "openclaw";
    process.env.LLM_PROVIDER = "local";
    process.env.OLLAMA_MODEL = "gemma4:latest";
    process.env.SCIENCESWARM_DIR = runtimeDir;
    process.env.OPENAI_API_KEY = "sk-runtime-secret";

    const diskOnly = await getConfigStatus(repoRoot);
    expect(diskOnly.ready).toBe(false);

    const status = await getConfigStatus(repoRoot, {
      includeRuntimeEnv: true,
    });
    expect(status.ready).toBe(true);
    expect(status.openaiApiKey.state).toBe("missing");
    expect(status.rawValues).toEqual({
      AGENT_BACKEND: "none",
      LLM_PROVIDER: "local",
      OPENAI_API_KEY: "",
    });
    expect(status.redactedKeys).toEqual([]);
    expect(JSON.stringify(status)).not.toContain("sk-runtime-secret");
    expect(JSON.stringify(status)).not.toContain(runtimeDir);
  });

  it("flags a placeholder OpenAI key and ready=false", async () => {
    await writeEnvLocal(
      repoRoot,
      [
        "AGENT_BACKEND=openclaw",
        "OPENAI_API_KEY=sk-proj-REPLACE-ME-etc",
        "",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.openaiApiKey.state).toBe("placeholder");
    expect(status.ready).toBe(false);
  });

  it("flags a placeholder OpenSci data dir and ready=false", async () => {
    await writeEnvLocal(
      repoRoot,
      [
        "AGENT_BACKEND=openclaw",
        "OPENAI_API_KEY=sk-real",
        "SCIENCESWARM_DIR=/path/to/scienceswarm-data",
        "",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.scienceswarmDir.state).toBe("placeholder");
    expect(status.ready).toBe(false);
  });

  it("flags an OpenAI key that doesn't start with sk- as invalid", async () => {
    await writeEnvLocal(
      repoRoot,
      [
        "AGENT_BACKEND=openclaw",
        "OPENAI_API_KEY=not-a-real-key",
        "",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.openaiApiKey.state).toBe("invalid");
    if (status.openaiApiKey.state === "invalid") {
      expect(status.openaiApiKey.reason).toMatch(/sk-/);
    }
    expect(status.ready).toBe(false);
  });

  it("surfaces a line-numbered warning when .env contains an invalid line", async () => {
    await writeEnvLocal(
      repoRoot,
      'OPENAI_API_KEY="sk-unterminated\nSCIENCESWARM_DIR=/tmp\n',
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.envFileExists).toBe(true);
    expect(status.envFileParseError).toBe(
      "Line 1 of .env could not be parsed. It will be preserved as-is on save.",
    );
    expect(status.openaiApiKey.state).toBe("missing");
    expect(status.scienceswarmDir.state).toBe("ok");
  });

  it("surfaces every invalid line number when .env contains multiple invalid lines", async () => {
    await writeEnvLocal(
      repoRoot,
      ['OPENAI_API_KEY="', "SCIENCESWARM_DIR=/tmp", "export BROKEN=1", ""].join(
        "\n",
      ),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.envFileExists).toBe(true);
    expect(status.envFileParseError).toBe(
      "Lines 1, 3 of .env could not be parsed. They will be preserved as-is on save.",
    );
    expect(status.openaiApiKey.state).toBe("missing");
    expect(status.scienceswarmDir.state).toBe("ok");
  });

  it("reports ok for an empty SCIENCESWARM_DIR entry (default fallback)", async () => {
    await writeEnvLocal(
      repoRoot,
      "OPENAI_API_KEY=sk-real\nSCIENCESWARM_DIR=\n",
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.scienceswarmDir).toEqual({ state: "ok" });
  });

  it("includes only setup-form keys in rawValues and redacts secret values", async () => {
    // Secrets (OPENAI_API_KEY) must not survive into rawValues even as
    // a placeholder literal — we validate against the true value but
    // expose only the sentinel. Unrelated keys stay omitted so the
    // unauthenticated status endpoint is scoped to the actual form.
    await writeEnvLocal(
      repoRoot,
      [
        "OPENAI_API_KEY=sk-proj-REPLACE-ME-etc",
        "SCIENCESWARM_DIR=/path/to/scienceswarm-data",
        "OTHER_KEY=whatever",
        "",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.rawValues).toEqual({
      OPENAI_API_KEY: REDACTED_SECRET_SENTINEL,
      SCIENCESWARM_DIR: "/path/to/scienceswarm-data",
    });
    expect(status.redactedKeys).toEqual(["OPENAI_API_KEY"]);
  });

  it("validates SCIENCESWARM_DIR=~/some/real/path by expanding the tilde", async () => {
    const realSub = path.join(tmpHome, "some", "real", "path");
    await fs.mkdir(realSub, { recursive: true });
    await writeEnvLocal(
      repoRoot,
      "OPENAI_API_KEY=sk-real\nSCIENCESWARM_DIR=~/some/real/path\n",
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.scienceswarmDir).toEqual({ state: "ok" });
  });

  it("reports invalid when SCIENCESWARM_DIR points at a non-existent path whose parent is missing", async () => {
    const target = path.join(tmpHome, "no-parent", "no-child");
    await writeEnvLocal(
      repoRoot,
      `OPENAI_API_KEY=sk-real\nSCIENCESWARM_DIR=${target}\n`,
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.scienceswarmDir.state).toBe("invalid");
  });

  it("reports ok when SCIENCESWARM_DIR points at a non-existent path whose parent IS writable", async () => {
    const target = path.join(tmpHome, "does-not-exist-yet");
    await writeEnvLocal(
      repoRoot,
      `OPENAI_API_KEY=sk-real\nSCIENCESWARM_DIR=${target}\n`,
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.scienceswarmDir).toEqual({ state: "ok" });
  });

  it("never echoes real secret values in rawValues for setup form secret fields", async () => {
    const realishValues: Record<string, string> = {
      OPENAI_API_KEY: "sk-real-openai-abc-123",
      GITHUB_SECRET: "gh-real-secret-xyz",
      GOOGLE_CLIENT_SECRET: "goog-real-secret-42",
      TELEGRAM_BOT_TOKEN: "1234:realtelegramtoken",
    };
    const envBody = Object.entries(realishValues)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    await writeEnvLocal(repoRoot, `${envBody}\n`);

    const status = await getConfigStatus(repoRoot);
    const raw = JSON.stringify(status);
    for (const value of Object.values(realishValues)) {
      expect(raw).not.toContain(value);
    }
    for (const key of Object.keys(realishValues)) {
      expect([REDACTED_SECRET_SENTINEL, ""]).toContain(
        status.rawValues[key],
      );
    }
    expect(new Set(status.redactedKeys)).toEqual(
      new Set(Object.keys(realishValues)),
    );
  });

  it("omits unrelated secret-looking keys from rawValues entirely", async () => {
    await writeEnvLocal(
      repoRoot,
      [
        "AGENT_API_KEY=agent-secret-123",
        "DISCORD_BOT_TOKEN=discord-secret-456",
        "ZOTERO_API_KEY=zotero-secret-789",
        "OPENAI_API_KEY=sk-real",
      ].join("\n"),
    );

    const status = await getConfigStatus(repoRoot);
    expect(status.rawValues["AGENT_API_KEY"]).toBeUndefined();
    expect(status.rawValues["DISCORD_BOT_TOKEN"]).toBeUndefined();
    expect(status.rawValues["ZOTERO_API_KEY"]).toBeUndefined();
    expect(status.rawValues["OPENAI_API_KEY"]).toBe(
      REDACTED_SECRET_SENTINEL,
    );
  });

  it("echoes non-secret keys (SCIENCESWARM_DIR, GOOGLE_CLIENT_ID, GITHUB_ID) verbatim so the UI can pre-fill", async () => {
    const dir = path.join(tmpHome, "data");
    const brainRoot = path.join(tmpHome, "brain");
    await fs.mkdir(dir);
    await fs.mkdir(brainRoot);
    await writeEnvLocal(
      repoRoot,
      [
        `SCIENCESWARM_DIR=${dir}`,
        `BRAIN_ROOT=${brainRoot}`,
        "GOOGLE_CLIENT_ID=google-client-id-123",
        "GITHUB_ID=github-client-id-456",
        "OPENAI_API_KEY=sk-real",
      ].join("\n"),
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.rawValues["SCIENCESWARM_DIR"]).toBe(dir);
    expect(status.rawValues["BRAIN_ROOT"]).toBe(brainRoot);
    expect(status.rawValues["GOOGLE_CLIENT_ID"]).toBe(
      "google-client-id-123",
    );
    expect(status.rawValues["GITHUB_ID"]).toBe("github-client-id-456");
    expect(status.rawValues["OPENAI_API_KEY"]).toBe(
      REDACTED_SECRET_SENTINEL,
    );
  });

  it("reports empty string for secret keys present but empty (so the UI can distinguish 'not set' from 'set but hidden')", async () => {
    await writeEnvLocal(
      repoRoot,
      "OPENAI_API_KEY=\nGITHUB_SECRET=\n",
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.rawValues["OPENAI_API_KEY"]).toBe("");
    expect(status.rawValues["GITHUB_SECRET"]).toBe("");
    // Empty values aren't "redacted" — nothing is hidden.
    expect(status.redactedKeys).toEqual([]);
  });

  it("still runs validation against the TRUE value even though rawValues is redacted", async () => {
    // Regression guard: if we validated the redacted sentinel instead
    // of the real value, every configured secret would come back as
    // `ok` regardless of whether it started with `sk-`. Write a
    // known-bad key and confirm the validator sees it.
    await writeEnvLocal(
      repoRoot,
      "OPENAI_API_KEY=not-an-sk-key-at-all\n",
    );
    const status = await getConfigStatus(repoRoot);
    expect(status.openaiApiKey.state).toBe("invalid");
    // But the raw value still isn't echoed.
    expect(status.rawValues["OPENAI_API_KEY"]).toBe(
      REDACTED_SECRET_SENTINEL,
    );
    expect(JSON.stringify(status)).not.toContain("not-an-sk-key-at-all");
  });
});
