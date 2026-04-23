/**
 * gbrain installer library.
 *
 * Phase A Lane 1 of the ScienceSwarm -> gbrain pivot. This module is
 * the single source of truth for local research-store initialization: it
 * verifies prerequisites, materializes `~/.scienceswarm/brain/` as a
 * git repo, runs gbrain's PGLite init via the package's own engine
 * factory, optionally seeds an ScienceSwarm-flavored RESOLVER.md, and
 * persists `BRAIN_ROOT=<dir>` into `.env`.
 *
 * Why a library, not a script?
 *
 *   * The /setup page calls this through a thin API route. The route
 *     wants to stream progress events back to the browser. A function
 *     that yields events is much easier to wire into a stream than a
 *     subprocess that prints to stdout.
 *   * Tests can run the installer in-process against an injected
 *     fake filesystem / fake bun checker / fake gbrain init, so the
 *     full happy-path and error taxonomy can be exercised without
 *     touching the real machine.
 *   * `scripts/install-gbrain.ts` is a thin CLI wrapper around this
 *     library (so a user typing `npm run install:gbrain` still works,
 *     and the `.sh` shim still has something to exec).
 *
 * Design constraints from the spec:
 *
 *   1. Verify prerequisites: bun, git, node, network, $HOME write,
 *      target dir writable.
 *   2. Offer to install bun via the official curl-pipe-bash if missing.
 *      Prompt-driven — the library never installs without consent.
 *   3. Create `~/.scienceswarm/brain/`, git-init it, run `gbrain init`
 *      against it via library import (NOT shell out — gbrain is a
 *      package.json dep at a pinned commit).
 *   4. Write `BRAIN_ROOT=$HOME/.scienceswarm/brain` into `.env` using
 *      the existing env-writer helpers (no duplicate writers).
 *   5. Return structured progress events the /setup UI can render.
 *   6. Five error taxonomy cases must each be detected explicitly,
 *      surface a clear message, and suggest a recovery path.
 *   7. User attribution: never default to "User". When we touch
 *      attributed surfaces, throw loudly if `SCIENCESWARM_USER_HANDLE`
 *      is missing. The installer itself does not write attributed
 *      pages, but the library exports a `getCurrentUserHandle()`
 *      helper so callers can fail-fast in the same shape.
 *
 * Coordination: the library is intentionally pure. All side effects
 * (filesystem, child_process, OS detection) come in via the
 * `InstallerEnvironment` argument so the same code path is exercised
 * by the tests and the production runtime.
 */

import * as path from "node:path";
import { readFileSync } from "node:fs";

import { loadBrainPreset } from "@/brain/presets";
import {
  BRAIN_PRESET_ENV_KEY,
  type BrainPresetId,
  normalizeBrainPreset,
} from "@/brain/presets/types";
import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  type EnvDocument,
} from "./env-writer";

// -----------------------------------------------------------------
// Public types
// -----------------------------------------------------------------

/**
 * A single failure mode the installer can detect. The five values
 * here are the spec-mandated taxonomy. A concrete `code` lets the UI
 * pick a recovery affordance (auto-install bun, open the proxy docs,
 * suggest an alternate path) without having to string-match a message.
 */
export type InstallErrorCode =
  | "bun-missing"
  | "git-missing"
  | "https-blocked"
  | "home-not-writable"
  | "target-not-writable"
  | "node-missing"
  | "gbrain-init-failed"
  | "env-write-failed"
  | "git-init-failed"
  | "internal";

export interface InstallError {
  code: InstallErrorCode;
  /** Short human-readable message (one sentence, no trailing period optional). */
  message: string;
  /** Concrete recovery path the user can actually act on. */
  recovery: string;
  /** Optional underlying error string for operator debugging. */
  cause?: string;
}

/**
 * Progress event emitted as the installer makes its way through the
 * steps. The /setup UI keeps a list of steps and updates them as the
 * stream lands. `step` is a stable identifier; `status` flips through
 * the lifecycle. `detail` is an optional human-readable note (e.g.
 * the resolved BRAIN_ROOT path, or "skipped — already initialized").
 */
