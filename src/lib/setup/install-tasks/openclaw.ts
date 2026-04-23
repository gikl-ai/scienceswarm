/**
 * openclaw install task — detects existing install; if missing, runs
 * `npm install -g openclaw`. Never prompts the user. Surfaces failure
 * but does not abort the whole bootstrap (task status becomes failed
 * and the rest of the orchestrator continues — users can still run
 * ScienceSwarm without openclaw, just without Telegram delivery).
 *
 * After the CLI is confirmed present, the task seeds the ScienceSwarm
 * gateway configuration via two `openclaw config set` calls routed
 * through `runOpenClaw`. This keeps every invocation consistent with
 * the state-dir vs profile mode split defined in
 * `src/lib/openclaw/runner.ts`, so a fresh install ends up with a
 * working local loopback gateway on the canonical ScienceSwarm port
 * without any manual step. Config-set failures are reported as
 * warnings and do not fail the whole task — users can still re-run
 * the commands by hand, and the gateway launch path will fall back
 * to the wrapper-resolved defaults.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getOpenClawPort } from "@/lib/config/ports";
import {
  type OpenClawMode,
  resolveOpenClawMode,
  runOpenClaw,
} from "@/lib/openclaw/runner";

import type { InstallTask, TaskYield } from "./types";

// Pinned to a known-good release — avoids a supply-chain footgun where
// a compromised or accidentally broken publish of `latest` would silently
// affect every fresh onboarding. Bump alongside any confirmed OpenClaw
// release audit.
const OPENCLAW_VERSION = "2026.4.14";
const OPENCLAW_PACKAGE = `openclaw@${OPENCLAW_VERSION}`;
// Upstream onboarding is best-effort here: ScienceSwarm owns the
// minimal local gateway config needed to unblock setup. Keep this
// timeout short so a wedged upstream step does not hold first-run
// users on "Connecting your runtime" for minutes.
const OPENCLAW_ONBOARD_TIMEOUT_MS = 15_000;

function hasCli(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(process.platform === "win32" ? "where" : "which", [name], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      resolve(code === 0 ? out.trim().split(/\r?\n/)[0] ?? null : null);
    });
  });
}

function npmInstallGlobal(
  pkg: string,
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("npm", ["install", "-g", pkg], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", (err) => resolve({ ok: false, stderr: String(err) }));
    proc.on("close", (code) => resolve({ ok: code === 0, stderr }));
  });
}

function parseOpenClawVersion(output: string): string | null {
  const match = output.match(/\bOpenClaw\s+(\d{4}\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

async function getInstalledOpenClawVersion(): Promise<string | null> {
  const result = await runOpenClaw(["--version"], { timeoutMs: 5_000 });
  if (!result.ok) return null;
  return parseOpenClawVersion(result.stdout);
}

async function* ensurePinnedOpenClawCli(
  existingPath: string | null,
): AsyncGenerator<TaskYield, string | null, unknown> {
  let cliPath = existingPath;
  let shouldInstall = !cliPath;

  if (cliPath) {
    const version = await getInstalledOpenClawVersion();
    if (version !== OPENCLAW_VERSION) {
      shouldInstall = true;
      yield {
        status: "running",
        detail: version
          ? `Updating OpenClaw ${version} to ${OPENCLAW_VERSION}…`
          : `Updating OpenClaw to ${OPENCLAW_VERSION}…`,
      };
    }
  }

  if (!shouldInstall) return cliPath;

  if (!cliPath) {
    yield {
      status: "running",
      detail: `Installing via npm (-g ${OPENCLAW_PACKAGE})…`,
    };
  }
  const { ok, stderr } = await npmInstallGlobal(OPENCLAW_PACKAGE);
  if (!ok) {
    yield {
      status: "failed",
      error: `npm install -g ${OPENCLAW_PACKAGE} failed. ${stderr.slice(0, 200)}`,
    };
    return null;
  }
  cliPath = await hasCli("openclaw");
  if (!cliPath) {
    yield {
      status: "failed",
      error:
        "openclaw not on PATH after npm install -g. Check your global bin dir.",
    };
    return null;
  }

  const version = await getInstalledOpenClawVersion();
  if (version !== OPENCLAW_VERSION) {
    yield {
      status: "failed",
      error: version
        ? `openclaw resolved to ${version} after installing ${OPENCLAW_PACKAGE}. Check your PATH for a stale binary.`
        : `Could not verify ${OPENCLAW_PACKAGE} after install. Check your PATH for a stale binary.`,
    };
    return null;
  }

  return cliPath;
}

/**
 * Run `openclaw config set <key> <value>` via the wrapper and translate
 * the outcome into a `TaskYield`. A failure becomes a `running` warning
 * event (not `failed`) so the broader install task still reports
 * success — config drift is recoverable and should not block onboarding.
 */
async function* applyProfileGatewayConfig(): AsyncGenerator<TaskYield, void, unknown> {
  const modeResult = await runOpenClaw(
    ["config", "set", "gateway.mode", "local"],
    { timeoutMs: 10_000 },
  );
  if (!modeResult.ok) {
    yield {
      status: "running",
      detail: `Warning: could not set gateway.mode=local. ${modeResult.stderr.slice(0, 200)}`,
    };
  }

  const port = String(getOpenClawPort());
  const portResult = await runOpenClaw(
    ["config", "set", "gateway.port", port],
    { timeoutMs: 10_000 },
  );
  if (!portResult.ok) {
    yield {
      status: "running",
      detail: `Warning: could not set gateway.port=${port}. ${portResult.stderr.slice(0, 200)}`,
    };
  }
}

