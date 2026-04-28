import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";

import { getOpenClawPort } from "@/lib/config/ports";
import {
  getScienceSwarmOpenClawConfigPath,
  getScienceSwarmOpenClawStateDir,
} from "@/lib/scienceswarm-paths";
import {
  resolveOpenClawMode,
  type OpenClawMode,
} from "@/lib/openclaw/runner";

export interface OpenClawGatewayAuthStatus {
  configured: boolean;
  configPath: string | null;
  searchedPaths: string[];
}

export class OpenClawGatewayAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenClawGatewayAuthConfigError";
  }
}

function defaultOpenClawConfigPath(): string {
  return path.join(
    process.env.HOME ?? os.homedir(),
    ".openclaw",
    "openclaw.json",
  );
}

function pushUnique(paths: string[], candidate: string): void {
  if (!paths.includes(candidate)) paths.push(candidate);
}

export function getOpenClawGatewayAuthConfigPaths(
  mode: OpenClawMode = resolveOpenClawMode(),
): string[] {
  const paths: string[] = [];

  if (mode.kind === "state-dir") {
    pushUnique(paths, mode.configPath);
    pushUnique(paths, getScienceSwarmOpenClawConfigPath());
  } else {
    // Preserve the existing profile-mode behavior: upstream OpenClaw owns
    // profile config resolution, while the gateway auth token is read from the
    // default profile config used by the gateway process.
    pushUnique(paths, defaultOpenClawConfigPath());
    pushUnique(paths, getScienceSwarmOpenClawConfigPath());
  }

  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOpenClawConfig(
  raw: string,
  configPath: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw) as unknown;
  } catch {
    throw new OpenClawGatewayAuthConfigError(
      `OpenClaw config at ${configPath} is not valid JSON5. Fix or remove it, then retry.`,
    );
  }

  if (!isRecord(parsed)) {
    throw new OpenClawGatewayAuthConfigError(
      `OpenClaw config at ${configPath} must contain a top-level object.`,
    );
  }

  return parsed;
}

function readConfigFromPath(
  configPath: string,
  options: { tolerateInvalid?: boolean } = {},
): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    return parseOpenClawConfig(raw, configPath);
  } catch (error) {
    if (
      options.tolerateInvalid === true &&
      error instanceof OpenClawGatewayAuthConfigError
    ) {
      return null;
    }
    throw error;
  }
}

function tokenFromConfig(config: unknown): string | null {
  if (!isRecord(config)) return null;
  const gateway = config.gateway;
  if (!isRecord(gateway)) return null;
  const auth = gateway.auth;
  if (!isRecord(auth)) return null;
  const token = auth.token;
  return typeof token === "string" && token.trim().length > 0
    ? token.trim()
    : null;
}

function readTokenFromPaths(paths: readonly string[]): {
  token: string | null;
  configPath: string | null;
} {
  for (const configPath of paths) {
    try {
      const config = readConfigFromPath(configPath, { tolerateInvalid: true });
      const token = tokenFromConfig(config);
      if (token) return { token, configPath };
    } catch {
      // Missing, malformed, or unreadable configs are not terminal here. Try
      // the next path and let the caller decide how to surface absence.
    }
  }

  return { token: null, configPath: null };
}

export function getOpenClawGatewayAuthStatus(
  mode: OpenClawMode = resolveOpenClawMode(),
): OpenClawGatewayAuthStatus {
  const searchedPaths = getOpenClawGatewayAuthConfigPaths(mode);
  const result = readTokenFromPaths(searchedPaths);
  return {
    configured: Boolean(result.token),
    configPath: result.configPath,
    searchedPaths,
  };
}

export function hasOpenClawGatewayAuthToken(
  mode: OpenClawMode = resolveOpenClawMode(),
): boolean {
  return getOpenClawGatewayAuthStatus(mode).configured;
}

export function readOpenClawGatewayToken(
  mode: OpenClawMode = resolveOpenClawMode(),
): string {
  const searchedPaths = getOpenClawGatewayAuthConfigPaths(mode);
  const { token } = readTokenFromPaths(searchedPaths);
  if (token) return token;

  throw new Error(
    "Cannot read OpenClaw gateway token. Ensure the gateway is installed and " +
      "openclaw.json contains gateway.auth.token. " +
      `Searched: ${searchedPaths.join(", ")}`,
  );
}

export function ensureOpenClawGatewayAuthConfig(options: {
  mode?: OpenClawMode;
  port?: number;
} = {}): void {
  const mode = options.mode ?? resolveOpenClawMode();
  if (mode.kind !== "state-dir") return;

  const stateDir = mode.stateDir || getScienceSwarmOpenClawStateDir();
  const configPath = mode.configPath;
  fs.mkdirSync(stateDir, { recursive: true });

  const config = readConfigFromPath(configPath) ?? {};

  const existingGateway = isRecord(config.gateway) ? config.gateway : {};
  const existingAuth = isRecord(existingGateway.auth)
    ? existingGateway.auth
    : {};
  const existingToken = existingAuth.token;
  const token =
    typeof existingToken === "string" && existingToken.trim().length > 0
      ? existingToken.trim()
      : randomBytes(32).toString("hex");

  config.gateway = {
    ...existingGateway,
    mode: "local",
    port: options.port ?? getOpenClawPort(),
    auth: {
      ...existingAuth,
      mode: typeof existingAuth.mode === "string" ? existingAuth.mode : "token",
      token,
    },
  };

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
