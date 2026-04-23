import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ArtifactImportRequest,
  ResearchRuntimeHost,
  RuntimeCancelResult,
  RuntimeEvent,
  RuntimeHostAuthStatus,
  RuntimeHostHealth,
  RuntimeSessionRecord,
  RuntimeTurnRequest,
  RuntimeTurnResult,
} from "@/lib/runtime-hosts";

const {
  isLocalRequest,
  resolveAgentConfig,
  agentHealthCheck,
  openClawHealthCheck,
  sendOpenClawMessage,
  runOpenClaw,
  streamChat,
  localHealthCheck,
  hasLocalModel,
  getLocalModel,
  isLocalProviderConfigured,
  injectBrainContextIntoUserMessage,
  parseFile,
  enforceCloudPrivacy,
  checkRateLimit,
  ensureBrainStoreReady,
  getBrainStore,
  listOpenClawSkills,
  sendMessageViaGateway,
  isGatewayPostAckError,
  GatewayPostAckError,
} = vi.hoisted(() => ({
  isLocalRequest: vi.fn(),
  resolveAgentConfig: vi.fn(),
  agentHealthCheck: vi.fn(),
  openClawHealthCheck: vi.fn(),
  sendOpenClawMessage: vi.fn(),
  runOpenClaw: vi.fn(),
  streamChat: vi.fn(),
  localHealthCheck: vi.fn(),
  hasLocalModel: vi.fn(),
  getLocalModel: vi.fn(),
  isLocalProviderConfigured: vi.fn(),
  injectBrainContextIntoUserMessage: vi.fn((message: string) => message),
  parseFile: vi.fn(),
  enforceCloudPrivacy: vi.fn<() => Promise<Response | null>>(async () => null),
  checkRateLimit: vi.fn(),
  ensureBrainStoreReady: vi.fn(),
  getBrainStore: vi.fn(),
  listOpenClawSkills: vi.fn(),
  sendMessageViaGateway: vi.fn(),
  isGatewayPostAckError: vi.fn(() => false),
  GatewayPostAckError: class GatewayPostAckError extends Error {},
}));

vi.mock("@/lib/agent-client", () => ({
  resolveAgentConfig,
  agentHealthCheck,
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest,
}));

vi.mock("@/lib/openclaw", () => ({
  healthCheck: openClawHealthCheck,
  gatewayHealthCheck: openClawHealthCheck,
  sendAgentMessage: sendOpenClawMessage,
  sendOpenClawChatMessage: sendOpenClawMessage,
  getConversationMessagesSince: vi.fn(),
}));

vi.mock("@/lib/openclaw/runner", () => ({
  runOpenClaw,
}));

vi.mock("@/lib/openclaw-bridge", () => ({
  processMessage: vi.fn(),
}));

vi.mock("@/lib/message-handler", () => ({
  streamChat,
}));

vi.mock("@/lib/local-llm", () => ({
  healthCheck: localHealthCheck,
  hasModel: hasLocalModel,
  getLocalModel,
  isLocalProviderConfigured,
}));

vi.mock("@/brain/chat-inject", () => ({
  injectBrainContextIntoUserMessage,
}));

vi.mock("@/brain/store", () => ({
  ensureBrainStoreReady,
  getBrainStore,
}));

vi.mock("@/lib/openclaw/skill-catalog", () => ({
  listOpenClawSkills,
}));

vi.mock("@/lib/openclaw/gateway-ws-client", () => ({
  sendMessageViaGateway,
  isGatewayPostAckError,
  GatewayPostAckError,
}));

vi.mock("@/lib/privacy-policy", () => ({
  enforceCloudPrivacy,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit,
}));

vi.mock("@/lib/file-parser", () => ({
  parseFile,
}));

vi.mock("@/lib/openhands", () => ({
  startConversation: vi.fn(),
  sendPendingMessage: vi.fn(),
  getEvents: vi.fn(),
  getConversation: vi.fn(),
  OPENHANDS_URL: "http://openhands.test",
}));

