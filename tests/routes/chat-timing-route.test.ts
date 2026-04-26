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
  type ChatTimingPhaseRecord,
  type ChatTimingLogPayload,
} from "@/lib/chat-timing-telemetry";

function timingPayload(
  turnId: string,
  detail: Record<string, string | number | boolean | null> = {},
  phases?: ChatTimingPhaseRecord[],
): ChatTimingLogPayload {
  return {
    event: "scienceswarm.chat.timing",
    route: "/api/chat/unified?prompt=Secret%20prompt",
    turnId,
    totalDurationMs: 123,
    outcome: "completed",
    status: 200,
    phases: phases ?? [{
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
      summaries: [{
        turnId: "turn-safe-1",
        totalDurationMs: 123,
        observedSplit: {
          chatReadinessDurationMs: null,
          gatewayConnectAuthDurationMs: null,
          requestToSendAckMs: null,
          requestToFirstGatewayEventMs: null,
          requestToFirstAssistantTextMs: null,
          requestToFinalAssistantTextMs: null,
        },
        skippedPhaseNames: [],
      }],
    });
    expect(JSON.stringify(body)).not.toContain("Secret prompt");
  });

  it("returns derived observed split summaries for retained timing phases", async () => {
    vi.stubEnv("SCIENCESWARM_CHAT_TIMING", "1");
    recordChatTimingArtifact(
      timingPayload(
        "turn-phase-split",
        {},
        [
          {
            name: "request_parse",
            order: 1,
            startedAtMs: 100,
            endedAtMs: 110,
            durationMs: 10,
          },
          {
            name: "chat_readiness",
            order: 2,
            startedAtMs: 110,
            endedAtMs: 125,
            durationMs: 15,
          },
          {
            name: "gateway_connect_auth",
            order: 3,
            startedAtMs: 126,
            endedAtMs: 140,
            durationMs: 14,
          },
          {
            name: "chat_send_ack",
            order: 4,
            startedAtMs: 142,
            endedAtMs: 142,
            durationMs: 0,
          },
          {
            name: "first_gateway_event",
            order: 5,
            startedAtMs: 168,
            endedAtMs: 168,
            durationMs: 0,
          },
          {
            name: "first_assistant_text",
            order: 6,
            startedAtMs: 180,
            endedAtMs: 180,
            durationMs: 0,
          },
          {
            name: "final_assistant_text",
            order: 7,
            startedAtMs: 250,
            endedAtMs: 250,
            durationMs: 0,
          },
          {
            name: "artifact_import_repair",
            order: 8,
            startedAtMs: 251,
            endedAtMs: 251,
            durationMs: 0,
            skipped: true,
          },
        ],
      ),
    );

    const response = await GET(new Request("http://localhost/api/chat/timing"));
    const body = await response.json();

    expect(body.summaries).toMatchObject([{
      turnId: "turn-phase-split",
      observedSplit: {
        chatReadinessDurationMs: 15,
        gatewayConnectAuthDurationMs: 14,
        requestToSendAckMs: 42,
        requestToFirstGatewayEventMs: 68,
        requestToFirstAssistantTextMs: 80,
        requestToFinalAssistantTextMs: 150,
      },
      skippedPhaseNames: ["artifact_import_repair"],
    }]);
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
