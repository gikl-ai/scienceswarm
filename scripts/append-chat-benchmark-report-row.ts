#!/usr/bin/env npx tsx

import { readFile, writeFile } from "node:fs/promises";

import {
  benchmarkRowHelpText,
  parseBenchmarkRowArgs,
  runBenchmarkRowCli,
  type ChatBenchmarkRowCliOptions,
} from "./benchmark-chat-hi-row";

const DEFAULT_REPORT_PATH = "docs/chat-speed-timing-report.md";

export interface AppendBenchmarkReportOptions {
  rowOptions: ChatBenchmarkRowCliOptions;
  reportPath: string;
}

export function appendBenchmarkReportHelpText(): string {
  return [
    "Usage: npx tsx scripts/append-chat-benchmark-report-row.ts [row options] [append options]",
    "",
    "Append options:",
    `  --report <path>         Markdown report file to update (default: ${DEFAULT_REPORT_PATH})`,
    "",
    benchmarkRowHelpText(),
  ].join("\n");
}

export function parseAppendBenchmarkReportArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): AppendBenchmarkReportOptions {
  const rowArgv: string[] = [];
  let reportPath = env.SCIENCESWARM_CHAT_REPORT_PATH ?? DEFAULT_REPORT_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--report") {
      reportPath = argv[++index] ?? reportPath;
      continue;
    }
    rowArgv.push(arg);
  }

  return {
    rowOptions: parseBenchmarkRowArgs(rowArgv, env),
    reportPath,
  };
}

export function appendBenchmarkRowToReport(
  documentText: string,
  row: string,
): string {
  if (documentText.includes(`\n${row}\n`) || documentText.endsWith(`\n${row}`)) {
    return documentText;
  }

  const notesHeading = "\n## Notes";
  const notesIndex = documentText.indexOf(notesHeading);
  if (notesIndex !== -1) {
    const beforeNotes = documentText.slice(0, notesIndex).replace(/\s+$/, "");
    const afterNotes = documentText.slice(notesIndex);
    return `${beforeNotes}\n${row}\n\n${afterNotes.replace(/^\n+/, "")}`;
  }

  return `${documentText.replace(/\s+$/, "")}\n\n${row}\n`;
}

export async function appendBenchmarkReportRow(
  options: AppendBenchmarkReportOptions,
): Promise<{ reportPath: string; row: string }> {
  const result = await runBenchmarkRowCli(options.rowOptions);
  const existingReport = await readFile(options.reportPath, "utf8");
  const nextReport = appendBenchmarkRowToReport(existingReport, result.row);
  if (nextReport !== existingReport) {
    await writeFile(options.reportPath, nextReport);
  }
  return {
    reportPath: options.reportPath,
    row: result.row,
  };
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(`${appendBenchmarkReportHelpText()}\n`);
      return;
    }

    const result = await appendBenchmarkReportRow(
      parseAppendBenchmarkReportArgs(argv),
    );
    console.log(`Appended benchmark row to ${result.reportPath}`);
    console.log(result.row);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
