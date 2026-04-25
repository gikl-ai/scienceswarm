import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const SCIENCESWARM_REPO_ROOT_ENV = "SCIENCESWARM_REPO_ROOT";
export const SCIENCESWARM_GBRAIN_BIN_ENV = "SCIENCESWARM_GBRAIN_BIN";

export interface ScienceSwarmGbrainPackageState {
  repoRoot: string;
  lockfilePath: string;
  packagePath: string;
  expectedVersion: string | null;
  expectedResolved: string | null;
  installedVersion: string | null;
  installedName: string | null;
  binPath: string;
  binExists: boolean;
  inSync: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function resolveScienceSwarmRepoRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured = env[SCIENCESWARM_REPO_ROOT_ENV]?.trim();
  return path.resolve(configured || cwd);
}

export function scienceSwarmNodeBinDir(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), "node_modules", ".bin");
}

export function scienceSwarmGbrainBin(repoRoot: string): string {
  return path.join(
    scienceSwarmNodeBinDir(repoRoot),
    process.platform === "win32" ? "gbrain.cmd" : "gbrain",
  );
}

function pathEnvKey(env: NodeJS.ProcessEnv): "PATH" | "Path" {
  return env.PATH === undefined && env.Path !== undefined ? "Path" : "PATH";
}

export function prependPathEntries(
  env: NodeJS.ProcessEnv,
  entries: readonly string[],
): NodeJS.ProcessEnv {
  const key = pathEnvKey(env);
  const current = env[key] ?? "";
  const existing = new Set(current.split(path.delimiter).filter(Boolean));
  const prepend = entries
    .map((entry) => path.resolve(entry))
    .filter((entry) => !existing.has(entry));
  if (prepend.length === 0) return env;
  const nextPath = [...prepend, current].filter(Boolean).join(path.delimiter);

  return {
    ...env,
    [key]: nextPath,
    PATH: nextPath,
  };
}

export function buildScienceSwarmGbrainEnv(
  env: NodeJS.ProcessEnv,
  repoRoot = resolveScienceSwarmRepoRoot(env),
): NodeJS.ProcessEnv {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const binPath = scienceSwarmGbrainBin(resolvedRepoRoot);
  return {
    ...prependPathEntries(env, [scienceSwarmNodeBinDir(resolvedRepoRoot)]),
    [SCIENCESWARM_REPO_ROOT_ENV]: resolvedRepoRoot,
    [SCIENCESWARM_GBRAIN_BIN_ENV]: binPath,
    GBRAIN_BIN: binPath,
  };
}

export function readScienceSwarmGbrainPackageState(
  repoRoot = resolveScienceSwarmRepoRoot(),
): ScienceSwarmGbrainPackageState {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const lockfilePath = path.join(resolvedRepoRoot, "package-lock.json");
  const packagePath = path.join(
    resolvedRepoRoot,
    "node_modules",
    "gbrain",
    "package.json",
  );
  const binPath = scienceSwarmGbrainBin(resolvedRepoRoot);

  let expectedVersion: string | null = null;
  let expectedResolved: string | null = null;
  try {
    const lock = readJsonFile(lockfilePath);
    const packages = isRecord(lock) ? lock.packages : null;
    const gbrain = isRecord(packages)
      ? packages["node_modules/gbrain"]
      : null;
    if (isRecord(gbrain)) {
      expectedVersion = stringField(gbrain.version);
      expectedResolved = stringField(gbrain.resolved);
    }
  } catch {
    expectedVersion = null;
    expectedResolved = null;
  }

  let installedVersion: string | null = null;
  let installedName: string | null = null;
  try {
    const pkg = readJsonFile(packagePath);
    if (isRecord(pkg)) {
      installedVersion = stringField(pkg.version);
      installedName = stringField(pkg.name);
    }
  } catch {
    installedVersion = null;
    installedName = null;
  }

  const binExists = existsSync(binPath);

  return {
    repoRoot: resolvedRepoRoot,
    lockfilePath,
    packagePath,
    expectedVersion,
    expectedResolved,
    installedVersion,
    installedName,
    binPath,
    binExists,
    inSync: Boolean(
      expectedVersion
        && installedVersion
        && expectedVersion === installedVersion
        && installedName === "gbrain"
        && binExists,
    ),
  };
}
