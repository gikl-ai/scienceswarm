import { describe, expect, it } from "vitest";

import {
  benchmarkHelpText,
  buildBenchmarkPayload,
  chatTimingArtifactUrl,
  chatBenchmarkUrl,
  formatBenchmarkSummary,
  normalizeBenchmarkBaseUrl,
  parseBenchmarkArgs,
  parseSseEvents,
  summarizeChatBenchmarkResponse,
  summarizeLatestTimingArtifact,
} from "../../scripts/benchmark-chat-hi";

describe("benchmark-chat-hi", () => {
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
        phaseCount: 1,
        phases: [{ name: "chat_readiness", durationMs: 7 }],
        promptCharCounts: { user_text: 2, guardrails: 40, total: 42 },
      },
    });
    expect(formattedWithTiming).toContain("Total: 100 ms");
    expect(formattedWithTiming).toContain("Timing phases: chat_readiness 7 ms");
    expect(formattedWithTiming).toContain(
      "Prompt chars: user_text 2, guardrails 40, total 42",
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
        },
      }),
    ).toContain("Timing phases: none\nPrompt chars: none");
    expect(
      formatBenchmarkSummary({
        status: 200,
        ok: true,
        backend: "openclaw",
        contentType: "text/event-stream",
        conversationId: "bench-fixed",
        headersMs: 5,
        firstChunkMs: 10,
        totalMs: 100,
        bytes: 200,
        eventCount: 3,
        progressEventCount: 1,
        finalEventCount: 1,
        finalTextSample: "Hello.",
        timingArtifact: null,
      }),
    ).toContain("Timing artifact: unavailable");
  });

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
      phaseCount: 2,
      phases: [
        { name: "request_parse", durationMs: 1 },
        { name: "chat_readiness", durationMs: 8, inferred: true },
      ],
      promptCharCounts: {
        user_text: 2,
        guardrails: 40,
        total: 42,
      },
    });

    expect(summarizeLatestTimingArtifact({ timings: [] })).toBeNull();
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