import {
  __resetConfiguredAgentRuntimeStatusCacheForTests,
  POST,
} from "@/app/api/chat/unified/route";
import {
  createRuntimeEventStore,
  createRuntimeHostRouter,
  createRuntimeSessionStore,
  getDefaultRuntimeSessionStore,
  requireRuntimeHostProfile,
} from "@/lib/runtime-hosts";
import { createOpenClawRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/openclaw";

let scienceswarmDir: string | null = null;

function ensureScienceSwarmDir(): string {
  if (!scienceswarmDir) {
    scienceswarmDir = mkdtempSync(
      path.join(tmpdir(), "scienceswarm-runtime-router-"),
    );
    process.env.SCIENCESWARM_DIR = scienceswarmDir;
    process.env.BRAIN_ROOT = path.join(scienceswarmDir, "brain");
    process.env.SCIENCESWARM_USER_HANDLE = "test-scientist";
  }
  return scienceswarmDir;
}

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/chat/unified", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": "runtime-router-test",
    },
    body: JSON.stringify(body),
  });
}

function turnPreviewFor(
  profile = requireRuntimeHostProfile("openclaw"),
): RuntimeTurnRequest["preview"] {
  return {
    allowed: true,
    projectPolicy: "local-only",
    hostId: profile.id,
    mode: "chat",
    effectivePrivacyClass: "local-network",
    destinations: [
      {
        hostId: profile.id,
        label: profile.label,
        privacyClass: "local-network",
      },
    ],
    dataIncluded: [],
    proof: {
      projectGatePassed: true,
      operationPrivacyClass: "local-network",
      adapterProof: "declared-local",
    },
    blockReason: null,
    requiresUserApproval: false,
    accountDisclosure: {
      authMode: profile.authMode,
      provider: profile.authProvider,
      billingClass: "local-compute",
      accountSource: "local-service",
      costCopyRequired: false,
    },
  };
}

class FakeOpenClawHost implements ResearchRuntimeHost {
  readonly sendTurn = vi.fn(async (
    runtimeRequest: RuntimeTurnRequest,
  ): Promise<RuntimeTurnResult> => ({
    hostId: "openclaw",
    sessionId: runtimeRequest.conversationId ?? "runtime-session",
    message: "adapter response",
  }));

  profile() {
    return requireRuntimeHostProfile("openclaw");
  }

  async health(): Promise<RuntimeHostHealth> {
    return {
      status: "ready",
      checkedAt: "2026-04-22T00:00:00.000Z",
    };
  }

  async authStatus(): Promise<RuntimeHostAuthStatus> {
    return {
      status: "not-required",
      authMode: "local",
      provider: "openclaw",
    };
  }

  async privacyProfile() {
    return {
      privacyClass: "local-network" as const,
      adapterProof: "declared-local" as const,
    };
  }

  async executeTask(_request: RuntimeTurnRequest): Promise<RuntimeSessionRecord> {
    throw new Error("not used");
  }

  async cancel(sessionId: string): Promise<RuntimeCancelResult> {
    return {
      sessionId,
      cancelled: false,
    };
  }

  async listSessions(_projectId: string): Promise<RuntimeSessionRecord[]> {
    return [];
  }

  async *streamEvents(_sessionId: string): AsyncIterable<RuntimeEvent> {
    return;
  }

  async artifactImportHints(
    _sessionId: string,
  ): Promise<ArtifactImportRequest[]> {
    return [];
  }
}

beforeEach(() => {
  __resetConfiguredAgentRuntimeStatusCacheForTests();
  vi.clearAllMocks();
  isLocalRequest.mockResolvedValue(true);
  resolveAgentConfig.mockReturnValue({
    type: "openclaw",
    url: "http://localhost:19002",
  });
  agentHealthCheck.mockResolvedValue({ status: "connected" });
  openClawHealthCheck.mockResolvedValue({
    status: "connected",
    gateway: "ws://localhost:19002/ws",
    channels: ["web"],
    agents: 1,
    sessions: 0,
  });
  sendOpenClawMessage.mockResolvedValue("OpenClaw routed response");
  sendMessageViaGateway.mockImplementation(
    async (
      sessionKey: string,
      message: string,
      _opts?: { onEvent?: (event: unknown) => void },
    ) => {
      const text = await sendOpenClawMessage(message, { session: sessionKey });
      return { text: text ?? "", events: [] };
    },
  );
  runOpenClaw.mockResolvedValue({ ok: false, stdout: "", stderr: "" });
  streamChat.mockReset();
  localHealthCheck.mockResolvedValue({
    running: false,
    models: [],
    url: "http://localhost:11434",
  });
  hasLocalModel.mockResolvedValue(false);
  getLocalModel.mockReturnValue("gemma4");
  isLocalProviderConfigured.mockReturnValue(false);
  injectBrainContextIntoUserMessage.mockImplementation(
    (message: string) => message,
  );
  parseFile.mockReset();
  enforceCloudPrivacy.mockResolvedValue(null);
  checkRateLimit.mockReturnValue({
    allowed: true,
    remaining: 30,
    resetMs: 60_000,
  });
  ensureBrainStoreReady.mockResolvedValue(undefined);
  getBrainStore.mockReturnValue({
    health: vi.fn(async () => ({ ok: true })),
    listPages: vi.fn(async () => []),
  });
  listOpenClawSkills.mockResolvedValue([]);
  getDefaultRuntimeSessionStore().clear();
  ensureScienceSwarmDir();
});

