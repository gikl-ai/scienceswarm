import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Playwright global setup for ScienceSwarm smoke tests.
 *
 * Temp-home ownership (Greptile P1 fix)
 * --------------------------------------
 * The per-run temp directory is now created at module scope inside
 * `playwright.config.ts`, BEFORE `defineConfig` runs. That is the
 * only way `webServer.env.SCIENCESWARM_HOME` / `BRAIN_ROOT` can see
 * the real path, because Playwright evaluates the webServer env
 * block at config-import time, not at globalSetup time.
 *
 * This hook therefore:
 *   1. Reads the temp path from `process.env.E2E_TMP_HOME` (set by
 *      the config).
 *   2. Seeds a tiny Rosalind Franklin / Photo 51 markdown corpus
 *      inside it so the deferred `test.fixme` stretch goal has a
 *      fixture to point at when it's promoted.
 *   3. Writes a JSON breadcrumb so `global-teardown.ts` can find
 *      the directory even if the env var is lost across process
 *      boundaries.
 *
 * It does NOT create the temp directory — that's the config's job,
 * and doing it again here would race the webServer spawn.
 */
export default async function globalSetup(): Promise<void> {
  const tmp = process.env.E2E_TMP_HOME;
  if (!tmp) {
    throw new Error(
      "[e2e] global-setup: E2E_TMP_HOME is not set. This should be " +
        "initialized at module scope in playwright.config.ts before " +
        "globalSetup runs — check that the config still creates the " +
        "temp dir at the top of the file.",
    );
  }

  // Seed the tiny sample corpus. Two files is enough to exercise the
  // "imported N files" UI path once warm-start is wired through the
  // smoke test. Kept deliberately small so the smoke stays under the
  // 120s budget even on a slow CI runner.
  const corpus = join(tmp, "sample-corpus");
  mkdirSync(corpus, { recursive: true });
  writeFileSync(
    join(corpus, "franklin-photo-51.md"),
    [
      "# Photo 51",
      "",
      "Rosalind Franklin's 1952 X-ray diffraction image of DNA.",
      "Photo 51 revealed the helical structure that Watson and Crick",
      "later described in their 1953 Nature paper.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(corpus, "watson-crick.md"),
    [
      "# Watson-Crick structure",
      "",
      "Watson and Crick's 1953 double-helix model of DNA relied on",
      "Rosalind Franklin's Photo 51 diffraction image.",
      "",
    ].join("\n"),
  );

  // Breadcrumb so teardown can find the temp dir even if the
  // environment variable is lost across process boundaries.
  writeFileSync(
    join(tmp, ".e2e-breadcrumb.json"),
    JSON.stringify({ tmp, created_at: new Date().toISOString() }, null, 2),
  );

  // Playwright shows globalSetup console output in its report, and a
  // one-line path breadcrumb is genuinely useful when a smoke run
  // fails and the developer wants to inspect the temp dir.
  console.log(`[e2e] temp home: ${tmp}`);
}
