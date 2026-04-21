// One-time, idempotent auto-migration from `.env.local` to `.env`.
//
// Historical context: earlier ScienceSwarm releases wrote user config to
// `.env.local` (Next.js convention). We've since consolidated on `.env`
// as the single source of truth for server-side config so that the
// dashboard, CLI tools, and docker boot all read from the same file.
//
// This module handles the one-way upgrade at boot: if `.env.local`
// exists, we migrate its contents into `.env` and rename the original
// to a timestamped backup so we don't re-migrate on the next run.
//
// Contract:
//   * Pure: no module-level state. Safe to call concurrently via a
//     sentinel-file check as the idempotency token.
//   * Never throws. All errors are returned as `{ status: "error" }`.
//   * Leaves a visible `.env.local.migrated-<timestamp>` sentinel so
//     (a) the next invocation is a no-op and (b) the user can see what
//     we did and recover the original bytes if they need to.
//   * Logs exactly one `console.warn` per invocation that actually did
//     work. No spam on no-op or already-migrated paths.
//
// Not in scope (yet): un-migrating, cross-filesystem moves, or merging
// files owned by different users. Stage A3b wires this into the boot
// path; stage A3a is just the module + unit tests.

import { promises as fs, readdirSync } from "node:fs";
import * as path from "node:path";

import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
} from "./env-writer";

/**
 * Outcome of a single `migrateEnvLocalOnce` call.
 *
 * `no-op` — nothing to do (no `.env.local` present).
 * `already-migrated` — a sentinel from a prior run was found.
 * `promoted` — `.env.local` existed, `.env` did not; we copied the
 *   file byte-for-byte to `.env` and renamed the original to the
 *   sentinel. `renameError` is present iff the rename step failed
 *   after the `.env` write succeeded.
 * `merged` — both files existed; we merged local entries into `.env`
 *   (local values win on conflict, local-only keys are appended) and
 *   then renamed. `mergedKeys` lists keys that were overwritten — i.e.
 *   keys present in BOTH files where the local value now lives in
 *   `.env`. New-from-local keys are not included there.
 * `error` — we could not even start; surface to the caller.
 */
export type MigrationResult =
  | { status: "no-op"; reason: "no-local-file" }
  | { status: "already-migrated" }
  | { status: "promoted"; renameError?: string }
  | { status: "merged"; mergedKeys: string[]; renameError?: string }
  | { status: "error"; error: string };

const SENTINEL_PREFIX = ".env.local.migrated-";

/**
 * Migrate `<repoRoot>/.env.local` to `<repoRoot>/.env` exactly once.
 *
 * Safe to call on every boot: the sentinel-file check makes repeat
 * calls a no-op. Safe to call concurrently: if two processes race,
 * both may write `.env` (via `writeEnvFileAtomic`, which is
 * rename-based and doesn't corrupt) but only one will succeed at
 * renaming `.env.local` away; the loser sees the sentinel on its
 * next boot and no-ops.
 */