export type InstallStepId =
  | "verify-prerequisites"
  | "ensure-home-writable"
  | "ensure-target-dir"
  | "git-init"
  | "gbrain-init"
  | "seed-resolver"
  | "write-env";

export interface InstallEvent {
  type: "step";
  step: InstallStepId;
  status: "started" | "succeeded" | "skipped" | "failed";
  detail?: string;
  error?: InstallError;
}

export interface InstallSummaryEvent {
  type: "summary";
  status: "ok" | "failed";
  brainRoot?: string;
  error?: InstallError;
}

export type InstallerEvent = InstallEvent | InstallSummaryEvent;

/**
 * Environment seam. Tests inject fakes; production passes
 * `defaultInstallerEnvironment()`. Every external interaction the
 * installer needs has a method here so the tests never need to touch
 * the real disk, the real network, or the real bun installer.
 */
export interface InstallerEnvironment {
  /** Absolute path of the user's home directory. */
  homeDir(): string;
  /** Look up a binary on PATH. Return `null` if missing. */
  which(bin: string): Promise<string | null>;
  /** HEAD a URL to test reachability. Returns true if the request returned a 2xx. */
  canReach(url: string): Promise<boolean>;
  /** Stat a path; returns `null` if it does not exist. */
  stat(filePath: string): Promise<{ isDirectory: boolean } | null>;
  /** Create a directory recursively. */
  mkdir(filePath: string): Promise<void>;
  /** Write a file (utf8). */
  writeFile(filePath: string, contents: string): Promise<void>;
  /**
   * Best-effort delete of a file. Used to clean up the writability
   * sentinel after a successful probe so the brain dir doesn't
   * accumulate `.writable` stubs across runs. Implementations should
   * swallow ENOENT; any other error is logged but never thrown — a
   * failed cleanup must not fail the install.
   */
  unlink(filePath: string): Promise<void>;
  /** Read a file (utf8). Returns `null` on ENOENT. */
  readFile(filePath: string): Promise<string | null>;
  /** Atomic write into `.env`. Wraps the existing env-writer helper. */
  writeEnvFileAtomic(filePath: string, contents: string): Promise<void>;
  /** Initialize the brain dir as a git repo. Throw on failure. */
  gitInit(dir: string): Promise<void>;
  /**
   * Initialize the gbrain database at the given dir. Implementations
   * delegate to gbrain's `createEngine({ engine: 'pglite' })` +
   * `connect({ database_path })` + `initSchema()`. Throwing here
   * surfaces as `gbrain-init-failed` with the inner message attached.
   */
  initGbrain(opts: { databasePath: string }): Promise<void>;
}

export interface InstallOptions {
  /**
   * Repo root used to locate the project `.env` file. Defaults to
   * `process.cwd()` when called from the CLI; the API route passes
   * the resolved repo root explicitly so it works under `next dev`.
   */
  repoRoot: string;
  /**
   * Override the brain root dir. Defaults to
   * `<homeDir>/.scienceswarm/brain`. Set via `BRAIN_ROOT` or
   * `SCIENCESWARM_HOME` environment when called from the CLI.
   */
  brainRoot?: string;
  /** Named brain preset that controls resolver seeding and persisted env state. */
  brainPreset?: BrainPresetId;
  /**
   * If `true` and `bun` is missing, the installer will surface the
   * `bun-missing` error with a `recovery` that names the auto-install
   * command — but it never executes the curl pipe itself. The actual
   * auto-install must be triggered by a separate, user-confirmed
   * action. Spec rule: "Prompt user first — do NOT silently install."
   */
  allowAutoInstallBun?: boolean;
  /**
   * Skip the network reachability check. Used by tests where the
   * sandbox blocks outbound HTTP and we don't want a false-positive
   * `https-blocked` report.
   */
  skipNetworkCheck?: boolean;
}

