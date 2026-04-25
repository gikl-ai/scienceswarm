import { afterEach, describe, expect, it, vi } from "vitest";

import {
  benchmarkRowHelpText,
  formatBenchmarkRowOutput,
  parseBenchmarkRowArgs,
  runBenchmarkRowCli,
} from "../../scripts/benchmark-chat-hi-row";

describe("benchmark-chat-hi-row", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses report metadata flags alongside the shared benchmark flags", () => {
    expect(
      parseBenchmarkRowArgs([
        "--url",
        "http://127.0.0.1:3001/dashboard?foo=1",
        "--project",
        "project-alpha",
        "--message",
        "Hi",
        "--timing-artifact",
        "--pr",
        "#272",
        "--change-area",
        "markdown row cli",
        "--date",
        "2026-04-25",
      ]),
    ).toMatchObject({
      benchmark: {
        baseUrl: "http://127.0.0.1:3001",
        projectId: "project-alpha",
        message: "Hi",
        includeTimingArtifact: true,
      },
      metadata: {
        date: "2026-04-25",
        prLabel: "#272",
        changeArea: "markdown row cli",
        environment: "Local `http://127.0.0.1:3001`",
      },
    });
  });

  it("uses report env defaults when metadata flags are omitted", () => {
    expect(
      parseBenchmarkRowArgs(
        ["--url", "http://localhost:4000/project"],
        {
          SCIENCESWARM_CHAT_REPORT_DATE: "2026-04-26",
          SCIENCESWARM_CHAT_REPORT_PR: "#273",
          SCIENCESWARM_CHAT_REPORT_CHANGE_AREA: "env defaults",
          SCIENCESWARM_CHAT_REPORT_ENVIRONMENT: "Preview",
        },
      ),
    ).toMatchObject({
      benchmark: {
        baseUrl: "http://localhost:4000",
      },
      metadata: {
        date: "2026-04-26",
        prLabel: "#273",
        changeArea: "env defaults",
        environment: "Preview",
      },
    });
  });

  it("formats a report row from benchmark output", () => {
    expect(
      formatBenchmarkRowOutput(
        {
          status: 200,
          ok: true,
          backend: "openclaw",
          contentType: "text/event-stream",
          conversationId: "bench-row",
          headersMs: 58,
          firstChunkMs: 58,
          firstChunkSharedHeadersTick: true,
          totalMs: 6677,
          bytes: 256,
          eventCount: 18,
          progressEventCount: 14,
          finalEventCount: 1,
          finalTextSample: "Hi! What would you like help with?",
          timingArtifact: null,
        },
        {
          date: "2026-04-25",
          prLabel: "#272",
          changeArea: "row cli",
          environment: "Local `http://localhost:3001`",
        },
      ),
    ).toBe(
      "| 2026-04-25 | #272 | row cli | Local `http://localhost:3001` | 58 | 58 | yes | 6677 | 14 | `Hi! What would you like help with?` | unavailable |",
    );
  });

  it("runs the benchmark and returns a markdown row", async () => {
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

    const result = await runBenchmarkRowCli(
      parseBenchmarkRowArgs([
        "--url",
        "http://127.0.0.1:3001",
        "--project",
        "project-alpha",
        "--message",
        "Hi",
        "--pr",
        "#272",
        "--change-area",
        "row cli",
        "--date",
        "2026-04-25",
      ]),
    );

    expect(result.summary.ok).toBe(true);
    expect(result.row).toContain("| 2026-04-25 | #272 | row cli |");
    expect(result.row).toContain("`Hi there.`");
  });

  it("documents the row-specific CLI flags", () => {
    expect(benchmarkRowHelpText()).toContain("--date <YYYY-MM-DD>");
    expect(benchmarkRowHelpText()).toContain("--pr <label>");
    expect(benchmarkRowHelpText()).toContain("--change-area <text>");
    expect(benchmarkRowHelpText()).toContain("--environment <text>");
  });
});