/**
 * Run OpenClaw's own non-interactive onboarding in ScienceSwarm's state dir.
 *
 * This is intentionally stronger than hand-writing `gateway.mode` and
 * `gateway.port`: upstream onboarding creates the agent workspace, writes
 * bootstrap prompt files, configures gateway auth, sets session defaults, and
 * registers the Ollama provider/plugin shape OpenClaw expects. ScienceSwarm
 * then layers its own Telegram bot token and gemma4:latest default on top in
 * later setup steps.
 */
async function* applyStateDirOnboarding(
  mode: Extract<OpenClawMode, { kind: "state-dir" }>,
): AsyncGenerator<TaskYield, boolean, unknown> {
  if (await stateDirOnboardingExists(mode)) {
    yield {
      status: "running",
      detail: "Using existing OpenClaw workspace and gateway config…",
    };
    return true;
  }

  const port = String(getOpenClawPort());
  const workspace = path.join(mode.stateDir, "workspace");
  yield {
    status: "running",
    detail: "Initializing OpenClaw workspace and gateway config…",
  };

  const result = await runOpenClaw(
    [
      "onboard",
      "--non-interactive",
      "--accept-risk",
      "--mode",
      "local",
      "--auth-choice",
      "ollama",
      "--gateway-bind",
      "loopback",
      "--gateway-port",
      port,
      "--workspace",
      workspace,
      "--skip-channels",
      "--skip-daemon",
      "--skip-skills",
      "--skip-ui",
      "--skip-health",
      "--json",
    ],
    {
      timeoutMs: OPENCLAW_ONBOARD_TIMEOUT_MS,
      extraEnv: { OLLAMA_API_KEY: "ollama-local" },
    },
  );

  if (!result.ok) {
    if (isOpenClawTimeout(result.stderr)) {
      yield {
        status: "running",
        detail:
          "OpenClaw onboarding timed out; writing minimal local gateway config…",
      };
      await writeMinimalStateDirOnboarding({
        mode,
        port: Number(port),
        workspace,
      });
      return true;
    }

    yield {
      status: "failed",
      error: `openclaw onboard failed. ${(result.stderr || result.stdout || `exit ${result.code}`).slice(0, 500)}`,
    };
    return false;
  }

  return true;
}

function isOpenClawTimeout(stderr: string): boolean {
  return /timeout after \d+ms/i.test(stderr);
}

async function writeMinimalStateDirOnboarding(args: {
  mode: Extract<OpenClawMode, { kind: "state-dir" }>;
  port: number;
  workspace: string;
}): Promise<void> {
  await fs.mkdir(args.mode.stateDir, { recursive: true });
  await fs.mkdir(args.workspace, { recursive: true });

  let config: Record<string, unknown> = {};
  let rawConfig: string | null = null;
  try {
    rawConfig = await fs.readFile(args.mode.configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  if (rawConfig) {
    try {
      config = JSON.parse(rawConfig) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }

  const existingGateway = config.gateway && typeof config.gateway === "object"
    ? (config.gateway as Record<string, unknown>)
    : {};
  const existingAuth = existingGateway.auth && typeof existingGateway.auth === "object"
    ? (existingGateway.auth as Record<string, unknown>)
    : null;

  config.gateway = {
    ...existingGateway,
    mode: "local",
    port: args.port,
    auth: existingAuth ?? {
      mode: "token",
      token: randomBytes(32).toString("hex"),
    },
  };

  await fs.writeFile(args.mode.configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function stateDirOnboardingExists(
  mode: Extract<OpenClawMode, { kind: "state-dir" }>,
): Promise<boolean> {
  let rawConfig: string;
  try {
    rawConfig = await fs.readFile(mode.configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return false;
  }

  const config = parsed as {
    gateway?: { mode?: unknown; port?: unknown; auth?: unknown };
  };
  const gateway = config.gateway;
  if (
    !gateway ||
    gateway.mode !== "local" ||
    gateway.port !== getOpenClawPort() ||
    typeof gateway.auth !== "object" ||
    gateway.auth === null
  ) {
    return false;
  }

  try {
    const workspace = await fs.stat(path.join(mode.stateDir, "workspace"));
    return workspace.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function* initializeOpenClawProfile(): AsyncGenerator<
  TaskYield,
  boolean,
  unknown
> {
  const mode = resolveOpenClawMode();
  if (mode.kind === "state-dir") {
    return yield* applyStateDirOnboarding(mode);
  }

  // Existing named profiles are user-managed. Keep the legacy lightweight
  // gateway config seeding, but do not run `onboard --reset` or rewrite their
  // workspace/secrets from ScienceSwarm setup.
  yield* applyProfileGatewayConfig();
  return true;
}

export const openclawTask: InstallTask = {
  id: "openclaw",
  async *run() {
    yield { status: "running", detail: "Checking for existing openclaw install…" };
    const existing = await hasCli("openclaw");
    const cliPath = yield* ensurePinnedOpenClawCli(existing);
    if (!cliPath) return;

    const initialized = yield* initializeOpenClawProfile();
    if (!initialized) return;

    if (existing) {
      yield {
        status: "succeeded",
        detail: "OpenClaw runtime is ready for this ScienceSwarm workspace.",
      };
      return;
    }

    yield {
      status: "succeeded",
      detail: "OpenClaw runtime was installed and configured for this ScienceSwarm workspace.",
    };
  },
};
