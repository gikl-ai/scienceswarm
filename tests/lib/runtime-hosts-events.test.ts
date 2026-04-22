import { describe, expect, it } from "vitest";

import {
  applyRuntimeEventRetention,
  createRuntimeEventStore,
  createRuntimeSessionStore,
  type RuntimeEvent,
} from "@/lib/runtime-hosts";

describe("runtime event store", () => {
  it("normalizes text/tool event aliases and ignores duplicate event ids", () => {
    const store = createRuntimeEventStore({
      now: () => new Date("2026-04-22T10:00:00.000Z"),
      idGenerator: () => "event-1",
    });

    const text = store.appendEvent({
      id: "event-1",
      sessionId: "session-1",
      hostId: "openclaw",
      type: "text",
      payload: { text: "hello" },
    });
    const duplicate = store.appendEvent({
      id: "event-1",
      sessionId: "session-1",
      hostId: "openclaw",
      type: "text",
      payload: { text: "ignored" },
    });
    const tool = store.appendEvent({
      id: "event-2",
      sessionId: "session-1",
      hostId: "openclaw",
      type: "tool",
      payload: { name: "gbrain_read" },
    });

    expect(text).toMatchObject({
      appended: true,
      duplicate: false,
      event: {
        type: "message",
        payload: { text: "hello" },
      },
    });
    expect(duplicate).toMatchObject({
      appended: false,
      duplicate: true,
      event: {
        payload: { text: "hello" },
      },
    });
    expect(tool.event.type).toBe("tool-call");
    expect(store.listEvents("session-1").map((event) => event.id)).toEqual([
      "event-1",
      "event-2",
    ]);
  });

  it("keeps stale event provenance without moving the session backward", () => {
    const sessions = createRuntimeSessionStore();
    sessions.createSession({
      id: "session-1",
      hostId: "openclaw",
      mode: "chat",
      status: "completed",
      updatedAt: "2026-04-22T10:05:00.000Z",
    });
    const events = createRuntimeEventStore({ sessions });

    const result = events.appendEvent({
      id: "late-running-status",
      sessionId: "session-1",
      hostId: "openclaw",
      type: "status",
      createdAt: "2026-04-22T10:00:00.000Z",
      payload: { status: "running" },
    });

    expect(result).toMatchObject({
      appended: true,
      stale: true,
      event: {
        payload: {
          status: "running",
          runtimeEventStale: true,
        },
      },
    });
    expect(sessions.getSession("session-1")?.status).toBe("completed");
    expect(events.listEvents("session-1")).toHaveLength(1);
  });

  it("adds a truncation marker when the per-session byte cap is exceeded", () => {
    const events = createRuntimeEventStore({
      now: () => new Date("2026-04-22T10:00:00.000Z"),
      retention: {
        eventTtlMs: null,
        maxEventLogBytesPerSession: 1_200,
      },
    });

    events.appendEvent({
      id: "event-1",
      sessionId: "session-1",
      hostId: "openclaw",
      type: "text",
      payload: { text: "first".repeat(100) },
    });
    const result = events.appendEvent({
      id: "event-2",
      sessionId: "session-1",
      hostId: "openclaw",
      type: "text",
      payload: { text: "second".repeat(100) },
    });

    const retained = events.listEvents("session-1");
    expect(result.truncated).toBe(true);
    expect(retained[0]).toMatchObject({
      type: "status",
      payload: {
        runtimeEventLogTruncated: true,
        reason: "retention-policy",
      },
    });
    expect(retained.some((event) => event.id === "event-2")).toBe(true);

    const replayEvicted = events.appendEvent({
      id: "event-1",
      sessionId: "session-1",
      hostId: "openclaw",
      type: "text",
      payload: { text: "first replayed after retention" },
    });
    const replayRetained = events.appendEvent({
      id: "event-2",
      sessionId: "session-1",
      hostId: "openclaw",
      type: "text",
      payload: { text: "second replay ignored" },
    });

    expect(replayEvicted.appended).toBe(true);
    expect(replayRetained).toMatchObject({
      appended: false,
      duplicate: true,
    });
  });

  it("accounts for TTL-dropped bytes without assuming dropped events are a prefix", () => {
    const fresh: RuntimeEvent = {
      id: "fresh",
      sessionId: "session-1",
      hostId: "openclaw",
      type: "message",
      createdAt: "2026-04-22T10:00:00.000Z",
      payload: { text: "fresh event" },
    };
    const expired: RuntimeEvent = {
      id: "expired",
      sessionId: "session-1",
      hostId: "openclaw",
      type: "message",
      createdAt: "2026-04-22T09:00:00.000Z",
      payload: { text: "expired event with unique byte accounting" },
    };

    const retained = applyRuntimeEventRetention({
      sessionId: "session-1",
      events: [fresh, expired],
      now: new Date("2026-04-22T10:00:00.000Z"),
      policy: {
        eventTtlMs: 30 * 60 * 1000,
        maxEventLogBytesPerSession: 10_000,
      },
    });

    expect(retained.events.map((event) => event.id)).toEqual([
      "runtime-event-log-truncated:session-1",
      "fresh",
    ]);
    expect(retained.droppedEventCount).toBe(1);
    expect(retained.droppedApproximateBytes).toBe(
      Buffer.byteLength(JSON.stringify(expired), "utf8"),
    );
  });
});