afterEach(() => {
  getDefaultRuntimeSessionStore().clear();
  vi.restoreAllMocks();
  if (scienceswarmDir) {
    rmSync(scienceswarmDir, { recursive: true, force: true });
    scienceswarmDir = null;
  }
  delete process.env.SCIENCESWARM_DIR;
  delete process.env.BRAIN_ROOT;
  delete process.env.SCIENCESWARM_USER_HANDLE;
});

describe("runtime host router", () => {
  it("dispatches an OpenClaw turn through the runtime adapter contract", async () => {
    const fakeOpenClaw = new FakeOpenClawHost();
    const sessionStore = createRuntimeSessionStore({
      now: () => new Date("2026-04-22T10:00:00.000Z"),
      idGenerator: () => "runtime-session-1",
    });
    const router = createRuntimeHostRouter({
      sessionStore,
      adapters: [fakeOpenClaw],
    });

    const result = await router.dispatchTurn({
      hostId: "openclaw",
      projectPolicy: "local-only",
      projectId: "project-alpha",
      conversationId: "web-project-alpha-session-1",
      mode: "chat",
      prompt: "Summarize the latest notes",
      approvalState: "not-required",
    });

    expect(fakeOpenClaw.sendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "openclaw",
        projectId: "project-alpha",
        conversationId: "web-project-alpha-session-1",
        prompt: "Summarize the latest notes",
      }),
    );
    expect(result.result).toMatchObject({
      hostId: "openclaw",
      sessionId: "web-project-alpha-session-1",
      message: "adapter response",
    });
    expect(sessionStore.listSessions()).toEqual([
      expect.objectContaining({
        hostId: "openclaw",
        projectId: "project-alpha",
        conversationId: "web-project-alpha-session-1",
        status: "completed",
      }),
    ]);
  });

  it("marks a prepared turn failed when dispatch cannot find an adapter", async () => {
    const sessionStore = createRuntimeSessionStore({
      now: () => new Date("2026-04-22T10:00:00.000Z"),
      idGenerator: () => "runtime-session-missing-adapter",
    });
    const eventStore = createRuntimeEventStore({
      sessions: sessionStore,
      now: () => new Date("2026-04-22T10:00:01.000Z"),
    });
    const router = createRuntimeHostRouter({
      sessionStore,
      eventStore,
      adapters: [],
    });

    await expect(router.dispatchTurn({
      hostId: "openclaw",
      projectPolicy: "local-only",
      projectId: "project-alpha",
      conversationId: "web-project-alpha-session-1",
      mode: "chat",
      prompt: "Summarize the latest notes",
      approvalState: "not-required",
    })).rejects.toMatchObject({
      code: "RUNTIME_HOST_UNKNOWN",
    });

    const [session] = sessionStore.listSessions();
    expect(session).toMatchObject({
      id: "rt-session-runtime-session-missing-adapter",
      status: "failed",
      errorCode: "RUNTIME_HOST_UNKNOWN",
    });
    expect(eventStore.listEvents(session.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          payload: expect.objectContaining({
            status: "failed",
            code: "RUNTIME_HOST_UNKNOWN",
          }),
        }),
      ]),
    );
  });

  it("uses unique terminal event ids when a turn is finished more than once", () => {
    const sessionStore = createRuntimeSessionStore({
      now: () => new Date("2026-04-22T10:00:00.000Z"),
      idGenerator: () => "runtime-session-double-finish",
    });
    const eventStore = createRuntimeEventStore({
      sessions: sessionStore,
      now: () => new Date("2026-04-22T10:00:01.000Z"),
    });
    const router = createRuntimeHostRouter({
      sessionStore,
      eventStore,
    });

    const prepared = router.prepareTurn({
      hostId: "openclaw",
      projectPolicy: "local-only",
      projectId: "project-alpha",
      conversationId: "web-project-alpha-session-1",
      mode: "chat",
      prompt: "Summarize the latest notes",
      approvalState: "not-required",
    });

    router.finishTurn(prepared.session.id, { status: "completed" });
    router.finishTurn(prepared.session.id, { status: "completed" });

    const terminalEvents = eventStore
      .listEvents(prepared.session.id)
      .filter((event) => event.type === "done");
    expect(terminalEvents.map((event) => event.id)).toEqual([
      `${prepared.session.id}:runtime-completed-1`,
      `${prepared.session.id}:runtime-completed-2`,
    ]);
  });

  it("exposes OpenClaw as a local-network runtime adapter", async () => {
    const adapter = createOpenClawRuntimeHostAdapter({
      healthCheck: async () => ({ status: "connected" }),
      sendAgentMessage: async () => "adapter response",
    });

    await expect(adapter.health()).resolves.toMatchObject({
      status: "ready",
    });
    await expect(adapter.authStatus()).resolves.toMatchObject({
      status: "not-required",
      provider: "openclaw",
    });
    await expect(adapter.privacyProfile()).resolves.toMatchObject({
      privacyClass: "local-network",
      adapterProof: "declared-local",
    });

    const profile = {
      ...requireRuntimeHostProfile("openclaw"),
      id: "codex" as const,
    };
    const profiledAdapter = createOpenClawRuntimeHostAdapter({
      profile,
      sendAgentMessage: async () => "profiled adapter response",
    });

    await expect(profiledAdapter.sendTurn({
      hostId: "codex",
      projectId: "project-alpha",
      conversationId: "conversation-alpha",
      mode: "chat",
      prompt: "Test the profile id",
      inputFileRefs: [],
      dataIncluded: [],
      approvalState: "not-required",
      preview: turnPreviewFor(profile),
    })).resolves.toMatchObject({
      hostId: "codex",
      sessionId: "conversation-alpha",
      message: "profiled adapter response",
    });
  });

  it("uses a unique OpenClaw session key when no conversation id is provided", async () => {
    const usedSessions: string[] = [];
    const adapter = createOpenClawRuntimeHostAdapter({
      sendAgentMessage: async (_message, options) => {
        usedSessions.push(options?.session ?? "");
        return "adapter response";
      },
    });
    const requestBase: RuntimeTurnRequest = {
      hostId: "openclaw",
      projectId: "project-alpha",
      conversationId: null,
      mode: "chat",
      prompt: "Run a one-off turn",
      inputFileRefs: [],
      dataIncluded: [],
      approvalState: "not-required",
      preview: turnPreviewFor(),
    };

    const first = await adapter.sendTurn(requestBase);
    const second = await adapter.sendTurn({
      ...requestBase,
      prompt: "Run a second one-off turn",
    });

    expect(first.sessionId).toMatch(/^openclaw-/);
    expect(second.sessionId).toMatch(/^openclaw-/);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(usedSessions).toEqual([first.sessionId, second.sessionId]);
  });
});

