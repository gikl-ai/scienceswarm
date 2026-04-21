/**
 * OpenClaw invocation wrapper — the single seam through which every JS/TS
 * call to the `openclaw` binary in this codebase MUST go. This exists so
 * that:
 *
 *   1. Every invocation sees the same `OPENCLAW_STATE_DIR` /
 *      `OPENCLAW_CONFIG_PATH` environment, eliminating the split-brain
 *      risk Codex flagged around `gateway install` (a service-install
 *      path that misses the env vars ends up pointing at default state
 *      while one-shot CLI commands hit the app-owned dir).
 *
 *   2. The mode split between ScienceSwarm-managed state (default,
 *      state-dir mode under `$SCIENCESWARM_DIR/openclaw`) and user-managed
 *      profile mode (opt-in via `OPENCLAW_PROFILE=<name>`) is decided in
 *      exactly one place. Call sites do not read `OPENCLAW_PROFILE`
 *      directly.
 *
 *   3. Long-running spawns (like `gateway run`) can expose their PID to
 *      callers via `spawnOpenClaw`, enabling kill-by-PID instead of the
 *      `pkill -f openclaw.*gateway` shotgun that would kill a user's
 *      unrelated profile gateways.
 *
 * The shell-level resolver at `scripts/openclaw-env.sh` mirrors this
 * module exactly. Changes to the resolution logic MUST update both.
 * There is a parity test in tests/lib/openclaw-runner-shell-parity.test.ts.
 */

import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  getScienceSwarmOpenClawConfigPath,
  getScienceSwarmOpenClawStateDir,
} from "@/lib/scienceswarm-paths";
import {
  readSavedLlmRuntimeEnv,
  resolveSavedLlmRuntimeEnv,
} from "@/lib/runtime-saved-env";

const execFileAsync = promisify(execFile);

/**
 * How ScienceSwarm should talk to OpenClaw for this invocation. The default
 * mode is state-dir — it isolates ScienceSwarm's own OpenClaw state under
 * `$SCIENCESWARM_DIR/openclaw` without disturbing any `~/.openclaw-<name>/`
 * profiles the user has set up for their own research personas.
 *
 * Profile mode exists as a power-user opt-in: setting `OPENCLAW_PROFILE`
 * in `.env` points ScienceSwarm at one of the user's existing profiles via
 * the upstream `--profile <name>` UX contract, leaving path resolution to
 * upstream.
 */
export type OpenClawMode =
  | { kind: "state-dir"; stateDir: string; configPath: string }
  | { kind: "profile"; profile: string };

/**
 * Pick the mode based on environment. `OPENCLAW_PROFILE` wins when it is
 * set and non-empty (after trimming). Otherwise we use state-dir mode with
 * paths resolved from `SCIENCESWARM_DIR` (or the default `~/.scienceswarm`).
 */
export function resolveOpenClawMode(): OpenClawMode {
  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.length > 0) {
    return { kind: "profile", profile };
  }
  return {
    kind: "state-dir",
    stateDir: getScienceSwarmOpenClawStateDir(),
    configPath: getScienceSwarmOpenClawConfigPath(),
  };
}

/**
 * Legacy healing: older ScienceSwarm builds symlinked
 * `$SCIENCESWARM_DIR/openclaw -> ~/.openclaw`, which defeats the current
 * state-dir isolation contract. If that symlink is still present, replace it
 * with a real directory under `$SCIENCESWARM_DIR` while copying the current
 * contents across, so future writes stop mutating the user's global
 * `~/.openclaw`.
 *
 * Safe behavior:
 *   - missing path     -> create the directory
 *   - real directory   -> leave it alone
 *   - symlink          -> copy dereferenced contents into a fresh real dir,
 *                         unlink the symlink, rename the copy into place
 *   - anything else    -> throw (callers surface the failure)
 */
