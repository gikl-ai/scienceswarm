import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as previewPOST } from "@/app/api/runtime/preview/route";
import {
  GET as sessionsGET,
  POST as sessionsPOST,
} from "@/app/api/runtime/sessions/route";
import { POST as streamPOST } from "@/app/api/runtime/sessions/stream/route";
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
import { RuntimeHostError } from "@/lib/runtime-hosts/errors";
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

async function readSsePayloads(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

function adapter(
  profile: RuntimeHostProfile,
  options: { onTurn?: (turn: RuntimeTurnRequest) => void } = {},
): ResearchRuntimeHost {
  return {
    profile: () => profile,
    health: async () => ({ status: "ready", checkedAt: "2026-04-22T12:00:00Z" }),
    authStatus: async () => ({
      status: "authenticated",
      authMode: profile.authMode,
      provider: profile.authProvider,
    }),
    privacyProfile: async () => profile.privacyClass,
    sendTurn: async (turn: RuntimeTurnRequest) => {
      options.onTurn?.(turn);
      turn.onEvent?.({
        id: `${profile.id}:stream-message`,
        sessionId: turn.conversationId ?? `${profile.id}-new-wrapper`,
        hostId: profile.id,
        type: "message",
        createdAt: "2026-04-22T12:00:00Z",
        payload: {
          text: `stream from ${profile.id}: ${turn.prompt}`,
          nativeSessionId: `${profile.id}-native-session`,
        },
      });
      return {
        hostId: profile.id,
        sessionId: `${profile.id}-native-session`,
        message: `reply from ${profile.id}: ${turn.prompt}`,
      };
    },
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

  it("rejects invalid status filters instead of casting arbitrary strings", async () => {
    const response = await sessionsGET(
      new Request("http://localhost/api/runtime/sessions?status=not-a-status"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: "RUNTIME_INVALID_REQUEST",
    });
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

  it("streams runtime chat events without passing wrapper session ids as native resume ids", async () => {
    const turns: RuntimeTurnRequest[] = [];
    __setRuntimeApiServicesForTests({
      sessionStore: sessions,
      eventStore: createRuntimeEventStore({ sessions }),
      adapters: [
        adapter(requireRuntimeHostProfile("codex"), {
          onTurn: (turn) => turns.push(turn),
        }),
      ],
      now: () => new Date("2026-04-22T12:00:00Z"),
    });

    const response = await streamPOST(jsonRequest(
      "http://localhost/api/runtime/sessions/stream",
      {
        hostId: "codex",
        projectId: "project-alpha",
        projectPolicy: "cloud-ok",
        mode: "chat",
        prompt: "Hosted turn",
        approvalState: "approved",
      },
    ));
    const payloads = await readSsePayloads(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(turns).toHaveLength(1);
    expect(turns[0].conversationId).toBeNull();
    const messageTexts = payloads.flatMap((payload) => {
      const event = payload.event;
      if (!event || typeof event !== "object") return [];
      const runtimeEvent = event as { type?: unknown; payload?: unknown };
      if (runtimeEvent.type !== "message") return [];
      const eventPayload = runtimeEvent.payload;
      if (!eventPayload || typeof eventPayload !== "object") return [];
      const text = (eventPayload as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });

    expect(messageTexts).toEqual(["stream from codex: Hosted turn"]);
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: "message",
            payload: expect.objectContaining({
              text: "stream from codex: Hosted turn",
              nativeSessionId: "codex-native-session",
            }),
          }),
        }),
        expect.objectContaining({
          session: expect.objectContaining({
            hostId: "codex",
            status: "completed",
            conversationId: "codex-native-session",
          }),
        }),
      ]),
    );
  });

  it("stores semantic RuntimeHostError codes on failed sessions", async () => {
    __setRuntimeApiServicesForTests({
      sessionStore: sessions,
      eventStore: createRuntimeEventStore({ sessions }),
      adapters: [
        {
          ...adapter(requireRuntimeHostProfile("openclaw")),
          sendTurn: async () => {
            throw new RuntimeHostError({
              code: "RUNTIME_HOST_AUTH_REQUIRED",
              status: 401,
              message: "OpenClaw auth required.",
              userMessage: "OpenClaw needs authentication.",
              recoverable: true,
            });
          },
        },
      ],
      now: () => new Date("2026-04-22T12:00:00Z"),
    });

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
    const [session] = sessions.listSessions();

    expect(response.status).toBe(401);
    expect(body.code).toBe("RUNTIME_HOST_AUTH_REQUIRED");
    expect(session?.errorCode).toBe("RUNTIME_HOST_AUTH_REQUIRED");
    expect(session?.status).toBe("failed");
  });

  it("keeps duplicate artifact source paths as distinct runtime events", async () => {
    __setRuntimeApiServicesForTests({
      sessionStore: sessions,
      eventStore: createRuntimeEventStore({ sessions }),
      adapters: [
        {
          ...adapter(requireRuntimeHostProfile("openclaw")),
          sendTurn: async () => ({
            hostId: "openclaw",
            sessionId: "openclaw-native-session",
            message: "two artifacts",
            artifacts: [
              {
                sessionId: "openclaw-native-session",
                hostId: "openclaw",
                sourcePath: "results/summary.md",
                sourceNamespace: "project-relative",
                provenance: {
                  generatedByHostId: "openclaw",
                  runtimeSessionId: "openclaw-native-session",
                  privacyClass: "local-only",
                },
              },
              {
                sessionId: "openclaw-native-session",
                hostId: "openclaw",
                sourcePath: "results/summary.md",
                sourceNamespace: "project-relative",
                provenance: {
                  generatedByHostId: "openclaw",
                  runtimeSessionId: "openclaw-native-session",
                  privacyClass: "local-only",
                },
              },
            ],
          }),
        },
      ],
      now: () => new Date("2026-04-22T12:00:00Z"),
    });

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
    const artifactEvents = body.events.filter(
      (event: { type: string }) => event.type === "artifact",
    );

    expect(response.status).toBe(200);
    expect(artifactEvents).toHaveLength(2);
    expect(new Set(artifactEvents.map((event: { id: string }) => event.id)).size).toBe(2);
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

  it("does not append a failure event when non-streaming CLI cancellation wins the race", async () => {
    __setRuntimeApiServicesForTests({
      sessionStore: sessions,
      eventStore: createRuntimeEventStore({ sessions }),
      adapters: [
        {
          ...adapter(requireRuntimeHostProfile("codex")),
          sendTurn: async (turn) => {
            if (!turn.runtimeSessionId) {
              throw new Error("expected runtimeSessionId");
            }
            await cancelPOST(
              new Request(
                `http://localhost/api/runtime/sessions/${turn.runtimeSessionId}/cancel`,
                { method: "POST" },
              ),
              params(turn.runtimeSessionId),
            );
            throw new RuntimeHostError({
              code: "RUNTIME_TRANSPORT_ERROR",
              status: 502,
              message: "Runtime CLI exited due to signal SIGTERM.",
              userMessage: "Runtime host command was interrupted.",
              recoverable: true,
            });
          },
        },
      ],
      now: () => new Date("2026-04-22T12:00:00Z"),
    });

    const response = await sessionsPOST(jsonRequest(
      "http://localhost/api/runtime/sessions",
      {
        hostId: "codex",
        projectId: "project-alpha",
        projectPolicy: "cloud-ok",
        mode: "chat",
        prompt: "Hosted turn",
        approvalState: "approved",
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session).toMatchObject({
      status: "cancelled",
    });
    expect(body.events).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ type: "error" }),
      ]),
    );
  });
});
