import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPromptSizeBuckets,
  clearChatTimingArtifactsForTests,
  createChatTimingTelemetry,
  getRecentChatTimingArtifacts,
  isChatTimingTelemetryEnabled,
  type ChatTimingLogPayload,
} from "@/lib/chat-timing-telemetry";

describe("chat timing telemetry", () => {
  beforeEach(() => {
    clearChatTimingArtifactsForTests();
  });

  afterEach(() => {
    clearChatTimingArtifactsForTests();
  });

  it("records ordered phases and gateway milestones without event text", () => {
    let now = 1_000;
    const logs: ChatTimingLogPayload[] = [];
    const telemetry = createChatTimingTelemetry({
      enabled: true,
      turnId: "turn-test",
      now: () => now,
      logger: (payload) => logs.push(payload),
    });

    const parsePhase = telemetry.startPhase("request_parse");
    now += 7;
    telemetry.endPhase(parsePhase);
    telemetry.recordSkippedPhase("project_materialization");

    telemetry.beginGatewayConnectAuth();
    now += 13;
    telemetry.observeGatewayEvent({
      method: "agent",
      payload: {
        stream: "assistant",
        data: { delta: "secret assistant text" },
      },
    });
    now += 5;
    telemetry.markFinalAssistantText("final text".length);
    telemetry.finish({ outcome: "completed", status: 200 });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "scienceswarm.chat.timing",
      route: "/api/chat/unified",
      turnId: "turn-test",
      outcome: "completed",
      status: 200,
    });
    expect(logs[0].phases.map((phase) => phase.name)).toEqual([
      "request_parse",
      "project_materialization",
      "gateway_connect_auth",
      "chat_send_ack",
      "first_gateway_event",
      "first_assistant_text",
      "final_assistant_text",
    ]);
    expect(logs[0].phases[0]).toMatchObject({ durationMs: 7 });
    expect(logs[0].phases[1]).toMatchObject({ skipped: true });
    expect(
      logs[0].phases.find((phase) => phase.name === "first_assistant_text"),
    ).toMatchObject({
      detail: { assistant_text_chars: "secret assistant text".length },
    });
    expect(JSON.stringify(logs[0])).not.toContain("secret assistant text");
    expect(JSON.stringify(logs[0])).not.toContain("final text");
    expect(getRecentChatTimingArtifacts()).toHaveLength(1);
  });

  it("reports prompt-size buckets without retaining prompt contents", () => {
    const buckets = buildPromptSizeBuckets({
      user_text: "private user request",
      guardrails: "rules",
      project_prompt: ["project", "context"],
      recent_chat_context: "prior turn",
      active_file: "selected file contents",
      workspace_files: "workspace excerpt",
    });

    expect(buckets).toEqual({
      user_text: "private user request".length,
      guardrails: "rules".length,
      project_prompt: "projectcontext".length,
      recent_chat_context: "prior turn".length,
      active_file: "selected file contents".length,
      workspace_files: "workspace excerpt".length,
      total:
        "private user request".length +
        "rules".length +
        "projectcontext".length +
        "prior turn".length +
        "selected file contents".length +
        "workspace excerpt".length,
    });
    expect(JSON.stringify(buckets)).not.toContain("private user request");
    expect(JSON.stringify(buckets)).not.toContain("workspace excerpt");
  });

  it("counts mixed string and object message content blocks", () => {
    let now = 2_000;
    const logs: ChatTimingLogPayload[] = [];
    const telemetry = createChatTimingTelemetry({
      enabled: true,
      turnId: "mixed-content",
      now: () => now,
      logger: (payload) => logs.push(payload),
    });

    telemetry.observeGatewayEvent({
      method: "chat.final",
      payload: {
        message: {
          role: "assistant",
          content: [
            "preamble",
            { type: "text", text: "body" },
          ],
        },
      },
    });
    now += 3;
    telemetry.finish({ outcome: "completed", status: 200 });

    const firstTextPhase = logs[0]?.phases.find(
      (phase) => phase.name === "first_assistant_text",
    );
    expect(firstTextPhase).toMatchObject({
      detail: { assistant_text_chars: "preamblebody".length },
    });
  });

  it("closes active phases as inferred on finish", () => {
    let now = 3_000;
    const logs: ChatTimingLogPayload[] = [];
    const telemetry = createChatTimingTelemetry({
      enabled: true,
      turnId: "active-phase",
      now: () => now,
      logger: (payload) => logs.push(payload),
    });

    telemetry.startPhase("project_materialization");
    now += 11;
    telemetry.finish({ outcome: "failed", status: 500 });

    expect(logs[0]?.phases).toEqual([
      expect.objectContaining({
        name: "project_materialization",
        durationMs: 11,
        inferred: true,
      }),
    ]);
  });

  it("is opt-in through SCIENCESWARM_CHAT_TIMING=1", () => {
    expect(
      isChatTimingTelemetryEnabled({ SCIENCESWARM_CHAT_TIMING: "1" }),
    ).toBe(true);
    expect(
      isChatTimingTelemetryEnabled({ SCIENCESWARM_CHAT_TIMING: "true" }),
    ).toBe(false);

    const logger = vi.fn();
    const telemetry = createChatTimingTelemetry({
      enabled: false,
      logger,
    });
    const phase = telemetry.startPhase("request_parse");
    telemetry.endPhase(phase);
    telemetry.finish({ outcome: "disabled" });
    expect(logger).not.toHaveBeenCalled();
  });
});
