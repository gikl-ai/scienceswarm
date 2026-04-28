import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/ports", () => ({
  getOllamaUrl: vi.fn(() => "http://127.0.0.1:11434"),
}));

vi.mock("@/lib/runtime/model-catalog", () => ({
  resolveConfiguredLocalModel: vi.fn(() => "gemma4:e4b"),
}));

vi.mock("@/lib/runtime-saved-env", () => ({
  getCurrentLlmRuntimeEnv: vi.fn(() => ({ ollamaModel: "gemma4:e4b" })),
}));

import { streamLocal } from "@/lib/local-llm";

describe("local-llm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies a timeout to streaming Ollama chat requests", async () => {
    const streamTimeoutSignal = new AbortController().signal;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(streamTimeoutSignal);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({
                  message: { thinking: "Inspecting..." },
                  done: false,
                })}\n`,
              ),
            );
            controller.close();
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks: Array<{ text?: string; thinking?: string }> = [];
    for await (const chunk of streamLocal([
      { role: "user", content: "Inspect the workspace" },
    ])) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ thinking: "Inspecting..." }]);
    expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({
        signal: streamTimeoutSignal,
      }),
    );
  });

  it("sends streaming chats to Ollama without forcing Gemma thinking mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({
                  message: { content: "done" },
                  done: false,
                })}\n`,
              ),
            );
            controller.close();
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks: Array<{ text?: string; thinking?: string }> = [];
    for await (const chunk of streamLocal([
      { role: "system", content: "You are ScienceSwarm." },
      { role: "user", content: "Reply with exactly FINAL." },
    ], "gemma4:e4b")) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ text: "done" }]);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.messages).toEqual([
      { role: "system", content: "You are ScienceSwarm." },
      { role: "user", content: "Reply with exactly FINAL." },
    ]);
  });
});