// -----------------------------------------------------------------
// Public API
// -----------------------------------------------------------------

const DEFAULT_BRAIN_DIRNAME = path.join(".scienceswarm", "brain");
const PGLITE_DBNAME = "brain.pglite";
const ENV_KEY = "BRAIN_ROOT";

/**
 * Run the installer and yield progress events as it goes. The final
 * yield is always a `summary` event with `status: "ok"` or `status:
 * "failed"` so UIs can definitively close the progress card.
 *
 * Idempotency:
 *   * If the target dir already exists, we keep its contents.
 *   * If `.git` is already present, the git-init step is reported
 *     as `skipped`.
 *   * If an initialized PGLite database is already present,
 *     gbrain-init is reported as `skipped` — we do not destroy data.
 *     An empty/stale database directory is not treated as initialized;
 *     gbrain gets a chance to repair/init it.
 *   * `RESOLVER.md` is only written if missing.
 *   * `BRAIN_ROOT` in `.env` is overwritten in place via the existing
 *     `mergeEnvValues` helper (the same path /setup uses elsewhere).
 */
export async function* runInstaller(
  options: InstallOptions,
  env: InstallerEnvironment,
): AsyncGenerator<InstallerEvent, void, unknown> {
  const brainPreset = normalizeBrainPreset(options.brainPreset);
  const brainRoot =
    options.brainRoot ??
    path.join(env.homeDir(), DEFAULT_BRAIN_DIRNAME);

  // -------------------------------------------------------------
  // Step 1: verify prerequisites
  // -------------------------------------------------------------
  yield startStep("verify-prerequisites", `Checking bun, git, node…`);
  const prereqError = await verifyPrerequisites(env, options);
  if (prereqError) {
    yield failStep("verify-prerequisites", prereqError);
    yield summary({ status: "failed", error: prereqError });
    return;
  }
  yield succeedStep("verify-prerequisites");

  // -------------------------------------------------------------
  // Step 2: $HOME writability
  // -------------------------------------------------------------
  yield startStep("ensure-home-writable");
  const homeError = await ensureHomeWritable(env);
  if (homeError) {
    yield failStep("ensure-home-writable", homeError);
    yield summary({ status: "failed", error: homeError });
    return;
  }
  yield succeedStep("ensure-home-writable");

  // -------------------------------------------------------------
  // Step 3: target dir + writability
  // -------------------------------------------------------------
  yield startStep("ensure-target-dir", brainRoot);
  const dirResult = await ensureTargetDir(env, brainRoot);
  if (!dirResult.ok) {
    yield failStep("ensure-target-dir", dirResult.error);
    yield summary({ status: "failed", error: dirResult.error });
    return;
  }
  yield succeedStep(
    "ensure-target-dir",
    dirResult.created ? "created" : "already present",
  );

  // -------------------------------------------------------------
  // Step 4: git init
  // -------------------------------------------------------------
  yield startStep("git-init");
  const gitDirExists = (await env.stat(path.join(brainRoot, ".git"))) != null;
  if (gitDirExists) {
    yield skipStep("git-init", "already a git repo");
  } else {
    try {
      await env.gitInit(brainRoot);
      yield succeedStep("git-init");
    } catch (err) {
      const error: InstallError = {
        code: "git-init-failed",
        message: `Failed to initialize git repo at ${brainRoot}.`,
        recovery: "Check that git is installed and the directory is writable, then re-run install.",
        cause: errMessage(err),
      };
      yield failStep("git-init", error);
      yield summary({ status: "failed", error });
      return;
    }
  }

  // -------------------------------------------------------------
  // Step 5: gbrain init (PGLite)
  // -------------------------------------------------------------
  yield startStep("gbrain-init", "Seeding PGLite + schema…");
  const dbPath = path.join(brainRoot, PGLITE_DBNAME);
  const dbInitialized = await isPgliteDatabaseInitialized(env, dbPath);
  if (dbInitialized) {
    yield skipStep(
      "gbrain-init",
      "PGLite database already present — leaving data intact",
    );
  } else {
    try {
      await env.initGbrain({ databasePath: dbPath });
      yield succeedStep("gbrain-init", dbPath);
    } catch (err) {
      const error: InstallError = {
        code: "gbrain-init-failed",
        message: "gbrain failed to initialize the local PGLite database.",
        recovery:
          "Check the ScienceSwarm server logs for the underlying error. Common fixes: free up disk space; remove a stale brain.pglite directory; re-run with a different BRAIN_ROOT.",
        cause: errMessage(err),
      };
      yield failStep("gbrain-init", error);
      yield summary({ status: "failed", error });
      return;
    }
  }

  // -------------------------------------------------------------
  // Step 6: seed RESOLVER.md (idempotent)
  // -------------------------------------------------------------
  yield startStep("seed-resolver");
  const resolverPath = path.join(brainRoot, "RESOLVER.md");
  if ((await env.stat(resolverPath)) != null) {
    yield skipStep("seed-resolver", "RESOLVER.md already present");
  } else {
    try {
      const preset = loadBrainPreset(brainPreset);
      await env.writeFile(resolverPath, preset.resolverTemplate);
      yield succeedStep("seed-resolver", resolverPath);
    } catch (err) {
      const error: InstallError = {
        code: "internal",
        message: `Could not seed RESOLVER.md for the ${brainPreset} preset.`,
        recovery:
          "Confirm the preset assets exist and are readable, then re-run install. If the problem persists, inspect the installer logs for the underlying asset read error.",
        cause: errMessage(err),
      };
      yield failStep("seed-resolver", error);
      yield summary({ status: "failed", error });
      return;
    }
  }

  // -------------------------------------------------------------
  // Step 7: write BRAIN_ROOT into .env
  // -------------------------------------------------------------
  yield startStep("write-env", "Updating project .env…");
  try {
    await persistBrainRoot(env, options.repoRoot, brainRoot, brainPreset);
    yield succeedStep("write-env", `${ENV_KEY}=${brainRoot}`);
  } catch (err) {
    const error: InstallError = {
      code: "env-write-failed",
      message: "Could not write BRAIN_ROOT into .env.",
      recovery:
        "Check that you can write to the project .env file, then re-run install.",
      cause: errMessage(err),
    };
    yield failStep("write-env", error);
    yield summary({ status: "failed", error });
    return;
  }

  yield summary({ status: "ok", brainRoot });
}

