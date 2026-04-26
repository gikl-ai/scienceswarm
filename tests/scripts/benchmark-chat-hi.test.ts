import { afterEach, describe, expect, it, vi } from "vitest";

import {
  benchmarkHelpText,
  buildBenchmarkPayload,
  fetchLatestTimingArtifact,
  chatTimingArtifactUrl,
  chatBenchmarkUrl,
  formatBenchmarkMarkdownRow,
  formatBenchmarkSummary,
  normalizeBenchmarkBaseUrl,
  parseBenchmarkArgs,
  parseSseEvents,
  summarizeChatBenchmarkResponse,
  summarizeLatestTimingArtifact,
  runChatHiBenchmark,
} from "../../scripts/benchmark-chat-hi";

describe("benchmark-chat-hi", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("builds the benchmark payload through OpenClaw with streaming phases", () => {
    expect(
      buildBenchmarkPayload({
        message: "Hi",
        projectId: "project-alpha",
        conversationId: "bench-1",
        streamPhases: true,
      }),
    ).toEqual({
      message: "Hi",
      messages: [{ role: "user", content: "Hi" }],
      backend: "openclaw",
      mode: "reasoning",
      files: [],
      projectId: "project-alpha",
      conversationId: "bench-1",
      streamPhases: true,
    });
  });

  it("parses SSE events and summarizes benchmark output", () => {
    const rawBody = [
      'event: progress\ndata: {"type":"progress","activityLines":["Checking OpenClaw"]}',
      'data: {"type":"thinking","text":"Planning the reply."}',
      'data: {"type":"final","text":"Hi there."}',
      "",
    ].join("\n\n");

    expect(parseSseEvents(rawBody)).toHaveLength(3);

    expect(
      summarizeChatBenchmarkResponse({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "text/event-stream; charset=utf-8",
        conversationId: "bench-1",
        rawBody,
        headersMs: 13.2,
        firstChunkMs: 24.6,
        totalMs: 1234.4,
        bytes: 321,
      }),
    ).toMatchObject({
      status: 200,
      ok: true,
      backend: "openclaw",
      conversationId: "bench-1",
      headersMs: 13,
      firstChunkMs: 25,
      firstChunkSharedHeadersTick: false,
      totalMs: 1234,
      bytes: 321,
      eventCount: 3,
      progressEventCount: 2,
      finalEventCount: 1,
      finalTextSample: "Hi there.",
    });
  });

  it("summarizes real unified chat progress wrappers and final text events", () => {
    const rawBody = [
      'data: {"progress":{"type":"event","method":"agent","payload":{"stream":"assistant","data":{"text":"Hello"}}}}',
      'data: {"progress":{"type":"event","method":"session.message","payload":{"message":{"role":"assistant","content":"Hello there."}}}}',
      'data: {"taskPhases":[]}',
      'data: {"text":"Hello there.","conversationId":"bench-real","backend":"openclaw","generatedFiles":[],"taskPhases":[]}',
      "data: [DONE]",
      "",
    ].join("\n\n");

    expect(
      summarizeChatBenchmarkResponse({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "text/event-stream; charset=utf-8",
        conversationId: "bench-real",
        rawBody,
        headersMs: 10,
        firstChunkMs: 20,
        totalMs: 100,
        bytes: 500,
      }),
    ).toMatchObject({
      eventCount: 5,
      progressEventCount: 2,
      finalEventCount: 1,
      finalTextSample: "Hello there.",
      firstChunkSharedHeadersTick: false,
    });
  });

  it("flags when the first stream chunk shares the same rounded timing tick as headers", () => {
    expect(
      summarizeChatBenchmarkResponse({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "text/event-stream; charset=utf-8",
        conversationId: "bench-shared-tick",
        rawBody: 'data: {"type":"final","text":"Done."}\n\n',
        headersMs: 58.2,
        firstChunkMs: 58.4,
        totalMs: 120.4,
        bytes: 64,
      }),
    ).toMatchObject({
      headersMs: 58,
      firstChunkMs: 58,
      firstChunkSharedHeadersTick: true,
      finalTextSample: "Done.",
    });
  });

  it("does not double-count hybrid progress wrappers as final events", () => {
    const rawBody = [
      'data: {"type":"final","progress":{"type":"event","payload":{"data":{"text":"still streaming"}}},"text":"not final"}',
      'data: {"type":"final","text":"Done."}',
      "",
    ].join("\n\n");

    expect(
      summarizeChatBenchmarkResponse({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "text/event-stream; charset=utf-8",
        conversationId: "bench-hybrid",
        rawBody,
        headersMs: 10,
        firstChunkMs: 20,
        totalMs: 100,
        bytes: 500,
      }),
    ).toMatchObject({
      eventCount: 2,
      progressEventCount: 1,
      finalEventCount: 1,
      finalTextSample: "Done.",
    });
  });

  it("supports JSON responses for non-streaming fallback measurements", () => {
    expect(
      summarizeChatBenchmarkResponse({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "application/json",
        conversationId: "bench-json",
        rawBody: '{"response":"Hello from JSON."}',
        headersMs: 10,
        firstChunkMs: null,
        totalMs: 50,
        bytes: 31,
      }),
    ).toMatchObject({
      eventCount: 0,
      progressEventCount: 0,
      finalEventCount: 0,
      finalTextSample: "Hello from JSON.",
    });
  });

  it("parses CLI flags and formats stable output", () => {
    const options = parseBenchmarkArgs(
      [
        "--url",
        "http://127.0.0.1:3001/dashboard",
        "--project",
        "project-alpha",
        "--message",
        "Hello",
        "--conversation-id",
        "bench-fixed",
        "--timeout-ms",
        "5000",
        "--no-stream-phases",
        "--timing-artifact",
        "--json",
      ],
      {},
    );

    expect(options).toMatchObject({
      baseUrl: "http://127.0.0.1:3001",
      projectId: "project-alpha",
      message: "Hello",
      conversationId: "bench-fixed",
      timeoutMs: 5000,
      streamPhases: false,
      includeTimingArtifact: true,
      json: true,
    });
    expect(chatBenchmarkUrl(options.baseUrl)).toBe(
      "http://127.0.0.1:3001/api/chat/unified",
    );
    expect(chatTimingArtifactUrl(options.baseUrl)).toBe(
      "http://127.0.0.1:3001/api/chat/timing",
    );
    expect(normalizeBenchmarkBaseUrl("http://localhost:4000/proxy?a=1#top")).toBe(
      "http://localhost:4000",
    );
    expect(chatBenchmarkUrl("http://localhost:4000/proxy")).toBe(
      "http://localhost:4000/api/chat/unified",
    );
    expect(benchmarkHelpText()).toContain("path/query/hash are stripped");
    const formattedWithTiming = formatBenchmarkSummary({
      status: 200,
      ok: true,
      backend: "openclaw",
      contentType: "text/event-stream",
      conversationId: "bench-fixed",
      headersMs: 5,
      firstChunkMs: 10,
      firstChunkSharedHeadersTick: false,
      totalMs: 100,
      bytes: 200,
      eventCount: 3,
      progressEventCount: 1,
      finalEventCount: 1,
      finalTextSample: "Hello.",
      timingArtifact: {
        turnId: "turn-1",
        startedAtMs: 1000,
        totalDurationMs: 100,
        outcome: "streamed",
        status: 200,
        phaseCount: 2,
        phases: [
          { name: "project_materialization", durationMs: 0, skipped: true },
          { name: "chat_readiness", durationMs: 7, inferred: true },
        ],
        promptCharCounts: {
          user_text: 2,
          guardrails: 40,
          recent_chat_context: 0,
          workspace_files: 0,
          total: 42,
        },
        observedSplit: {
          chatReadinessDurationMs: 7,
          gatewayConnectAuthDurationMs: null,
          requestToSendAckMs: null,
          requestToFirstGatewayEventMs: null,
          requestToFirstAssistantTextMs: null,
          requestToFinalAssistantTextMs: null,
        },
      },
    });
    expect(formattedWithTiming).toContain("Total: 100 ms");
    expect(formattedWithTiming).toContain(
      "Observed split: browser->server headers 5 ms, server->first chunk 5 ms, first chunk->complete 90 ms",
    );
    expect(formattedWithTiming).toContain(
      "Timing phases: project_materialization skipped, chat_readiness 7 ms (inferred)",
    );
    expect(formattedWithTiming).toContain("Server timing: readiness 7 ms");
    expect(formattedWithTiming).toContain(
      "Skipped phases: project_materialization",
    );
    expect(formattedWithTiming).toContain(
      "Prompt chars: total 42, recent_chat_context 0, workspace_files 0, user_text 2, guardrails 40",
    );
    expect(formattedWithTiming).toContain(
      "Prompt highlights: total 42, recent_chat_context 0, workspace_files 0",
    );

    expect(
      formatBenchmarkSummary({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "text/event-stream",
        conversationId: "bench-fixed",
        headersMs: 5,
        firstChunkMs: 10,
        firstChunkSharedHeadersTick: false,
        totalMs: 100,
        bytes: 200,
        eventCount: 3,
        progressEventCount: 1,
        finalEventCount: 1,
        finalTextSample: "Hello.",
        timingArtifact: {
          turnId: "turn-1",
          startedAtMs: 1000,
          totalDurationMs: 100,
          outcome: "streamed",
          status: 200,
          phaseCount: 0,
          phases: [],
          promptCharCounts: {},
          observedSplit: null,
        },
      }),
    ).toContain(
      "Timing phases: none\nPrompt chars: none\nPrompt highlights: none",
    );
    expect(
      formatBenchmarkSummary({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "text/event-stream",
        conversationId: "bench-fixed",
        headersMs: 5,
        firstChunkMs: 10,
        firstChunkSharedHeadersTick: false,
        totalMs: 100,
        bytes: 200,
        eventCount: 3,
        progressEventCount: 1,
        finalEventCount: 1,
        finalTextSample: "Hello.",
        timingArtifact: {
          turnId: "turn-1",
          startedAtMs: 1000,
          totalDurationMs: 100,
          outcome: "streamed",
          status: 200,
          phaseCount: 0,
          phases: [],
          promptCharCounts: {},
          observedSplit: null,
        },
      }),
    ).not.toContain("Skipped phases:");
    expect(
      formatBenchmarkSummary({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "text/event-stream",
        conversationId: "bench-fixed",
        headersMs: 58,
        firstChunkMs: 58,
        firstChunkSharedHeadersTick: true,
        totalMs: 100,
        bytes: 200,
        eventCount: 3,
        progressEventCount: 1,
        finalEventCount: 1,
        finalTextSample: "Hello.",
        timingArtifact: null,
      }),
    ).not.toContain("Shared timing tick:");
    expect(
      formatBenchmarkSummary({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "text/event-stream",
        conversationId: "bench-fixed",
        headersMs: 5,
        firstChunkMs: 10,
        firstChunkSharedHeadersTick: false,
        totalMs: 100,
        bytes: 200,
        eventCount: 3,
        progressEventCount: 1,
        finalEventCount: 1,
        finalTextSample: "Hello.",
        timingArtifact: null,
      }),
    ).toContain("Timing artifact: unavailable");
    expect(
      formatBenchmarkSummary({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "text/event-stream",
        conversationId: "bench-fixed",
        headersMs: 5,
        firstChunkMs: null,
        firstChunkSharedHeadersTick: false,
        totalMs: 100,
        bytes: 200,
        eventCount: 3,
        progressEventCount: 1,
        finalEventCount: 1,
        finalTextSample: "Hello.",
        timingArtifact: null,
      }),
    ).toContain(
      "Observed split: browser->server headers 5 ms, server->first chunk n/a, first chunk->complete n/a",
    );
  });

  it("formats a markdown timing report row from a benchmark summary", () => {
    expect(
      formatBenchmarkMarkdownRow(
        {
          status: 200,
          ok: true,
          backend: "openclaw",
          contentType: "text/event-stream",
          conversationId: "bench-fixed",
          headersMs: 58,
          firstChunkMs: 58,
          firstChunkSharedHeadersTick: true,
          totalMs: 6677,
          bytes: 256,
          eventCount: 18,
          progressEventCount: 14,
          finalEventCount: 1,
          finalTextSample: "Hi! What would you like help with?",
          timingArtifact: {
            available: false,
            reason: "endpoint_disabled_or_no_timings",
            detail: "HTTP 404 Not Found",
          },
        },
        {
          date: "2026-04-24",
          prLabel: "#263",
          changeArea: "benchmark summary",
          environment: "Local `http://localhost:3001`",
        },
      ),
    ).toBe(
      "| 2026-04-24 | #263 | benchmark summary | Local `http://localhost:3001` | 58 | 58 | yes | 6677 | 14 | `Hi! What would you like help with?` | unavailable (artifact endpoint disabled or no timings; HTTP 404 Not Found) |",
    );
  });

  it("escapes markdown row cells and handles missing first chunk and timing artifact", () => {
    expect(
      formatBenchmarkMarkdownRow(
        {
          status: 200,
          ok: true,
          backend: "openclaw",
          contentType: "application/json",
          conversationId: "bench-fixed",
          headersMs: 12,
          firstChunkMs: null,
          firstChunkSharedHeadersTick: false,
          totalMs: 40,
          bytes: 64,
          eventCount: 1,
          progressEventCount: 0,
          finalEventCount: 1,
          finalTextSample: "Done | ready",
          timingArtifact: null,
        },
        {
          date: "2026-04-25",
          prLabel: "baseline",
          changeArea: "json fallback",
          environment: "CI\npreview",
        },
      ),
    ).toBe(
      "| 2026-04-25 | baseline | json fallback | CI preview | 12 | n/a | no | 40 | 0 | `Done \\| ready` | unavailable |",
    );
  });

  it("uses a longer code-span delimiter when the final sample contains backticks", () => {
    expect(
      formatBenchmarkMarkdownRow(
        {
          status: 200,
          ok: true,
          backend: "openclaw",
          contentType: "text/event-stream",
          conversationId: "bench-fixed",
          headersMs: 25,
          firstChunkMs: 30,
          firstChunkSharedHeadersTick: false,
          totalMs: 90,
          bytes: 120,
          eventCount: 4,
          progressEventCount: 2,
          finalEventCount: 1,
          finalTextSample: "Use `npm install`",
          timingArtifact: {
            turnId: "turn-2",
            startedAtMs: 2000,
            totalDurationMs: 123,
            outcome: "streamed",
            status: 200,
            phaseCount: 1,
            phases: [{ name: "chat_readiness", durationMs: 7 }],
            promptCharCounts: { total: 12 },
            observedSplit: {
              chatReadinessDurationMs: 7,
              gatewayConnectAuthDurationMs: null,
              requestToSendAckMs: null,
              requestToFirstGatewayEventMs: null,
              requestToFirstAssistantTextMs: null,
              requestToFinalAssistantTextMs: null,
            },
          },
        },
        {
          date: "2026-04-25",
          prLabel: "#267",
          changeArea: "markdown row helper",
          environment: "Local `http://localhost:3001`",
        },
      ),
    ).toBe(
      "| 2026-04-25 | #267 | markdown row helper | Local `http://localhost:3001` | 25 | 30 | no | 90 | 2 | `` Use `npm install` `` | 123 ms |",
    );
  });

  it("classifies a 404 timing response as disabled/no timings with a human hint", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/chat/unified")) {
        return Promise.resolve(
          new Response('data: {"type":"final","text":"Hi there."}\n\n', {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "x-chat-backend": "openclaw",
            },
          }),
        );
      }
      if (url.endsWith("/api/chat/timing")) {
        return Promise.resolve(
          new Response("", {
            status: 404,
            statusText: "Not Found",
          }),
        );
      }
      throw new Error(`Unexpected fetch target: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const summary = await runChatHiBenchmark({
      baseUrl: "http://127.0.0.1:3001",
      projectId: "project-alpha",
      message: "Hi",
      conversationId: "bench-diagnostic",
      timeoutMs: 10_000,
      streamPhases: true,
      includeTimingArtifact: true,
      json: true,
    });

    expect(summary.timingArtifact).toMatchObject({
      available: false,
      reason: "endpoint_disabled_or_no_timings",
      detail:
        "HTTP 404 Not Found; enable SCIENCESWARM_CHAT_TIMING=1 and ensure the app is running locally with current code",
    });
    expect(JSON.stringify(summary, null, 2)).toContain(
      '"reason": "endpoint_disabled_or_no_timings"',
    );
    expect(formatBenchmarkSummary(summary)).toContain(
      "Timing artifact: unavailable (artifact endpoint disabled or no timings; HTTP 404 Not Found; enable SCIENCESWARM_CHAT_TIMING=1 and ensure the app is running locally with current code)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out waiting for the timing artifact instead of hanging", async () => {
    vi.useFakeTimers();

    const abortError = () => {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      return error;
    };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/api/chat/timing")) {
        throw new Error(`Unexpected fetch target: ${url}`);
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            reject(abortError());
          },
          { once: true },
        );
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const summaryPromise = fetchLatestTimingArtifact("http://127.0.0.1:3001");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(summaryPromise).resolves.toMatchObject({
      available: false,
      reason: "timeout",
      detail: "timing endpoint did not respond before the 5000 ms timeout",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "classifies a 404 timing response as disabled/no timings",
      response: new Response("", {
        status: 404,
        statusText: "Not Found",
      }),
      expected: {
        reason: "endpoint_disabled_or_no_timings",
        detail:
          "HTTP 404 Not Found; enable SCIENCESWARM_CHAT_TIMING=1 and ensure the app is running locally with current code",
      },
      minStartedAtMs: undefined,
    },
    {
      name: "classifies a non-OK timing response as unreachable/non-OK",
      response: new Response("", {
        status: 503,
        statusText: "Service Unavailable",
      }),
      expected: {
        reason: "endpoint_unreachable_or_non_ok",
        detail: "HTTP 503 Service Unavailable",
      },
      minStartedAtMs: undefined,
    },
    {
      name: "classifies an empty timings array as disabled/no timings",
      response: new Response(JSON.stringify({ timings: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      expected: {
        reason: "endpoint_disabled_or_no_timings",
        detail: "timings array was empty",
      },
      minStartedAtMs: undefined,
    },
    {
      name: "classifies older timing artifacts as no matching recent artifact",
      response: new Response(
        JSON.stringify({
          timings: [
            {
              turnId: "older",
              totalDurationMs: 12,
              outcome: "streamed",
              status: 200,
              phases: [
                { name: "request_parse", startedAtMs: 10, durationMs: 1 },
              ],
              promptCharCounts: { total: 1 },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
      expected: {
        reason: "no_matching_recent_artifact",
        detail: "no timings started at or after 1000 ms",
      },
      minStartedAtMs: 1_000,
    },
  ] as const)(
    "$name",
    async ({ response, expected, minStartedAtMs }) => {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith("/api/chat/timing")) {
          throw new Error(`Unexpected fetch target: ${url}`);
        }
        return Promise.resolve(response.clone());
      });

      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchLatestTimingArtifact("http://127.0.0.1:3001", { minStartedAtMs }),
      ).resolves.toMatchObject({
        available: false,
        ...expected,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("summarizes the latest sanitized chat timing artifact", () => {
    expect(
      summarizeLatestTimingArtifact({
        maxEntries: 25,
        timings: [
          {
            turnId: "older",
            totalDurationMs: 999,
            outcome: "old",
            status: 200,
            phases: [],
            promptCharCounts: { total: 1 },
          },
          {
            turnId: "turn-1",
            totalDurationMs: 123.6,
            outcome: "streamed",
            status: 200,
            phases: [
              { name: "request_parse", startedAtMs: 1000, durationMs: 1.2 },
              {
                name: "project_materialization",
                startedAtMs: 1001,
                durationMs: 0,
                skipped: true,
              },
              {
                name: "chat_readiness",
                startedAtMs: 1002,
                durationMs: 7.5,
                inferred: true,
              },
              { name: "", durationMs: 99 },
            ],
            promptCharCounts: {
              user_text: 2,
              guardrails: 40.2,
              total: 42.2,
            },
          },
        ],
      }),
    ).toEqual({
      turnId: "turn-1",
      startedAtMs: 1000,
      totalDurationMs: 124,
      outcome: "streamed",
      status: 200,
      phaseCount: 3,
      phases: [
        { name: "request_parse", startedAtMs: 1000, durationMs: 1 },
        {
          name: "project_materialization",
          startedAtMs: 1001,
          durationMs: 0,
          skipped: true,
        },
        {
          name: "chat_readiness",
          startedAtMs: 1002,
          durationMs: 8,
          inferred: true,
        },
      ],
      promptCharCounts: {
        user_text: 2,
        guardrails: 40,
        total: 42,
      },
      observedSplit: {
        chatReadinessDurationMs: 8,
        gatewayConnectAuthDurationMs: null,
        requestToSendAckMs: null,
        requestToFirstGatewayEventMs: null,
        requestToFirstAssistantTextMs: null,
        requestToFinalAssistantTextMs: null,
      },
    });

    expect(summarizeLatestTimingArtifact({ timings: [] })).toBeNull();
  });

  it("derives observed server timing milestones from sanitized timing phases", () => {
    expect(
      summarizeLatestTimingArtifact({
        timings: [
          {
            turnId: "turn-server-split",
            totalDurationMs: 150,
            outcome: "streamed",
            status: 200,
            phases: [
              {
                name: "request_parse",
                startedAtMs: 1000,
                endedAtMs: 1010,
                durationMs: 10,
              },
              {
                name: "chat_readiness",
                startedAtMs: 1010,
                endedAtMs: 1025,
                durationMs: 15,
              },
              {
                name: "gateway_connect_auth",
                startedAtMs: 1026,
                endedAtMs: 1040,
                durationMs: 14,
              },
              {
                name: "chat_send_ack",
                startedAtMs: 1042,
                endedAtMs: 1042,
                durationMs: 0,
              },
              {
                name: "first_gateway_event",
                startedAtMs: 1068,
                endedAtMs: 1068,
                durationMs: 0,
              },
              {
                name: "first_assistant_text",
                startedAtMs: 1080,
                endedAtMs: 1080,
                durationMs: 0,
              },
              {
                name: "final_assistant_text",
                startedAtMs: 1150,
                endedAtMs: 1150,
                durationMs: 0,
              },
            ],
            promptCharCounts: { total: 2 },
          },
        ],
      }),
    ).toMatchObject({
      observedSplit: {
        chatReadinessDurationMs: 15,
        gatewayConnectAuthDurationMs: 14,
        requestToSendAckMs: 42,
        requestToFirstGatewayEventMs: 68,
        requestToFirstAssistantTextMs: 80,
        requestToFinalAssistantTextMs: 150,
      },
    });
  });

  it("filters timing artifacts to turns that started after the benchmark request", () => {
    const responseJson = {
      timings: [
        {
          turnId: "older",
          totalDurationMs: 999,
          outcome: "old",
          status: 200,
          phases: [{ name: "request_parse", startedAtMs: 900, durationMs: 1 }],
          promptCharCounts: { total: 1 },
        },
        {
          turnId: "current",
          totalDurationMs: 123,
          outcome: "streamed",
          status: 200,
          phases: [
            { name: "request_parse", startedAtMs: 1500, durationMs: 1 },
          ],
          promptCharCounts: { total: 2 },
        },
      ],
    };

    expect(
      summarizeLatestTimingArtifact(responseJson, { minStartedAtMs: 1000 }),
    ).toMatchObject({
      turnId: "current",
      startedAtMs: 1500,
    });
    expect(
      summarizeLatestTimingArtifact(responseJson, { minStartedAtMs: 2000 }),
    ).toBeNull();
  });
});
