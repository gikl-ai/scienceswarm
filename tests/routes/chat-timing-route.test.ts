import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isLocalRequestMock } = vi.hoisted(() => ({
  isLocalRequestMock: vi.fn(),
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: isLocalRequestMock,
}));

import { GET } from "@/app/api/chat/timing/route";
import {
  CHAT_TIMING_ARTIFACT_LIMIT,
  clearChatTimingArtifactsForTests,
  recordChatTimingArtifact,
  type ChatTimingLogPayload,
} from "@/lib/chat-timing-telemetry";

function timingPayload(
  turnId: string,
  detail: Record<string, string | number | boolean | null> = {},
): ChatTimingLogPayload {
  return {
    event: "scienceswarm.chat.timing",
    route: "/api/chat/unified?prompt=Secret%20prompt",
    turnId,
    totalDurationMs: 123,
    outcome: "completed",
    status: 200,
    phases: [{
      name: "request_parse",
      order: 1,
      startedAtMs: 10,
      endedAtMs: 20,
      durationMs: 10,
      detail,
    }],
    promptCharCounts: {
      user_text: 13,
      guardrails: 5,
      project_prompt: 0,
      recent_chat_context: 0,
      active_file: 0,
      workspace_files: 0,
      total: 18,
    },
  };
}

describe("GET /api/chat/timing", () => {
  beforeEach(() => {
    clearChatTimingArtifactsForTests();
    isLocalRequestMock.mockResolvedValue(true);
  });

  afterEach(() => {
    clearChatTimingArtifactsForTests();
    isLocalRequestMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("is unavailable by default and does not expose retained payloads", async () => {
    recordChatTimingArtifact(
      timingPayload("turn-secret", { raw_prompt: "Secret prompt" }),
    );

    const response = await GET(new Request("http://localhost/api/chat/timing"));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("");
  });

  it("rejects non-local requests even when timing artifacts are enabled", async () => {
    vi.stubEnv("SCIENCESWARM_CHAT_TIMING", "1");
    isLocalRequestMock.mockResolvedValue(false);
    recordChatTimingArtifact(
      timingPayload("turn-secret", { raw_prompt: "Secret prompt" }),
    );

    const response = await GET(new Request("https://example.com/api/chat/timing"));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("");
  });

  it("returns enabled timing artifacts without prompt-like strings", async () => {
    vi.stubEnv("SCIENCESWARM_CHAT_TIMING", "1");
    recordChatTimingArtifact(
      timingPayload("turn-safe-1", { raw_prompt: "Secret prompt" }),
    );

    const response = await GET(new Request("http://localhost/api/chat/timing"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({
      maxEntries: CHAT_TIMING_ARTIFACT_LIMIT,
      timings: [{
        route: "/api/chat/unified",
        turnId: "turn-safe-1",
        promptCharCounts: {
          user_text: 13,
          total: 18,
        },
        phases: [{
          name: "request_parse",
          detail: { raw_prompt: "[redacted]" },
        }],
      }],
    });
    expect(JSON.stringify(body)).not.toContain("Secret prompt");
  });

  it("retains only the most recent bounded timing artifacts", async () => {
    vi.stubEnv("SCIENCESWARM_CHAT_TIMING", "1");
    for (let index = 0; index < CHAT_TIMING_ARTIFACT_LIMIT + 3; index += 1) {
      recordChatTimingArtifact(timingPayload(`turn-${index}`));
    }

    const response = await GET(new Request("http://localhost/api/chat/timing"));
    const body = await response.json() as { timings: Array<{ turnId: string }> };

    expect(body.timings).toHaveLength(CHAT_TIMING_ARTIFACT_LIMIT);
    expect(body.timings.at(0)?.turnId).toBe("turn-3");
    expect(body.timings.at(-1)?.turnId).toBe(
      `turn-${CHAT_TIMING_ARTIFACT_LIMIT + 2}`,
    );
  });
});
