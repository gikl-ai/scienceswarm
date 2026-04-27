#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolveStandaloneServerPath(cwd = process.cwd()) {
  return path.join(cwd, ".next", "standalone", "server.js");
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function resolveStandaloneServerEnv(env = process.env) {
  return {
    ...env,
    PORT: env.FRONTEND_PORT?.trim() || env.PORT?.trim() || "3001",
    HOSTNAME: env.FRONTEND_HOST?.trim() || env.HOSTNAME?.trim() || "127.0.0.1",
  };
}

export function isStandaloneEntrypoint(
  cliPath = process.argv[1],
  moduleUrl = import.meta.url,
) {
  if (!cliPath) {
    return false;
  }

  return path.resolve(cliPath) === path.resolve(fileURLToPath(moduleUrl));
}

/**
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} [options]
 */
export async function startStandaloneServer(options = {}) {
  const serverPath = resolveStandaloneServerPath(options.cwd);
  if (!existsSync(serverPath)) {
    throw new Error(
      `Standalone server not found at ${serverPath}. Run npm run build:standalone first.`,
    );
  }

  Object.assign(process.env, resolveStandaloneServerEnv(options.env));
  await import(pathToFileURL(serverPath).href);
}

if (isStandaloneEntrypoint()) {
  startStandaloneServer().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Failed to start standalone server.",
    );
    process.exit(1);
  });
}
