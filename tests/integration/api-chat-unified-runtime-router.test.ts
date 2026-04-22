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
  sendAgentMessage: sendOpenClawMessage,
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

import { POST } from "@/app/api/chat/unified/route";
import {
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
      preview: {
        allowed: true,
        projectPolicy: "local-only",
        hostId: "codex",
        mode: "chat",
        effectivePrivacyClass: "local-network",
        destinations: [
          {
            hostId: "codex",
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
      },
    })).resolves.toMatchObject({
      hostId: "codex",
      sessionId: "conversation-alpha",
      message: "profiled adapter response",
    });
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
        status: "completed",
      }),
    ]);
  });
});