export function ensureOpenClawStateDirReady(
  mode: OpenClawMode = resolveOpenClawMode(),
): void {
  if (mode.kind !== "state-dir") return;

  const stateDir = mode.stateDir;
  fs.mkdirSync(path.dirname(stateDir), { recursive: true });

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      fs.mkdirSync(stateDir, { recursive: true });
      return;
    }
    throw err;
  }

  if (stat.isDirectory()) return;

  if (!stat.isSymbolicLink()) {
    throw new Error(
      `OpenClaw state path exists but is not a directory: ${stateDir}`,
    );
  }

  const tmpDir = `${stateDir}.migrate-${process.pid}-${Date.now()}`;
  try {
    fs.cpSync(stateDir, tmpDir, {
      recursive: true,
      dereference: true,
      force: true,
    });
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      fs.mkdirSync(tmpDir, { recursive: true });
    } else {
      throw new Error(
        `Failed to migrate legacy OpenClaw symlink at ${stateDir}: ${errno.message}`,
      );
    }
  }

  try {
    fs.unlinkSync(stateDir);
    fs.renameSync(tmpDir, stateDir);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `Failed to replace legacy OpenClaw symlink at ${stateDir}: ${(err as Error).message}`,
    );
  }
}

/**
 * Build argv for an openclaw invocation. Profile mode prepends
 * `--profile <name>` as a global option; state-dir mode returns args
 * unchanged because the env vars carry the isolation.
 */
export function buildOpenClawArgs(
  args: readonly string[],
  mode: OpenClawMode = resolveOpenClawMode(),
): string[] {
  if (mode.kind === "profile") {
    return ["--profile", mode.profile, ...args];
  }
  return [...args];
}

/**
 * Build the env object to pass to `spawn`/`execFile`. In state-dir mode
 * this exports both `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`. In
 * profile mode it deletes both so a stale shell export cannot shadow the
 * profile's upstream-managed paths — upstream `--profile` owns path
 * resolution in that mode.
 */
export function buildOpenClawEnv(
  mode: OpenClawMode = resolveOpenClawMode(),
  extra?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const savedRuntime =
    process.env.NODE_ENV === "test"
      ? resolveSavedLlmRuntimeEnv(process.env, null)
      : readSavedLlmRuntimeEnv(process.env);

  env.LLM_PROVIDER = savedRuntime.llmProvider;
  if (savedRuntime.llmModel) {
    env.LLM_MODEL = savedRuntime.llmModel;
  } else {
    delete env.LLM_MODEL;
  }
  if (savedRuntime.ollamaModel) {
    env.OLLAMA_MODEL = savedRuntime.ollamaModel;
  } else {
    delete env.OLLAMA_MODEL;
  }
  if (savedRuntime.openaiApiKey) {
    env.OPENAI_API_KEY = savedRuntime.openaiApiKey;
  } else {
    delete env.OPENAI_API_KEY;
  }
  if (savedRuntime.strictLocalOnly) {
    env.SCIENCESWARM_STRICT_LOCAL_ONLY = "1";
  } else {
    delete env.SCIENCESWARM_STRICT_LOCAL_ONLY;
  }
  if (mode.kind === "state-dir") {
    env.OPENCLAW_STATE_DIR = mode.stateDir;
    env.OPENCLAW_CONFIG_PATH = mode.configPath;
  } else {
    delete env.OPENCLAW_STATE_DIR;
    delete env.OPENCLAW_CONFIG_PATH;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        env[key] = value;
      } else {
        delete env[key];
      }
    }
  }
  return env;
}

export interface RunOpenClawOptions {
  mode?: OpenClawMode;
  /** Absolute path to the openclaw binary. Defaults to `"openclaw"` on PATH. */
  cliPath?: string;
  /** Override the working directory for the spawned process. */
  cwd?: string;
  /** Milliseconds before the process is killed. Defaults to 30_000. */
  timeoutMs?: number;
  /**
   * Extra env vars to merge into the spawned process environment on top of
   * the wrapper-built env (which already exports state-dir/config-path
   * keys). Use this for secrets like `OPENAI_API_KEY` that the caller
   * wants to inject without mutating `process.env`.
   */
  extraEnv?: Record<string, string | undefined>;
}

