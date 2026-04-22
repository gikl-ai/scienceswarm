import { describe, expect, it } from "vitest";

import {
  RuntimeHostError,
  createRuntimeSessionStore,
} from "@/lib/runtime-hosts";

describe("runtime session store", () => {
  it("creates, updates, reads, and filters operational runtime sessions", () => {
    const store = createRuntimeSessionStore({
      now: () => new Date("2026-04-22T10:00:00.000Z"),
      idGenerator: () => "session-1",
    });

    const created = store.createSession({
      hostId: "openclaw",
      projectId: "project-alpha",
      conversationId: "conversation-1",
      mode: "chat",
    });

    expect(created).toMatchObject({
      id: "rt-session-session-1",
      hostId: "openclaw",
      projectId: "project-alpha",
      conversationId: "conversation-1",
      mode: "chat",
      status: "queued",
      readOnly: undefined,
    });

    const updated = store.updateSession(created.id, {
      status: "running",
      updatedAt: "2026-04-22T10:00:05.000Z",
    });

    expect(updated).toMatchObject({
      id: created.id,
      status: "running",
      updatedAt: "2026-04-22T10:00:05.000Z",
    });
    expect(store.getSession(created.id)).toEqual(updated);
    expect(store.listSessions({ projectId: "project-alpha" })).toEqual([
      updated,
    ]);
    expect(store.listSessions({ status: "queued" })).toEqual([]);
  });

  it("keeps unknown historical host sessions readable and read-only marked", () => {
    const store = createRuntimeSessionStore();

    const session = store.createSession({
      id: "legacy-session",
      hostId: "legacy-runtime-v1",
      mode: "chat",
    });

    expect(session).toMatchObject({
      id: "legacy-session",
      hostId: "legacy-runtime-v1",
      readOnly: true,
    });
    expect(store.getSession("legacy-session")).toEqual(session);
  });

  it("allows project and conversation ids to be cleared explicitly", () => {
    const store = createRuntimeSessionStore();
    const session = store.createSession({
      id: "session-1",
      hostId: "openclaw",
      projectId: "project-alpha",
      conversationId: "conversation-1",
      mode: "chat",
    });

    const updated = store.updateSession(session.id, {
      projectId: null,
      conversationId: null,
    });

    expect(updated).toMatchObject({
      projectId: null,
      conversationId: null,
    });
  });

  it("prevents runtime status from moving backward", () => {
    const store = createRuntimeSessionStore();
    const session = store.createSession({
      id: "session-1",
      hostId: "openclaw",
      mode: "chat",
      status: "completed",
      updatedAt: "2026-04-22T10:00:00.000Z",
    });

    expect(() =>
      store.updateSession(session.id, {
        status: "running",
        updatedAt: "2026-04-22T10:01:00.000Z",
      })
    ).toThrow(RuntimeHostError);

    expect(store.getSession(session.id)?.status).toBe("completed");
  });
});