describe("/api/chat/unified runtime router facade", () => {
  it("keeps direct backend requests on OpenClaw while recording a runtime session", async () => {
    const response = await POST(request({
      backend: "direct",
      message: "Hello from the runtime facade",
      conversationId: "web:alpha-project:session-1",
      messages: [
        {
          role: "user",
          content: "Hello from the runtime facade",
        },
      ],
      files: [
        {
          name: "empty.txt",
          size: "0",
        },
      ],
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    expect(body).toMatchObject({
      backend: "openclaw",
      response: "OpenClaw routed response",
      conversationId: "web-alpha-project-session-1",
    });
    expect(sendOpenClawMessage).toHaveBeenCalled();

    const sessions = getDefaultRuntimeSessionStore().listSessions({
      hostId: "openclaw",
    });
    expect(sessions).toEqual([
      expect.objectContaining({
        hostId: "openclaw",
        projectId: null,
        conversationId: "web:alpha-project:session-1",
        mode: "chat",
        status: "completed",
        preview: expect.objectContaining({
          allowed: true,
          hostId: "openclaw",
          effectivePrivacyClass: "local-network",
          dataIncluded: expect.arrayContaining([
            expect.objectContaining({
              label: "empty.txt",
              bytes: 0,
            }),
          ]),
        }),
      }),
    ]);
  });

  it("does not create a runtime session when OpenClaw readiness blocks the facade", async () => {
    resolveAgentConfig.mockReturnValue(null);

    const response = await POST(request({
      backend: "direct",
      message: "Try bypassing OpenClaw",
    }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    expect(body).toMatchObject({
      backend: "openclaw",
      error: "Chat requires OpenClaw. Start OpenClaw in Settings.",
    });
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
    expect(getDefaultRuntimeSessionStore().listSessions()).toEqual([]);
  });

  it("records unexpected OpenClaw handler exceptions as handler failures", async () => {
    sendOpenClawMessage.mockRejectedValueOnce(
      new Error("workspace materialization failed"),
    );

    const response = await POST(request({
      backend: "openclaw",
      message: "Trigger a handler failure",
      conversationId: "web:alpha-project:session-2",
      messages: [
        {
          role: "user",
          content: "Trigger a handler failure",
        },
      ],
    }));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: expect.any(String),
      backend: "openclaw",
      mode: "reasoning",
    });
    expect(getDefaultRuntimeSessionStore().listSessions()).toEqual([
      expect.objectContaining({
        hostId: "openclaw",
        conversationId: "web:alpha-project:session-2",
        status: "failed",
        errorCode: "RUNTIME_HANDLER_ERROR",
      }),
    ]);
  });

  it("records OpenClaw failure output as a handler failure", async () => {
    sendOpenClawMessage.mockResolvedValueOnce(
      "OpenClaw error: model not found.",
    );

    const response = await POST(request({
      backend: "openclaw",
      message: "Trigger an agent-level failure",
      conversationId: "web:alpha-project:session-3",
      messages: [
        {
          role: "user",
          content: "Trigger an agent-level failure",
        },
      ],
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      backend: "openclaw",
      conversationId: "web-alpha-project-session-3",
    });
    expect(getDefaultRuntimeSessionStore().listSessions()).toEqual([
      expect.objectContaining({
        hostId: "openclaw",
        conversationId: "web:alpha-project:session-3",
        status: "failed",
        errorCode: "RUNTIME_HANDLER_ERROR",
      }),
    ]);
  });

  it("preserves SSE behavior while completing the runtime session", async () => {
    const response = await POST(request({
      backend: "openclaw",
      mode: "openclaw-tools",
      message: "Run the analysis and save a summary",
      streamPhases: true,
      messages: [
        {
          role: "user",
          content: "Run the analysis and save a summary",
        },
      ],
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    expect(body).toContain("OpenClaw routed response");
    expect(body).toContain("data: [DONE]");
    expect(getDefaultRuntimeSessionStore().listSessions()).toEqual([
      expect.objectContaining({
        hostId: "openclaw",
        mode: "mcp-tool",
        status: "completed",
        preview: expect.objectContaining({
          mode: "mcp-tool",
        }),
      }),
    ]);
  });

  it("fails the runtime session when an SSE client disconnects", async () => {
    let resolveOpenClawMessage: (value: string) => void = () => {};
    sendOpenClawMessage.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveOpenClawMessage = resolve;
      }),
    );

    const response = await POST(request({
      backend: "openclaw",
      mode: "openclaw-tools",
      message: "Start a long analysis",
      streamPhases: true,
      messages: [
        {
          role: "user",
          content: "Start a long analysis",
        },
      ],
    }));
    const reader = response.body?.getReader();

    expect(response.status).toBe(200);
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel();
    expect(getDefaultRuntimeSessionStore().listSessions()).toEqual([
      expect.objectContaining({
        hostId: "openclaw",
        mode: "mcp-tool",
        status: "failed",
        errorCode: "RUNTIME_CLIENT_DISCONNECTED",
      }),
    ]);

    resolveOpenClawMessage("OpenClaw routed response");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