/**
 * Convenience wrapper that drains the generator into a flat array.
 * Used by the CLI and by tests; the API route consumes the generator
 * directly so it can stream events to the browser.
 */
export async function runInstallerToCompletion(
  options: InstallOptions,
  env: InstallerEnvironment,
): Promise<{ events: InstallerEvent[]; ok: boolean }> {
  const events: InstallerEvent[] = [];
  for await (const event of runInstaller(options, env)) {
    events.push(event);
  }
  const last = events[events.length - 1];
  const ok = last?.type === "summary" && last.status === "ok";
  return { events, ok };
}

/**
 * Resolve the "current ScienceSwarm user handle" for write attribution.
 *
 * Spec decision 3A: never default to "User". Read
 * `SCIENCESWARM_USER_HANDLE` from the environment and throw loudly if
 * unset. The installer itself doesn't attribute writes — the brain
 * directory is empty after install — but every downstream code path
 * that *does* write attributed pages should call this helper, and we
 * keep it co-located with the installer so Lane 1 ships one
 * canonical resolver.
 */
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

function readSavedUserHandle(cwd = process.cwd()): string | null {
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

// -----------------------------------------------------------------
// Step internals
// -----------------------------------------------------------------

async function verifyPrerequisites(
  env: InstallerEnvironment,
  options: InstallOptions,
): Promise<InstallError | null> {
  // 1. bun
  const bun = await env.which("bun");
  if (bun == null) {
    // bun's curl|bash installer script unpacks a zip, so `unzip` must
    // be on PATH for it to succeed. Minimal Linux images (Debian
    // slim, Ubuntu cloud base, Alpine) don't always include unzip,
    // which is the #1 reason Phase D cloud-VM probes fail on
    // fresh boxes. Call it out inline so users don't have to find
    // this in bun's own install docs.
    const curlHint =
      "Install from https://bun.sh or run: curl -fsSL https://bun.sh/install | bash." +
      " Note: bun's installer script requires `unzip` — on minimal Linux images install it first via `apt-get install -y unzip` (Ubuntu/Debian) or `yum install -y unzip` (RHEL).";
    return {
      code: "bun-missing",
      message: "bun is required but was not found on PATH.",
      recovery: options.allowAutoInstallBun
        ? curlHint
        : `${curlHint} Then re-run install.`,
    };
  }

  // 2. git
  const git = await env.which("git");
  if (git == null) {
    return {
      code: "git-missing",
      message: "git is required but was not found on PATH.",
      recovery:
        "Install via `brew install git` (macOS) or your platform's package manager, then re-run install.",
    };
  }

  // 3. node — we're already running under Node when the API route
  //    invokes this, but the CLI may be re-launched from a shell that
  //    has a different PATH. Better to verify than to surface a
  //    confusing error halfway through gbrain init.
  const node = await env.which("node");
  if (node == null) {
    return {
      code: "node-missing",
      message: "node was not found on PATH.",
      recovery:
        "Install Node 20 or newer (https://nodejs.org) and ensure `node` is on your PATH.",
    };
  }

  // 4. https reachability — only check bun.sh, the one URL we'd hit
  //    if we needed to install bun. GitHub access is implicit via the
  //    pre-installed package; if `npm install` already worked, the
  //    network was up.
  if (!options.skipNetworkCheck) {
    const reachable = await env.canReach("https://bun.sh/install");
    if (!reachable) {
      return {
        code: "https-blocked",
        message: "Cannot reach https://bun.sh from this machine.",
        recovery:
          "If you're behind a corporate proxy, set HTTPS_PROXY and re-run. Otherwise install bun manually from https://bun.sh and re-run.",
      };
    }
  }

  return null;
}

/**
 * Verify the user can write into `$HOME/.scienceswarm` by touching a
 * sentinel file. Spec mandates this exact failure mode.
 */
async function ensureHomeWritable(
  env: InstallerEnvironment,
): Promise<InstallError | null> {
  const baseDir = path.join(env.homeDir(), ".scienceswarm");
  const sentinel = path.join(baseDir, ".writable");
  try {
    await env.mkdir(baseDir);
    await env.writeFile(sentinel, "ok");
  } catch (err) {
    return {
      code: "home-not-writable",
      message: `Cannot write to ${baseDir}.`,
      recovery:
        "Check the directory's permissions (chmod u+w), or set SCIENCESWARM_HOME to a directory you can write to and re-run.",
      cause: errMessage(err),
    };
  }
  // Clean up the probe sentinel — it served its purpose and we don't
  // want a `.writable` stub sitting in the user's home dir. Cleanup
  // failures are non-fatal: if we could write the file, the dir is
  // writable and the install should proceed.
  await env.unlink(sentinel);
  return null;
}

interface EnsureDirResult {
  ok: true;
  created: boolean;
}
type EnsureDirOutcome = EnsureDirResult | { ok: false; error: InstallError };

/**
 * Ensure the brain dir exists and is writable. Distinct from
 * `ensureHomeWritable` because the user can override BRAIN_ROOT to a
 * path outside `$HOME/.scienceswarm` (e.g. an external drive that's
 * been remounted read-only). We probe the actual target.
 */
async function ensureTargetDir(
  env: InstallerEnvironment,
  brainRoot: string,
): Promise<EnsureDirOutcome> {
  const existing = await env.stat(brainRoot);
  let created = false;
  if (existing == null) {
    try {
      await env.mkdir(brainRoot);
      created = true;
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "target-not-writable",
          message: `Could not create ${brainRoot}.`,
          recovery:
            "Set BRAIN_ROOT to a writable path and re-run install.",
          cause: errMessage(err),
        },
      };
    }
  } else if (!existing.isDirectory) {
    return {
      ok: false,
      error: {
        code: "target-not-writable",
        message: `${brainRoot} exists but is not a directory.`,
        recovery:
          "Move or remove the conflicting file, or set BRAIN_ROOT to a different path.",
      },
    };
  }

  // Probe writability by touching a sentinel inside the target. This
  // catches read-only mounts (SIP, locked external drives) that
  // mkdir won't always reveal up front.
  const sentinel = path.join(brainRoot, ".writable");
  try {
    await env.writeFile(sentinel, "ok");
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "target-not-writable",
        message: `${brainRoot} is read-only or otherwise not writable.`,
        recovery:
          "Set BRAIN_ROOT to a writable path (an unlocked filesystem outside SIP) and re-run install.",
        cause: errMessage(err),
      },
    };
  }
  // Clean up the probe sentinel — leaving a `.writable` stub inside
  // the user's brain dir would be confusing and (worse) git would try
  // to track it on the next gbrain commit. Cleanup failures are
  // non-fatal.
  await env.unlink(sentinel);
  return { ok: true, created };
}

