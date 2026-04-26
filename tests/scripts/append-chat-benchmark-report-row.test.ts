import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendBenchmarkReportHelpText,
  appendBenchmarkReportRow,
  appendBenchmarkRowToReport,
  parseAppendBenchmarkReportArgs,
} from "../../scripts/append-chat-benchmark-report-row";

const BASE_REPORT = `# Chat Speed Timing Report

## Measurements

| Date | PR | Change area | Environment | Headers ms | First chunk ms | Shared tick | Total ms | Progress events | Final text sample | Timing artifact |
| --- | --- | --- | --- | ---: | ---: | :---: | ---: | ---: | --- | --- |
| 2026-04-24 | baseline | initial local benchmark | Local \`http://localhost:3001\` | 58 | 58 | yes | 6677 | 14 | \`Hi! What would you like help with?\` | unavailable |

## Notes

- Example note
`;

describe("append-chat-benchmark-report-row", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses append-specific flags alongside the shared row helper flags", () => {
    expect(
      parseAppendBenchmarkReportArgs([
        "--report",
        "docs/custom-report.md",
        "--url",
        "http://127.0.0.1:3001/dashboard",
        "--pr",
        "#277",
        "--change-area",
        "append helper",
      ]),
    ).toMatchObject({
      reportPath: "docs/custom-report.md",
      rowOptions: {
        benchmark: {
          baseUrl: "http://127.0.0.1:3001",
        },
        metadata: {
          prLabel: "#277",
          changeArea: "append helper",
        },
      },
    });
  });

  it("rejects --report without a path argument", () => {
    expect(() =>
      parseAppendBenchmarkReportArgs(["--report"]),
    ).toThrow("--report requires a path argument");
  });

  it("rejects missing report paths when no env override is set", () => {
    expect(() =>
      parseAppendBenchmarkReportArgs([
        "--url",
        "http://127.0.0.1:3001/dashboard",
        "--pr",
        "#277",
        "--change-area",
        "append helper",
      ]),
    ).toThrow(
      "A report path is required. Pass --report <path> or set SCIENCESWARM_CHAT_REPORT_PATH.",
    );
  });

  it("inserts a new row before the notes section", () => {
    const row =
      "| 2026-04-25 | #277 | append helper | Local `http://localhost:3001` | 40 | 55 | no | 120 | 2 | `Hi there.` | unavailable |";

    const next = appendBenchmarkRowToReport(BASE_REPORT, row);

    expect(next).toContain(`${row}\n\n## Notes`);
    expect(next.match(/\| 2026-04-25 \| #277 \|/g)).toHaveLength(1);
  });

  it("does not append the same row twice", () => {
    const row =
      "| 2026-04-25 | #277 | append helper | Local `http://localhost:3001` | 40 | 55 | no | 120 | 2 | `Hi there.` | unavailable |";

    const once = appendBenchmarkRowToReport(BASE_REPORT, row);
    const twice = appendBenchmarkRowToReport(once, row);

    expect(twice).toBe(once);
  });

  it("runs the benchmark helper and writes the report file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          new Response('data: {"type":"final","text":"Hi there."}\n\n', {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "x-chat-backend": "openclaw",
            },
          }),
        )
      ),
    );

    const directory = await mkdtemp(join(tmpdir(), "benchmark-report-append-"));
    const reportPath = join(directory, "chat-speed-report.md");
    await writeFile(reportPath, BASE_REPORT);

    const result = await appendBenchmarkReportRow(
      parseAppendBenchmarkReportArgs([
        "--report",
        reportPath,
        "--url",
        "http://127.0.0.1:3001",
        "--project",
        "project-alpha",
        "--message",
        "Hi",
        "--pr",
        "#277",
        "--change-area",
        "append helper",
        "--date",
        "2026-04-25",
      ]),
    );

    const reportText = await readFile(reportPath, "utf8");
    expect(result.reportPath).toBe(reportPath);
    expect(result.row).toContain("| 2026-04-25 | #277 | append helper |");
    expect(reportText).toContain(result.row);
    expect(reportText).toContain("\n\n## Notes");
    expect(result.ok).toBe(true);
  });

  it("does not write the report when the benchmark fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          new Response('data: {"type":"final","text":"Failed."}\n\n', {
            status: 503,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "x-chat-backend": "openclaw",
            },
          }),
        )
      ),
    );

    const directory = await mkdtemp(join(tmpdir(), "benchmark-report-append-"));
    const reportPath = join(directory, "chat-speed-report.md");
    await writeFile(reportPath, BASE_REPORT);

    const result = await appendBenchmarkReportRow(
      parseAppendBenchmarkReportArgs([
        "--report",
        reportPath,
        "--url",
        "http://127.0.0.1:3001",
        "--project",
        "project-alpha",
        "--message",
        "Hi",
        "--pr",
        "#289",
        "--change-area",
        "append helper",
        "--date",
        "2026-04-25",
      ]),
    );

    expect(result.ok).toBe(false);
    expect(await readFile(reportPath, "utf8")).toBe(BASE_REPORT);
  });

  it("documents the append flag in help text", () => {
    expect(appendBenchmarkReportHelpText()).toContain("--report <path>");
    expect(appendBenchmarkReportHelpText()).toContain(
      "scripts/benchmark-chat-hi-row.ts",
    );
  });
});
