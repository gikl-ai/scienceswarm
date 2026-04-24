import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/runtime/preview/route";
import {
  __resetRuntimeApiServicesForTests,
  __setRuntimeApiServicesForTests,
} from "@/app/api/runtime/_shared";
import type {
  ResearchRuntimeHost,
  RuntimeHostProfile,
  RuntimeTurnRequest,
} from "@/lib/runtime-hosts/contracts";
import { requireRuntimeHostProfile } from "@/lib/runtime-hosts/registry";

function request(body: unknown): Request {
  return new Request("http://localhost/api/runtime/preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
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
      sessionId: turn.conversationId ?? "native-session",
      message: "ok",
    }),
    executeTask: async (turn: RuntimeTurnRequest) => ({
      id: turn.conversationId ?? "task-session",
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

beforeEach(() => {
  __setRuntimeApiServicesForTests({
    adapters: [
      adapter(requireRuntimeHostProfile("openclaw")),
      adapter(requireRuntimeHostProfile("codex")),
    ],
  });
});

afterEach(() => {
  __resetRuntimeApiServicesForTests();
});

describe("POST /api/runtime/preview", () => {
  it("blocks local-only hosted calls before prompt construction", async () => {
    const response = await POST(request({
      hostId: "codex",
      projectId: "project-alpha",
      projectPolicy: "local-only",
      mode: "chat",
      prompt: "Summarize the assay.",
    }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.code).toBe("RUNTIME_PRIVACY_BLOCKED");
    expect(body.error).toContain("local-only");
  });

  it("returns TurnPreview disclosure for allowed hosted calls", async () => {
    const response = await POST(request({
      hostId: "codex",
      projectId: "project-alpha",
      projectPolicy: "cloud-ok",
      mode: "chat",
      prompt: "Summarize the assay.",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preview).toMatchObject({
      allowed: true,
      hostId: "codex",
      mode: "chat",
      requiresUserApproval: true,
      accountDisclosure: {
        authMode: "subscription-native",
        accountSource: "host-cli-login",
        costCopyRequired: false,
      },
    });
    expect(body.preview.dataIncluded[0]).toMatchObject({
      kind: "prompt",
      label: "User prompt",
    });
  });
});
