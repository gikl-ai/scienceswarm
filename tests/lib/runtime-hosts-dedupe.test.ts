import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUNTIME_DEDUPE_WINDOWS_MS,
  createRuntimeDedupeStore,
  createRuntimeIdempotencyKey,
} from "@/lib/runtime-hosts";

describe("runtime dedupe policy", () => {
  it("builds stable idempotency keys from operation, hosts, prompt hash, and client submit id", () => {
    const left = createRuntimeIdempotencyKey({
      operation: "compare",
      projectId: "project-alpha",
      conversationId: "conversation-1",
      hostIds: ["codex", "openclaw"],
      prompt: "  compare   this  ",
      clientSubmitId: "client-1",
    });
    const right = createRuntimeIdempotencyKey({
      operation: "compare",
      projectId: "project-alpha",
      conversationId: "conversation-1",
      hostIds: ["openclaw", "codex"],
      prompt: "compare this",
      clientSubmitId: "client-1",
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^runtime:compare:[a-f0-9]{64}$/);
  });

  it("dedupes in-flight chat operations regardless of rerun intent", () => {
    const store = createRuntimeDedupeStore();
    const key = "runtime:chat:in-flight";

    expect(
      store.claimOperation({
        key,
        operation: "chat",
        sessionId: "session-1",
      }),
    ).toMatchObject({
      decision: "claimed",
      record: { sessionId: "session-1", status: "in-flight" },
    });

    expect(
      store.claimOperation({
        key,
        operation: "chat",
        sessionId: "session-2",
        bypassCompletedDedupe: true,
      }),
    ).toMatchObject({
      decision: "deduped-in-flight",
      record: { sessionId: "session-1", status: "in-flight" },
    });
  });

  it("dedupes completed chat for two minutes, then allows a new claim", () => {
    let nowMs = Date.parse("2026-04-22T10:00:00.000Z");
    const store = createRuntimeDedupeStore({
      now: () => new Date(nowMs),
    });
    const key = "runtime:chat:completed-window";

    store.claimOperation({
      key,
      operation: "chat",
      sessionId: "session-1",
    });
    const completed = store.completeOperation(key);
    expect(completed?.expiresAt).toBe("2026-04-22T10:02:00.000Z");

    nowMs += DEFAULT_RUNTIME_DEDUPE_WINDOWS_MS.chat - 1;
    expect(
      store.claimOperation({
        key,
        operation: "chat",
        sessionId: "session-2",
      }),
    ).toMatchObject({
      decision: "deduped-completed",
      record: { sessionId: "session-1", status: "completed" },
    });

    nowMs += 2;
    expect(
      store.claimOperation({
        key,
        operation: "chat",
        sessionId: "session-2",
      }),
    ).toMatchObject({
      decision: "claimed",
      record: { sessionId: "session-2", status: "in-flight" },
    });
  });

  it("lets explicit reruns bypass completed dedupe but not in-flight dedupe", () => {
    const store = createRuntimeDedupeStore();
    const key = "runtime:chat:rerun";

    store.claimOperation({
      key,
      operation: "chat",
      sessionId: "session-1",
    });
    store.completeOperation(key);

    expect(
      store.claimOperation({
        key,
        operation: "chat",
        sessionId: "session-2",
        bypassCompletedDedupe: true,
      }),
    ).toMatchObject({
      decision: "claimed",
      record: { sessionId: "session-2", status: "in-flight" },
    });

    expect(
      store.claimOperation({
        key,
        operation: "chat",
        sessionId: "session-3",
        bypassCompletedDedupe: true,
      }),
    ).toMatchObject({
      decision: "deduped-in-flight",
      record: { sessionId: "session-2", status: "in-flight" },
    });
  });

  it("keeps completion and failure marking idempotent after a record completes", () => {
    let nowMs = Date.parse("2026-04-22T10:00:00.000Z");
    const store = createRuntimeDedupeStore({
      now: () => new Date(nowMs),
    });
    const key = "runtime:chat:idempotent-complete";

    store.claimOperation({
      key,
      operation: "chat",
      sessionId: "session-1",
    });
    const firstCompletion = store.completeOperation(key);

    nowMs += 60_000;
    expect(store.completeOperation(key, "session-2")).toEqual(firstCompletion);
    expect(store.failOperation(key)).toEqual(firstCompletion);
    expect(
      store.claimOperation({
        key,
        operation: "chat",
        sessionId: "session-3",
      }),
    ).toMatchObject({
      decision: "deduped-completed",
      record: {
        sessionId: "session-1",
        expiresAt: "2026-04-22T10:02:00.000Z",
      },
    });
  });

  it("uses ten-minute task/compare windows and 24-hour artifact import/writeback windows", () => {
    let nowMs = Date.parse("2026-04-22T10:00:00.000Z");
    const store = createRuntimeDedupeStore({
      now: () => new Date(nowMs),
    });

    for (const operation of ["task", "compare"] as const) {
      const key = `runtime:${operation}:window`;
      store.claimOperation({ key, operation, sessionId: `${operation}-1` });
      expect(store.completeOperation(key)?.expiresAt).toBe(
        "2026-04-22T10:10:00.000Z",
      );
    }

    for (const operation of ["artifact-import", "artifact-writeback"] as const) {
      const key = `runtime:${operation}:window`;
      store.claimOperation({ key, operation, sessionId: `${operation}-1` });
      expect(store.completeOperation(key)?.expiresAt).toBe(
        "2026-04-23T10:00:00.000Z",
      );
    }

    nowMs += DEFAULT_RUNTIME_DEDUPE_WINDOWS_MS.compare - 1;
    expect(
      store.claimOperation({
        key: "runtime:compare:window",
        operation: "compare",
        sessionId: "compare-2",
      }),
    ).toMatchObject({
      decision: "deduped-completed",
      record: { sessionId: "compare-1" },
    });

    nowMs = Date.parse("2026-04-23T09:59:59.999Z");
    expect(
      store.claimOperation({
        key: "runtime:artifact-import:window",
        operation: "artifact-import",
        sessionId: "artifact-import-2",
      }),
    ).toMatchObject({
      decision: "deduped-completed",
      record: { sessionId: "artifact-import-1" },
    });
  });
});
