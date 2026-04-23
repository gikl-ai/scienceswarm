import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as previewPOST } from "@/app/api/runtime/preview/route";
import {
  GET as sessionsGET,
  POST as sessionsPOST,
} from "@/app/api/runtime/sessions/route";
import { GET as sessionGET } from "@/app/api/runtime/sessions/[sessionId]/route";
import { GET as eventsGET } from "@/app/api/runtime/sessions/[sessionId]/events/route";
import { POST as cancelPOST } from "@/app/api/runtime/sessions/[sessionId]/cancel/route";
import {
  __resetRuntimeApiServicesForTests,
  __setRuntimeApiServicesForTests,
} from "@/app/api/runtime/_shared";
import {
  createRuntimeEventStore,
} from "@/lib/runtime-hosts/events";
import {
  createRuntimeSessionStore,
  type RuntimeSessionStore,
} from "@/lib/runtime-hosts/sessions";
import type {
  ResearchRuntimeHost,
  RuntimeHostProfile,
  RuntimeTurnRequest,
} from "@/lib/runtime-hosts/contracts";
import { requireRuntimeHostProfile } from "@/lib/runtime-hosts/registry";

let sessions: RuntimeSessionStore;

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function params(sessionId: string) {
  return { params: Promise.resolve({ sessionId }) };
}

function adapter(profile: RuntimeHostProfile): ResearchRuntimeHost {
  return {
    profile: () => profile,
    health: async () => ({ status: "ready", checkedAt: "2026-04-22T12:00:00Z" }),
    authStatus: async () => ({
      status: "authenticated",
      authMode: profile.authMode,
      provider: profile.authProvider,
    }),
    privacyProfile: async () => profile.privacyClass,
    sendTurn: async (turn: RuntimeTurnRequest) => ({
      hostId: profile.id,
      sessionId: `${profile.id}-native-session`,
      message: `reply from ${profile.id}: ${turn.prompt}`,
    }),
    executeTask: async (turn: RuntimeTurnRequest) => ({
      id: `${profile.id}-task-session`,
      hostId: profile.id,
      projectId: turn.projectId,
      conversationId: `${profile.id}-conversation`,
      mode: turn.mode,
      status: "running",
      createdAt: "2026-04-22T12:00:00Z",
      updatedAt: "2026-04-22T12:00:00Z",
      preview: turn.preview,
    }),
    cancel: async (sessionId) => ({ sessionId, cancelled: true }),
    listSessions: async () => [],
    streamEvents: async function* () {},
    artifactImportHints: async () => [],
  };
}

beforeEach(() => {
  sessions = createRuntimeSessionStore({
    now: () => new Date("2026-04-22T12:00:00Z"),
    idGenerator: (() => {
      let index = 0;
      return () => `session-${++index}`;
    })(),
  });
  const events = createRuntimeEventStore({
    sessions,
    now: () => new Date("2026-04-22T12:00:00Z"),
    idGenerator: (() => {
      let index = 0;
      return () => `event-${++index}`;
    })(),
  });
  __setRuntimeApiServicesForTests({
    sessionStore: sessions,
    eventStore: events,
    adapters: [
      adapter(requireRuntimeHostProfile("openclaw")),
      adapter(requireRuntimeHostProfile("codex")),
      adapter(requireRuntimeHostProfile("openhands")),
    ],
    now: () => new Date("2026-04-22T12:00:00Z"),
  });
});

afterEach(() => {
  __resetRuntimeApiServicesForTests();
});

describe("runtime session APIs", () => {
  it("lists queued, running, completed, failed, and cancelled states", async () => {
    for (const status of ["queued", "running", "completed", "failed", "cancelled"] as const) {
      sessions.createSession({
        hostId: "openclaw",
        projectId: "project-alpha",
        mode: "chat",
        status,
      });
    }

    const response = await sessionsGET(
      new Request("http://localhost/api/runtime/sessions?projectId=project-alpha"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions.map((session: { status: string }) => session.status)).toEqual([
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("renders unknown historical host ids as read-only session history", async () => {
    const session = sessions.createSession({
      hostId: "retired-host",
      projectId: "project-alpha",
      mode: "chat",
      status: "completed",
    });

    const response = await sessionGET(
      new Request(`http://localhost/api/runtime/sessions/${session.id}`),
      params(session.id),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session.readOnly).toBe(true);
    expect(body.session.host).toMatchObject({
      known: false,
      readOnly: true,
      id: "retired-host",
    });
  });

  it("recomputes policy at send time after a preview and blocks changed local-only policy", async () => {
    const preview = await previewPOST(jsonRequest(
      "http://localhost/api/runtime/preview",
      {
        hostId: "codex",
        projectId: "project-alpha",
        projectPolicy: "cloud-ok",
        mode: "chat",
        prompt: "Use hosted runtime.",
      },
    ));
    expect(preview.status).toBe(200);

    const response = await sessionsPOST(jsonRequest(
      "http://localhost/api/runtime/sessions",
      {
        hostId: "codex",
        projectId: "project-alpha",
        projectPolicy: "local-only",
        mode: "chat",
        prompt: "Use hosted runtime.",
        approvalState: "approved",
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("RUNTIME_PRIVACY_BLOCKED");
    expect(sessions.listSessions()).toHaveLength(0);
  });

  it("creates a completed chat session and exposes its events", async () => {
    const response = await sessionsPOST(jsonRequest(
      "http://localhost/api/runtime/sessions",
      {
        hostId: "openclaw",
        projectId: "project-alpha",
        projectPolicy: "local-only",
        mode: "chat",
        prompt: "Local turn",
        approvalState: "approved",
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session).toMatchObject({
      hostId: "openclaw",
      status: "completed",
      conversationId: "openclaw-native-session",
    });

    const events = await eventsGET(
      new Request(`http://localhost/api/runtime/sessions/${body.session.id}/events`),
      params(body.session.id),
    );
    const eventBody = await events.json();
    expect(eventBody.events.map((event: { type: string }) => event.type)).toEqual(
      expect.arrayContaining(["status", "message", "done"]),
    );
  });

  it("labels wrapper-kill versus host-api cancellation semantics", async () => {
    const wrapperSession = sessions.createSession({
      hostId: "codex",
      projectId: "project-alpha",
      mode: "task",
      status: "running",
    });
    const hostApiSession = sessions.createSession({
      hostId: "openhands",
      projectId: "project-alpha",
      mode: "task",
      status: "running",
    });

    const wrapperResponse = await cancelPOST(
      new Request(`http://localhost/api/runtime/sessions/${wrapperSession.id}/cancel`, {
        method: "POST",
      }),
      params(wrapperSession.id),
    );
    const hostApiResponse = await cancelPOST(
      new Request(`http://localhost/api/runtime/sessions/${hostApiSession.id}/cancel`, {
        method: "POST",
      }),
      params(hostApiSession.id),
    );

    await expect(wrapperResponse.json()).resolves.toMatchObject({
      cancelSemantics: "kill-wrapper-process",
      result: { cancelled: true },
    });
    await expect(hostApiResponse.json()).resolves.toMatchObject({
      cancelSemantics: "host-api-cancel",
      result: { cancelled: true },
    });
  });
});
