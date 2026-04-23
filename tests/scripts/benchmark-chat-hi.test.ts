import { describe, expect, it } from "vitest";

import {
  buildBenchmarkPayload,
  chatBenchmarkUrl,
  formatBenchmarkSummary,
  parseBenchmarkArgs,
  parseSseEvents,
  summarizeChatBenchmarkResponse,
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
      finalEventCount: 2,
      finalTextSample: "Hi there.",
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
        "--json",
      ],
      {},
    );

    expect(options).toMatchObject({
      baseUrl: "http://127.0.0.1:3001/dashboard",
      projectId: "project-alpha",
      message: "Hello",
      conversationId: "bench-fixed",
      timeoutMs: 5000,
      streamPhases: false,
      json: true,
    });
    expect(chatBenchmarkUrl(options.baseUrl)).toBe(
      "http://127.0.0.1:3001/api/chat/unified",
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
      }),
    ).toContain("Total: 100 ms");
  });
});
