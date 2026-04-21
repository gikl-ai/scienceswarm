import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Playwright configuration for ScienceSwarm end-to-end tests.
 *
 * Scope:
 *   - Drive the scientist happy path through the real Next.js app and
 *     the real gbrain-backed API routes.
 *   - Kept deliberately narrow for the first landing: Chromium only,
 *     one test file, no CI matrix sprawl.
 *
 * Glob discipline:
 *   - `testMatch: "**\/*.spec.ts"` so we never collide with the
 *     legacy `tests/e2e/*.test.ts` vitest suites that live under the
 *     same directory. vitest.config.ts mirrors this split from the
 *     other side (excludes `tests/e2e/**\/*.spec.ts`).
 *
 * Dev server:
 *   - Managed here via `webServer` so individual specs never spawn
 *     their own Next.js process.
 *   - Pinned to `FRONTEND_PORT=3456` because the project's `npm run
 *     dev` picks its port from `scripts/print-port.ts`, which honors
 *     `FRONTEND_PORT` first (see `src/lib/config/ports.ts`).
 *   - `reuseExistingServer` is on for local iteration but off in CI,
 *     where we always want a fresh process with a fresh temp home.
 *
 * Temp home — module-scope initialization (Greptile P1 fix)
 * ---------------------------------------------------------
 *   Playwright evaluates `webServer.env` at config-import time. That
 *   is BEFORE `globalSetup` runs, so if the temp directory were
 *   created inside `global-setup.ts`, the dev server would spawn
 *   with a stale `process.env.E2E_TMP_HOME` snapshot (or the
 *   hardcoded fallback) and never see the seeded sample corpus.
 *
 *   Fix: create the temp directory at module scope here, BEFORE
 *   `defineConfig` runs. We also write it back onto `process.env`
 *   so `global-setup.ts` can pick it up and do its fixture-seeding
 *   work against the same path, and so individual specs can read
 *   `process.env.E2E_TMP_HOME` if they need to.
 *
 *   `global-setup.ts` now only seeds the corpus; `global-teardown.ts`
 *   still removes the directory at the end of the run.
 */
const PORT = Number(process.env.E2E_PORT ?? 3456);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

// Module-scope initialization — runs once, synchronously, before
// `defineConfig` is called. Honors an existing `E2E_TMP_HOME` if the
// caller (e.g. a wrapping CI script) has already prepared one; falls
// back to a fresh `mkdtemp` otherwise.
const E2E_TMP_HOME =
  process.env.E2E_TMP_HOME ?? mkdtempSync(join(tmpdir(), "scienceswarm-e2e-"));
process.env.E2E_TMP_HOME = E2E_TMP_HOME;
const BRAIN_ROOT = join(E2E_TMP_HOME, "brain");
mkdirSync(BRAIN_ROOT, { recursive: true });

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  // A whole-file budget large enough to cover cold Next.js route
  // compilation plus the gbrain installer on a slow CI runner. Per-
  // expect timeouts still default to 5s.
  timeout: 120_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Next.js reads `PORT` / `FRONTEND_PORT` through print-port.ts.
    // We force `FRONTEND_PORT` so the app binds to a deterministic
    // port we can point Playwright at, regardless of what the
    // developer normally runs on.
    command: "npm run dev",
    url: BASE_URL,
    // Next.js dev compile on a cold cache can run 30–60s; keep the
    // ceiling generous so CI never races the compiler.
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Forward the current process env so the dev server keeps
      // whatever the CI runner has already set up (PATH, NODE
      // flags, etc.). Our explicit overrides below take precedence
      // because the spread happens first.
      ...(process.env as Record<string, string>),
      FRONTEND_PORT: String(PORT),
      PORT: String(PORT),
      // Consumed by src/lib/setup/gbrain-installer.ts and every write
      // path. Decision 3A — attribution is non-optional.
      SCIENCESWARM_USER_HANDLE: "smoke-test",
      // Point the app at the per-run temp directory created at
      // module scope above. These are guaranteed to exist by the
      // `mkdtempSync` + `mkdirSync` calls at the top of this file,
      // so there is no hardcoded fallback path — a failure to
      // create the dir surfaces immediately as a config error.
      SCIENCESWARM_HOME: E2E_TMP_HOME,
      SCIENCESWARM_DIR: E2E_TMP_HOME,
      BRAIN_ROOT,
      // Keep the radar runner off during smoke runs — the dashboard
      // stale-chip flow is a Spec 4 stretch goal; base smoke just
      // asserts the API surface responds.
      ENABLE_RADAR_RUNNER: "false",
      // Don't inherit a real OpenAI key into the test process. The
      // smoke flow never hits a paid LLM; anything that does must
      // be behind an explicit opt-in.
      OPENAI_API_KEY: "",
    },
  },
});
