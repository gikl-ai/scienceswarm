// Detection helper for the local OpenClaw CLI.
//
// This module is the single source of truth for "is openclaw
// installed / configured / running?" probes so both
// `GET /api/settings/openclaw` and `GET /api/setup/status` render
// consistent answers without either route reimplementing the CLI
// parsing. Keep this module dependency-light: no NextResponse, no
// route helpers — just Node APIs and dynamic imports so the
// consumers stay simple.
//
// All probes swallow errors and return conservative defaults ("not
// installed / not configured / not running") rather than throwing.
// The /setup page in particular treats these fields as optional
// diagnostics; a failure to detect OpenClaw must never break the
// main readiness probe.
//
// Why `execFile("which", ...)` instead of `process.env.PATH` parsing:
// the CLI can be installed into user-level bin dirs that a CI worker
// doesn't know about, and matching `which`'s resolution behavior
// mirrors what a human would see from the shell.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runOpenClaw } from "@/lib/openclaw/runner";
import { isOpenClawGatewayReachable } from "@/lib/openclaw/reachability";
import { getOpenClawGatewayAuthStatus } from "@/lib/openclaw/gateway-auth";

const exec = promisify(execFile);

export interface OpenClawFullStatus {
  installed: boolean;
  configured: boolean;
  running: boolean;
  version: string | null;
  model: string | null;
  configPath: string | null;
  source: "system" | "external" | "none";
  steps: {
    install: boolean;
    configure: boolean;
    start: boolean;
  };
}

/**
 * Minimal summary exposed through `GET /api/setup/status`. The
 * `/setup` page only needs the three booleans to drive its
 * install/configure/start affordances; surfacing the CLI version or
 * config path here would leak information the page never uses.
 */
export interface OpenClawSetupSummary {
  installed: boolean;
  configured: boolean;
  running: boolean;
}

async function hasCmd(name: string): Promise<boolean> {
  try {
    await exec("which", [name], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function getOpenClawVersion(): Promise<string | null> {
  const result = await runOpenClaw(["--version"], { timeoutMs: 12000 });
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

async function getOpenClawConfigPath(): Promise<string | null> {
  const result = await runOpenClaw(["config", "file"], { timeoutMs: 12000 });
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

async function getOpenClawModel(): Promise<string | null> {
  const result = await runOpenClaw(
    ["config", "get", "agents.defaults.model.primary"],
    { timeoutMs: 12000 },
  );
  if (!result.ok) return null;
  return result.stdout.trim() || null;
}

async function isOpenClawRunning(): Promise<boolean> {
  const reachable = await isOpenClawGatewayReachable();
  const auth = getOpenClawGatewayAuthStatus();
  return reachable && auth.configured;
}

/**
 * Full status shape consumed by `GET /api/settings/openclaw`.
 */
export async function getOpenClawStatus(): Promise<OpenClawFullStatus> {
  const auth = getOpenClawGatewayAuthStatus();
  const [installed, running] = await Promise.all([
    hasCmd("openclaw"),
    isOpenClawRunning(),
  ]);

  if (!installed && !running) {
    return {
      installed: false,
      configured: false,
      running: false,
      version: null,
      model: null,
      configPath: null,
      source: "none",
      steps: {
        install: false,
        configure: false,
        start: false,
      },
    };
  }

  const [version, model, configPath] = installed
    ? await Promise.all([
      getOpenClawVersion(),
      getOpenClawModel(),
      getOpenClawConfigPath(),
    ])
    : [null, null, null];

  const configured = auth.configured && Boolean(model || running);

  return {
    installed: true,
    configured,
    running,
    version,
    model,
    configPath,
    source: installed ? "system" : "external",
    steps: {
      install: true,
      configure: configured,
      start: running,
    },
  };
}

/**
 * Thin projection of `getOpenClawStatus` for the /setup page. Errors
 * bubble up to the caller so the status route can downgrade the whole
 * block to `undefined` rather than pretending OpenClaw is definitively
 * "not installed" when a probe crashed.
 */
export async function getOpenClawSetupSummary(): Promise<OpenClawSetupSummary> {
  const full = await getOpenClawStatus();
  return {
    installed: full.installed,
    configured: full.configured,
    running: full.running,
  };
}
