import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/runtime/health/route";
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

function adapter(profile: RuntimeHostProfile): ResearchRuntimeHost {
  return {
    profile: () => profile,
    health: async () => ({
      status: "ready",
      checkedAt: "2026-04-22T12:00:00.000Z",
      detail: `${profile.id} ready`,
    }),
    authStatus: async () => ({
      status: "not-required",
      authMode: profile.authMode,
      provider: profile.authProvider,
    }),
    privacyProfile: async () => ({
      privacyClass: profile.privacyClass,
      adapterProof: profile.privacyClass === "hosted"
        ? "declared-hosted"
        : "declared-local",
    }),
    sendTurn: async (request: RuntimeTurnRequest) => ({
      hostId: profile.id,
      sessionId: request.conversationId ?? "session-1",
      message: "ok",
    }),
    executeTask: async (request: RuntimeTurnRequest) => ({
      id: request.conversationId ?? "session-1",
      hostId: profile.id,
      projectId: request.projectId,
      conversationId: request.conversationId,
      mode: request.mode,
      status: "completed",
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:00:00.000Z",
      preview: request.preview,
    }),
    cancel: async (sessionId: string) => ({ sessionId, cancelled: true }),
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
    now: () => new Date("2026-04-22T12:00:00.000Z"),
  });
});

afterEach(() => {
  __resetRuntimeApiServicesForTests();
});

describe("GET /api/runtime/health", () => {
  it("returns host health, auth, capability, and MCP profile data", async () => {
    const response = await GET(new Request("http://localhost/api/runtime/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    const codex = body.hosts.find(
      (host: { profile: { id: string } }) => host.profile.id === "codex",
    );
    expect(codex).toMatchObject({
      profile: {
        id: "codex",
        authMode: "subscription-native",
        capabilities: expect.arrayContaining(["chat", "task", "mcp-tools"]),
        mcpTools: expect.arrayContaining(["gbrain_search", "gbrain_capture"]),
      },
      health: { status: "ready" },
      auth: { status: "not-required" },
    });
    expect(body.checkedAt).toBe("2026-04-22T12:00:00.000Z");
  });

  it("rejects non-local runtime health requests", async () => {
    const response = await GET(new Request("https://example.com/api/runtime/health"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      code: "RUNTIME_INVALID_REQUEST",
      recoverable: false,
    });
  });
});
