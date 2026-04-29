import path from "node:path";

import { expandHomeDir } from "@/lib/scienceswarm-paths";

export const SCIENCESWARM_CONFIG_ROOT_ENV = "SCIENCESWARM_CONFIG_ROOT";

/**
 * Root for mutable setup config such as `.env`.
 *
 * In source checkouts this is the repo root (`process.cwd()`). Packaged
 * desktop apps run from a read-only app bundle, so Electron sets
 * `SCIENCESWARM_CONFIG_ROOT` to its writable userData directory before the
 * standalone server starts.
 */
export function resolveSetupConfigRoot(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const configured = env[SCIENCESWARM_CONFIG_ROOT_ENV]?.trim();
  return path.resolve(expandHomeDir(configured || cwd));
}

export function resolveSetupEnvPath(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  return path.join(resolveSetupConfigRoot(env, cwd), ".env");
}
