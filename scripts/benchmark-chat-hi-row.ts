#!/usr/bin/env npx tsx

import {
  formatBenchmarkMarkdownRow,
  normalizeBenchmarkBaseUrl,
  parseBenchmarkArgs,
  runChatHiBenchmark,
  type ChatBenchmarkOptions,
  type ChatBenchmarkReportRowMetadata,
  type ChatBenchmarkSummary,
} from "./benchmark-chat-hi";

export interface ChatBenchmarkRowCliOptions {
  benchmark: ChatBenchmarkOptions;
  metadata: ChatBenchmarkReportRowMetadata;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function benchmarkRowHelpText(): string {
  return [
    "Usage: npx tsx scripts/benchmark-chat-hi-row.ts [benchmark options] [report options]",
    "",
    "Report options:",
    "  --date <YYYY-MM-DD>     Report date (default: today in UTC)",
    "  --pr <label>            PR label (default: baseline)",
    "  --change-area <text>    Short change area label (default: local benchmark)",
    "  --environment <text>    Report environment label (default: Local `<origin>`)",
    "",
    "Benchmark options:",
    "  Reuses the same flags as scripts/benchmark-chat-hi.ts:",
    "  --url, --project, --message, --conversation-id, --timeout-ms,",
    "  --no-stream-phases, --timing-artifact, --json",
  ].join("\n");
}

export function parseBenchmarkRowArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): ChatBenchmarkRowCliOptions {
  const benchmarkArgv: string[] = [];
  let dateOverride: string | null = null;
  let prLabelOverride: string | null = null;
  let changeAreaOverride: string | null = null;
  let environmentOverride: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] ?? "";
    if (arg === "--date") {
      dateOverride = next();
      continue;
    }
    if (arg === "--pr") {
      prLabelOverride = next();
      continue;
    }
    if (arg === "--change-area") {
      changeAreaOverride = next();
      continue;
    }
    if (arg === "--environment") {
      environmentOverride = next();
      continue;
    }
    benchmarkArgv.push(arg);
  }

  const benchmark = parseBenchmarkArgs(benchmarkArgv, env);
  return {
    benchmark,
    metadata: {
      date:
        dateOverride ??
        env.SCIENCESWARM_CHAT_REPORT_DATE ??
        todayIsoDate(),
      prLabel:
        prLabelOverride ??
        env.SCIENCESWARM_CHAT_REPORT_PR ??
        "baseline",
      changeArea:
        changeAreaOverride ??
        env.SCIENCESWARM_CHAT_REPORT_CHANGE_AREA ??
        "local benchmark",
      environment:
        environmentOverride ??
        env.SCIENCESWARM_CHAT_REPORT_ENVIRONMENT ??
        `Local \`${normalizeBenchmarkBaseUrl(benchmark.baseUrl)}\``,
    },
  };
}

export function formatBenchmarkRowOutput(
  summary: ChatBenchmarkSummary,
  metadata: ChatBenchmarkReportRowMetadata,
): string {
  return formatBenchmarkMarkdownRow(summary, metadata);
}

export async function runBenchmarkRowCli(
  options: ChatBenchmarkRowCliOptions,
): Promise<{ row: string; summary: ChatBenchmarkSummary }> {
  const summary = await runChatHiBenchmark(options.benchmark);
  return {
    row: formatBenchmarkRowOutput(summary, options.metadata),
    summary,
  };
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(`${benchmarkRowHelpText()}\n`);
      return;
    }

    const result = await runBenchmarkRowCli(parseBenchmarkRowArgs(argv));
    console.log(result.row);
    if (!result.summary.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