async function isPgliteDatabaseInitialized(
  env: InstallerEnvironment,
  dbPath: string,
): Promise<boolean> {
  const dbStat = await env.stat(dbPath);
  if (dbStat == null || !dbStat.isDirectory) return false;
  return (await env.stat(path.join(dbPath, "PG_VERSION"))) != null;
}

/**
 * Persist `BRAIN_ROOT` into the project `.env`. Reuses the existing
 * env-writer helpers — same atomic-rename, comment-preserving path
 * the /setup POST handler uses, so this never duplicates write logic.
 */
async function persistBrainRoot(
  env: InstallerEnvironment,
  repoRoot: string,
  brainRoot: string,
  brainPreset: BrainPresetId,
): Promise<void> {
  const envPath = path.join(repoRoot, ".env");
  const existing = (await env.readFile(envPath)) ?? "";
  const doc: EnvDocument = parseEnvFile(existing);
  const merged = mergeEnvValues(doc, {
    [ENV_KEY]: brainRoot,
    [BRAIN_PRESET_ENV_KEY]: brainPreset,
  });
  const serialized = serializeEnvDocument(merged);
  await env.writeEnvFileAtomic(envPath, serialized);
}

// -----------------------------------------------------------------
// Event helpers
// -----------------------------------------------------------------

