#!/usr/bin/env npx tsx
/**
 * Standalone dream-cycle sidecar.
 *
 * This wrapper mirrors `scripts/run-research-radar.ts`: parse CLI/env,
 * check the persisted schedule, run the long brain job outside Next.js,
 * and write a structured freshness pointer for API/UI consumers.
 */

import { loadBrainConfig } from "../src/brain/config";
import { createLLMClient } from "../src/brain/llm";
import { runDreamCycle, type DreamCycleMode } from "../src/brain/dream-cycle";
import { readScheduleConfig, shouldRunNow } from "../src/brain/dream-scheduler";
import { dreamLastRunPath, writeDreamLastRun, type DreamLastRun } from "../src/brain/dream-report";
import { existsSync } from "fs";

interface CliOptions {
  force: boolean;
  json: boolean;
  mode?: DreamCycleMode;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { force: false, json: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      opts.force = true;
    } else if (arg === "--mode") {
      const next = argv[++i] as DreamCycleMode | undefined;
      if (!next || !["full", "sweep-only", "enrich-only"].includes(next)) {
        process.stderr.write("dream-cycle: --mode requires full, sweep-only, or enrich-only\n");
        process.exit(1);
      }
      opts.mode = next;
    } else if (arg === "--no-json") {
      opts.json = false;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  return opts;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: npx tsx scripts/run-dream-cycle.ts [options]",
      "",
      "Options:",
      "  --force       Run even when the persisted schedule is disabled or not due.",
      "  --mode MODE   full, sweep-only, or enrich-only. Defaults to schedule mode.",
      "  --no-json     Emit a human-readable line instead of JSON.",
      "  -h, --help    Show this help.",
      "",
      "Exit codes:",
      "  0   Clean run or schedule skip.",
      "  1   Fatal startup/run error; no successful pointer written.",
      "  2   Partial run; pointer written with errors.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadBrainConfig();
  if (!config) {
    process.stderr.write("dream-cycle: no initialized brain found\n");
    return 1;
  }

  const schedule = readScheduleConfig(config);
  const mode = opts.mode ?? schedule.mode;
  if (!opts.force && !shouldRunNow(schedule)) {
    const skipped: DreamLastRun = {
      timestamp: new Date().toISOString(),
      mode,
      pages_compiled: 0,
      contradictions_found: 0,
      backlinks_added: 0,
      duration_ms: 0,
      duration_ms_per_stage: {},
      errors: [],
      partial: false,
      skipped: true,
      reason: "Not due yet",
    };
    // Do not persist skipped polls. The sidecar wakes independently of the
    // dream schedule, and a skipped pointer would overwrite the last real
    // morning headline.
    const pointerPath = dreamLastRunPath(config.root);
    emit(opts, skipped, existsSync(pointerPath) ? pointerPath : null);
    return 0;
  }

  const llm = createLLMClient(config);
  const started = Date.now();
  let report: DreamLastRun;
  let pointerPath: string | null = null;
  try {
    const result = await runDreamCycle(config, llm, mode);
    report = {
      timestamp: new Date().toISOString(),
      mode,
      pages_compiled: result.pagesCompiled,
      contradictions_found: result.contradictionsFound,
      backlinks_added: result.backlinksAdded,
      duration_ms: result.durationMs,
      duration_ms_per_stage: {
        total: result.durationMs,
        runner_wall: Date.now() - started,
      },
      errors: [],
      partial: false,
      headline: result.headline ?? undefined,
    };
    pointerPath = writeDreamLastRun(config.root, report);
  } catch (error) {
    report = {
      timestamp: new Date().toISOString(),
      mode,
      pages_compiled: 0,
      contradictions_found: 0,
      backlinks_added: 0,
      duration_ms: Date.now() - started,
      duration_ms_per_stage: {
        runner_wall: Date.now() - started,
      },
      errors: [errMessage(error)],
      partial: true,
    };
    pointerPath = writeDreamLastRun(config.root, report);
    emit(opts, report, pointerPath);
    return 2;
  }

  emit(opts, report, pointerPath);
  return report.errors.length > 0 ? 2 : 0;
}

function emit(opts: CliOptions, report: DreamLastRun, pointerPath: string | null): void {
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        type: "summary",
        ...report,
        last_run_path: pointerPath,
      }) + "\n",
    );
    return;
  }
  process.stdout.write(
    `dream-cycle: ${report.skipped ? "skipped" : "ran"}; ` +
      `${report.pages_compiled} page(s) compiled, ` +
      `${report.contradictions_found} contradiction(s), ` +
      `${report.errors.length} error(s)` +
      `${pointerPath ? `; pointer=${pointerPath}` : ""}\n`,
  );
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`dream-cycle: unhandled: ${errMessage(error)}\n`);
    process.exit(1);
  },
);
