import * as path from "node:path";
import { readFileSync } from "node:fs";

import { parseEnvFile } from "@/lib/setup/env-writer";
import { resolveSetupConfigRoot } from "@/lib/setup/config-root";

export function getCurrentUserHandle(
  envSource: Record<string, string | undefined> = process.env,
  options: {
    cwd?: string;
    includeSavedEnvFallback?: boolean;
  } = {},
): string {
  const handle = resolveCurrentUserHandle(envSource, options);
  if (handle) {
    return handle;
  }
  throw new Error(
    "SCIENCESWARM_USER_HANDLE is not set. " +
      "Every brain write needs a real author handle — set SCIENCESWARM_USER_HANDLE in your .env " +
      "(e.g. SCIENCESWARM_USER_HANDLE=@yourname) before running this operation.",
  );
}

function resolveCurrentUserHandle(
  envSource: Record<string, string | undefined>,
  options: {
    cwd?: string;
    includeSavedEnvFallback?: boolean;
  },
): string | null {
  const configuredHandle = envSource.SCIENCESWARM_USER_HANDLE?.trim();
  if (configuredHandle) {
    return configuredHandle;
  }

  const shouldCheckSavedEnv =
    options.includeSavedEnvFallback ?? envSource === process.env;
  if (!shouldCheckSavedEnv) {
    return null;
  }

  const savedHandle = readSavedUserHandle(options.cwd);
  return savedHandle?.trim() || null;
}

function readSavedUserHandle(cwd = resolveSetupConfigRoot()): string | null {
  try {
    const envPath = path.join(cwd, ".env");
    const contents = readFileSync(envPath, "utf8");
    const doc = parseEnvFile(contents);
    for (const line of doc.lines) {
      if (line.type === "entry" && line.key === "SCIENCESWARM_USER_HANDLE") {
        const value = line.value.trim();
        return value || null;
      }
    }
  } catch {
    return null;
  }
  return null;
}