function startStep(step: InstallStepId, detail?: string): InstallEvent {
  return { type: "step", step, status: "started", detail };
}

function succeedStep(step: InstallStepId, detail?: string): InstallEvent {
  return { type: "step", step, status: "succeeded", detail };
}

function skipStep(step: InstallStepId, detail?: string): InstallEvent {
  return { type: "step", step, status: "skipped", detail };
}

function failStep(step: InstallStepId, error: InstallError): InstallEvent {
  return { type: "step", step, status: "failed", error };
}

function summary(opts: {
  status: "ok" | "failed";
  brainRoot?: string;
  error?: InstallError;
}): InstallSummaryEvent {
  return { type: "summary", ...opts };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// -----------------------------------------------------------------
// Default environment (production)
// -----------------------------------------------------------------

/**
 * Production-grade `InstallerEnvironment`. Lazily imports
 * `node:child_process` / `node:fs` / `node:os` so the library stays
 * importable from environments that don't have those modules
 * available (the test harness can replace it wholesale).
 */
export async function defaultInstallerEnvironment(): Promise<InstallerEnvironment> {
  const { promises: fs } = await import("node:fs");
  const os = await import("node:os");
  const childProcess = await import("node:child_process");
  const { writeEnvFileAtomic: writeAtomic } = await import("./env-writer");

  return {
    homeDir() {
      return os.homedir();
    },
    async which(bin: string): Promise<string | null> {
      return new Promise((resolve) => {
        const which = childProcess.spawn(
          process.platform === "win32" ? "where" : "which",
          [bin],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        let out = "";
        which.stdout.on("data", (chunk) => {
          out += chunk.toString("utf8");
        });
        which.on("error", () => resolve(null));
        which.on("close", (code) => {
          if (code === 0 && out.trim().length > 0) {
            resolve(out.split(/\r?\n/)[0]?.trim() ?? null);
          } else {
            resolve(null);
          }
        });
      });
    },
    async canReach(url: string): Promise<boolean> {
      // 10s ceiling so a slow-but-not-blocked network (high-latency
      // proxy, congested link) doesn't leave the "Verify
      // prerequisites" step hanging on the OS-level TCP timeout for
      // 30+ seconds. We translate a timeout into a clean `false` so
      // the caller surfaces the standard `https-blocked` recovery
      // hint, just like a real network failure.
      try {
        const res = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(10_000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    async stat(filePath: string) {
      try {
        const st = await fs.stat(filePath);
        return { isDirectory: st.isDirectory() };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw err;
      }
    },
    async mkdir(filePath: string) {
      await fs.mkdir(filePath, { recursive: true });
    },
    async writeFile(filePath: string, contents: string) {
      await fs.writeFile(filePath, contents, { encoding: "utf8" });
    },
    async unlink(filePath: string) {
      // Best-effort cleanup. Swallow ENOENT (already gone) and any
      // other error — failing to delete a probe sentinel must not
      // fail the install. We do log unexpected errors for debugging.
      try {
        await fs.unlink(filePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          console.warn(
            `gbrain-installer: failed to clean up sentinel ${filePath}: ${errMessage(err)}`,
          );
        }
      }
    },
    async readFile(filePath: string) {
      try {
        return await fs.readFile(filePath, { encoding: "utf8" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw err;
      }
    },
    async writeEnvFileAtomic(filePath: string, contents: string) {
      await writeAtomic(filePath, contents);
    },
    async gitInit(dir: string) {
      await new Promise<void>((resolve, reject) => {
        const proc = childProcess.spawn("git", ["init", "--quiet"], {
          cwd: dir,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        proc.on("error", (err) => reject(err));
        proc.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `git init exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
              ),
            );
          }
        });
      });
    },
    async initGbrain(opts: { databasePath: string }) {
      // ScienceSwarm reaches gbrain's exported `engine-factory`
      // through the shared runtime bridge so there's exactly one place
      // that owns any package/runtime compatibility quirks.
      //
      // The bridge is a `.mjs` file because it predates this module —
      // ts-node / tsx / Next.js bundlers all happily consume it. The
      // `.mjs` file has no TS types, so we cast through a narrow
      // structural shape that captures only the BrainEngine methods
      // we actually call here.
      interface PgLiteEngineLike {
        connect(config: {
          engine: "pglite";
          database_path: string;
        }): Promise<void>;
        initSchema(): Promise<void>;
        disconnect(): Promise<void>;
      }
      interface RuntimeBridge {
        createRuntimeEngine(config: {
          engine: "pglite";
          database_path: string;
        }): Promise<PgLiteEngineLike>;
      }
      const bridge = (await import(
        "../../brain/stores/gbrain-runtime.mjs"
      )) as RuntimeBridge;
      const engine = await bridge.createRuntimeEngine({
        engine: "pglite",
        database_path: opts.databasePath,
      });
      try {
        await engine.connect({
          engine: "pglite",
          database_path: opts.databasePath,
        });
        await engine.initSchema();
      } finally {
        try {
          await engine.disconnect();
        } catch {
          // Non-fatal: even if disconnect throws (e.g. the lock
          // wasn't acquired), the schema we just initialized is
          // already on disk.
        }
      }
    },
  };
}