export async function migrateEnvLocalOnce(
  repoRoot: string,
): Promise<MigrationResult> {
  try {
    // 1. Sentinel check first. If any previous run already migrated,
    //    we do nothing — including no re-read of `.env.local`, which
    //    may legitimately exist again if a user recreated one.
    let entries: string[];
    try {
      entries = readdirSync(repoRoot);
    } catch (err) {
      return {
        status: "error",
        error: `readdir(${repoRoot}) failed: ${errMessage(err)}`,
      };
    }
    const hasSentinel = entries.some((entry) =>
      entry.startsWith(SENTINEL_PREFIX),
    );
    if (hasSentinel) {
      return { status: "already-migrated" };
    }

    const localPath = path.join(repoRoot, ".env.local");
    const envPath = path.join(repoRoot, ".env");

    // 2. Does `.env.local` exist? ENOENT is the overwhelmingly common
    //    case once a user has booted once.
    const localExists = await exists(localPath);
    if (!localExists) {
      return { status: "no-op", reason: "no-local-file" };
    }

    // 3. Read local contents. If the file exists but we can't read
    //    it, surface the error — don't silently no-op.
    let localContents: string;
    try {
      localContents = await fs.readFile(localPath, "utf8");
    } catch (err) {
      return {
        status: "error",
        error: `read .env.local failed: ${errMessage(err)}`,
      };
    }

    const envExists = await exists(envPath);

    if (!envExists) {
      // Promote path. `.env` does not exist, so we copy bytes
      // verbatim — preserves every comment, every quote, every
      // ordering decision the user made.
      try {
        await fs.writeFile(envPath, localContents, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (err) {
        return {
          status: "error",
          error: `write .env failed: ${errMessage(err)}`,
        };
      }

      const sentinelPath = buildSentinelPath(repoRoot);
      const renameError = await safeRename(localPath, sentinelPath);
      console.warn(
        `[scienceswarm] migrated .env.local \u2192 .env (backup at ${sentinelPath})`,
      );
      return renameError
        ? { status: "promoted", renameError }
        : { status: "promoted" };
    }

    // 4. Merge path. Both files exist. Apply local entries onto the
    //    `.env` doc via `mergeEnvValues` so that `.env`'s comments
    //    and ordering are preserved while local values win on
    //    conflicts and new-from-local keys are appended.
    let envContents: string;
    try {
      envContents = await fs.readFile(envPath, "utf8");
    } catch (err) {
      return {
        status: "error",
        error: `read .env failed: ${errMessage(err)}`,
      };
    }

    const envDoc = parseEnvFile(envContents);
    const localDoc = parseEnvFile(localContents);

    // Collect all entry key/value pairs from local. Later duplicates
    // of the same key inside `.env.local` win within-file (matches
    // how `mergeEnvValues` collapses duplicates into the first
    // position with the latest value). This is consistent with how
    // dotenv loaders handle the same situation in Node.
    const localUpdates: Record<string, string> = {};
    const localKeysInOrder: string[] = [];
    for (const line of localDoc.lines) {
      if (line.type === "entry") {
        if (!(line.key in localUpdates)) {
          localKeysInOrder.push(line.key);
        }
        localUpdates[line.key] = line.value;
      }
    }

    // Which keys existed in `.env` already? Those are the ones we
    // report in `mergedKeys`. New-from-local keys are appended but
    // aren't "merged" in the overwrite sense.
    const envKeys = new Set<string>();
    for (const line of envDoc.lines) {
      if (line.type === "entry") {
        envKeys.add(line.key);
      }
    }
    const mergedKeys = localKeysInOrder.filter((k) => envKeys.has(k));

    const mergedDoc = mergeEnvValues(envDoc, localUpdates);
    const serialized = serializeEnvDocument(mergedDoc);

    try {
      await writeEnvFileAtomic(envPath, serialized);
    } catch (err) {
      return {
        status: "error",
        error: `write .env failed: ${errMessage(err)}`,
      };
    }

    const sentinelPath = buildSentinelPath(repoRoot);
    const renameError = await safeRename(localPath, sentinelPath);
    console.warn(
      `[scienceswarm] migrated .env.local \u2192 .env (backup at ${sentinelPath})`,
    );
    return renameError
      ? { status: "merged", mergedKeys, renameError }
      : { status: "merged", mergedKeys };
  } catch (err) {
    return { status: "error", error: errMessage(err) };
  }
}

// -----------------------------------------------------------------
// Internals
// -----------------------------------------------------------------

function buildSentinelPath(repoRoot: string): string {
  // Colons are illegal in Windows filenames and annoying to type on
  // any shell. Replace them in the ISO timestamp so the sentinel
  // name is portable and easy to reason about.
  const stamp = new Date().toISOString().replace(/:/g, "-");
  return path.join(repoRoot, `${SENTINEL_PREFIX}${stamp}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    // Other errors (EACCES, EIO, …) are NOT "file absent". Propagate so
    // the top-level try/catch in `migrateEnvLocalOnce` returns a proper
    // `{ status: "error" }` instead of masking I/O problems as a no-op.
    throw err;
  }
}

/**
 * Rename but never throw. Returns `undefined` on success or the
 * error message on failure. Caller decides how to surface it — in
 * our case we set `renameError` on the result so that the `.env`
 * write (which already succeeded) isn't retroactively reported as a
 * failure.
 */
async function safeRename(
  from: string,
  to: string,
): Promise<string | undefined> {
  try {
    await fs.rename(from, to);
    return undefined;
  } catch (err) {
    return errMessage(err);
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