export interface RunOpenClawResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Exit code if the process exited normally, null otherwise. */
  code: number | null;
}

/**
 * One-shot async call to `openclaw`. Captures stdout/stderr. Returns
 * a structured result with `ok=false` on non-zero exit, timeout, or
 * ENOENT — never throws on process failure so callers can use it as a
 * boolean gate. Throws only on programmer errors (bad option shape).
 */
export async function runOpenClaw(
  args: readonly string[],
  options: RunOpenClawOptions = {},
): Promise<RunOpenClawResult> {
  const mode = options.mode ?? resolveOpenClawMode();
  ensureOpenClawStateDirReady(mode);
  const argv = buildOpenClawArgs(args, mode);
  const env = buildOpenClawEnv(mode, options.extraEnv);
  const cliPath = options.cliPath ?? "openclaw";
  const timeoutMs = options.timeoutMs ?? 30_000;

  try {
    const { stdout, stderr } = await execFileAsync(cliPath, argv, {
      env,
      cwd: options.cwd,
      timeout: timeoutMs,
    });
    // Default encoding on execFile is "utf8", so both are strings. No
    // Buffer handling needed unless a caller opts into {encoding: "buffer"},
    // which this wrapper deliberately does not expose.
    return {
      ok: true,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (err) {
    // execFile rejects with an Error carrying stdout/stderr/code/killed/signal
    // as extra properties. Node doesn't include these in NodeJS.ErrnoException,
    // so we narrow via a local interface.
    interface ExecFileError {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    }
    const e = err as Error & ExecFileError;
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    let stderr = typeof e.stderr === "string" ? e.stderr : "";
    // Normalize error surface so callers get a useful stderr for timeouts
    // and missing-binary cases instead of node's terse error messages.
    if (e.code === "ENOENT") {
      stderr = stderr || `openclaw binary not found at "${cliPath}" (ENOENT)`;
    } else if (e.killed && e.signal) {
      stderr = stderr || `openclaw killed by signal ${e.signal} (timeout after ${timeoutMs}ms)`;
    }
    const code = typeof e.code === "number" ? e.code : null;
    return { ok: false, stdout, stderr, code };
  }
}

export interface RunOpenClawSyncOptions {
  mode?: OpenClawMode;
  cliPath?: string;
  cwd?: string;
  /** Milliseconds before the process is killed. Defaults to 5_000. */
  timeoutMs?: number;
}

/**
 * Synchronous one-shot call. Used by the deprecated `isConnected()` path
 * and anywhere else that genuinely needs sync (rare). Returns `null` on
 * any failure so the caller can treat it as a boolean-like gate. Never
 * throws.
 */
export function runOpenClawSync(
  args: readonly string[],
  options: RunOpenClawSyncOptions = {},
): { stdout: string; stderr: string } | null {
  const mode = options.mode ?? resolveOpenClawMode();
  ensureOpenClawStateDirReady(mode);
  const argv = buildOpenClawArgs(args, mode);
  const env = buildOpenClawEnv(mode);
  const cliPath = options.cliPath ?? "openclaw";
  const timeoutMs = options.timeoutMs ?? 5_000;

  try {
    const stdout = execFileSync(cliPath, argv, {
      env,
      cwd: options.cwd,
      timeout: timeoutMs,
      stdio: "pipe",
      encoding: "utf8",
    });
    // With encoding: "utf8" the return is a string; without it, Buffer.
    // We force utf8 so callers always get a string.
    return {
      stdout: typeof stdout === "string" ? stdout : String(stdout),
      stderr: "",
    };
  } catch {
    return null;
  }
}

export interface SpawnOpenClawOptions {
  mode?: OpenClawMode;
  cliPath?: string;
  cwd?: string;
  stdio?: StdioOptions;
  /** Detach the child so the parent can exit independently. */
  detached?: boolean;
  /**
   * Extra env vars to merge into the spawned process environment on top of
   * the wrapper-built env. Same semantics as `RunOpenClawOptions.extraEnv`.
   */
  extraEnv?: Record<string, string | undefined>;
}

/**
 * Streaming/long-running spawn for commands like `gateway run` and
 * `gateway start`. Returns the `ChildProcess` so callers can read
 * `child.pid`, pipe stdout/stderr, and call `child.kill(signal)`.
 *
 * This is the ONLY non-captured-output variant of openclaw invocation
 * and the only reason the settings route can stop a gateway by PID
 * instead of `pkill -f openclaw.*gateway`.
 */
export function spawnOpenClaw(
  args: readonly string[],
  options: SpawnOpenClawOptions = {},
): ChildProcess {
  const mode = options.mode ?? resolveOpenClawMode();
  ensureOpenClawStateDirReady(mode);
  const argv = buildOpenClawArgs(args, mode);
  const env = buildOpenClawEnv(mode, options.extraEnv);
  const cliPath = options.cliPath ?? "openclaw";
  return spawn(cliPath, argv, {
    env,
    cwd: options.cwd,
    stdio: options.stdio ?? "pipe",
    detached: options.detached ?? false,
  });
}

// ─── Gateway PID tracking ────────────────────────────────────────────────
// Replaces the `pkill -f "openclaw.*gateway"` shotgun at the prior
// settings route call sites. `spawnOpenClaw` captures `child.pid` and
// writes it to a pidfile inside the state dir (or a tmp scratch dir in
// profile mode); `killGatewayByPid` reads the pidfile and signals that
// single process by PID. No more cross-profile collateral damage.

function gatewayPidProfileSlug(profile: string): string {
  const safeProfile = profile.replace(/[^A-Za-z0-9._-]/g, "_");
  const profileHex = Buffer.from(profile, "utf8").toString("hex");
  return `${safeProfile}-${profileHex}`;
}

function gatewayPidFilePath(mode: OpenClawMode = resolveOpenClawMode()): string {
  if (mode.kind === "state-dir") {
    return path.join(mode.stateDir, "gateway.pid");
  }
  return path.join(
    process.env.TMPDIR ?? "/tmp",
    `openclaw-gateway-${gatewayPidProfileSlug(mode.profile)}.pid`,
  );
}

export function writeGatewayPid(pid: number, mode?: OpenClawMode): void {
  const resolved = mode ?? resolveOpenClawMode();
  ensureOpenClawStateDirReady(resolved);
  const pidFile = gatewayPidFilePath(resolved);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(pid), "utf8");
}

export function readGatewayPid(mode?: OpenClawMode): number | null {
  try {
    const resolved = mode ?? resolveOpenClawMode();
    ensureOpenClawStateDirReady(resolved);
    const raw = fs.readFileSync(gatewayPidFilePath(resolved), "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

export function clearGatewayPid(mode?: OpenClawMode): void {
  try {
    const resolved = mode ?? resolveOpenClawMode();
    ensureOpenClawStateDirReady(resolved);
    fs.unlinkSync(gatewayPidFilePath(resolved));
  } catch {
    // File already gone — nothing to clean up.
  }
}

/**
 * Kill the tracked gateway process by PID. Sends SIGTERM first and, if
 * the process is still alive after `graceMs`, escalates to SIGKILL.
 * Deletes the pidfile on success. Returns true if a signal was
 * delivered to a valid PID, false if no tracked PID or the PID no
 * longer exists.
 */
export async function killGatewayByPid(
  options: { mode?: OpenClawMode; graceMs?: number } = {},
): Promise<boolean> {
  const mode = options.mode ?? resolveOpenClawMode();
  const graceMs = options.graceMs ?? 2_000;
  const pid = readGatewayPid(mode);
  if (pid === null) return false;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // PID is stale — process no longer exists. Clean up and report
    // that no live process was killed.
    clearGatewayPid(mode);
    return false;
  }

  await new Promise((resolve) => setTimeout(resolve, graceMs));

  // Check if still alive (signal 0 is a liveness probe, not a kill).
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }

  if (alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Race: the process exited between the probe and the SIGKILL.
    }
  }

  clearGatewayPid(mode);
  return true;
}
