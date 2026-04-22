import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted spy handles so we can adjust the mocked child_process behavior
// per-test without juggling module reloads.
//
// The wrapper does `promisify(execFile)` at module load. `promisify` has
// special handling for functions that carry `util.promisify.custom` —
// when the symbol is present, promisify uses the attached promise-returning
// implementation directly instead of wrapping the callback form. We want
// that path because it lets the tests control the resolved/rejected value
// cleanly via a single `vi.fn()`. We use `Symbol.for("nodejs.util.promisify.custom")`
// which returns the same well-known symbol across the VM.
const mocks = vi.hoisted(() => {
  const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
  const execFilePromise = vi.fn();
  const execFileMock = Object.assign(vi.fn(), {
    [promisifyCustom]: execFilePromise,
  });
  return {
    execFileMock,
    execFilePromise,
    execFileSyncMock: vi.fn(),
    spawnMock: vi.fn(),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    execFile: mocks.execFileMock,
    execFileSync: mocks.execFileSyncMock,
    spawn: mocks.spawnMock,
  };
});

// Import AFTER the mock is registered so the wrapper picks up the mocked
// child_process.
import {
  buildOpenClawArgs,
  buildOpenClawEnv,
  clearGatewayPid,
  killGatewayByPid,
  readGatewayPid,
  resolveOpenClawMode,
  runOpenClaw,
  runOpenClawSync,
  spawnOpenClaw,
  writeGatewayPid,
} from "@/lib/openclaw/runner";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  // Wipe every var the wrapper reads, then restore the minimum required
  // for os.homedir() and path resolution to keep working.
  for (const key of ["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "SCIENCESWARM_DIR"]) {
    delete process.env[key];
  }
}

beforeEach(() => {
  resetEnv();
  mocks.execFileMock.mockReset();
  mocks.execFilePromise.mockReset();
  mocks.execFileSyncMock.mockReset();
  mocks.spawnMock.mockReset();
});

