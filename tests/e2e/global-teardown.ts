import { rmSync } from "node:fs";

/**
 * Playwright global teardown — remove the temp home created in
 * `global-setup.ts` so repeated smoke runs don't accumulate stale
 * PGLite databases under `$TMPDIR`.
 *
 * We deliberately swallow removal errors: if PGLite's WAL files are
 * still being flushed as Next.js shuts down, the directory removal
 * will race and throw. That's harmless — the OS will clean up
 * `$TMPDIR` on its own, and we'd rather the teardown always return
 * cleanly than fail a green test run on a janitorial error.
 */
export default async function globalTeardown(): Promise<void> {
  const tmp = process.env.E2E_TMP_HOME;
  if (!tmp) return;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    // Surfacing the failure in the Playwright report makes future
    // race diagnosis easier.
    console.warn(`[e2e] failed to remove temp home ${tmp}:`, err);
  }
}
