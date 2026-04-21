import os from "node:os";
import path from "node:path";

function assertProjectSlug(projectSlug: string): string {
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error("Invalid project slug");
  }
  return projectSlug;
}

export function expandHomeDir(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolveConfiguredPath(input?: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return path.resolve(expandHomeDir(trimmed));
}

export function getScienceSwarmDataRoot(): string {
  return (
    resolveConfiguredPath(process.env.SCIENCESWARM_DIR) ??
    path.join(os.homedir(), ".scienceswarm")
  );
}

export function getScienceSwarmProjectsRoot(): string {
  return path.join(getScienceSwarmDataRoot(), "projects");
}

export function getScienceSwarmProjectRoot(projectSlug: string): string {
  return path.join(getScienceSwarmProjectsRoot(), assertProjectSlug(projectSlug));
}

export function getScienceSwarmProjectBrainRoot(projectSlug: string): string {
  return path.join(getScienceSwarmProjectRoot(projectSlug), ".brain");
}

export function getScienceSwarmProjectBrainWikiRoot(projectSlug: string): string {
  return path.join(getScienceSwarmProjectBrainRoot(projectSlug), "wiki");
}

export function getScienceSwarmProjectBrainStateRoot(projectSlug: string): string {
  return path.join(getScienceSwarmProjectBrainRoot(projectSlug), "state");
}

export function getScienceSwarmWorkspaceRoot(): string {
  return path.join(getScienceSwarmDataRoot(), "workspace");
}

export function getScienceSwarmBrainRoot(): string {
  // Respect an explicit BRAIN_ROOT override first (users may mount
  // the brain on an external drive independent of SCIENCESWARM_DIR).
  return (
    resolveConfiguredPath(process.env.BRAIN_ROOT) ??
    path.join(getScienceSwarmDataRoot(), "brain")
  );
}

export function getScienceSwarmStateRoot(): string {
  return path.join(getScienceSwarmBrainRoot(), "state");
}

/**
 * Directory that holds the Telegram session file used by the
 * simple-onboarding creature bot flow. One file per install, mode 0600.
 */
export function getScienceSwarmTelegramRoot(): string {
  return path.join(getScienceSwarmDataRoot(), "telegram");
}

export function getScienceSwarmTelegramSessionPath(): string {
  return path.join(getScienceSwarmTelegramRoot(), "session");
}

// OpenClaw state-dir mode lives under $SCIENCESWARM_DIR/openclaw so every
// ScienceSwarm-managed dotdir is a child of ~/.scienceswarm. Upstream OpenClaw
// reads OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH at process start; see
// src/lib/openclaw/runner.ts for the wrapper that exports those vars.
export function getScienceSwarmOpenClawStateDir(): string {
  return path.join(getScienceSwarmDataRoot(), "openclaw");
}

export function getScienceSwarmOpenClawConfigPath(): string {
  return path.join(getScienceSwarmOpenClawStateDir(), "openclaw.json");
}