afterEach(() => {
  // Restore the original process.env so later tests in this file (and
  // other files) see a clean slate.
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

describe("resolveOpenClawMode", () => {
  it("defaults to state-dir mode under ~/.scienceswarm/openclaw when no env is set", () => {
    const mode = resolveOpenClawMode();
    expect(mode.kind).toBe("state-dir");
    if (mode.kind !== "state-dir") throw new Error("narrow");
    expect(mode.stateDir).toBe(path.join(os.homedir(), ".scienceswarm", "openclaw"));
    expect(mode.configPath).toBe(
      path.join(os.homedir(), ".scienceswarm", "openclaw", "openclaw.json"),
    );
  });

  it("honors SCIENCESWARM_DIR for the resolved state dir", () => {
    process.env.SCIENCESWARM_DIR = "/tmp/custom-scienceswarm";
    const mode = resolveOpenClawMode();
    expect(mode.kind).toBe("state-dir");
    if (mode.kind !== "state-dir") throw new Error("narrow");
    expect(mode.stateDir).toBe("/tmp/custom-scienceswarm/openclaw");
    expect(mode.configPath).toBe("/tmp/custom-scienceswarm/openclaw/openclaw.json");
  });

  it("flips to profile mode when OPENCLAW_PROFILE is set and non-empty", () => {
    process.env.OPENCLAW_PROFILE = "project-alpha";
    const mode = resolveOpenClawMode();
    expect(mode).toEqual({ kind: "profile", profile: "project-alpha" });
  });

  it("treats an empty OPENCLAW_PROFILE as unset", () => {
    process.env.OPENCLAW_PROFILE = "";
    expect(resolveOpenClawMode().kind).toBe("state-dir");
  });

  it("treats whitespace-only OPENCLAW_PROFILE as unset", () => {
    process.env.OPENCLAW_PROFILE = "   ";
    expect(resolveOpenClawMode().kind).toBe("state-dir");
  });

  it("never resolves to a state dir under ~/.openclaw for any OPENCLAW_PROFILE value", () => {
    const homeOpenclaw = path.join(os.homedir(), ".openclaw");
    for (const candidate of ["", "   ", "project-alpha", "beta", "dev", "eng"]) {
      process.env.OPENCLAW_PROFILE = candidate;
      const mode = resolveOpenClawMode();
      if (mode.kind === "state-dir") {
        expect(mode.stateDir).not.toBe(homeOpenclaw);
      }
      // Profile mode has no state dir; the invariant trivially holds.
    }
  });
});

describe("buildOpenClawArgs", () => {
  it("passes args through unchanged in state-dir mode", () => {
    expect(
      buildOpenClawArgs(["gateway", "run", "--port", "18789"], {
        kind: "state-dir",
        stateDir: "/s",
        configPath: "/s/openclaw.json",
      }),
    ).toEqual(["gateway", "run", "--port", "18789"]);
  });

  it("prepends --profile <name> in profile mode", () => {
    expect(
      buildOpenClawArgs(["gateway", "run"], { kind: "profile", profile: "foo" }),
    ).toEqual(["--profile", "foo", "gateway", "run"]);
  });

  it("defaults to resolved mode when no mode is passed", () => {
    process.env.OPENCLAW_PROFILE = "bar";
    expect(buildOpenClawArgs(["status"])).toEqual(["--profile", "bar", "status"]);
  });
});

describe("buildOpenClawEnv", () => {
  it("exports OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH in state-dir mode", () => {
    const env = buildOpenClawEnv({
      kind: "state-dir",
      stateDir: "/tmp/x/openclaw",
      configPath: "/tmp/x/openclaw/openclaw.json",
    });
    expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/x/openclaw");
    expect(env.OPENCLAW_CONFIG_PATH).toBe("/tmp/x/openclaw/openclaw.json");
  });

  it("deletes OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH in profile mode", () => {
    // Seed a stale shell export and verify the wrapper clears it.
    process.env.OPENCLAW_STATE_DIR = "/leftover/from/shell";
    process.env.OPENCLAW_CONFIG_PATH = "/leftover/from/shell/openclaw.json";
    const env = buildOpenClawEnv({ kind: "profile", profile: "foo" });
    expect(env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(env.OPENCLAW_CONFIG_PATH).toBeUndefined();
  });

  it("deletes keys when extraEnv passes undefined", () => {
    const env = buildOpenClawEnv(
      {
        kind: "state-dir",
        stateDir: "/tmp/x/openclaw",
        configPath: "/tmp/x/openclaw/openclaw.json",
      },
      { OPENCLAW_STATE_DIR: undefined, OPENCLAW_CONFIG_PATH: undefined },
    );
    expect(env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(env.OPENCLAW_CONFIG_PATH).toBeUndefined();
  });

  it("preserves unrelated env vars", () => {
    process.env.MY_OTHER_VAR = "keep-me";
    const env = buildOpenClawEnv({
      kind: "state-dir",
      stateDir: "/s",
      configPath: "/s/openclaw.json",
    });
    expect(env.MY_OTHER_VAR).toBe("keep-me");
  });

  it("removes cloud OpenAI credentials when saved runtime mode is local", () => {
    process.env.LLM_PROVIDER = "local";
    process.env.OLLAMA_MODEL = "gemma4:latest";
    process.env.OPENAI_API_KEY = "sk-should-not-leak";

    const env = buildOpenClawEnv({
      kind: "state-dir",
      stateDir: "/s",
      configPath: "/s/openclaw.json",
    });

    expect(env.LLM_PROVIDER).toBe("local");
    expect(env.OLLAMA_MODEL).toBe("gemma4:latest");
    expect(env.OLLAMA_API_KEY).toBe("ollama-local");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("legacy state-dir healing", () => {
  it("replaces a legacy symlinked state dir with a real directory copy before invoking openclaw", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-heal-"));
    try {
      const legacyDir = path.join(tmpRoot, "legacy-openclaw");
      const dataRoot = path.join(tmpRoot, "data");
      const stateDir = path.join(dataRoot, "openclaw");

      fs.mkdirSync(path.join(legacyDir, "credentials"), { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, "openclaw.json"),
        JSON.stringify({ gateway: { port: 18789 } }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(legacyDir, "credentials", "telegram-default-allowFrom.json"),
        JSON.stringify({ version: 1, allowFrom: ["123"] }),
        "utf8",
      );
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.symlinkSync(legacyDir, stateDir);

      mockExecFileSuccess("ok", "");
      await runOpenClaw(["status"], {
        mode: {
          kind: "state-dir",
          stateDir,
          configPath: path.join(stateDir, "openclaw.json"),
        },
      });

      const stat = fs.lstatSync(stateDir);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);
      expect(
        fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"),
      ).toContain('"port":18789');
      fs.writeFileSync(path.join(stateDir, "marker"), "new", "utf8");
      expect(fs.existsSync(path.join(legacyDir, "marker"))).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ─── runOpenClaw (async spawn path) ─────────────────────────────────────

/**
 * Control the promisified execFile resolution. The wrapper calls
 * `promisify(execFile)` at module load, and because our mock carries
 * `util.promisify.custom`, promisify uses `mocks.execFilePromise`
 * directly. We stub the resolved or rejected value per-test.
 */
function mockExecFileSuccess(stdout: string, stderr = "") {
  mocks.execFilePromise.mockResolvedValue({ stdout, stderr });
}

function mockExecFileFailure(
  error: Error & {
    stdout?: string;
    stderr?: string;
    code?: number | string;
    killed?: boolean;
    signal?: string;
  },
) {
  mocks.execFilePromise.mockRejectedValue(error);
}

describe("runOpenClaw", () => {
  it("resolves {ok: true, stdout, stderr} on success", async () => {
    mockExecFileSuccess("version 2026.4.11\n", "");
    const result = await runOpenClaw(["--version"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("version 2026.4.11\n");
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("forwards buildOpenClawArgs output to execFile", async () => {
    process.env.OPENCLAW_PROFILE = "beta";
    mockExecFileSuccess("ok", "");
    await runOpenClaw(["gateway", "run"]);
    const firstCall = mocks.execFilePromise.mock.calls[0];
    expect(firstCall[0]).toBe("openclaw");
    expect(firstCall[1]).toEqual(["--profile", "beta", "gateway", "run"]);
  });

  it("forwards state-dir env vars to execFile in state-dir mode", async () => {
    process.env.SCIENCESWARM_DIR = "/tmp/run-test";
    mockExecFileSuccess("ok", "");
    await runOpenClaw(["status"]);
    const opts = mocks.execFilePromise.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.OPENCLAW_STATE_DIR).toBe("/tmp/run-test/openclaw");
    expect(opts.env.OPENCLAW_CONFIG_PATH).toBe("/tmp/run-test/openclaw/openclaw.json");
  });

  it("deletes state-dir env vars in profile mode", async () => {
    process.env.OPENCLAW_PROFILE = "p1";
    process.env.OPENCLAW_STATE_DIR = "/leftover";
    process.env.OPENCLAW_CONFIG_PATH = "/leftover/openclaw.json";
    mockExecFileSuccess("ok", "");
    await runOpenClaw(["status"]);
    const opts = mocks.execFilePromise.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(opts.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
  });

  it("resolves {ok: false} with stderr on non-zero exit", async () => {
    const err = Object.assign(new Error("Command failed"), {
      stdout: "",
      stderr: "fatal: config missing\n",
      code: 2,
    });
    mockExecFileFailure(err);
    const result = await runOpenClaw(["config", "validate"]);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("fatal: config missing");
    expect(result.code).toBe(2);
  });

  it("resolves {ok: false} with ENOENT hint when binary is missing", async () => {
    const err = Object.assign(new Error("spawn openclaw ENOENT"), {
      code: "ENOENT",
    });
    mockExecFileFailure(err);
    const result = await runOpenClaw(["--version"]);
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/ENOENT/);
    expect(result.code).toBeNull();
  });

  it("resolves {ok: false} with timeout hint when killed by signal", async () => {
    const err = Object.assign(new Error("Command timed out"), {
      killed: true,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    });
    mockExecFileFailure(err);
    const result = await runOpenClaw(["gateway", "install"], { timeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/timeout/i);
  });

  it("respects cliPath override", async () => {
    mockExecFileSuccess("ok");
    await runOpenClaw(["--version"], { cliPath: "/opt/openclaw/bin/openclaw" });
    expect(mocks.execFilePromise.mock.calls[0][0]).toBe("/opt/openclaw/bin/openclaw");
  });

  it("respects timeoutMs option on the execFile call", async () => {
    mockExecFileSuccess("ok");
    await runOpenClaw(["status"], { timeoutMs: 12_345 });
    const opts = mocks.execFilePromise.mock.calls[0][2] as { timeout: number };
    expect(opts.timeout).toBe(12_345);
  });
});

// ─── runOpenClawSync (sync variant for --version) ──────────────────────

describe("runOpenClawSync", () => {
  it("returns {stdout, stderr} on success", () => {
    mocks.execFileSyncMock.mockImplementation(() => "openclaw 2026.4.11\n");
    const result = runOpenClawSync(["--version"]);
    expect(result).not.toBeNull();
    expect(result?.stdout).toBe("openclaw 2026.4.11\n");
  });

  it("returns null on any failure (e.g., ENOENT, non-zero exit, timeout)", () => {
    mocks.execFileSyncMock.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(runOpenClawSync(["--version"])).toBeNull();
  });

  it("forwards env vars and argv just like the async variant", () => {
    process.env.SCIENCESWARM_DIR = "/tmp/sync-test";
    mocks.execFileSyncMock.mockImplementation(() => "ok");
    runOpenClawSync(["--version"]);
    const [bin, argv, opts] = mocks.execFileSyncMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(bin).toBe("openclaw");
    expect(argv).toEqual(["--version"]);
    expect(opts.env.OPENCLAW_STATE_DIR).toBe("/tmp/sync-test/openclaw");
  });
});

// ─── spawnOpenClaw (streaming variant for long-running commands) ───────

describe("spawnOpenClaw", () => {
  it("returns the ChildProcess so callers can read child.pid and call child.kill()", () => {
    const fakeChild = Object.assign(new EventEmitter(), {
      pid: 4242,
      kill: vi.fn(),
    });
    mocks.spawnMock.mockReturnValue(fakeChild);

    const child = spawnOpenClaw(["gateway", "run", "--bind", "loopback"]);
    expect(child.pid).toBe(4242);
    child.kill("SIGTERM");
    expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("forwards env vars in state-dir mode", () => {
    process.env.SCIENCESWARM_DIR = "/tmp/spawn-test";
    const fakeChild = Object.assign(new EventEmitter(), { pid: 1, kill: vi.fn() });
    mocks.spawnMock.mockReturnValue(fakeChild);
    spawnOpenClaw(["gateway", "start"]);
    const opts = mocks.spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(opts.env.OPENCLAW_STATE_DIR).toBe("/tmp/spawn-test/openclaw");
  });

  it("prepends --profile in profile mode", () => {
    process.env.OPENCLAW_PROFILE = "foo";
    const fakeChild = Object.assign(new EventEmitter(), { pid: 1, kill: vi.fn() });
    mocks.spawnMock.mockReturnValue(fakeChild);
    spawnOpenClaw(["gateway", "start"]);
    const argv = mocks.spawnMock.mock.calls[0][1] as string[];
    expect(argv).toEqual(["--profile", "foo", "gateway", "start"]);
  });
});

// ─── Gateway PID tracking ─────────────────────────────────────────────

describe("gateway pid tracking", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pid-test-"));
    process.env.SCIENCESWARM_DIR = tmpRoot;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("round-trips a pid through writeGatewayPid/readGatewayPid", () => {
    writeGatewayPid(9999);
    expect(readGatewayPid()).toBe(9999);
  });

  it("writes the pidfile inside the resolved state dir", () => {
    writeGatewayPid(12345);
    const expected = path.join(tmpRoot, "openclaw", "gateway.pid");
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, "utf8").trim()).toBe("12345");
  });

  it("returns null when no pidfile exists", () => {
    expect(readGatewayPid()).toBeNull();
  });

  it("returns null on a corrupt pidfile", () => {
    fs.mkdirSync(path.join(tmpRoot, "openclaw"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "openclaw", "gateway.pid"), "not-a-number", "utf8");
    expect(readGatewayPid()).toBeNull();
  });

  it("clearGatewayPid removes the pidfile", () => {
    writeGatewayPid(1);
    clearGatewayPid();
    expect(readGatewayPid()).toBeNull();
  });

  it("sanitizes profile-mode pid filenames so they stay under TMPDIR", () => {
    process.env.OPENCLAW_PROFILE = "../project alpha/../../beta";
    process.env.TMPDIR = tmpRoot;

    writeGatewayPid(456);

    const expected = path.join(
      tmpRoot,
      "openclaw-gateway-.._project_alpha_.._.._beta-2e2e2f70726f6a65637420616c7068612f2e2e2f2e2e2f62657461.pid",
    );
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, "utf8").trim()).toBe("456");
  });

  it("keeps distinct profile names on distinct pid files even when their sanitized stems match", () => {
    process.env.TMPDIR = tmpRoot;

    writeGatewayPid(111, { kind: "profile", profile: "alpha/beta" });
    writeGatewayPid(222, { kind: "profile", profile: "alpha_beta" });

    const slashPath = path.join(
      tmpRoot,
      "openclaw-gateway-alpha_beta-616c7068612f62657461.pid",
    );
    const underscorePath = path.join(
      tmpRoot,
      "openclaw-gateway-alpha_beta-616c7068615f62657461.pid",
    );

    expect(fs.readFileSync(slashPath, "utf8").trim()).toBe("111");
    expect(fs.readFileSync(underscorePath, "utf8").trim()).toBe("222");
  });

  it("killGatewayByPid returns false and clears the pidfile when PID is stale", async () => {
    // PID 2^31-1 is extremely unlikely to exist — process.kill will throw ESRCH.
    writeGatewayPid(2_147_483_646);
    const result = await killGatewayByPid({ graceMs: 0 });
    expect(result).toBe(false);
    expect(readGatewayPid()).toBeNull();
  });

  it("killGatewayByPid returns false when no pidfile exists", async () => {
    const result = await killGatewayByPid({ graceMs: 0 });
    expect(result).toBe(false);
  });
});
