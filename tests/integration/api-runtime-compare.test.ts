import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/runtime/compare/route";
import {
  __resetRuntimeApiServicesForTests,
  __setRuntimeApiServicesForTests,
} from "@/app/api/runtime/_shared";
import { createRuntimeConcurrencyManager } from "@/lib/runtime-hosts/concurrency";
import { createRuntimeEventStore } from "@/lib/runtime-hosts/events";
import {
  RuntimeSessionStore,
  createRuntimeSessionStore,
  type CreateRuntimeSessionInput,
} from "@/lib/runtime-hosts/sessions";
import {
  createApiKeyRuntimeHostProfile,
} from "@/lib/runtime-hosts/adapters/api-key";
import type {
  ResearchRuntimeHost,
  RuntimeSessionRecord,
  RuntimeHostProfile,
  RuntimeTurnRequest,
} from "@/lib/runtime-hosts/contracts";
import { requireRuntimeHostProfile } from "@/lib/runtime-hosts/registry";

function request(body: unknown): Request {
  return new Request("http://localhost/api/runtime/compare", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function adapter(
  profile: RuntimeHostProfile,
  options: { fail?: boolean; onTurn?: (turn: RuntimeTurnRequest) => void } = {},
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
      if (options.fail) throw new Error(`${profile.id} failed`);
      return {
        hostId: profile.id,
        sessionId: `${profile.id}-native-session`,
        message: `${profile.label} says ${turn.prompt}`,
      };
    },
    executeTask: async (turn: RuntimeTurnRequest) => ({
      id: `${profile.id}-task-session`,
      hostId: profile.id,
      projectId: turn.projectId,
      conversationId: turn.conversationId,
      mode: turn.mode,
      status: "completed",
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

class MissingPreviewReturnSessionStore extends RuntimeSessionStore {
  createSession(input: CreateRuntimeSessionInput): RuntimeSessionRecord {
    const session = super.createSession(input);
    if (input.mode !== "chat") return session;
    return {
      ...session,
      preview: undefined,
    };
  }
}

function installAdapters(adapters: ResearchRuntimeHost[]) {
  const sessions = createRuntimeSessionStore({
    now: () => new Date("2026-04-22T12:00:00Z"),
    idGenerator: (() => {
      let index = 0;
      return () => `compare-session-${++index}`;
    })(),
  });
  __setRuntimeApiServicesForTests({
    sessionStore: sessions,
    eventStore: createRuntimeEventStore({ sessions }),
    concurrencyManager: createRuntimeConcurrencyManager({
      policy: { compare: { maxChildren: 3 } },
    }),
    adapters,
    now: () => new Date("2026-04-22T12:00:00Z"),
  });
  return sessions;
}

beforeEach(() => {
  installAdapters([
    adapter(requireRuntimeHostProfile("openclaw")),
    adapter(requireRuntimeHostProfile("codex")),
  ]);
});

afterEach(() => {
  __resetRuntimeApiServicesForTests();
});

describe("POST /api/runtime/compare", () => {
  it("creates no parent or child sessions until all selected hosts pass policy", async () => {
    const sessions = installAdapters([
      adapter(requireRuntimeHostProfile("openclaw")),
      adapter(requireRuntimeHostProfile("codex")),
    ]);

    const response = await POST(request({
      projectId: "project-alpha",
      projectPolicy: "local-only",
      selectedHostIds: ["openclaw", "codex"],
      prompt: "Compare models.",
      approvalState: "approved",
    }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("RUNTIME_PRIVACY_BLOCKED");
    expect(sessions.listSessions()).toHaveLength(0);
  });

  it("returns partial results when one child host fails", async () => {
    installAdapters([
      adapter(requireRuntimeHostProfile("openclaw")),
      adapter(requireRuntimeHostProfile("codex"), { fail: true }),
    ]);

    const response = await POST(request({
      projectId: "project-alpha",
      projectPolicy: "cloud-ok",
      selectedHostIds: ["openclaw", "codex"],
      prompt: "Compare models.",
      approvalState: "approved",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.partialFailure).toBe(true);
    expect(body.parentSession).toMatchObject({
      mode: "compare",
      status: "completed",
    });
    expect(body.childResults).toEqual([
      expect.objectContaining({ hostId: "openclaw", status: "completed" }),
      expect.objectContaining({ hostId: "codex", status: "failed" }),
    ]);
    expect(body.synthesisPreview.dataIncluded).toHaveLength(1);
  });

  it("includes API-key cost and account disclosure for compare fan-out", async () => {
    const apiKeyCodex = createApiKeyRuntimeHostProfile("openai");
    installAdapters([
      adapter(requireRuntimeHostProfile("openclaw")),
      adapter(apiKeyCodex),
    ]);

    const response = await POST(request({
      projectId: "project-alpha",
      projectPolicy: "cloud-ok",
      selectedHostIds: ["codex"],
      prompt: "Compare API key host.",
      approvalState: "approved",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.comparePreview.accountDisclosure).toMatchObject({
      authMode: "api-key",
      accountSource: ".env",
      costCopyRequired: true,
      compareFanOutCount: 1,
    });
  });

  it("uses each child's own preview when a returned child session omits preview", async () => {
    const turnPreviewHosts: string[] = [];
    const sessions = new MissingPreviewReturnSessionStore({
      now: () => new Date("2026-04-22T12:00:00Z"),
      idGenerator: (() => {
        let index = 0;
        return () => `compare-session-${++index}`;
      })(),
    });
    __setRuntimeApiServicesForTests({
      sessionStore: sessions,
      eventStore: createRuntimeEventStore({ sessions }),
      concurrencyManager: createRuntimeConcurrencyManager({
        policy: { compare: { maxChildren: 3 } },
      }),
      adapters: [
        adapter(requireRuntimeHostProfile("openclaw"), {
          onTurn: (turn) => turnPreviewHosts.push(turn.preview.hostId),
        }),
        adapter(requireRuntimeHostProfile("codex"), {
          onTurn: (turn) => turnPreviewHosts.push(turn.preview.hostId),
        }),
      ],
      now: () => new Date("2026-04-22T12:00:00Z"),
    });

    const response = await POST(request({
      projectId: "project-alpha",
      projectPolicy: "cloud-ok",
      selectedHostIds: ["openclaw", "codex"],
      prompt: "Compare models.",
      approvalState: "approved",
    }));

    expect(response.status).toBe(200);
    expect(turnPreviewHosts.sort()).toEqual(["codex", "openclaw"]);
  });
});
