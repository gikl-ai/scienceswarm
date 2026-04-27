#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveStandaloneServerPath(cwd = process.cwd()) {
  return path.join(cwd, ".next", "standalone", "server.js");
}

export function resolveStandaloneServerEnv(env = process.env) {
  return {
    ...env,
    PORT: env.FRONTEND_PORT?.trim() || env.PORT?.trim() || "3001",
    HOSTNAME: env.FRONTEND_HOST?.trim() || env.HOSTNAME?.trim() || "127.0.0.1",
  };
}

export async function startStandaloneServer(options = {}) {
  const serverPath = resolveStandaloneServerPath(options.cwd);
  if (!existsSync(serverPath)) {
    throw new Error(
      `Standalone server not found at ${serverPath}. Run npm run build:standalone first.`,
    );
  }

  process.env = resolveStandaloneServerEnv(options.env);
  await import(pathToFileURL(serverPath).href);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  startStandaloneServer().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Failed to start standalone server.",
    );
    process.exit(1);
  });
}
