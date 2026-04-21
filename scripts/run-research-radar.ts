#!/usr/bin/env npx tsx
/**
 * scripts/run-research-radar.ts — standalone entry for the
 * research-radar gbrain skill.
 *
 * Phase C Lane 1 of the gbrain pivot. The body of the runner lives in
 * `src/lib/radar/skill-runner.ts` so the same code path is shared by:
 *
 *   1. This CLI (run via `npm run radar:run` or directly via `npx tsx`).
 *   2. ScienceSwarm's host scheduler in production — it spawns this script
 *      every N minutes from start.sh (default 30, override via
 *      `SCIENCESWARM_RADAR_INTERVAL_MINUTES`).
 *   3. The unit tests in `tests/lib/radar/skill-runner.test.ts`, which
 *      inject a fake `SkillRunnerEnvironment` so they can exercise the
 *      full happy path, the LLM-retry path, and the missing-handle
 *      failure path without touching disk or the network.
 *
 * The wrapper itself is intentionally tiny: parse a `--dry-run` flag,
 * resolve the production environment, call the shared body, format the
 * result as a single JSON line on stdout, and translate the result
 * into a process exit code.
 *
 * Why a separate process (decision 1A from the spec):
 *   The radar runs LLM calls + network fetches that can take minutes
 *   per concept. Running it inside Next.js means a hung call eats a
 *   request handler slot and a crash takes the dashboard down with it.
 *   Spawning it as its own node process is the simplest fix that lets
 *   the cron crash freely without touching the dashboard.
 *
 * Exit codes:
 *   0 — clean run (no errors, including the empty-radar success case).
 *   1 — fatal startup error (missing SCIENCESWARM_USER_HANDLE, missing
 *       BRAIN_ROOT, engine open failure). The caller should NOT try to
 *       interpret this as "skill ran but no work" — the freshness
 *       pointer was not written.
 *   2 — partial run (some concepts errored mid-write but the freshness
 *       pointer WAS written and reflects the partial state).
 */

import {
  defaultRunnerEnvironment,
  runResearchRadarSkill,
  type SkillRunnerOptions,
} from "../src/lib/radar/skill-runner";

interface CliOptions extends SkillRunnerOptions {
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { json: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--no-json") {
      // Emit a short human-readable line on stdout instead of JSON.
      // The cron harness leaves this off because it expects the
      // machine-parseable JSON; humans running `npm run radar:run`
      // by hand can pass `--no-json` for a friendlier summary.
      opts.json = false;
    } else if (arg === "--brain-root") {
      const next = argv[++i];
      if (!next) {
        process.stderr.write(
          "research-radar: --brain-root requires a path argument\n",
        );
        process.exit(1);
      }
      opts.brainRoot = next;
    } else if (arg === "--llm-retries") {
      const next = argv[++i];
      const n = Number.parseInt(next ?? "", 10);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(
          `research-radar: --llm-retries requires a non-negative integer (got '${next ?? ""}')\n`,
        );
        process.exit(1);
      }
      opts.llmRetries = n;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  return opts;
}

function printUsage(): void {
  // Use process.stdout.write rather than console.log so the help
  // output stays out of the JSON-on-stdout contract the cron harness
  // depends on (it's only ever printed in response to --help, but the
  // discipline is worth keeping).
  process.stdout.write(
    [
      "Usage: npx tsx scripts/run-research-radar.ts [options]",
      "",
      "Options:",
      "  --dry-run            Run the pipeline but do not write the last-run pointer.",
      "  --brain-root PATH    Override BRAIN_ROOT for this invocation.",
      "  --llm-retries N      Max LLM retries per concept (default 1).",
      "  --no-json            Emit a human-readable summary instead of JSON. Default is JSON.",
      "  -h, --help           Show this help and exit 0.",
      "",
      "Environment:",
      "  SCIENCESWARM_USER_HANDLE   Required. Author handle for brain writes.",
      "  BRAIN_ROOT                Required (or use --brain-root).",
      "  SCIENCESWARM_RADAR_INTERVAL_MINUTES  Default 30. Used for stale detection.",
      "",
      "Exit codes:",
      "  0   Clean run.",
      "  1   Fatal startup error (no last-run pointer written).",
      "  2   Partial run (some concepts errored; last-run pointer written).",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));

  let env;
  try {
    env = await defaultRunnerEnvironment();
  } catch (err) {
    process.stderr.write(
      `research-radar: failed to build runner environment: ${errMessage(err)}\n`,
    );
    return 1;
  }

  let result;
  try {
    result = await runResearchRadarSkill(env, opts);
  } catch (err) {
    process.stderr.write(`research-radar: fatal: ${errMessage(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    return 1;
  }

  // Emit a single JSON line summary on stdout. The cron harness pipes
  // this into observability; a single line means a single log row.
  // `--no-json` swaps to a short human-readable line for interactive
  // debugging — the default stays JSON because the cron harness
  // depends on it.
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        type: "summary",
        radars_processed: result.radars_processed,
        concepts_processed: result.concepts_processed,
        errors_count: result.errors.length,
        last_run_path: result.last_run_path,
        last_run: result.last_run,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `research-radar: ${result.radars_processed} radar(s), ` +
        `${result.concepts_processed} concept(s) processed, ` +
        `${result.errors.length} error(s); ` +
        `pointer=${result.last_run_path}\n`,
    );
  }

  // If anything went wrong inside the loop, surface the per-error
  // strings on stderr so a human can debug.
  for (const errStr of result.errors) {
    process.stderr.write(`research-radar: ${errStr}\n`);
  }

  return result.errors.length > 0 ? 2 : 0;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`research-radar: unhandled: ${errMessage(err)}\n`);
    process.exit(1);
  },
);
