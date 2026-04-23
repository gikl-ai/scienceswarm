import path from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageFileRefFromObject } from "@/brain/gbrain-data-contracts";
import { createGbrainFileStore } from "@/brain/gbrain-file-store";
import type { BrainPage } from "@/brain/store";

const {
  isLocalRequest,
  resolveAgentConfig,
  agentHealthCheck,
  sendAgentMessage,
  openClawHealthCheck,
  sendOpenClawMessage,
  getConversationMessagesSince,
  runOpenClaw,
  streamChat,
  localHealthCheck,
  hasLocalModel,
  getLocalModel,
  isLocalProviderConfigured,
  injectBrainContextIntoUserMessage,
  parseFile,
  readFile,
  enforceCloudPrivacy,
  checkRateLimit,
  ensureBrainStoreReady,
  getBrainStore,
  getBrainPage,
  gbrainHealth,
  putBrainPage,
  upsertBrainChunks,
  listOpenClawSkills,
  sendMessageViaGateway,
  isGatewayPostAckError,
  GatewayPostAckError,
} = vi.hoisted(() => ({
  isLocalRequest: vi.fn(),
  resolveAgentConfig: vi.fn(),
  agentHealthCheck: vi.fn(),
  sendAgentMessage: vi.fn(),
  openClawHealthCheck: vi.fn(),
  sendOpenClawMessage: vi.fn(),
  getConversationMessagesSince: vi.fn(),
  runOpenClaw: vi.fn(),
  streamChat: vi.fn(),
  localHealthCheck: vi.fn(),
  hasLocalModel: vi.fn(),
  getLocalModel: vi.fn(),
  isLocalProviderConfigured: vi.fn(),
  injectBrainContextIntoUserMessage: vi.fn((message: string) => message),
  parseFile: vi.fn(),
  readFile: vi.fn(),
  enforceCloudPrivacy: vi.fn<() => Promise<Response | null>>(async () => null),
  checkRateLimit: vi.fn(),
  ensureBrainStoreReady: vi.fn(),
  getBrainStore: vi.fn(),
  getBrainPage: vi.fn(),
  gbrainHealth: vi.fn(),
  putBrainPage: vi.fn(),
  upsertBrainChunks: vi.fn(),
  listOpenClawSkills: vi.fn(),
  sendMessageViaGateway: vi.fn(),
  isGatewayPostAckError: vi.fn(() => false),
  GatewayPostAckError: class GatewayPostAckError extends Error {},
}));

vi.mock("@/lib/agent-client", () => ({
  resolveAgentConfig,
  agentHealthCheck,
  sendAgentMessage,
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest,
}));

vi.mock("@/lib/openclaw", () => ({
  healthCheck: openClawHealthCheck,
  gatewayHealthCheck: openClawHealthCheck,
  sendAgentMessage: sendOpenClawMessage,
  sendOpenClawChatMessage: sendOpenClawMessage,
  getConversationMessagesSince,
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

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile,
  };
});

vi.mock("@/lib/openhands", () => ({
  startConversation: vi.fn(),
  sendPendingMessage: vi.fn(),
  getEvents: vi.fn(),
  getConversation: vi.fn(),
  OPENHANDS_URL: "http://openhands.test",
}));

import { POST as commandPOST } from "@/app/api/chat/command/route";
import {
  __getConfiguredAgentRuntimeStatusCacheSizeForTests,
  __resetConfiguredAgentRuntimeStatusCacheForTests,
  GET,
  POST,
  shouldPreMaterializeProjectWorkspaceForTurn,
} from "@/app/api/chat/unified/route";

let scienceswarmDir: string | null = null;

function ensureScienceSwarmDir(): string {
  if (!scienceswarmDir) {
    scienceswarmDir = mkdtempSync(
      path.join(tmpdir(), "scienceswarm-chat-unified-"),
    );
    process.env.SCIENCESWARM_DIR = scienceswarmDir;
    process.env.BRAIN_ROOT = path.join(scienceswarmDir, "brain");
    process.env.SCIENCESWARM_USER_HANDLE = "test-scientist";
  }
  return scienceswarmDir;
}

function createProjectRoot(slug: string): string {
  const projectRoot = path.join(ensureScienceSwarmDir(), "projects", slug);
  mkdirSync(projectRoot, { recursive: true });
  return projectRoot;
}

function createSharedWorkspaceRoot(): string {
  const workspaceRoot = path.join(ensureScienceSwarmDir(), "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

function writeWorkspaceFile(
  root: string,
  relativePath: string,
  contents: string,
): string {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

async function readSseEvents(
  response: Response,
): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  const events: Array<Record<string, unknown>> = [];

  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") continue;
    events.push(JSON.parse(payload) as Record<string, unknown>);
  }

  return events;
}

function mockDirectLLMStream(text: string): void {
  const encoder = new TextEncoder();
  streamChat.mockResolvedValueOnce(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ text })}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
  );
}

beforeEach(() => {
  __resetConfiguredAgentRuntimeStatusCacheForTests();
  vi.unstubAllGlobals();
  isLocalRequest.mockReset();
  resolveAgentConfig.mockReset();
  agentHealthCheck.mockReset();
  sendAgentMessage.mockReset();
  openClawHealthCheck.mockReset();
  sendOpenClawMessage.mockReset();
  runOpenClaw.mockReset();
  sendMessageViaGateway.mockReset();
  // Default behaviour: route gateway WS calls through the existing
  // sendOpenClawMessage mock so each test only has to stub one function.
  // Tests that need raw WS event semantics can override this.
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
  getConversationMessagesSince.mockReset();
  streamChat.mockReset();
  localHealthCheck.mockReset();
  hasLocalModel.mockReset();
  getLocalModel.mockReset();
  isLocalProviderConfigured.mockReset();
  injectBrainContextIntoUserMessage.mockReset();
  parseFile.mockReset();
  readFile.mockReset();
  enforceCloudPrivacy.mockReset();
  checkRateLimit.mockReset();
  ensureBrainStoreReady.mockReset();
  getBrainStore.mockReset();
  getBrainPage.mockReset();
  gbrainHealth.mockReset();
  putBrainPage.mockReset();
  upsertBrainChunks.mockReset();
  listOpenClawSkills.mockReset();
  isLocalRequest.mockResolvedValue(true);
  injectBrainContextIntoUserMessage.mockImplementation(
    (message: string) => message,
  );
  enforceCloudPrivacy.mockResolvedValue(null);
  checkRateLimit.mockReturnValue({
    allowed: true,
    remaining: 30,
    resetMs: 60_000,
  });
  ensureBrainStoreReady.mockResolvedValue(undefined);
  gbrainHealth.mockResolvedValue({ ok: true });
  upsertBrainChunks.mockResolvedValue(undefined);
  putBrainPage.mockResolvedValue(undefined);
  listOpenClawSkills.mockResolvedValue([]);
  getBrainStore.mockReturnValue({
    getPage: getBrainPage,
    health: gbrainHealth,
    listPages: vi.fn(async () => []),
    engine: {
      transaction: vi.fn(async (run: (tx: unknown) => Promise<void>) =>
        run({
          putPage: putBrainPage,
          upsertChunks: upsertBrainChunks,
        }),
      ),
    },
  });
  localHealthCheck.mockResolvedValue({
    running: false,
    models: [],
    url: "http://localhost:11434",
  });
  hasLocalModel.mockResolvedValue(false);
  getLocalModel.mockReturnValue("gemma4");
  isLocalProviderConfigured.mockReturnValue(false);
  // Default: no agent configured
  resolveAgentConfig.mockReturnValue(null);
  openClawHealthCheck.mockResolvedValue({
    status: "disconnected",
    gateway: "",
    channels: [],
    agents: 0,
    sessions: 0,
  });
  scienceswarmDir = null;
  delete process.env.SCIENCESWARM_DIR;
  delete process.env.BRAIN_ROOT;
  delete process.env.SCIENCESWARM_USER_HANDLE;
});

describe("GET /api/chat/unified", () => {
  it("returns empty messages for poll when CLI is unavailable", async () => {
    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00Z&projectId=test",
    );

    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toEqual([]);
    // CLI not available returns "none" backend
    expect(body.backend).toBe("none");
  });

  it("uses conversation-scoped OpenClaw history when conversationId is provided", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    getConversationMessagesSince.mockResolvedValueOnce([
      {
        id: "channel-1",
        userId: "assistant",
        channel: "telegram",
        content: "Cross-channel reply",
        timestamp: "2026-01-01T00:00:02.000Z",
        conversationId: "web:alpha-project:session-1",
      },
    ]);

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00.000Z&projectId=alpha-project&conversationId=web:alpha-project:session-1",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      backend: "openclaw",
      conversationId: "web-alpha-project-session-1",
      generatedArtifacts: [],
      generatedFiles: [],
      messages: [
        expect.objectContaining({
          id: "channel-1",
          channel: "telegram",
          content: "Cross-channel reply",
        }),
      ],
    });
    expect(getConversationMessagesSince).toHaveBeenCalledWith(
      "web-alpha-project-session-1",
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("discovers the latest project-scoped OpenClaw session when conversationId is missing", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });

    const projectRoot = createProjectRoot("alpha-project");
    const sessionsRoot = path.join(
      ensureScienceSwarmDir(),
      "openclaw",
      "agents",
      "main",
      "sessions",
    );
    mkdirSync(sessionsRoot, { recursive: true });
    const sessionWorkspace = path.join(ensureScienceSwarmDir(), "openclaw", "workspace");
    mkdirSync(path.join(sessionWorkspace, "reports"), { recursive: true });
    const sessionSummaryFile = path.join(
      sessionWorkspace,
      "reports",
      "baseline_vs_variant_summary.md",
    );
    writeFileSync(sessionSummaryFile, "# Summary\n");
    utimesSync(
      sessionSummaryFile,
      new Date("2026-01-01T00:00:02.500Z"),
      new Date("2026-01-01T00:00:02.500Z"),
    );

    const olderSessionId = "web-alpha-project-older";
    const newerSessionId = "web-alpha-project-newer";
    const olderSessionFile = path.join(sessionsRoot, `${olderSessionId}.jsonl`);
    const newerSessionFile = path.join(sessionsRoot, `${newerSessionId}.jsonl`);
    writeFileSync(olderSessionFile, `${JSON.stringify({ type: "session", id: olderSessionId, cwd: sessionWorkspace })}\n`);
    writeFileSync(newerSessionFile, `${JSON.stringify({ type: "session", id: newerSessionId, cwd: sessionWorkspace })}\n`);
    utimesSync(
      olderSessionFile,
      new Date("2026-01-01T00:00:01.000Z"),
      new Date("2026-01-01T00:00:01.000Z"),
    );
    utimesSync(
      newerSessionFile,
      new Date("2026-01-01T00:00:03.000Z"),
      new Date("2026-01-01T00:00:03.000Z"),
    );

    getConversationMessagesSince.mockResolvedValueOnce([
      {
        id: "assistant-finished",
        userId: "assistant",
        role: "assistant",
        channel: "web",
        content:
          "Recovered from the durable project-scoped session. Saved reports/baseline_vs_variant_summary.md.",
        timestamp: "2026-01-01T00:00:04.000Z",
        conversationId: newerSessionId,
      },
    ]);

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00.000Z&projectId=alpha-project",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      backend: "openclaw",
      conversationId: newerSessionId,
      generatedArtifacts: [
        expect.objectContaining({
          projectPath: "docs/baseline_vs_variant_summary.md",
          tool: "OpenClaw CLI",
        }),
      ],
      generatedFiles: ["docs/baseline_vs_variant_summary.md"],
      messages: [
        expect.objectContaining({
          id: "assistant-finished",
          channel: "web",
          content: expect.stringContaining(
            "docs/baseline_vs_variant_summary.md",
          ),
        }),
      ],
    });
    expect(getConversationMessagesSince).toHaveBeenCalledWith(
      newerSessionId,
      "2026-01-01T00:00:00.000Z",
    );
    expect(
      existsSync(
        path.join(projectRoot, "docs", "baseline_vs_variant_summary.md"),
      ),
    ).toBe(true);
  });

  it("reuses already imported poll artifacts instead of creating suffixed duplicates", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });

    const projectRoot = createProjectRoot("alpha-project");
    const sessionsRoot = path.join(
      ensureScienceSwarmDir(),
      "openclaw",
      "agents",
      "main",
      "sessions",
    );
    mkdirSync(sessionsRoot, { recursive: true });

    const sessionWorkspace = path.join(ensureScienceSwarmDir(), "openclaw", "workspace");
    mkdirSync(path.join(sessionWorkspace, "reports"), { recursive: true });
    const sessionSummaryFile = path.join(
      sessionWorkspace,
      "reports",
      "baseline_vs_variant_summary.md",
    );
    writeFileSync(sessionSummaryFile, "# Summary\n");
    utimesSync(
      sessionSummaryFile,
      new Date("2026-01-01T00:00:02.500Z"),
      new Date("2026-01-01T00:00:02.500Z"),
    );

    const sessionId = "web-alpha-project-session-1";
    writeFileSync(
      path.join(sessionsRoot, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: sessionId, cwd: sessionWorkspace })}\n`,
    );

    getConversationMessagesSince.mockResolvedValue([
      {
        id: "assistant-finished",
        userId: "assistant",
        role: "assistant",
        channel: "web",
        content:
          "Recovered from the durable project-scoped session. Saved reports/baseline_vs_variant_summary.md.",
        timestamp: "2026-01-01T00:00:04.000Z",
        conversationId: sessionId,
      },
    ]);

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00.000Z&projectId=alpha-project",
    );

    const firstResponse = await GET(request);
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toMatchObject({
      generatedFiles: ["docs/baseline_vs_variant_summary.md"],
    });

    const secondResponse = await GET(request);
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      generatedFiles: ["docs/baseline_vs_variant_summary.md"],
    });

    expect(
      existsSync(
        path.join(projectRoot, "docs", "baseline_vs_variant_summary.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(projectRoot, "docs", "baseline_vs_variant_summary-2.md"),
      ),
    ).toBe(false);
  });

  it("sanitizes internal log noise from polled OpenClaw assistant responses", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    getConversationMessagesSince.mockResolvedValueOnce([
      {
        id: "assistant-noise",
        userId: "assistant",
        channel: "web",
        content: [
          "[agents/auth-profiles] synced openai-codex credentials from external cli",
          "[agent/embedded] auto-compaction succeeded for openai/gpt-5.4; retrying prompt",
          "",
          "Here is your draft summary.",
          "",
          "",
        ].join("\n"),
        timestamp: "2026-01-01T00:00:05.000Z",
        conversationId: "web:alpha-project:session-1",
      },
    ]);

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00.000Z&projectId=alpha-project&conversationId=web:alpha-project:session-1",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-noise",
          content: "Here is your draft summary.",
        }),
      ]),
    );
    expect(body.messages[0]?.content).not.toContain("[agents/auth-profiles]");
    expect(body.messages[0]?.content).not.toContain("[agent/embedded]");
  });

  it("keeps user-authored bracketed text in cross-channel CLI poll responses", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    runOpenClaw.mockResolvedValueOnce({
      ok: true,
      stdout: JSON.stringify([
        {
          id: "user-cross-channel",
          userId: "user",
          channel: "telegram",
          content: "[agents/auth-profiles] keep this user-authored line",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "assistant-cross-channel",
          userId: "assistant",
          channel: "telegram",
          content: [
            "[agents/auth-profiles] synced openai-codex credentials from external cli",
            "",
            "Delivered update.",
            "",
            "",
          ].join("\n"),
          timestamp: "2026-01-01T00:00:02.000Z",
        },
      ]),
    });

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00.000Z&projectId=alpha-project",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      backend: "openclaw",
      messages: [
        expect.objectContaining({
          id: "user-cross-channel",
          content: "[agents/auth-profiles] keep this user-authored line",
        }),
        expect.objectContaining({
          id: "assistant-cross-channel",
          content: "Delivered update.",
        }),
      ],
    });
    expect(runOpenClaw).toHaveBeenCalledWith(
      ["sessions", "messages", "--json", "--limit", "20"],
      { timeoutMs: 5000 },
    );
  });

  it("imports generated OpenClaw outputs referenced by assistant web completions", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const homeRoot = mkdtempSync(path.join(tmpdir(), "openclaw-home-"));
    vi.stubEnv("HOME", homeRoot);

    const mediaPath = path.join(
      homeRoot,
      ".openclaw",
      "media",
      "tool-image-generation",
      "ratio-trend.jpg",
    );
    mkdirSync(path.dirname(mediaPath), { recursive: true });
    writeFileSync(mediaPath, "binary-image");

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    getConversationMessagesSince.mockResolvedValueOnce([
      {
        id: "assistant-finished",
        userId: "assistant",
        role: "assistant",
        channel: "web",
        content: `I saved the figure to ${mediaPath}.`,
        timestamp: "2026-01-01T00:00:03.000Z",
        conversationId: "web:alpha-project:session-1",
      },
    ]);

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00.000Z&projectId=alpha-project&conversationId=web:alpha-project:session-1",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      generatedFiles: ["figures/ratio-trend.jpg"],
      generatedArtifacts: [
        expect.objectContaining({
          projectPath: "figures/ratio-trend.jpg",
          tool: "OpenClaw CLI",
        }),
      ],
      messages: [
        expect.objectContaining({
          id: "assistant-finished",
          channel: "web",
          content: expect.stringContaining("figures/ratio-trend.jpg"),
        }),
      ],
    });
    expect(
      existsSync(path.join(projectRoot, "figures", "ratio-trend.jpg")),
    ).toBe(true);
  });

  it("materializes authored artifact blocks from polled OpenClaw assistant completions", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const coverLetterPath = path.join(
      projectRoot,
      "docs",
      "revision-package-cover-letter.md",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    getConversationMessagesSince.mockResolvedValueOnce([
      {
        id: "assistant-cover-letter",
        userId: "assistant",
        role: "assistant",
        channel: "web",
        content: [
          "```scienceswarm-artifact path=\"docs/revision-package-cover-letter.md\"",
          "# Cover Letter to the Editor",
          "",
          "Dear Editor,",
          "",
          "We appreciate the reviewers' feedback and submit the revised manuscript for reconsideration.",
          "```",
          "",
          "The following artifacts are available in the workspace:",
          "- `docs/revision-package-cover-letter.md`",
          "- `docs/revision-package-revised-manuscript.md`",
        ].join("\n"),
        timestamp: "2026-01-01T00:00:04.000Z",
        conversationId: "web:alpha-project:session-1",
      },
    ]);

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00.000Z&projectId=alpha-project&conversationId=web:alpha-project:session-1",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      backend: "openclaw",
      generatedFiles: ["docs/revision-package-cover-letter.md"],
      generatedArtifacts: [
        expect.objectContaining({
          projectPath: "docs/revision-package-cover-letter.md",
          tool: "OpenClaw CLI",
        }),
      ],
      messages: [
        expect.objectContaining({
          id: "assistant-cover-letter",
          channel: "web",
          content: expect.stringContaining(
            "docs/revision-package-cover-letter.md",
          ),
        }),
      ],
    });
    expect(existsSync(coverLetterPath)).toBe(true);
    expect(readFileSync(coverLetterPath, "utf-8")).toContain("Dear Editor,");
    expect(body.messages[0]?.content).not.toContain("scienceswarm-artifact");
  });

  it("returns empty poll messages for an invalid conversationId", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00.000Z&projectId=alpha-project&conversationId=../../etc-passwd",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      backend: "none",
      messages: [],
    });
    expect(getConversationMessagesSince).not.toHaveBeenCalled();
  });

  it("returns empty poll messages for an invalid since timestamp", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=not-a-date&projectId=alpha-project&conversationId=web:alpha-project:session-1",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      backend: "none",
      messages: [],
    });
    expect(getConversationMessagesSince).not.toHaveBeenCalled();
  });

  it("returns empty poll messages for an invalid projectId", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00.000Z&projectId=../../etc-passwd",
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      backend: "none",
      messages: [],
    });
    expect(getConversationMessagesSince).not.toHaveBeenCalled();
  });

  it("returns error for unknown action", async () => {
    const request = new Request(
      "http://localhost/api/chat/unified?action=unknown",
    );
    const response = await GET(request);
    expect(response.status).toBe(400);
  });

  it("returns health status when action=health", async () => {
    const agentCfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(agentCfg);
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: ["telegram"],
      agents: 1,
      sessions: 2,
    });

    // Mock OpenHands health check
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 })),
    );

    const request = new Request(
      "http://localhost/api/chat/unified?action=health",
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.agent).toEqual({ type: "openclaw", status: "connected" });
    // Legacy field
    expect(body.openclaw).toBe("connected");
    expect(body.channels).toEqual(["telegram"]);
  });

  it("reuses a fresh OpenClaw runtime status between the health probe and the next POST even when config key order differs", async () => {
    resolveAgentConfig
      .mockReturnValueOnce({
        url: "http://localhost:19002",
        type: "openclaw",
      })
      .mockReturnValueOnce({
        type: "openclaw",
        url: "http://localhost:19002",
      });
    openClawHealthCheck.mockResolvedValue({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: ["telegram"],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("Hello back");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    );

    const healthResponse = await GET(
      new Request("http://localhost/api/chat/unified?action=health"),
    );
    expect(healthResponse.status).toBe(200);

    const postResponse = await POST(new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "runtime-status-cache-test",
      },
      body: JSON.stringify({
        message: "Hi",
        messages: [{ role: "user", content: "Hi" }],
      }),
    }));

    expect(postResponse.status).toBe(200);
    expect(openClawHealthCheck).toHaveBeenCalledTimes(1);
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(1);
  });

  it("reuses the cheap OpenClaw gateway status for back-to-back POSTs", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValue({
      status: "connected",
      gateway: "http://127.0.0.1:19002",
    });
    sendOpenClawMessage
      .mockResolvedValueOnce("First response")
      .mockResolvedValueOnce("Second response");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    );

    for (const [index, message] of ["Hi", "Hi again"].entries()) {
      const postResponse = await POST(new Request("http://localhost/api/chat/unified", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-real-ip": `runtime-status-post-cache-test-${index}`,
        },
        body: JSON.stringify({
          message,
          messages: [{ role: "user", content: message }],
        }),
      }));
      expect(postResponse.status).toBe(200);
    }

    expect(openClawHealthCheck).toHaveBeenCalledTimes(1);
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(2);
  });

  it("prunes expired runtime-status cache entries before caching a new config", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-22T00:00:00Z"));
      resolveAgentConfig.mockReturnValueOnce({
        type: "openclaw",
        url: "http://localhost:19002",
      });
      openClawHealthCheck.mockResolvedValue({
        status: "connected",
        gateway: "ws://127.0.0.1:19002",
        channels: ["telegram"],
        agents: 1,
        sessions: 2,
      });

      const firstResponse = await GET(
        new Request("http://localhost/api/chat/unified?action=health"),
      );
      expect(firstResponse.status).toBe(200);
      expect(__getConfiguredAgentRuntimeStatusCacheSizeForTests()).toBe(1);

      vi.setSystemTime(new Date("2026-04-22T00:00:11Z"));
      resolveAgentConfig.mockReturnValueOnce({
        type: "openclaw",
        url: "http://localhost:19003",
      });

      const secondResponse = await GET(
        new Request("http://localhost/api/chat/unified?action=health"),
      );
      expect(secondResponse.status).toBe(200);
      expect(openClawHealthCheck).toHaveBeenCalledTimes(2);
      expect(__getConfiguredAgentRuntimeStatusCacheSizeForTests()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports ready from direct OpenAI availability when no local provider is selected", async () => {
    const originalCwd = process.cwd();
    const isolatedCwd = mkdtempSync(
      path.join(tmpdir(), "scienceswarm-chat-health-"),
    );

    process.chdir(isolatedCwd);
    try {
      vi.stubEnv("OPENAI_API_KEY", "sk-test-key");

      const request = new Request(
        "http://localhost/api/chat/unified?action=health",
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.llmProvider).toBe("openai");
      expect(body.ready).toBe(true);
    } finally {
      process.chdir(originalCwd);
      rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  it("reports only local readiness when strict local-only mode is enabled", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    const agentCfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(agentCfg);
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: ["telegram"],
      agents: 1,
      sessions: 2,
    });
    isLocalProviderConfigured.mockReturnValue(false);
    localHealthCheck.mockResolvedValueOnce({
      running: false,
      models: [],
      url: "http://localhost:11434",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request(
      "http://localhost/api/chat/unified?action=health",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.strictLocalOnly).toBe(true);
    expect(body.llmProvider).toBe("local");
    expect(body.agent).toEqual({ type: "openclaw", status: "connected" });
    expect(body.openhands).toBe("disconnected");
    expect(body.channels).toEqual(["telegram"]);
    expect(body.ready).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps llmProvider as local when health falls back after local mode is selected", async () => {
    const originalCwd = process.cwd();
    const isolatedCwd = mkdtempSync(
      path.join(tmpdir(), "scienceswarm-chat-health-"),
    );

    process.chdir(isolatedCwd);
    try {
      vi.stubEnv("LLM_PROVIDER", "local");
      localHealthCheck.mockRejectedValueOnce(new Error("ollama unavailable"));

      const request = new Request(
        "http://localhost/api/chat/unified?action=health",
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.llmProvider).toBe("local");
      expect(body.strictLocalOnly).toBe(false);
      expect(body.ready).toBe(false);
    } finally {
      process.chdir(originalCwd);
      rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  it("returns a strict-local-only poll response when the mode is enabled", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");

    const request = new Request(
      "http://localhost/api/chat/unified?action=poll&since=2026-01-01T00:00:00Z&projectId=test",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      messages: [],
      backend: "strict-local-only",
    });
  });
});

afterEach(() => {
  if (scienceswarmDir) {
    rmSync(scienceswarmDir, { recursive: true, force: true });
    scienceswarmDir = null;
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/chat/unified", () => {
  it("returns 400 when no message provided", async () => {
    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("No message provided");
  });

  it("handles setup intent directly in the unified chat path", async () => {
    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "gbrain-grounded-answer-test",
      },
      body: JSON.stringify({
        message: "Set up my research brain",
        messages: [{ role: "user", content: "Set up my research brain" }],
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("brain-setup");
    const body = await response.json();
    expect(body.backend).toBe("brain-setup");
    expect(body.response).toContain("Brain setup (1/4)");
    expect(body.response).toContain("What's your name?");
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("answers model-system applicability requests from the visible active file and saves an artifact", async () => {
    createProjectRoot("alpha-project");
    readFile.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "model-applicability-active-file",
      },
      body: JSON.stringify({
        message:
          "Is this organoid model applicable to our patient biomarker question, and what validation ladder should reduce transfer risk?",
        projectId: "alpha-project",
        activeFile: {
          path: "docs/organoid-fit-memo.md",
          content: [
            "# Organoid fit memo",
            "Patient-derived organoid CRC-214 has KRAS G12D and TP53 loss.",
            "Viability assay at day 7 after EGFR + MEK inhibition, n=4 wells per dose.",
            "Vehicle controls are included, but there is no immune co-culture or stromal compartment.",
          ].join("\n"),
        },
      }),
    });

    const response = await POST(request);
    const body = (await response.json()) as {
      response?: string;
      generatedArtifacts?: Array<{ projectPath?: string; tool?: string }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    expect(body.response).toContain("Transfer risks:");
    expect(body.response).toContain("Validation ladder:");
    expect(body.response).toContain("immune");
    expect(body.generatedArtifacts?.[0]?.tool).toBe(
      "ScienceSwarm model-system applicability",
    );
    const artifactPath = body.generatedArtifacts?.[0]?.projectPath;
    expect(artifactPath).toBeTruthy();
    expect(
      readFileSync(
        path.join(ensureScienceSwarmDir(), "projects", "alpha-project", artifactPath ?? ""),
        "utf-8",
      ),
    ).toContain("## Missing Metadata ScienceSwarm Will Not Assume");
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
  });

  it("handles missing model metadata honestly instead of routing to a generic agent answer", async () => {
    createProjectRoot("alpha-project");
    readFile.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "model-applicability-missing-metadata",
      },
      body: JSON.stringify({
        message:
          "Is this model system applicable to the target biological question if my source does not specify assay context or patient origin?",
        projectId: "alpha-project",
      }),
    });

    const response = await POST(request);
    const body = (await response.json()) as { response?: string };

    expect(response.status).toBe(200);
    expect(body.response).toContain("Missing metadata ScienceSwarm will not assume:");
    expect(body.response).toContain("model identity");
    expect(body.response).toContain("assay or readout");
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
  });

  it("answers target-prioritization requests from the visible active file and saves an artifact", async () => {
    createProjectRoot("alpha-project");
    readFile.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "target-prioritization-active-file",
      },
      body: JSON.stringify({
        message:
          "Rank these target and biomarker candidates for the next validation wave and show the ranking criteria.",
        projectId: "alpha-project",
        activeFile: {
          path: "docs/target-candidates.md",
          content: [
            "# Target candidates",
            "- EGFR + MEK: patient-derived organoid response replicated in n=4 wells with viability assay, KRAS feedback mechanism, existing inhibitors, and western readout.",
            "- AXL: resistance marker enriched after treatment, but only one RNA-seq observation and no perturbation assay yet.",
            "- ERBB3: plausible bypass pathway with antibody reagent available, but evidence is weaker and timeline is longer.",
          ].join("\n"),
        },
      }),
    });

    const response = await POST(request);
    const body = (await response.json()) as {
      response?: string;
      generatedArtifacts?: Array<{ projectPath?: string; tool?: string }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    expect(body.response).toContain("Priority ranking:");
    expect(body.response).toContain("Ranking criteria:");
    expect(body.response).toContain("EGFR");
    expect(body.generatedArtifacts?.[0]?.tool).toBe(
      "ScienceSwarm target prioritizer",
    );
    const artifactPath = body.generatedArtifacts?.[0]?.projectPath;
    expect(artifactPath).toBeTruthy();
    expect(
      readFileSync(
        path.join(ensureScienceSwarmDir(), "projects", "alpha-project", artifactPath ?? ""),
        "utf-8",
      ),
    ).toContain("## Thin Evidence and Missing Information");
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
  });

  it("reprioritizes under visible practical constraints and names thin evidence", async () => {
    createProjectRoot("alpha-project");
    readFile.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "target-prioritization-constraints",
      },
      body: JSON.stringify({
        message:
          "Reprioritize AXL, MET, and YAP1 biomarkers for a short two-week lab window with limited assay support and be honest about thin evidence.",
        projectId: "alpha-project",
        activeFile: {
          path: "docs/thin-biomarker-list.txt",
          content:
            "AXL, MET, and YAP1 are tempting resistance biomarkers, but no cohort, replication, or perturbation readout is available yet.",
        },
      }),
    });

    const response = await POST(request);
    const body = (await response.json()) as { response?: string };

    expect(response.status).toBe(200);
    expect(body.response).toContain("Constraint sensitivity:");
    expect(body.response).toMatch(/Short-window|Limited assay/i);
    expect(body.response).toContain("Thin evidence and missing information:");
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
  });

  it("returns local slash-command help from the dedicated command route", async () => {
    listOpenClawSkills.mockResolvedValueOnce([
      {
        slug: "project-organizer",
        name: "project-organizer",
        description: "Organize the current project",
        runtime: "in-session",
        emoji: null,
      },
    ]);

    const request = new Request("http://localhost/api/chat/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "slash-help-test",
      },
      body: JSON.stringify({
        message: "/help",
        messages: [{ role: "user", content: "/help" }],
      }),
    });

    const response = await commandPOST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("slash-commands");
    const body = await response.json();
    expect(body.response).toContain("**ScienceSwarm slash commands**");
    expect(body.response).toContain("`/help`");
    expect(body.response).toContain("`/project-organizer [request]`");
    expect(checkRateLimit).toHaveBeenCalledWith("slash-help-test", "web");
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("returns 503 for unknown slash-like input when OpenClaw is disconnected (no local fallback)", async () => {
    listOpenClawSkills.mockResolvedValueOnce([
      {
        slug: "project-organizer",
        name: "project-organizer",
        description: "Organize the current project",
        runtime: "in-session",
        emoji: null,
      },
    ]);
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "disconnected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 0,
      sessions: 0,
    });

    const request = new Request("http://localhost/api/chat/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "slash-unknown-disconnected-test",
      },
      body: JSON.stringify({
        message: "/tmp",
        messages: [{ role: "user", content: "/tmp" }],
      }),
    });

    const response = await commandPOST(request);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain("OpenClaw");
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("routes known slash skill commands only through OpenClaw", async () => {
    listOpenClawSkills.mockResolvedValueOnce([
      {
        slug: "project-organizer",
        name: "project-organizer",
        description: "Organize the current project",
        runtime: "in-session",
        emoji: null,
      },
    ]);
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw organized the project");

    const request = new Request("http://localhost/api/chat/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "slash-openclaw-test",
      },
      body: JSON.stringify({
        message: "/project-organizer show duplicate papers",
        messages: [
          { role: "user", content: "/project-organizer show duplicate papers" },
        ],
      }),
    });

    const response = await commandPOST(request);

    expect(response.status).toBe(200);
    expect(sendOpenClawMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        "ScienceSwarm slash command: `/project-organizer show duplicate papers`",
      ),
      expect.any(Object),
    );
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).toContain(
      "Use the installed ScienceSwarm skill `project-organizer`",
    );
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).toContain(
      "User request:\nshow duplicate papers",
    );
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).toContain(
      "Do not describe steps — do them.",
    );
    expect(streamChat).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("streams slash skill runs when the dashboard requests task phases", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });

    listOpenClawSkills.mockResolvedValueOnce([
      {
        slug: "project-organizer",
        name: "project-organizer",
        description: "Organize the current project",
        runtime: "in-session",
        emoji: null,
      },
    ]);
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 1,
    });
    const authoredPlanResponse = [
      "```scienceswarm-artifact path=\"docs/revision-plan.md\"",
      "# Revision Checklist",
      "",
      "- Clarify the reviewer concerns before revising results.",
      "```",
    ].join("\n");
    sendOpenClawMessage.mockResolvedValue(authoredPlanResponse);

    const request = new Request("http://localhost/api/chat/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "slash-stream-test",
      },
      body: JSON.stringify({
        message: "/project-organizer draft a revision checklist",
        messages: [
          {
            role: "user",
            content: "/project-organizer draft a revision checklist",
          },
        ],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await commandPOST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");

    const events = await readSseEvents(response);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      taskPhases: [
        { id: "running-skill", label: "Running skill", status: "active" },
        {
          id: "importing-result",
          label: "Importing result",
          status: "pending",
        },
        { id: "done", label: "Done", status: "pending" },
      ],
    });
    expect(events[1]).toMatchObject({
      taskPhases: [
        { id: "running-skill", label: "Running skill", status: "completed" },
        {
          id: "importing-result",
          label: "Importing result",
          status: "active",
        },
        { id: "done", label: "Done", status: "pending" },
      ],
    });
    expect(events[2]).toMatchObject({
      text: expect.stringContaining("docs/revision-plan.md"),
      generatedFiles: ["docs/revision-plan.md"],
      taskPhases: [
        { id: "running-skill", label: "Running skill", status: "completed" },
        {
          id: "importing-result",
          label: "Importing result",
          status: "completed",
        },
        { id: "done", label: "Done", status: "completed" },
      ],
    });
    expect(sendOpenClawMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        "ScienceSwarm slash command: `/project-organizer draft a revision checklist`",
      ),
      expect.any(Object),
    );
    expect(streamChat).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("does not fall back to direct chat when a known slash skill command needs OpenClaw", async () => {
    listOpenClawSkills.mockResolvedValueOnce([
      {
        slug: "db-pubmed",
        name: "db-pubmed",
        description: "Search PubMed",
        runtime: "in-session",
        emoji: "PM",
      },
    ]);
    isLocalProviderConfigured.mockReturnValue(true);
    localHealthCheck.mockResolvedValueOnce({
      running: true,
      models: ["gemma4:latest"],
      url: "http://localhost:11434",
    });
    hasLocalModel.mockResolvedValueOnce(true);
    getLocalModel.mockReturnValue("gemma4:latest");
    mockDirectLLMStream("PubMed answer");

    const request = new Request("http://localhost/api/chat/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "slash-direct-test",
      },
      body: JSON.stringify({
        message: "/pubmed TP53 mutation",
        messages: [{ role: "user", content: "/pubmed TP53 mutation" }],
      }),
    });

    const response = await commandPOST(request);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      mode: "reasoning",
      error: expect.stringContaining("requires OpenClaw"),
    });
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("does not let slash skill prompts trigger setup or other deterministic chat workflows", async () => {
    listOpenClawSkills.mockResolvedValueOnce([
      {
        slug: "scienceswarm-capture",
        name: "scienceswarm-capture",
        description: "Capture notes after brain setup is complete",
        runtime: "in-session",
        emoji: null,
      },
    ]);
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw captured the note");

    const request = new Request("http://localhost/api/chat/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "slash-capture-test",
      },
      body: JSON.stringify({
        message: "/capture note this result",
        messages: [{ role: "user", content: "/capture note this result" }],
      }),
    });

    const response = await commandPOST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: "OpenClaw captured the note",
    });
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("returns 503 for normal chat turns when OpenClaw is disconnected (reasoning mode, local configured)", async () => {
    // Previously: a reasoning-mode turn with local Ollama configured would
    // silently fall through to the local-direct stream. Now OpenClaw is the
    // only chat dispatcher, so a disconnected OpenClaw returns 503 with a
    // clear "Start OpenClaw" error — even if a local model is configured.
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "disconnected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 0,
      sessions: 0,
    });
    isLocalProviderConfigured.mockReturnValue(true);
    localHealthCheck.mockResolvedValueOnce({
      running: true,
      models: ["gemma4:latest"],
      url: "http://localhost:11434",
    });
    hasLocalModel.mockResolvedValueOnce(true);
    getLocalModel.mockReturnValue("gemma4:latest");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "disconnected-local-configured-test",
      },
      body: JSON.stringify({
        message: "What source families are available?",
        messages: [
          { role: "user", content: "What source families are available?" },
        ],
        projectId: "alpha-project",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(503);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    const body = await response.json();
    expect(body.backend).toBe("openclaw");
    expect(body.error).toContain("OpenClaw");
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("does not bypass OpenClaw tools mode for scientific source prompts", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw handled tools mode");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "scientific-source-openclaw-mode-test",
      },
      body: JSON.stringify({
        message: "Search PubMed for enzyme papers.",
        messages: [
          { role: "user", content: "Search PubMed for enzyme papers." },
        ],
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    const body = await response.json();
    expect(body.backend).toBe("openclaw");
    expect(body.response).toBe("OpenClaw handled tools mode");
    expect(sendOpenClawMessage).toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("does not bypass connected OpenClaw reasoning for scientific source prompts", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      "OpenClaw handled reasoning mode",
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "scientific-source-openclaw-reasoning-test",
      },
      body: JSON.stringify({
        message: "Search PubMed for enzyme papers.",
        messages: [
          { role: "user", content: "Search PubMed for enzyme papers." },
        ],
        projectId: "alpha-project",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    expect(response.headers.get("X-Chat-Mode")).toBe("reasoning");
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      mode: "reasoning",
      response: "OpenClaw handled reasoning mode",
    });
    expect(sendOpenClawMessage).toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("replays setup progress from chat history for follow-up answers", async () => {
    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "computational biology",
        messages: [
          { role: "user", content: "Set up my research brain" },
          { role: "assistant", content: "I'll set up your research brain." },
          { role: "user", content: "Dr. Ada Lovelace" },
          { role: "assistant", content: "What's your research field?" },
          { role: "user", content: "computational biology" },
        ],
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.backend).toBe("brain-setup");
    expect(body.response).toContain("Brain setup (3/4)");
    expect(body.response).toContain("What institution are you at?");
  });

  it("routes trivial greetings through OpenClaw instead of answering locally", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw says hi");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Hi",
        projectId: "alpha-project",
        mode: "reasoning",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      mode: "reasoning",
      response: "OpenClaw says hi",
    });
    expect(openClawHealthCheck).toHaveBeenCalledOnce();
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      "Keep ordinary conversational replies brief; for greetings, acknowledgements, or short status questions, answer in 1-2 sentences",
    );
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("emits opt-in chat timing logs without prompt contents", async () => {
    vi.stubEnv("SCIENCESWARM_CHAT_TIMING", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async (_message, options) => {
      options?.onEvent?.({
        method: "agent",
        payload: {
          stream: "assistant",
          data: { delta: "private assistant delta" },
        },
      });
      return "OpenClaw says hi";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Secret prompt: EGFR timing window",
        projectId: "alpha-project",
        mode: "reasoning",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: "OpenClaw says hi",
    });
    const timingCall = infoSpy.mock.calls.find(
      ([prefix]) => prefix === "[scienceswarm-chat-timing]",
    );
    expect(timingCall).toBeTruthy();
    const payload = JSON.parse(String(timingCall?.[1])) as {
      phases: Array<{ name: string }>;
      promptCharCounts: Record<string, number>;
    };
    expect(payload.phases.map((phase) => phase.name)).toEqual(
      expect.arrayContaining([
        "request_parse",
        "project_materialization",
        "file_reference_merge",
        "shortcut_detectors",
        "chat_readiness",
        "prompt_context_construction",
        "gateway_connect_auth",
        "chat_send_ack",
        "first_gateway_event",
        "first_assistant_text",
        "final_assistant_text",
        "artifact_import_repair",
      ]),
    );
    expect(payload.promptCharCounts.user_text).toBe(
      "Secret prompt: EGFR timing window".length,
    );
    expect(payload.promptCharCounts.guardrails).toBeGreaterThan(0);
    expect(payload.promptCharCounts.total).toBeGreaterThan(
      payload.promptCharCounts.user_text,
    );
    expect(JSON.stringify(payload)).not.toContain(
      "Secret prompt: EGFR timing window",
    );
    expect(JSON.stringify(payload)).not.toContain("private assistant delta");
    infoSpy.mockRestore();
  });

  it("streams opt-in timing meta events in order", async () => {
    vi.stubEnv("SCIENCESWARM_CHAT_TIMING", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async (_message, options) => {
      options?.onEvent?.({
        payload: {
          stream: "assistant",
          data: { delta: "private assistant delta" },
        },
      });
      return "OpenClaw says hi";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Secret prompt: EGFR timing window",
        projectId: "alpha-project",
        mode: "reasoning",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const timingEvents = events
      .map((event) => event.timing)
      .filter((event): event is Record<string, unknown> =>
        Boolean(event && typeof event === "object" && !Array.isArray(event)),
      );

    expect(timingEvents.map((event) => event.name)).toEqual([
      "request_start",
      "readiness_complete",
      "gateway_ack",
      "first_gateway_event",
      "final_assistant_text",
    ]);
    const firstGatewayEvent = timingEvents.find(
      (event) => event.name === "first_gateway_event",
    );
    expect(firstGatewayEvent).not.toHaveProperty("detail");
    expect(timingEvents.every((event) => event.type === "chat_timing")).toBe(true);
    expect(timingEvents.every((event) => typeof event.elapsedMs === "number")).toBe(true);
    expect(JSON.stringify(timingEvents)).not.toContain(
      "Secret prompt: EGFR timing window",
    );
    expect(JSON.stringify(timingEvents)).not.toContain("private assistant delta");
    infoSpy.mockRestore();
  });

  it("streams opt-in timing meta without a first gateway event when OpenClaw is quiet", async () => {
    vi.stubEnv("SCIENCESWARM_CHAT_TIMING", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw says hi");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Quiet no-event prompt",
        projectId: "alpha-project",
        mode: "reasoning",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const timingEvents = events
      .map((event) => event.timing)
      .filter((event): event is Record<string, unknown> =>
        Boolean(event && typeof event === "object" && !Array.isArray(event)),
      );

    expect(timingEvents.map((event) => event.name)).toEqual([
      "request_start",
      "readiness_complete",
      "gateway_ack",
      "final_assistant_text",
    ]);
    expect(timingEvents.some((event) => event.name === "first_gateway_event")).toBe(
      false,
    );
    expect(JSON.stringify(timingEvents)).not.toContain("Quiet no-event prompt");
    infoSpy.mockRestore();
  });

  it("records streaming timing failures as stream errors", async () => {
    vi.stubEnv("SCIENCESWARM_CHAT_TIMING", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockRejectedValueOnce(new Error("gateway exploded"));

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Trigger stream error",
        projectId: "alpha-project",
        mode: "reasoning",
        streamPhases: true,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const events = await readSseEvents(response);
    expect(events.at(-1)).toMatchObject({
      backend: "openclaw",
      generatedFiles: [],
    });
    const timingCall = infoSpy.mock.calls.find(
      ([prefix]) => prefix === "[scienceswarm-chat-timing]",
    );
    expect(timingCall).toBeTruthy();
    const payload = JSON.parse(String(timingCall?.[1])) as {
      outcome?: string;
      status?: number;
    };
    expect(payload).toMatchObject({
      outcome: "stream_error",
      status: 500,
    });
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("pre-materializes openclaw-tools turns even without content hints", () => {
    expect(
      shouldPreMaterializeProjectWorkspaceForTurn({
        projectId: "tools-project",
        message: "run the tests",
        chatMode: "openclaw-tools",
        files: [],
        activeFile: null,
      }),
    ).toBe(true);
  });

  it("returns 503 when OpenClaw is not the configured agent", async () => {
    // Previously this returned 503 only after walking three fallback paths
    // (local direct, OpenHands, final streamDirectResponse). The new
    // precondition short-circuits on the agent selector itself.
    resolveAgentConfig.mockReturnValue(null);

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "no-openclaw-configured",
      },
      body: JSON.stringify({ message: "Hello", projectId: "alpha-project" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.backend).toBe("openclaw");
    expect(body.error).toContain("OpenClaw");
    expect(streamChat).not.toHaveBeenCalled();
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
  });

  it("uses OpenClaw in strict local-only mode when OpenClaw is the selected backend", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    const agentCfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(agentCfg);
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw reply");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Hello",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.backend).toBe("openclaw");
    expect(body.response).toBe("OpenClaw reply");
    expect(streamChat).not.toHaveBeenCalled();
    expect(sendOpenClawMessage).toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an actionable OpenClaw error when the web gateway turn fails", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockRejectedValueOnce(
      new Error("OpenClaw gateway unreachable"),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "openclaw-gateway-failure",
      },
      body: JSON.stringify({
        message: "Hello",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(502);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    const body = await response.json();
    expect(body.backend).toBe("openclaw");
    expect(body.error).toContain("ScienceSwarm could not complete this request.");
    expect(body.error).toContain("Technical detail: OpenClaw gateway unreachable");
    expect(streamChat).not.toHaveBeenCalled();
  });

  // The two tests that used to live here ("returns an actionable settings
  // error when the local model is configured but not downloaded" and
  // "allows local fallback when cloud privacy blocks remote chat") exercised
  // the local-direct short-circuit and the OpenClaw-disconnected local
  // fallback respectively. Both are dead code under the chat-only-through-
  // OpenClaw rule; see the dedicated 503 tests above.

  it("uses the per-project workspace for OpenClaw even when a shared workspace exists", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const sharedWorkspaceRoot = createSharedWorkspaceRoot();
    const agentCfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(agentCfg);
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    isLocalProviderConfigured.mockReturnValue(true);
    localHealthCheck.mockResolvedValueOnce({
      running: true,
      models: [],
      url: "http://localhost:11434",
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw answer");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Hello",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.backend).toBe("openclaw");
    expect(body.response).toBe("OpenClaw answer");
    const [[openClawMessage, openClawOptions]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain("Hello");
    expect(openClawMessage).toContain(
      `[Workspace: ${projectRoot} — use ABSOLUTE paths for all read/write/exec operations]`,
    );
    expect(openClawMessage).toContain(
      "Prefer canonical gbrain tools such as brain_capture for task/note/decision/hypothesis page creation",
    );
    expect(openClawMessage).toContain(
      "Do not spawn subagents, background agents, sessions, or gateway pairing flows.",
    );
    expect(openClawMessage).toContain(
      "Use absolute workspace paths only inside tool arguments. In final responses and saved scientist-facing documents, refer to project-visible relative paths",
    );
    expect(openClawMessage).toContain(
      "Do not mention Codex, Claude Code, Pi, or any other external agent brand in the response.",
    );
    expect(openClawMessage).toContain(
      "Do not promise future background monitoring, follow-up messages, or later progress updates after your final response.",
    );
    expect(openClawMessage).toContain(
      "Do not run git add, git commit, or git push unless the user explicitly asked",
    );
    expect(openClawMessage).toContain(
      "Do not mutate .brain/state or .brain/wiki directly when a canonical gbrain tool exists.",
    );
    expect(openClawOptions.cwd).toBe(projectRoot);
    expect(openClawOptions.cwd).not.toBe(sharedWorkspaceRoot);
    expect(openClawOptions.session).toEqual(
      expect.stringContaining("web-alpha-project-"),
    );
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("routes sweep/save prompts with explanatory wording through OpenClaw tools", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    resolveAgentConfig.mockReturnValue({ type: "openclaw", url: "http://localhost:19002" });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    isLocalProviderConfigured.mockReturnValue(true);
    localHealthCheck.mockResolvedValueOnce({
      running: true,
      models: [],
      url: "http://localhost:11434",
    });
    sendOpenClawMessage.mockResolvedValue(
      [
        "```scienceswarm-artifact path=\"docs/sweep-summary.md\"",
        "# Sweep Summary",
        "",
        "Toy smoke sweep complete.",
        "```",
        "",
        "Saved `docs/sweep-summary.md`.",
      ].join("\n"),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "Using docs/benchmark-suite.md, run a tiny deterministic toy sweep, save docs/sweep-summary.md, and explain which result is most trustworthy and why.",
        projectId: "alpha-project",
        mode: "reasoning",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage, openClawOptions]] = sendOpenClawMessage.mock.calls;
    expect(openClawOptions.cwd).toBe(projectRoot);
    expect(openClawMessage).toContain(
      "Execute all steps using your tools when real work is required.",
    );
    expect(openClawMessage).toContain(
      `The only valid location for created files, scripts, outputs, artifacts, and exec targets in this turn is inside ${projectRoot}.`,
    );
    expect(openClawMessage).not.toContain("Clarification request rules:");
  });

  it("routes hybrid approval-question action prompts through OpenClaw tools", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    resolveAgentConfig.mockReturnValue({ type: "openclaw", url: "http://localhost:19002" });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    isLocalProviderConfigured.mockReturnValue(true);
    localHealthCheck.mockResolvedValueOnce({
      running: true,
      models: [],
      url: "http://localhost:11434",
    });
    sendOpenClawMessage.mockResolvedValue("Saved `docs/sweep-summary.md`.");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "What will happen? Please run the benchmark sweep and save docs/sweep-summary.md.",
        projectId: "alpha-project",
        mode: "reasoning",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage, openClawOptions]] = sendOpenClawMessage.mock.calls;
    expect(openClawOptions.cwd).toBe(projectRoot);
    expect(openClawMessage).toContain(
      "Execute all steps using your tools when real work is required.",
    );
    expect(openClawMessage).toContain(
      `The only valid location for created files, scripts, outputs, artifacts, and exec targets in this turn is inside ${projectRoot}.`,
    );
    expect(openClawMessage).not.toContain("Clarification request rules:");
  });

  it("materializes gbrain-backed project inputs before sending OpenClaw executable workspace paths", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    readFile.mockImplementation(
      async (
        filePath: string,
        options?: BufferEncoding | { encoding?: BufferEncoding },
      ) =>
        readFileSync(
          filePath,
          typeof options === "string" ? options : options?.encoding,
        ),
    );
    const fileStore = createGbrainFileStore({
      brainRoot: process.env.BRAIN_ROOT,
    });
    const csvObject = await fileStore.putObject({
      project: "alpha-project",
      filename: "mendel-counts.csv",
      mime: "text/csv",
      stream: new Blob(["trait,observed,expected\nround,315,313.5\n"]).stream(),
      uploadedBy: "test-scientist",
      source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
      maxBytes: 1024 * 1024,
    });
    const codeObject = await fileStore.putObject({
      project: "alpha-project",
      filename: "chisq.py",
      mime: "text/x-python",
      stream: new Blob(["import csv\nprint('chi-square rerun')\n"]).stream(),
      uploadedBy: "test-scientist",
      source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
      maxBytes: 1024 * 1024,
    });
    const pages: BrainPage[] = [
      {
        path: "mendel-counts",
        title: "mendel-counts.csv",
        type: "dataset",
        content: "Dataset page for Mendel counts.",
        frontmatter: {
          type: "dataset",
          project: "alpha-project",
          file_refs: [
            pageFileRefFromObject(csvObject, "source", "mendel-counts.csv"),
          ],
        },
      },
      {
        path: "chisq",
        title: "chisq.py",
        type: "code",
        content: "Code page for chi-square rerun.",
        frontmatter: {
          type: "code",
          project: "alpha-project",
          file_refs: [pageFileRefFromObject(codeObject, "source", "chisq.py")],
        },
      },
    ];
    getBrainPage.mockImplementation(
      async (slug: string) => pages.find((page) => page.path === slug) ?? null,
    );
    getBrainStore.mockReturnValue({
      getPage: getBrainPage,
      health: gbrainHealth,
      listPages: vi.fn(async (filters?: { type?: string }) =>
        filters?.type
          ? pages.filter((page) => page.type === filters.type)
          : pages,
      ),
      engine: {
        transaction: vi.fn(async (run: (tx: unknown) => Promise<void>) =>
          run({
            putPage: putBrainPage,
            upsertChunks: upsertBrainChunks,
          }),
        ),
      },
    });

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      "OpenClaw reran the visible data/code inputs.",
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "openclaw-gbrain-materialize",
      },
      body: JSON.stringify({
        message:
          "Please rerun chisq.py against mendel-counts.csv and tell me where the provenance will be visible.",
        files: [
          {
            name: "mendel-counts.csv",
            size: "1 KB",
            source: "gbrain",
            brainSlug: "mendel-counts",
            workspacePath: "gbrain:mendel-counts",
          },
          {
            name: "chisq.py",
            size: "1 KB",
            source: "gbrain",
            brainSlug: "chisq",
            workspacePath: "gbrain:chisq",
          },
        ],
        projectId: "alpha-project",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(
      readFileSync(
        path.join(projectRoot, "data", "mendel-counts.csv"),
        "utf-8",
      ),
    ).toContain("observed");
    expect(
      readFileSync(path.join(projectRoot, "code", "chisq.py"), "utf-8"),
    ).toContain("chi-square rerun");
    const [[openClawMessage, openClawOptions]] = sendOpenClawMessage.mock.calls;
    expect(openClawOptions).toMatchObject({ cwd: projectRoot });
    expect(openClawMessage).toContain("data/mendel-counts.csv");
    expect(openClawMessage).toContain("code/chisq.py");
    expect(openClawMessage).toContain("gbrain:mendel-counts");
    expect(openClawMessage).toContain("gbrain:chisq");
  });

  it("sends the raw request to selected OpenClaw when no SCIENCESWARM prompt file is present", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw answer");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Enumerate papers",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage, openClawOptions]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain("\nEnumerate papers\n");
    expect(openClawMessage).toContain(
      `[Workspace: ${projectRoot} — use ABSOLUTE paths for all read/write/exec operations]`,
    );
    expect(openClawOptions.cwd).toBe(projectRoot);
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("includes recent web chat context in OpenClaw follow-up artifact requests", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("Saved artifacts");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "openclaw-history-context",
      },
      body: JSON.stringify({
        message:
          "Please save the critique and proposed revision plan as artifacts.",
        projectId: "alpha-project",
        messages: [
          {
            role: "user",
            content:
              "Please audit the uploaded Hubble 1929 paper and propose a revision plan.",
          },
          {
            role: "assistant",
            content:
              "Critique: tighten uncertainty treatment.\nPlan: revise the introduction and data table.",
          },
          {
            role: "user",
            content:
              "Please save the critique and proposed revision plan as artifacts.",
          },
        ],
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain("Recent web chat context for continuity");
    expect(openClawMessage).not.toContain("Assistant:\nCritique: tighten uncertainty treatment.");
    expect(openClawMessage).toContain(
      "User:\nPlease audit the uploaded Hubble 1929 paper and propose a revision plan.",
    );
    expect(openClawMessage).toContain("Current user request:");
    expect(openClawMessage).toContain(
      "Please save the critique and proposed revision plan as artifacts.",
    );
  });

  it("frames revise-and-resubmit audits as direct artifact-producing OpenClaw tasks", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("Saved critique and plan");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-task",
      },
      body: JSON.stringify({
        message:
          "Please audit the uploaded Hubble paper and propose a revision plan.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
        files: [
          {
            name: "hubble-1929.pdf",
            size: "552 KB",
            source: "gbrain",
            brainSlug: "hubble-1929",
            workspacePath: "gbrain:hubble-1929",
          },
        ],
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      "This is an audit plus revision-plan request.",
    );
    expect(openClawMessage).toContain(
      path.join(projectRoot, "docs", "hubble-1929-critique.md"),
    );
    expect(openClawMessage).toContain(
      path.join(projectRoot, "docs", "hubble-1929-revision-plan.md"),
    );
    expect(openClawMessage).toContain(
      "Do not rewrite the manuscript until the user clearly approves the current plan.",
    );
    expect(openClawMessage).toContain(
      "Do not spawn subagents, background agents, sessions, or gateway pairing flows.",
    );
    expect(openClawMessage).toContain(
      "Do not mention Codex, Claude Code, Pi, or any other external agent brand in the response.",
    );
    expect(openClawMessage).toContain(
      "Do not promise future background monitoring, follow-up messages, or later progress updates after your final response.",
    );
  });

  it("sanitizes active file fences before sending current-preview context to OpenClaw", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw answer");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "active-file-fence-test",
      },
      body: JSON.stringify({
        message: "What does it do?",
        projectId: "alpha-project",
        mode: "openclaw-tools",
        activeFile: {
          path: "notes/example.md",
          content: "Before\n```ts\nconsole.log('hi')\n```\nAfter",
        },
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      '<scienceswarm_current_file_context path="notes/example.md">',
    );
    expect(openClawMessage).toContain("` ` `ts");
    expect(openClawMessage).toContain("` ` `\nAfter");
    expect(openClawMessage).not.toContain("```ts\nconsole.log('hi')\n```");
    expect(openClawMessage).toContain("<file_content>");
  });

  it("sends active stale task context to selected OpenClaw for next-action questions", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw grounded next action");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "active-stale-task-openclaw",
      },
      body: JSON.stringify({
        message: "What action should I take next for this stale research task?",
        projectId: "alpha-project",
        activeFile: {
          path: "wiki/tasks/2026-04-18-topic-neutrophil-netosis-timing-assay.md",
          content: [
            "# Topic: Neutrophil NETosis timing assay",
            "",
            "Research task: quantify whether IL-8 priming changes the NETosis onset time in donor neutrophils.",
            "Status: running. Last update: 2026-02-12.",
            "Open question: whether the timing window should be rerun with the donor-matched viability control.",
            "",
            "Timeline",
            "2026-04-18 dream-cycle Research task flagged as stale",
            "No research task update for 65 days.",
          ].join("\n"),
        },
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    expect(response.headers.get("X-Chat-Mode")).toBe("reasoning");
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: "OpenClaw grounded next action",
    });
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      '<scienceswarm_current_file_context path="wiki/tasks/2026-04-18-topic-neutrophil-netosis-timing-assay.md">',
    );
    expect(openClawMessage).toContain(
      "Research task: quantify whether IL-8 priming",
    );
    expect(openClawMessage).toContain("No research task update for 65 days.");
    expect(openClawMessage).toContain(
      "What action should I take next for this stale research task?",
    );
    expect(openClawMessage).toContain(
      "Answer the user's latest request directly using the visible project context.",
    );
    expect(openClawMessage).toContain(
      "Ignore project brief next-move suggestions unless the user explicitly asks you to act on them in this turn.",
    );
    expect(openClawMessage).not.toContain("Execute all steps using your tools");
    expect(streamChat).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("auto-resolves project file references from the message for OpenClaw requests", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    writeFileSync(
      path.join(projectRoot, "RESULTS.md"),
      "# Results\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
    );
    const agentCfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(agentCfg);
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    readFile.mockResolvedValueOnce(
      Buffer.from("# Results\n\n| A | B |\n| - | - |\n| 1 | 2 |\n"),
    );
    parseFile.mockResolvedValueOnce({
      text: "| A | B |\n| - | - |\n| 1 | 2 |",
      pages: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      "Saved chart to results/summary-chart.svg",
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "Read results.md in the test project folder, extract the table, and create a chart.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage, openClawOptions]] = sendOpenClawMessage.mock.calls;
    expect(openClawOptions).toEqual(
      expect.objectContaining({
        cwd: projectRoot,
      }),
    );
    expect(openClawMessage).toContain("[Files: RESULTS.md]");
    expect(openClawMessage).toContain(
      "Resolved project file references for this turn:",
    );
    expect(openClawMessage).toContain("- results.md -> RESULTS.md");
    expect(openClawMessage).toContain("File: RESULTS.md (1 pages)");
    expect(openClawMessage).toContain("| A | B |");
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: "Saved chart to results/summary-chart.svg",
    });
  });

  it("keeps clarification-style openclaw-tools requests in direct-answer mode", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce("gemma4 e2b trace ok.");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "clarification-openclaw-tools",
      },
      body: JSON.stringify({
        message:
          "What model are you running, and reply with exactly: gemma4 e2b trace ok.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
        backend: "openclaw",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      "Answer the user's latest request directly using the visible project context.",
    );
    expect(openClawMessage).toContain(
      "Ignore project brief next-move suggestions unless the user explicitly asks you to act on them in this turn.",
    );
    expect(openClawMessage).not.toContain("Execute all steps using your tools");
  });

  it("forces tool execution for scaffold requests from the default chat mode and imports the authored artifacts", async () => {
    const projectRoot = createProjectRoot("project-alpha-scaffold");
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      [
        "```scienceswarm-artifact path=\"README.md\"",
        "# Project Alpha Scaffold",
        "",
        "Run `python3 train.py --config configs/experiment.yaml` after installing dependencies.",
        "```",
        "",
        "```scienceswarm-artifact path=\"configs/experiment.yaml\"",
        "model: project-alpha",
        "context_length: 32768",
        "```",
        "",
        "The scaffold is ready in the workspace.",
      ].join("\n"),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "reasoning-scaffold-artifacts",
      },
      body: JSON.stringify({
        message:
          "Scaffold a runnable experiment for project-alpha with a configurable baseline. I need starter code, configs, dataset entry points, a training script, an evaluation script, and a README that explains what remains to do.",
        projectId: "project-alpha-scaffold",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    const [[openClawMessage, openClawOptions]] = sendOpenClawMessage.mock.calls;

    expect(response.status).toBe(200);
    expect(openClawMessage).toContain("Execute all steps using your tools");
    expect(openClawMessage).toContain("Do not describe steps — do them.");
    expect(openClawMessage).toContain("Continue until fully complete.");
    expect(openClawMessage).toContain(
      `The only valid location for created files, scripts, outputs, artifacts, and exec targets in this turn is inside ${projectRoot}.`,
    );
    expect(openClawMessage).toContain(
      "Do not install new packages unless the user explicitly asked you to modify the environment.",
    );
    expect(openClawOptions).toEqual(
      expect.objectContaining({
        cwd: projectRoot,
        timeoutMs: 180000,
      }),
    );
    expect(finalEvent).toMatchObject({
      text: expect.stringContaining("scaffold is ready"),
      generatedFiles: expect.arrayContaining([
        "README.md",
        "configs/experiment.yaml",
      ]),
      taskPhases: expect.arrayContaining([
        expect.objectContaining({ id: "importing-result", status: "completed" }),
      ]),
    });
    expect(existsSync(path.join(projectRoot, "README.md"))).toBe(true);
    expect(existsSync(path.join(projectRoot, "configs", "experiment.yaml"))).toBe(
      true,
    );
    expect(readFileSync(path.join(projectRoot, "README.md"), "utf-8")).toContain(
      "Project Alpha Scaffold",
    );
  });

  it("resolves @ project file references from the message for OpenClaw requests", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    writeFileSync(
      path.join(projectRoot, "RESULTS.md"),
      "# Results\n\nMentioned content\n",
    );
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    readFile.mockResolvedValueOnce(
      Buffer.from("# Results\n\nMentioned content\n"),
    );
    parseFile.mockResolvedValueOnce({
      text: "Mentioned content",
      pages: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce("Used RESULTS.md");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Summarize @results.md",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain("- results.md -> RESULTS.md");
    expect(openClawMessage).toContain("File: RESULTS.md (1 pages)");
    expect(openClawMessage).toContain("Mentioned content");
  });

  it("includes up to ten referenced files in OpenClaw request context", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const files = Array.from({ length: 11 }, (_, index) => {
      const number = index + 1;
      const workspacePath = `notes/file-${number}.md`;
      writeWorkspaceFile(projectRoot, workspacePath, `# File ${number}\n`);
      return {
        name: `file-${number}.md`,
        size: "1 KB",
        workspacePath,
      };
    });

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    for (let index = 1; index <= 10; index += 1) {
      readFile.mockResolvedValueOnce(Buffer.from(`# File ${index}\n`));
      parseFile.mockResolvedValueOnce({
        text: `Context from file ${index}`,
        pages: 1,
      });
    }
    sendOpenClawMessage.mockResolvedValueOnce("Read ten files");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Summarize these notes.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
        files,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain("File: notes/file-10.md (1 pages)");
    expect(openClawMessage).toContain("Context from file 10");
    expect(openClawMessage).not.toContain("File: notes/file-11.md");
    expect(readFile).toHaveBeenCalledTimes(10);
    expect(parseFile).toHaveBeenCalledTimes(10);
  });

  it("implicitly attaches imported project notes for broad literature questions", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    writeWorkspaceFile(
      projectRoot,
      "docs/project_notes.md",
      "# Project Notes\n\nThe imported notes describe a configurable baseline and evaluation split.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    readFile.mockResolvedValueOnce(
      Buffer.from(
        "# Project Notes\n\nThe imported notes describe a configurable baseline and evaluation split.\n",
      ),
    );
    parseFile.mockResolvedValueOnce({
      text: "The imported notes describe a configurable baseline and evaluation split.",
      pages: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce("Grounded answer");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "Based on the imported project note, identify two falsifiable hypotheses.",
        projectId: "alpha-project",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage, openClawOptions]] = sendOpenClawMessage.mock.calls;
    expect(openClawOptions).toEqual(
      expect.objectContaining({
        cwd: projectRoot,
        channel: "web",
      }),
    );
    expect(openClawMessage).toContain(
      "Resolved project file references for this turn:",
    );
    expect(openClawMessage).toContain(
      "- visible imported project context -> docs/project_notes.md",
    );
    expect(openClawMessage).toContain(
      "File: docs/project_notes.md (1 pages)",
    );
    expect(openClawMessage).toContain(
      "The imported notes describe a configurable baseline and evaluation split.",
    );
  });

  it("includes selected gbrain mention content for OpenClaw requests", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    getBrainPage.mockImplementation(async (slug: string) => {
      if (slug === "wiki/entities/papers/demo/hubble-1929.md") {
        return {
          title: "Hubble 1929",
          type: "paper",
          content: "# Hubble 1929\n\nCepheid distance evidence.",
          frontmatter: {},
        };
      }
      return null;
    });
    sendOpenClawMessage.mockResolvedValueOnce("Used Hubble 1929");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Summarize @Hubble_1929",
        projectId: "alpha-project",
        mode: "openclaw-tools",
        files: [
          {
            name: "Hubble 1929",
            size: "gbrain page",
            source: "gbrain",
            brainSlug: "wiki/entities/papers/demo/hubble-1929.md",
            workspacePath: "gbrain:wiki/entities/papers/demo/hubble-1929.md",
          },
        ],
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(ensureBrainStoreReady).toHaveBeenCalled();
    expect(getBrainPage).toHaveBeenCalledWith(
      "wiki/entities/papers/demo/hubble-1929.md",
    );
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      "gbrain:wiki/entities/papers/demo/hubble-1929.md",
    );
    expect(openClawMessage).toContain(
      "Brain page: gbrain:wiki/entities/papers/demo/hubble-1929.md",
    );
    expect(openClawMessage).toContain("Cepheid distance evidence.");
  });

  it("resolves extensionless project file references by unique stem match", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    writeFileSync(path.join(projectRoot, "RESULTS.md"), "# Results\n");
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    readFile.mockResolvedValueOnce(Buffer.from("# Results\n"));
    parseFile.mockResolvedValueOnce({
      text: "# Results",
      pages: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce("Used RESULTS.md");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Read results in the current project and summarize it.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      "Resolved project file references for this turn:",
    );
    expect(openClawMessage).toContain("- results -> RESULTS.md");
    expect(openClawMessage).toContain("File: RESULTS.md (1 pages)");
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: expect.stringContaining("RESULTS.md"),
    });
  });

  it("streams live task phases for OpenClaw chart jobs when requested by the dashboard", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "results"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, "results", "summary-chart.svg"),
      "<svg></svg>",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    readFile.mockResolvedValueOnce(
      Buffer.from("# Results\n\n| A | B |\n| - | - |\n| 1 | 2 |\n"),
    );
    parseFile.mockResolvedValueOnce({
      text: "| A | B |\n| - | - |\n| 1 | 2 |",
      pages: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      "Saved chart to results/summary-chart.svg",
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "Read results.md in the test project folder, extract the table, and create a chart.",
        files: [
          { name: "results.md", size: "1 KB", workspacePath: "RESULTS.md" },
        ],
        projectId: "alpha-project",
        mode: "openclaw-tools",
        streamPhases: true,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");

    const events = await readSseEvents(response);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "active" },
        {
          id: "extracting-table",
          label: "Extracting table",
          status: "pending",
        },
        {
          id: "generating-chart",
          label: "Generating chart",
          status: "pending",
        },
        {
          id: "importing-result",
          label: "Importing result",
          status: "pending",
        },
        { id: "done", label: "Done", status: "pending" },
      ],
    });
    expect(events[1]).toMatchObject({
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "completed" },
        { id: "extracting-table", label: "Extracting table", status: "active" },
        {
          id: "generating-chart",
          label: "Generating chart",
          status: "pending",
        },
        {
          id: "importing-result",
          label: "Importing result",
          status: "pending",
        },
        { id: "done", label: "Done", status: "pending" },
      ],
    });
    expect(events[2]).toMatchObject({
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "completed" },
        {
          id: "extracting-table",
          label: "Extracting table",
          status: "completed",
        },
        {
          id: "generating-chart",
          label: "Generating chart",
          status: "completed",
        },
        { id: "importing-result", label: "Importing result", status: "active" },
        { id: "done", label: "Done", status: "pending" },
      ],
    });
    expect(events[3]).toMatchObject({
      text: "Saved chart to results/summary-chart.svg",
      conversationId: expect.stringMatching(/^web-alpha-project-/),
      generatedFiles: ["results/summary-chart.svg"],
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "completed" },
        {
          id: "extracting-table",
          label: "Extracting table",
          status: "completed",
        },
        {
          id: "generating-chart",
          label: "Generating chart",
          status: "completed",
        },
        {
          id: "importing-result",
          label: "Importing result",
          status: "completed",
        },
        { id: "done", label: "Done", status: "completed" },
      ],
    });
  });

  it("streams visible audit and plan phases for revise-and-resubmit requests", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-critique.md"),
      "# Critique\n",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-revision-plan.md"),
      "# Plan\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      `Saved critique to ${path.join(projectRoot, "docs", "hubble-1929-critique.md")} and plan to ${path.join(projectRoot, "docs", "hubble-1929-revision-plan.md")}`,
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-phases",
      },
      body: JSON.stringify({
        message: "Audit the uploaded Hubble paper and propose a revision plan.",
        files: [
          {
            name: "hubble-1929.pdf",
            size: "552 KB",
            source: "gbrain",
            brainSlug: "hubble-1929",
            workspacePath: "gbrain:hubble-1929",
          },
        ],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const events = await readSseEvents(response);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "active" },
        {
          id: "drafting-critique",
          label: "Drafting critique",
          status: "pending",
        },
        { id: "drafting-plan", label: "Drafting plan", status: "pending" },
        {
          id: "importing-result",
          label: "Importing result",
          status: "pending",
        },
        { id: "done", label: "Done", status: "pending" },
      ],
    });
    expect(events[1]).toMatchObject({
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "completed" },
        {
          id: "drafting-critique",
          label: "Drafting critique",
          status: "active",
        },
        { id: "drafting-plan", label: "Drafting plan", status: "pending" },
        {
          id: "importing-result",
          label: "Importing result",
          status: "pending",
        },
        { id: "done", label: "Done", status: "pending" },
      ],
    });
    expect(events[2]).toMatchObject({
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "completed" },
        {
          id: "drafting-critique",
          label: "Drafting critique",
          status: "completed",
        },
        { id: "drafting-plan", label: "Drafting plan", status: "completed" },
        { id: "importing-result", label: "Importing result", status: "active" },
        { id: "done", label: "Done", status: "pending" },
      ],
    });
    expect(events[3]).toMatchObject({
      text: "Saved critique to docs/hubble-1929-critique.md and plan to docs/hubble-1929-revision-plan.md",
      generatedFiles: [
        "docs/hubble-1929-critique.md",
        "docs/hubble-1929-revision-plan.md",
      ],
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "completed" },
        {
          id: "drafting-critique",
          label: "Drafting critique",
          status: "completed",
        },
        { id: "drafting-plan", label: "Drafting plan", status: "completed" },
        {
          id: "importing-result",
          label: "Importing result",
          status: "completed",
        },
        { id: "done", label: "Done", status: "completed" },
      ],
    });
    expect(putBrainPage).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-web-alpha-project"),
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          relative_path: "docs/hubble-1929-critique.md",
        }),
      }),
    );
    expect(putBrainPage).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-web-alpha-project"),
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          relative_path: "docs/hubble-1929-revision-plan.md",
        }),
      }),
    );
    expect(JSON.stringify(events[3])).not.toContain(projectRoot);
  });

  it("repairs missing full-scope audit artifacts without surfacing a premature cover letter", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const critiquePath = "docs/mendel-1866-textlayer-critique.md";
    const planPath = "docs/mendel-1866-textlayer-revision-plan.md";
    const analysisPath = "docs/mendel-1866-textlayer-analysis-rerun.md";
    const coverPath = "docs/mendel-1866-textlayer-cover-letter.md";

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage
      .mockResolvedValueOnce(
        [
          "The full-scope audit is complete.",
          `Critique: ${critiquePath}`,
          `Revision Plan: ${planPath}`,
          `Cover Letter: ${coverPath}`,
        ].join("\n"),
      )
      .mockResolvedValueOnce(
        [
          `\`\`\`scienceswarm-artifact path="${critiquePath}"`,
          "# Mendel Manuscript Critique",
          "",
          "The manuscript needs clearer uncertainty treatment and explicit linkage between trait counts and the statistical rerun.",
          "```",
          "",
          `\`\`\`scienceswarm-artifact path="${planPath}"`,
          "# Mendel Revision Plan",
          "",
          "This plan is approval-gated. Step 1: revise the manuscript only after explicit approval. Step 2: draft the cover letter after the revised manuscript is approved.",
          "```",
          "",
          `\`\`\`scienceswarm-artifact path="${analysisPath}"`,
          "# Chi-square Rerun Provenance",
          "",
          "Inputs used: data/mendel-counts.csv and code/chisq.py. Procedure: rerun the chi-square calculations against the visible CSV. Result: the trait ratios remain consistent with the expected Mendelian counts; no regenerated figure was produced in this pass.",
          "```",
        ].join("\n"),
      );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "mendel-full-scope-repair",
      },
      body: JSON.stringify({
        message:
          "Please run a full-scope revise-and-resubmit audit of this Mendel package using all three visible inputs: the manuscript PDF, mendel-counts.csv, and chisq.py. Rerun the chi-square analysis from the code against the CSV, regenerate any useful figure or table output if possible, note whether translation is available from the manuscript, critique the manuscript, and save a prioritized approval-gated revision plan. Do not rewrite the manuscript or draft the cover letter until I approve the plan.",
        files: [
          {
            name: "mendel-1866-textlayer.pdf",
            size: "200 KB",
            source: "gbrain",
            brainSlug: "mendel-1866-textlayer",
            workspacePath: "gbrain:mendel-1866-textlayer",
          },
          {
            name: "mendel-counts.csv",
            size: "2 KB",
            source: "gbrain",
            brainSlug: "mendel-counts",
            workspacePath: "gbrain:mendel-counts",
          },
          {
            name: "chisq.py",
            size: "8 KB",
            source: "gbrain",
            brainSlug: "chisq",
            workspacePath: "gbrain:chisq",
          },
        ],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1) ?? {};
    expect(finalEvent).toMatchObject({
      text: expect.stringContaining("required audit-stage artifacts"),
      generatedFiles: expect.arrayContaining([
        critiquePath,
        planPath,
        analysisPath,
      ]),
    });
    expect(finalEvent.text).not.toContain(coverPath);
    expect(finalEvent.text).toContain(
      "did not create a revised manuscript or cover letter",
    );
    expect(
      readFileSync(path.join(projectRoot, critiquePath), "utf-8"),
    ).toContain("Mendel Manuscript Critique");
    expect(readFileSync(path.join(projectRoot, planPath), "utf-8")).toContain(
      "approval-gated",
    );
    expect(
      readFileSync(path.join(projectRoot, analysisPath), "utf-8"),
    ).toContain("Chi-square Rerun Provenance");
    expect(existsSync(path.join(projectRoot, coverPath))).toBe(false);
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(2);
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).toContain(
      "Do not write or draft the editor cover letter",
    );
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).toContain(
      "mendel-1866-textlayer-analysis-rerun.md",
    );
    expect(sendOpenClawMessage.mock.calls[1]?.[0]).toContain(
      "these required audit-stage artifacts",
    );
    expect(sendOpenClawMessage.mock.calls[1]?.[0]).toContain(critiquePath);
    expect(sendOpenClawMessage.mock.calls[1]?.[0]).toContain(planPath);
    expect(sendOpenClawMessage.mock.calls[1]?.[0]).toContain(analysisPath);
  });

  it("materializes OpenClaw-authored audit artifact blocks from the initial response without extra repair turns", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const critiquePath = "docs/mendel-1866-textlayer-critique.md";
    const planPath = "docs/mendel-1866-textlayer-revision-plan.md";
    const analysisPath = "docs/mendel-1866-textlayer-analysis-rerun.md";

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      [
        `\`\`\`scienceswarm-artifact path="${critiquePath}"`,
        "# Initial Critique",
        "",
        "Real model-authored critique.",
        "```",
        "",
        `\`\`\`scienceswarm-artifact path="${planPath}"`,
        "# Initial Plan",
        "",
        "Approval-gated plan with cover-letter drafting deferred until approval.",
        "```",
        "",
        `\`\`\`scienceswarm-artifact path="${analysisPath}"`,
        "# Initial Provenance",
        "",
        "Inputs used: data/mendel-counts.csv and code/chisq.py. Result: chi-square rerun documented.",
        "```",
      ].join("\n"),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "mendel-initial-artifact-blocks",
      },
      body: JSON.stringify({
        message:
          "Please run a full-scope revise-and-resubmit audit of this Mendel package using all three visible inputs: the manuscript PDF, mendel-counts.csv, and chisq.py. Rerun the chi-square analysis from the code against the CSV, regenerate any useful figure or table output if possible, critique the manuscript, and save a prioritized approval-gated revision plan. Do not rewrite the manuscript or draft the cover letter until I approve the plan.",
        files: [
          {
            name: "mendel-1866-textlayer.pdf",
            size: "200 KB",
            source: "gbrain",
            brainSlug: "mendel-1866-textlayer",
            workspacePath: "gbrain:mendel-1866-textlayer",
          },
        ],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1) ?? {};
    expect(finalEvent).toMatchObject({
      generatedFiles: expect.arrayContaining([
        critiquePath,
        planPath,
        analysisPath,
      ]),
    });
    expect(
      readFileSync(path.join(projectRoot, critiquePath), "utf-8"),
    ).toContain("Initial Critique");
    expect(readFileSync(path.join(projectRoot, planPath), "utf-8")).toContain(
      "Approval-gated",
    );
    expect(
      readFileSync(path.join(projectRoot, analysisPath), "utf-8"),
    ).toContain("Initial Provenance");
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(1);
  });

  it("streams actionable recovery guidance when the local model connection fails", async () => {
    const projectId = "alpha-project-model-outage";
    createProjectRoot(projectId);

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      "LLM request failed: network connection error.",
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "openclaw-model-outage",
      },
      body: JSON.stringify({
        message:
          "Please audit the uploaded Hubble 1929 paper for one new reviewer-facing risk and save docs/hubble-1929-dependency-outage-audit.md with one paragraph. Do not revise the manuscript.",
        files: [
          {
            name: "hubble-1929.pdf",
            size: "552 KB",
            source: "gbrain",
            brainSlug: "hubble-1929",
            workspacePath: "gbrain:hubble-1929",
          },
        ],
        projectId,
        streamPhases: true,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1) ?? {};
    expect(finalEvent).toMatchObject({
      text: expect.stringContaining("local AI model connection is unavailable"),
      generatedFiles: [],
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "completed" },
        { id: "importing-result", label: "Importing result", status: "failed" },
        { id: "done", label: "Done", status: "pending" },
      ],
    });
    expect(finalEvent.text).toEqual(expect.stringContaining("Open Settings"));
    expect(finalEvent.text).toEqual(expect.stringContaining("gemma4:latest"));
  });

  it("repairs an explicitly requested missing artifact through OpenClaw-authored content", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const targetPath = "docs/hubble-1929-dependency-outage-audit-fixed.md";

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage
      .mockResolvedValueOnce(`Dependency Audit: ${targetPath} (To be created)`)
      .mockResolvedValueOnce(
        [
          `\`\`\`scienceswarm-artifact path="${targetPath}"`,
          "# Dependency Recovery Audit",
          "",
          "The current critique remains usable, but the response should explicitly separate Hubble's velocity-distance evidence from later calibration assumptions before resubmission.",
          "```",
        ].join("\n"),
      );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "openclaw-missing-requested-artifact",
      },
      body: JSON.stringify({
        message: `Dependency is restored. Please retry the Hubble 1929 one-paragraph reviewer-risk audit and save ${targetPath}. Do not revise the manuscript.`,
        files: [
          {
            name: "hubble-1929.pdf",
            size: "552 KB",
            source: "gbrain",
            brainSlug: "hubble-1929",
            workspacePath: "gbrain:hubble-1929",
          },
        ],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1) ?? {};
    expect(finalEvent).toMatchObject({
      text: expect.stringContaining(`I created \`${targetPath}\``),
      generatedFiles: [targetPath],
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "completed" },
        {
          id: "importing-result",
          label: "Importing result",
          status: "completed",
        },
        { id: "done", label: "Done", status: "completed" },
      ],
    });
    expect(readFileSync(path.join(projectRoot, targetPath), "utf-8")).toContain(
      "Dependency Recovery Audit",
    );
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(2);
    expect(sendOpenClawMessage.mock.calls[1]?.[0]).toContain(
      "could not verify that the requested visible artifact exists",
    );
    expect(JSON.stringify(finalEvent)).not.toContain(projectRoot);
    expect(putBrainPage).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-web-alpha-project"),
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          relative_path: targetPath,
        }),
      }),
    );
  });

  it("repairs a missing audit critique through OpenClaw instead of fabricating one", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const critiquePath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-critique.md",
    );
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    injectBrainContextIntoUserMessage.mockImplementationOnce(
      (message: string) =>
        [
          "Use the following project memory when relevant.",
          "",
          "## Project Brief",
          "- Later this workflow will need an editor cover letter.",
          "",
          "## User Request",
          message,
        ].join("\n"),
    );
    sendOpenClawMessage
      .mockImplementationOnce(async () => {
        writeFileSync(planPath, "# Plan\n\nApproval gated.\n");
        return [
          `I created a critique at \`${critiquePath}\`.`,
          `I created a plan at \`${planPath}\`.`,
        ].join("\n");
      })
      .mockResolvedValueOnce(
        [
          '```scienceswarm-artifact path="docs/hubble-1929-critique.md"',
          "# Critique",
          "",
          "OpenClaw-authored critique content for the audit.",
          "```",
        ].join("\n"),
      );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-missing-critique",
      },
      body: JSON.stringify({
        message:
          "Audit the uploaded Hubble paper thoroughly and propose a revision plan.",
        files: [
          {
            name: "hubble-1929.pdf",
            size: "552 KB",
            source: "gbrain",
            brainSlug: "hubble-1929",
            workspacePath: "gbrain:hubble-1929",
          },
        ],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: [
        "docs/hubble-1929-revision-plan.md",
        "docs/hubble-1929-critique.md",
      ],
    });
    expect(finalEvent?.text).toContain("docs/hubble-1929-critique.md");
    expect(finalEvent?.text).toContain("docs/hubble-1929-revision-plan.md");
    expect(JSON.stringify(finalEvent)).not.toContain(projectRoot);
    expect(readFileSync(critiquePath, "utf-8")).toContain(
      "OpenClaw-authored critique content",
    );
    const openClawPrompt = sendOpenClawMessage.mock.calls[0]?.[0] as string;
    expect(openClawPrompt).toContain("Write a critique artifact");
    expect(openClawPrompt).not.toContain(
      "This request asks for a cover letter",
    );
    expect(sendOpenClawMessage.mock.calls[1]?.[0]).toContain(
      "could not verify that this required audit-stage artifact exists",
    );
    expect(putBrainPage).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-web-alpha-project"),
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          relative_path: "docs/hubble-1929-revision-plan.md",
        }),
      }),
    );
    expect(putBrainPage).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-web-alpha-project"),
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          relative_path: "docs/hubble-1929-critique.md",
        }),
      }),
    );
  });

  it("accepts an existing visible critique when retrying a missing audit plan", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const critiquePath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-critique.md",
    );
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    writeFileSync(
      critiquePath,
      "# Existing Critique\n\nAlready visible and still usable.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      writeFileSync(planPath, "# Revision Plan\n\nApproval-gated plan.\n");
      return "I kept docs/hubble-1929-critique.md and created docs/hubble-1929-revision-plan.md.";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-existing-critique",
      },
      body: JSON.stringify({
        message:
          "Please retry the plan-stage work using the uploaded hubble-1929.pdf. Keep the existing critique, and create the missing approval-gated revision plan as a visible file at docs/hubble-1929-revision-plan.md. Do not draft the revised manuscript or cover letter yet.",
        files: [
          {
            name: "hubble-1929.pdf",
            size: "552 KB",
            source: "gbrain",
            brainSlug: "hubble-1929",
            workspacePath: "gbrain:hubble-1929",
          },
        ],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);

    expect(response.status).toBe(200);
    expect(finalEvent).toMatchObject({
      text: expect.stringContaining(
        "created docs/hubble-1929-revision-plan.md",
      ),
      generatedFiles: expect.arrayContaining([
        "docs/hubble-1929-critique.md",
        "docs/hubble-1929-revision-plan.md",
      ]),
    });
    expect(finalEvent?.text).not.toContain("could not verify");
    expect(finalEvent?.text).toContain("docs/hubble-1929-critique.md");
    expect(finalEvent?.text).toContain("docs/hubble-1929-revision-plan.md");
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(1);
    expect(readFileSync(critiquePath, "utf-8")).toContain("Existing Critique");
    expect(readFileSync(planPath, "utf-8")).toContain("Approval-gated");
    expect(JSON.stringify(finalEvent)).not.toContain(projectRoot);
  });

  it("imports a visible plan change written by OpenClaw", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const originalPlan = [
      "# Revision Plan",
      "",
      "## Goal",
      "Revise the manuscript after approval.",
      "",
      "## **Execution Protocol**",
      "",
      "1. **I require explicit approval to proceed.**",
    ].join("\n");
    writeFileSync(planPath, originalPlan);
    const oldTimestamp = new Date(Date.now() - 10_000);
    utimesSync(planPath, oldTimestamp, oldTimestamp);

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      writeFileSync(
        planPath,
        [
          "# Revision Plan",
          "",
          "## Goal",
          "Revise the manuscript after approval.",
          "",
          "## Reviewer Response Checklist",
          "",
          "| Planned revision | Editor-facing response item |",
          "|---|---|",
          "| Uncertainty section | Tell the editor the limitations section was added. |",
          "",
          "## **Execution Protocol**",
          "",
          "1. **I require explicit approval to proceed.**",
        ].join("\n"),
      );
      return "I updated docs/hubble-1929-revision-plan.md with a reviewer response checklist.";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-plan-fallback",
      },
      body: JSON.stringify({
        message:
          "Please update the revision plan to add a reviewer response checklist that maps planned revisions to editor-facing response items.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revision-plan.md"],
    });

    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("## Reviewer Response Checklist");
    expect(updatedPlan).toContain("Editor-facing response item");
    expect(updatedPlan.indexOf("## Reviewer Response Checklist")).toBeLessThan(
      updatedPlan.indexOf("## **Execution Protocol**"),
    );
    expect(putBrainPage).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-web-alpha-project"),
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          relative_path: "docs/hubble-1929-revision-plan.md",
        }),
      }),
    );
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
  });

  it("routes statistical uncertainty plan-change requests through OpenClaw", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const originalPlan = [
      "# Revision Plan",
      "",
      "## Goal",
      "Revise the manuscript after approval.",
      "",
      "## **Execution Protocol**",
      "",
      "1. **I require explicit approval to proceed.**",
    ].join("\n");
    writeFileSync(planPath, originalPlan);

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      writeFileSync(
        planPath,
        [
          "# Revision Plan",
          "",
          "## Goal",
          "Revise the manuscript after approval.",
          "",
          "## Statistical Uncertainty and Limitations",
          "",
          "- Discuss peculiar velocities, distance-scale assumptions, and measurement scatter.",
          "",
          "## **Execution Protocol**",
          "",
          "1. **I require explicit approval to proceed.**",
        ].join("\n"),
      );
      return "I updated docs/hubble-1929-revision-plan.md with Statistical Uncertainty and Limitations.";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-statistical-plan",
      },
      body: JSON.stringify({
        message:
          "Please update the visible revision plan artifact to add a short Statistical Uncertainty and Limitations section before manuscript rewriting, keep it approval-gated, and read the saved plan back before replying.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revision-plan.md"],
      text: expect.stringContaining("Statistical Uncertainty and Limitations"),
    });

    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("## Statistical Uncertainty and Limitations");
    expect(updatedPlan).toContain("peculiar velocities");
    expect(
      updatedPlan.indexOf("## Statistical Uncertainty and Limitations"),
    ).toBeLessThan(updatedPlan.indexOf("## **Execution Protocol**"));
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
  });

  it("treats approval-plus-plan-change messages as plan changes", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "## Goal",
        "Revise the manuscript after approval.",
        "",
        "## **Execution Protocol**",
        "",
        "1. **I require explicit approval to proceed.**",
      ].join("\n"),
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      writeFileSync(
        planPath,
        [
          "# Revision Plan",
          "",
          "## Goal",
          "Revise the manuscript after approval.",
          "",
          "## Statistical Uncertainty and Limitations",
          "",
          "- Add a section on calibration drift before any manuscript rewriting.",
          "",
          "## **Execution Protocol**",
          "",
          "1. **I require explicit approval to proceed.**",
        ].join("\n"),
      );
      return "I updated docs/hubble-1929-revision-plan.md with Statistical Uncertainty and Limitations.";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-approval-plus-plan-change",
      },
      body: JSON.stringify({
        message:
          "I approve the current direction, but update the visible revision plan artifact to add a short Statistical Uncertainty and Limitations section before manuscript rewriting, keep it approval-gated, and do not run the revision yet.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revision-plan.md"],
      text: expect.stringContaining("Statistical Uncertainty and Limitations"),
    });
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
    expect(readFileSync(planPath, "utf-8")).toContain(
      "## Statistical Uncertainty and Limitations",
    );
  });

  it("retries a plan change when OpenClaw claims success without updating the visible plan", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "## Goal",
        "Revise the manuscript after approval.",
        "",
        "## **Execution Protocol**",
        "",
        "1. **I require explicit approval to proceed.**",
      ].join("\n"),
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    utimesSync(planPath, oldTimestamp, oldTimestamp);

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage
      .mockResolvedValueOnce(
        "I updated docs/hubble-1929-revision-plan.md with the Material Calibration Cross-Check.",
      )
      .mockResolvedValueOnce(
        [
          "I corrected docs/hubble-1929-revision-plan.md and verified the Material Calibration Cross-Check section.",
          "",
          '```scienceswarm-artifact path="docs/hubble-1929-revision-plan.md"',
          "# Revision Plan",
          "",
          "## Goal",
          "Revise the manuscript after approval.",
          "",
          "## Material Calibration Cross-Check",
          "",
          "- Add a fresh Cepheid zero-point check.",
          "- Discuss Virgo-cluster leverage as a systematic risk.",
          "",
          "## **Execution Protocol**",
          "",
          "1. **I require explicit approval to proceed.**",
          "```",
        ].join("\n"),
      );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-plan-verify-retry",
      },
      body: JSON.stringify({
        message:
          "Before running any further revision, update the visible approved plan docs/hubble-1929-revision-plan.md to add a material Material Calibration Cross-Check step requiring a fresh Cepheid zero-point check and a note on Virgo-cluster leverage. Keep the changed plan approval-gated and read back the saved plan before replying.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revision-plan.md"],
      text: expect.stringContaining("Material Calibration Cross-Check"),
    });
    expect(finalEvent?.text).not.toContain("scienceswarm-artifact");
    const updatedPlan = readFileSync(planPath, "utf-8");
    expect(updatedPlan).toContain("Material Calibration Cross-Check");
    expect(updatedPlan).toContain("Cepheid zero-point check");
    expect(updatedPlan).toContain("Virgo-cluster leverage");
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(2);
  });

  it("records plan approval without changing the plan or running the revision", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const originalPlan = [
      "# Revision Plan",
      "",
      "## Goal",
      "Revise the manuscript after approval.",
      "",
      "## Reviewer Response Checklist",
      "",
      "| Planned revision | Editor-facing response item |",
      "|---|---|",
      "| Uncertainty section | Tell the editor the limitations section was added. |",
      "",
      "## **Execution Protocol**",
      "",
      "1. **I require explicit approval to proceed.**",
    ].join("\n");
    writeFileSync(planPath, originalPlan);

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("This should not be called.");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-plan-approval",
      },
      body: JSON.stringify({
        message:
          "I approve the updated revision plan with the Statistical Uncertainty and Limitations section and the Reviewer Response Checklist. Please keep approval tied to this currently visible plan and do not start the revision until I explicitly ask you to run the revision.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const payload = (await response.json()) as {
      response?: string;
      generatedFiles?: string[];
    };
    expect(payload.response).toContain("I recorded your approval");
    expect(payload.response).toContain("docs/hubble-1929-plan-approval.md");
    expect(payload.response).toContain(
      "I have not changed the plan and have not started rewriting the manuscript",
    );
    expect(payload.generatedFiles).toEqual([
      "docs/hubble-1929-plan-approval.md",
    ]);
    expect(readFileSync(planPath, "utf-8")).toBe(originalPlan);
    expect(readFileSync(approvalPath, "utf-8")).toContain(
      "# Revision Plan Approval Record",
    );
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
    expect(putBrainPage).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-web-alpha-project"),
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          relative_path: "docs/hubble-1929-plan-approval.md",
        }),
      }),
    );
  });

  it("records terse plan-approved language without running the revision", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const originalPlan = [
      "# Revision Plan",
      "",
      "## Goal",
      "Revise the manuscript after approval.",
      "",
      "## Approval Gate",
      "",
      "Do not rewrite until approved.",
    ].join("\n");
    writeFileSync(planPath, originalPlan);

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("This should not be called.");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-terse-plan-approved",
      },
      body: JSON.stringify({
        message:
          "Plan approved. Please record approval for this plan and do not run the revision yet.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const payload = (await response.json()) as {
      response?: string;
      generatedFiles?: string[];
    };

    expect(payload.response).toContain("I recorded your approval");
    expect(payload.response).toContain(
      "I have not changed the plan and have not started rewriting the manuscript",
    );
    expect(payload.generatedFiles).toEqual([
      "docs/hubble-1929-plan-approval.md",
    ]);
    expect(readFileSync(planPath, "utf-8")).toBe(originalPlan);
    expect(readFileSync(approvalPath, "utf-8")).toContain(
      "# Revision Plan Approval Record",
    );
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
  });

  it("records approval for an explicitly referenced numbered plan and runs that approved plan", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-revision-plan.md"),
      "# Revision Plan\n\n## Approval Gate\n\nOld plan.\n",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-revision-plan-2.md"),
      [
        "# Revision Plan",
        "",
        "## Statistical Uncertainty and Limitations",
        "",
        "- Add uncertainty around distance estimates and sample limits.",
        "",
        "## Approval Gate",
        "",
        "Do not rewrite until approved.",
      ].join("\n"),
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revised-manuscript.md",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValue({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });

    const approvalRequest = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-numbered-approval",
      },
      body: JSON.stringify({
        message:
          "I have reviewed and approve the changed plan in docs/hubble-1929-revision-plan-2.md, including the Statistical Uncertainty and Limitations section. Please record this fresh approval for that changed plan and do not revise until I explicitly ask you to run it.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const approvalResponse = await POST(approvalRequest);
    const approvalPayload = (await approvalResponse.json()) as {
      response?: string;
      generatedFiles?: string[];
    };
    expect(approvalPayload.response).toContain(
      "docs/hubble-1929-revision-plan-2.md",
    );
    expect(approvalPayload.generatedFiles).toEqual([
      "docs/hubble-1929-plan-approval.md",
    ]);
    expect(readFileSync(approvalPath, "utf-8")).toContain(
      "docs/hubble-1929-revision-plan-2.md",
    );
    expect(sendOpenClawMessage).not.toHaveBeenCalled();

    sendOpenClawMessage.mockImplementationOnce(async () => {
      writeFileSync(
        revisedPath,
        [
          "# Revised Manuscript Draft",
          "",
          "This draft follows the approved numbered plan.",
          "",
          "## Statistical Uncertainty and Limitations",
          "",
          "Added limitations.",
        ].join("\n"),
      );
      return "Saved the approved revision to docs/hubble-1929-revised-manuscript.md.";
    });

    const runRequest = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-numbered-run",
      },
      body: JSON.stringify({
        message:
          "Please run the revision now using the approved updated plan in docs/hubble-1929-revision-plan-2.md and save the revised manuscript as a visible artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const runResponse = await POST(runRequest);
    expect(runResponse.headers.get("Content-Type")).toContain(
      "text/event-stream",
    );
    const events = await readSseEvents(runResponse);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revised-manuscript.md"],
      text: expect.stringContaining("docs/hubble-1929-revised-manuscript.md"),
    });
    expect(readFileSync(revisedPath, "utf-8")).toContain(
      "approved numbered plan",
    );
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
  });

  it("treats a same-turn plan approval and revision run request as approved", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revised-manuscript.md",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "## Statistical Uncertainty and Limitations",
        "",
        "- Add uncertainty around distance estimates and sample limits.",
        "",
        "## Approval Gate",
        "",
        "Do not rewrite until approved.",
      ].join("\n"),
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      writeFileSync(
        revisedPath,
        [
          "# Revised Manuscript Draft",
          "",
          "This draft follows the plan approved in the same request.",
        ].join("\n"),
      );
      return "Saved the approved revision to docs/hubble-1929-revised-manuscript.md.";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-same-turn-approval-run",
      },
      body: JSON.stringify({
        message:
          "I approve the visible Hubble revision plan in docs/hubble-1929-revision-plan.md. Please run the revision now and save the revised manuscript as a visible artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    expect(response.headers.get("Content-Type")).toContain(
      "text/event-stream",
    );
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revised-manuscript.md"],
      text: expect.stringContaining("docs/hubble-1929-revised-manuscript.md"),
    });
    expect(readFileSync(approvalPath, "utf-8")).toContain(
      "docs/hubble-1929-revision-plan.md",
    );
    expect(readFileSync(revisedPath, "utf-8")).toContain(
      "approved in the same request",
    );
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
  });

  it("retries a revision when OpenClaw claims plan compliance but the manuscript misses approved requirements", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revised-manuscript.md",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan: Hubble 1929 Revise-and-Resubmit Package",
        "",
        "**Project Goal:** To revise the original manuscript to present a statistically robust, historically significant, and scientifically rigorous argument for a linear relationship between distance and radial velocity among extra-galactic nebulae, suitable for resubmission to a top-tier journal.",
        "",
        "**Prerequisites:** This plan assumes the user accepts the high-level critique points detailed in the associated critique document. **No revisions will be performed until this plan receives explicit approval.**",
        "",
        "**I. Revision Steps (Chronological Priority)**",
        "",
        "**Step 1: Formalize Methodology and Data Handling (Highest Priority)**",
        '* **Action:** Overhaul the "Method" section.',
        "* **Deliverable:** A detailed mathematical account of the error propagation for distances derived from stellar luminosity criteria.",
        '* **Mandate:** Introduce a mandatory "Data Uncertainty Analysis" subsection that quantifies the variance introduced by using mean group luminosities vs. individual stellar measurements.',
        "",
        "**Step 6: Material Calibration Cross-Check (Critical New Step)**",
        "",
        "* **Action:** Introduce a mandatory, explicit cross-check phase.",
        "* **Deliverable:** The revised manuscript must now include a dedicated subsection detailing a 'Material Calibration Cross-Check.' This section must require a fresh, explicit determination of the Cepheid zero-point calibration constant ($M_0$). Furthermore, it must dedicate specific discussion to the weight and potential over-leverage of the Virgo Cluster data, treating it as a potential source of systematic bias rather than definitive confirmation.",
        "* **Mandate:** This step requires the assumption of external, non-Hubble data to test the robustness of the $k$ value independently.",
        "",
        "**II. Approval Gates**",
        "",
        "1. **Crucial Checkpoint:** The revision is contingent on the user approving the shift in focus from 'discovery' to 'statistically validated hypothesis' AND the acceptance of this explicit, new calibration step.",
        "2. **Execution:** Once approved, I will write the revised manuscript to `docs/hubble-1929-revised-manuscript.md`.",
      ].join("\n"),
    );
    writeFileSync(
      approvalPath,
      "# Revision Plan Approval Record\n\nApproved current plan.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValue({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage
      .mockImplementationOnce(async () => {
        writeFileSync(
          revisedPath,
          "# Revised Manuscript\n\nThis draft discusses general uncertainty only.\n",
        );
        return "Saved docs/hubble-1929-revised-manuscript.md with Material Calibration Cross-Check included.";
      })
      .mockImplementationOnce(async () => {
        writeFileSync(
          revisedPath,
          [
            "# Revised Manuscript",
            "",
            "## Material Calibration Cross-Check",
            "",
            "This revision performs a fresh Cepheid zero-point calibration constant review and treats Virgo-cluster leverage as a systematic risk rather than definitive confirmation.",
            "",
            "The cross-check also uses external non-Hubble data to test the robustness of the k value independently.",
          ].join("\n"),
        );
        return "Corrected docs/hubble-1929-revised-manuscript.md and read back the Material Calibration Cross-Check section.";
      });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-revision-verify-retry",
      },
      body: JSON.stringify({
        message:
          "Please retry the revision now using the approved plan in docs/hubble-1929-revision-plan.md and save the revised manuscript as a visible artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revised-manuscript.md"],
      text: expect.stringContaining("Material Calibration Cross-Check"),
    });
    const revised = readFileSync(revisedPath, "utf-8");
    expect(revised).toContain("Material Calibration Cross-Check");
    expect(revised).toContain("Cepheid zero-point calibration constant");
    expect(revised).toContain("Virgo-cluster leverage");
    expect(revised).toContain("external non-Hubble data");
    const retryPrompt = sendOpenClawMessage.mock.calls[1]?.[0] ?? "";
    expect(retryPrompt).not.toContain("Project Goal");
    expect(retryPrompt).not.toContain("Chronological Priority");
    expect(retryPrompt).not.toContain("statistically validated hypothesis");
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(2);
  });

  it("uses compact OpenClaw context for revision runs", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revised-manuscript.md",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "**Step 6: Material Calibration Cross-Check (Critical New Step)**",
        "",
        "* **Deliverable:** The revised manuscript must now include a dedicated subsection detailing a 'Material Calibration Cross-Check.' This section must require a fresh, explicit determination of the Cepheid zero-point calibration constant ($M_0$). Furthermore, it must dedicate specific discussion to the weight and potential over-leverage of the Virgo Cluster data, treating it as a potential source of systematic bias rather than definitive confirmation.",
        "* **Mandate:** This step requires the assumption of external, non-Hubble data to test the robustness of the $k$ value independently.",
        "",
        "**II. Approval Gates**",
        "No revisions will be performed until this plan receives explicit approval.",
      ].join("\n"),
    );
    writeFileSync(
      approvalPath,
      "# Revision Plan Approval Record\n\nApproved current plan.\n",
    );
    writeWorkspaceFile(
      projectRoot,
      "docs/stale-long-context.md",
      "UNREAD_BULK_CONTEXT",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValue({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    parseFile.mockResolvedValue({ text: "UNREAD_BULK_CONTEXT" });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      writeFileSync(
        revisedPath,
        [
          "# Revised Manuscript",
          "",
          "## Material Calibration Cross-Check",
          "",
          "This revision performs a fresh Cepheid zero-point calibration constant check.",
          "It treats Virgo Cluster leverage as a systematic risk and compares the k value against external non-Hubble data.",
        ].join("\n"),
      );
      return "Saved docs/hubble-1929-revised-manuscript.md with the approved plan requirements.";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-compact-context",
      },
      body: JSON.stringify({
        message:
          "Please run the revision now using the approved plan in docs/hubble-1929-revision-plan.md and save the revised manuscript as a visible artifact.",
        messages: [
          {
            role: "assistant",
            content: "STALE OLD CHAT CONTEXT SHOULD NOT BE SENT",
          },
          { role: "user", content: "Earlier unrelated instruction" },
          {
            role: "user",
            content:
              "Please run the revision now using the approved plan in docs/hubble-1929-revision-plan.md and save the revised manuscript as a visible artifact.",
          },
        ],
        files: [
          {
            name: "stale-long-context.md",
            workspacePath: "docs/stale-long-context.md",
            source: "generated",
            size: "1 KB",
          },
        ],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    expect(events.at(-1)).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revised-manuscript.md"],
    });
    const initialPrompt = sendOpenClawMessage.mock.calls[0]?.[0] ?? "";
    const initialOptions = sendOpenClawMessage.mock.calls[0]?.[1] ?? {};
    expect(initialPrompt).toContain("Revise-and-resubmit artifact rules");
    expect(initialPrompt).not.toContain("Recent web chat context");
    expect(initialPrompt).not.toContain(
      "STALE OLD CHAT CONTEXT SHOULD NOT BE SENT",
    );
    expect(initialPrompt).not.toContain("UNREAD_BULK_CONTEXT");
    expect(initialOptions).toMatchObject({ timeoutMs: 90_000 });
    expect(injectBrainContextIntoUserMessage).not.toHaveBeenCalled();
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(1);
  });

  it("materializes a verified OpenClaw-authored manuscript block when the first fast pass only claims success", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revised-manuscript.md",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "**Step 6: Material Calibration Cross-Check (Critical New Step)**",
        "",
        "* **Deliverable:** The revised manuscript must now include a dedicated subsection detailing a 'Material Calibration Cross-Check.' This section must require a fresh, explicit determination of the Cepheid zero-point calibration constant ($M_0). Furthermore, it must dedicate specific discussion to the weight and potential over-leverage of the Virgo Cluster data, treating it as a potential source of systematic bias rather than definitive confirmation.",
        "* **Mandate:** This step requires the assumption of external, non-Hubble data to test the robustness of the $k$ value independently.",
        "",
        "**II. Approval Gates**",
        "No revisions will be performed until this plan receives explicit approval.",
      ].join("\n"),
    );
    writeFileSync(
      approvalPath,
      "# Revision Plan Approval Record\n\nApproved current plan.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValue({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage
      .mockImplementationOnce(async () => {
        writeFileSync(
          revisedPath,
          "# Revised Manuscript\n\nThis draft discusses general uncertainty only.\n",
        );
        return "Saved docs/hubble-1929-revised-manuscript.md with the approved changes.";
      })
      .mockImplementationOnce(async () =>
        [
          '```scienceswarm-artifact path="docs/hubble-1929-revised-manuscript.md"',
          "# Revised Manuscript",
          "",
          "## Material Calibration Cross-Check",
          "",
          "The revised manuscript now performs a fresh Cepheid zero-point calibration constant check before treating the distance scale as stable.",
          "",
          "The analysis explicitly treats Virgo Cluster leverage as a possible systematic bias rather than definitive confirmation of the velocity-distance relation.",
          "",
          "The cross-check compares against external non-Hubble data so the robustness of the k value is tested independently.",
          "```",
        ].join("\n"),
      );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-block-repair",
      },
      body: JSON.stringify({
        message:
          "Please retry the revision now using the approved plan in docs/hubble-1929-revision-plan.md and save the revised manuscript as a visible artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revised-manuscript.md"],
      text: expect.stringContaining("verified the visible revised manuscript"),
    });
    const revised = readFileSync(revisedPath, "utf-8");
    expect(revised).toContain("Material Calibration Cross-Check");
    expect(revised).toContain("Cepheid zero-point calibration constant");
    expect(revised).toContain("Virgo Cluster leverage");
    expect(revised).toContain("external non-Hubble data");
    const blockRepairPrompt = sendOpenClawMessage.mock.calls[1]?.[0] ?? "";
    expect(blockRepairPrompt).toContain(
      "Return exactly one complete machine-readable artifact block",
    );
    expect(blockRepairPrompt).toContain("Do not use workspace tools");
    expect(blockRepairPrompt).toContain(
      "Do not mention Codex, Claude Code, Pi, or any other external agent brand in the response.",
    );
    expect(blockRepairPrompt).toContain(
      "Do not promise future background monitoring, follow-up messages, or later progress updates after your final response.",
    );
    expect(blockRepairPrompt).toContain("Current revised manuscript content");
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps a visible candidate artifact when authored revision blocks still fail verification", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revised-manuscript.md",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "## Material Calibration Cross-Check",
        "",
        "- The revised manuscript must add a material calibration cross-check section.",
        "- The revised manuscript must mention the Cepheid zero-point calibration constant.",
        "- The revised manuscript must discuss Virgo Cluster leverage.",
        "- The revised manuscript must compare against external non-Hubble data.",
        "",
        "## Approval Gate",
        "",
        "Do not rewrite until approved.",
      ].join("\n"),
    );
    writeFileSync(
      approvalPath,
      "# Revision Plan Approval Record\n\nApproved current plan.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValue({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage
      .mockResolvedValueOnce(
        [
          '```scienceswarm-artifact path="docs/hubble-1929-revised-manuscript.md"',
          "# Revised Manuscript Draft",
          "",
          "## Material Calibration Cross-Check",
          "",
          "The revised manuscript now performs a fresh Cepheid zero-point calibration constant check.",
          "",
          "The manuscript also treats Virgo Cluster leverage as a possible systematic bias.",
          "```",
        ].join("\n"),
      )
      .mockResolvedValueOnce(
        [
          '```scienceswarm-artifact path="docs/hubble-1929-revised-manuscript.md"',
          "# Revised Manuscript Draft",
          "",
          "## Material Calibration Cross-Check",
          "",
          "The revised manuscript now performs a fresh Cepheid zero-point calibration constant check.",
          "",
          "The manuscript also treats Virgo Cluster leverage as a possible systematic bias.",
          "",
          "This second pass still omits the external comparison requirement.",
          "```",
        ].join("\n"),
      );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-visible-incomplete-artifact",
      },
      body: JSON.stringify({
        message:
          "Please run the revision now using the approved plan in docs/hubble-1929-revision-plan.md and save the revised manuscript as a visible artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revised-manuscript.md"],
      text: expect.stringContaining(
        "Artifact available for review: `docs/hubble-1929-revised-manuscript.md`",
      ),
    });
    expect(readFileSync(revisedPath, "utf-8")).toContain(
      "external comparison requirement",
    );
    const repairPrompt = sendOpenClawMessage.mock.calls[1]?.[0] ?? "";
    expect(repairPrompt).toContain("Current revised manuscript content");
    expect(repairPrompt).toContain(
      "The manuscript also treats Virgo Cluster leverage as a possible systematic bias.",
    );
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(2);
  });

  it("ignores response-letter instructions when verifying the revised manuscript artifact", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revised-manuscript.md",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "## Revised Manuscript",
        "",
        "- The revised manuscript must add a mechanistic mediation section.",
        "",
        "## The Point-by-Point Response Letter (Crucial)",
        "",
        "- Create a dedicated document that maps every single piece of feedback to the specific location in the revised manuscript (e.g., \"Reviewer 1, Point 3: Addressed on Page 8, Lines 12-15\").",
        "",
        "## Approval Gate",
        "",
        "Do not rewrite until approved.",
      ].join("\n"),
    );
    writeFileSync(
      approvalPath,
      "# Revision Plan Approval Record\n\nApproved current plan.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      [
        '```scienceswarm-artifact path="docs/hubble-1929-revised-manuscript.md"',
        "# Revised Manuscript Draft",
        "",
        "## Mechanistic Mediation Section",
        "",
        "This revision adds a dedicated mechanistic mediation analysis section to the manuscript.",
        "```",
      ].join("\n"),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-ignore-response-letter-requirements",
      },
      body: JSON.stringify({
        message:
          "Please run the revision now using the approved plan in docs/hubble-1929-revision-plan.md and save the revised manuscript as a visible artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revised-manuscript.md"],
      text: expect.stringContaining("docs/hubble-1929-revised-manuscript.md"),
    });
    expect(finalEvent?.text).not.toContain(
      "Reviewer 1, Point 3: Addressed on Page 8, Lines 12-15",
    );
    expect(readFileSync(revisedPath, "utf-8")).toContain(
      "Mechanistic Mediation Section",
    );
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
  });

  it("routes an approved revision run through OpenClaw after approval gating", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const critiquePath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-critique.md",
    );
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revised-manuscript.md",
    );
    writeFileSync(
      critiquePath,
      "# Critique\n\nAdd a limitations section and clarify the main claim.\n",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "## Statistical Uncertainty and Limitations",
        "",
        "- Add uncertainty around distance estimates and sample limits.",
        "",
        "## Approval Gate",
        "",
        "Do not rewrite until approved.",
      ].join("\n"),
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      writeFileSync(
        revisedPath,
        [
          "# Revised Manuscript Draft",
          "",
          "This draft was written by the configured OpenClaw/LLM path.",
          "",
          "## Statistical Uncertainty and Limitations",
          "",
          "Added limitations.",
        ].join("\n"),
      );
      return "I revised the manuscript and saved it to docs/hubble-1929-revised-manuscript.md.";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-run-approved",
      },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content:
              "Please audit the uploaded Hubble paper and propose a revision plan.",
          },
          {
            role: "assistant",
            content:
              "I created docs/hubble-1929-critique.md and docs/hubble-1929-revision-plan.md.",
          },
          {
            role: "user",
            content:
              "Please update the visible revision plan artifact to add a short Statistical Uncertainty and Limitations section before manuscript rewriting.",
          },
          {
            role: "assistant",
            content: "I updated docs/hubble-1929-revision-plan.md.",
          },
          {
            role: "user",
            content:
              "I approve the currently visible revision plan, including the Statistical Uncertainty and Limitations section.",
          },
          {
            role: "assistant",
            content:
              "I recorded your approval and have not rewritten the manuscript.",
          },
          {
            role: "user",
            content:
              "Please run the approved revision now and write the revised manuscript artifact.",
          },
        ],
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revised-manuscript.md"],
      text: expect.stringContaining("docs/hubble-1929-revised-manuscript.md"),
    });
    expect(existsSync(revisedPath)).toBe(true);
    const revised = readFileSync(revisedPath, "utf-8");
    expect(revised).toContain("# Revised Manuscript Draft");
    expect(revised).toContain("Statistical Uncertainty and Limitations");
    expect(revised).toContain("configured OpenClaw/LLM path");
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).toContain(
      "write the revised manuscript artifact to",
    );
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).toContain(
      "docs/hubble-1929-revised-manuscript.md",
    );
    expect(putBrainPage).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-web-alpha-project"),
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          relative_path: "docs/hubble-1929-revised-manuscript.md",
        }),
      }),
    );
  });

  it("treats an approved full package with a cover letter as a revision run and verifies both deliverables", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    mkdirSync(path.join(projectRoot, "data"), { recursive: true });
    mkdirSync(path.join(projectRoot, "code"), { recursive: true });
    mkdirSync(path.join(projectRoot, "papers"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "mendel-1866-textlayer-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "mendel-1866-textlayer-plan-approval.md",
    );
    const analysisPath = path.join(
      projectRoot,
      "docs",
      "mendel-1866-textlayer-analysis-rerun.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "mendel-1866-textlayer-revised-manuscript.md",
    );
    const coverPath = path.join(
      projectRoot,
      "docs",
      "mendel-1866-textlayer-cover-letter.md",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "## Statistical Interpretation",
        "",
        "- The revised manuscript must discuss the chi-square rerun provenance and the p-value near 0.989.",
        "",
        "## Approval Gate",
        "",
        "Do not rewrite until approved.",
      ].join("\n"),
    );
    writeFileSync(
      approvalPath,
      "# Revision Plan Approval Record\n\nApproved current Mendel plan.\n",
    );
    writeFileSync(
      analysisPath,
      "# Data/Code Rerun Provenance\n\np-value near 0.989.\n",
    );
    writeFileSync(
      path.join(projectRoot, "data", "mendel-counts.csv"),
      "trait,observed,expected\nseed,6022,6000\n",
    );
    writeFileSync(
      path.join(projectRoot, "code", "chisq.py"),
      "print('p=0.989')\n",
    );
    writeFileSync(
      path.join(projectRoot, "papers", "mendel-1866-textlayer.pdf"),
      "%PDF fixture\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage
      .mockResolvedValueOnce("I ran the package, but only summarized it.")
      .mockImplementationOnce(async () => {
        writeFileSync(
          revisedPath,
          [
            "# Revised Manuscript",
            "",
            "## Statistical Interpretation",
            "",
            "The revised manuscript discusses the chi-square rerun provenance and the p-value near 0.989.",
          ].join("\n"),
        );
        return "Saved docs/mendel-1866-textlayer-revised-manuscript.md.";
      })
      .mockImplementationOnce(async () => {
        writeFileSync(
          coverPath,
          [
            "# Cover Letter to the Editor",
            "",
            "Dear Editor,",
            "",
            "The revised package includes the manuscript revision and preserves the data/code rerun provenance.",
          ].join("\n"),
        );
        return "Saved docs/mendel-1866-textlayer-cover-letter.md.";
      });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-full-package-cover",
      },
      body: JSON.stringify({
        message:
          "Please run the approved Mendel revision package now. Use docs/mendel-1866-textlayer-revision-plan.md, docs/mendel-1866-textlayer-plan-approval.md, and docs/mendel-1866-textlayer-analysis-rerun.md. Create visible project artifacts for the revised manuscript and editor cover letter, keep data/mendel-counts.csv and code/chisq.py as read-only inputs, and preserve visible provenance for the data/code rerun.",
        files: [
          {
            name: "mendel-counts.csv",
            workspacePath: "data/mendel-counts.csv",
            source: "upload",
            size: "1 KB",
          },
          {
            name: "chisq.py",
            workspacePath: "code/chisq.py",
            source: "upload",
            size: "1 KB",
          },
          {
            name: "mendel-1866-textlayer.pdf",
            workspacePath: "papers/mendel-1866-textlayer.pdf",
            source: "upload",
            size: "1 KB",
          },
        ],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: [
        "docs/mendel-1866-textlayer-revised-manuscript.md",
        "docs/mendel-1866-textlayer-cover-letter.md",
      ],
      text: expect.stringContaining(
        "docs/mendel-1866-textlayer-cover-letter.md",
      ),
    });
    const phaseLabels = events
      .flatMap((event) =>
        Array.isArray(event.taskPhases) ? event.taskPhases : [],
      )
      .map((phase) => (phase as { label?: string }).label);
    expect(phaseLabels).toContain("Drafting revision");
    expect(phaseLabels).toContain("Drafting cover letter");
    expect(existsSync(revisedPath)).toBe(true);
    expect(existsSync(coverPath)).toBe(true);
    expect(readFileSync(revisedPath, "utf-8")).toContain("p-value near 0.989");
    expect(readFileSync(coverPath, "utf-8")).toContain("Dear Editor");
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(3);
    const repairPrompts = sendOpenClawMessage.mock.calls
      .map((call) => call[0])
      .join("\n\n");
    expect(repairPrompts).not.toContain(
      "Requested artifact: " +
        path.join(projectRoot, "data", "mendel-counts.csv"),
    );
  });

  it("uses the visible approval record when revision chat history is absent", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "## Statistical Uncertainty and Limitations",
        "",
        "- Add uncertainty around distance estimates and sample limits.",
      ].join("\n"),
    );
    writeFileSync(
      approvalPath,
      "# Revision Plan Approval Record\n\nApproved.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      const revisedPath = path.join(
        projectRoot,
        "docs",
        "hubble-1929-revised-manuscript.md",
      );
      writeFileSync(
        revisedPath,
        "# Revised Manuscript Draft\n\nWritten by OpenClaw.\n",
      );
      return "Saved the approved revision to docs/hubble-1929-revised-manuscript.md.";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-run-persisted-approval",
      },
      body: JSON.stringify({
        message:
          "Please run the approved revision now and write the revised manuscript artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-revised-manuscript.md"],
      text: expect.stringContaining("docs/hubble-1929-revised-manuscript.md"),
    });
    expect(
      existsSync(
        path.join(projectRoot, "docs", "hubble-1929-revised-manuscript.md"),
      ),
    ).toBe(true);
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
  });

  it("classifies an approved revision run from the raw prompt when a plan preview is active", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revised-manuscript.md",
    );
    const coverPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-cover-letter.md",
    );
    const planContent = [
      "# Revision Plan",
      "",
      "## Critique and Revision Scope",
      "",
      "- The revised manuscript must include statistical uncertainty and limitations.",
      "",
      "## Approval Gate",
      "",
      "Do not write the revised manuscript or editor cover letter until the scientist approves the plan.",
    ].join("\n");
    writeFileSync(planPath, planContent);
    writeFileSync(
      approvalPath,
      "# Revision Plan Approval Record\n\nApproved current plan.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage
      .mockImplementationOnce(async () => {
        writeFileSync(
          revisedPath,
          "# Revised Manuscript\n\nThis manuscript includes statistical uncertainty and limitations.\n",
        );
        return "Saved docs/hubble-1929-revised-manuscript.md.";
      })
      .mockImplementationOnce(async () => {
        writeFileSync(
          coverPath,
          "# Cover Letter to the Editor\n\nDear Editor,\n\nPlease consider this revised manuscript.\n",
        );
        return "Saved docs/hubble-1929-cover-letter.md.";
      });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-active-plan-preview",
      },
      body: JSON.stringify({
        message:
          "Please run the approved Hubble revision package now using docs/hubble-1929-revision-plan.md and docs/hubble-1929-plan-approval.md. Create visible project artifacts for the revised manuscript and the editor cover letter.",
        messages: [
          {
            role: "user",
            content:
              "I approve the visible Hubble revision plan in docs/hubble-1929-revision-plan.md. Please record approval for that plan and do not run the revision yet.",
          },
          {
            role: "assistant",
            content:
              "I recorded your approval and have not started rewriting the manuscript.",
          },
        ],
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
        activeFile: {
          path: "docs/hubble-1929-revision-plan.md",
          content: planContent,
        },
      }),
    });

    const response = await POST(request);
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: [
        "docs/hubble-1929-revised-manuscript.md",
        "docs/hubble-1929-cover-letter.md",
      ],
      text: expect.stringContaining("docs/hubble-1929-cover-letter.md"),
    });
    const phaseLabels = events
      .flatMap((event) => event.taskPhases ?? [])
      .map((phase) => (phase as { label?: string }).label);
    expect(phaseLabels).toContain("Drafting revision");
    expect(phaseLabels).toContain("Drafting cover letter");
    expect(phaseLabels).not.toContain("Drafting critique");
    expect(phaseLabels).not.toContain("Drafting plan");
    expect(existsSync(revisedPath)).toBe(true);
    expect(existsSync(coverPath)).toBe(true);
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).toContain(
      "write the revised manuscript artifact to",
    );
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).not.toContain(
      "[Currently viewing file:",
    );
  });

  it("blocks a revision run when the visible plan changed after the last approval", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const planPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revision-plan.md",
    );
    const approvalPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-plan-approval.md",
    );
    const revisedPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-revised-manuscript.md",
    );
    writeFileSync(
      approvalPath,
      "# Revision Plan Approval Record\n\nApproved old plan.\n",
    );
    const oldTimestamp = new Date(Date.now() - 20_000);
    utimesSync(approvalPath, oldTimestamp, oldTimestamp);
    writeFileSync(
      planPath,
      [
        "# Revision Plan",
        "",
        "## Statistical Uncertainty and Limitations",
        "",
        "- Added after the earlier approval.",
        "",
        "## Approval Gate",
        "",
        "Needs fresh approval.",
      ].join("\n"),
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-stale-approval",
      },
      body: JSON.stringify({
        message:
          "Please run the approved revision now and write the revised manuscript artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    const payload = (await response.json()) as {
      response?: string;
      generatedFiles?: string[];
    };
    expect(payload.response).toContain(
      "I did not start rewriting the manuscript",
    );
    expect(payload.response).toContain("approval is stale");
    expect(payload.generatedFiles).toEqual([]);
    expect(existsSync(revisedPath)).toBe(false);
    expect(sendOpenClawMessage).not.toHaveBeenCalled();
    expect(putBrainPage).not.toHaveBeenCalled();
  });

  it("routes editor cover-letter drafting through OpenClaw", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const coverLetterPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-cover-letter.md",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-critique.md"),
      "# Critique\n\nClarify the central claim.\n",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-revision-plan.md"),
      "# Revision Plan\n\n## Statistical Uncertainty and Limitations\n\n- Add limitations.\n",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-revised-manuscript.md"),
      "# Revised Manuscript Draft\n\n## Statistical Uncertainty and Limitations\n\nAdded limitations.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      writeFileSync(
        coverLetterPath,
        [
          "# Cover Letter to the Editor",
          "",
          "Dear Editor,",
          "",
          "This letter was drafted by the configured OpenClaw/LLM path.",
        ].join("\n"),
      );
      return "I drafted the cover letter and saved it to docs/hubble-1929-cover-letter.md.";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-cover-letter",
      },
      body: JSON.stringify({
        message:
          "Please draft a cover letter to the editor for this revised manuscript and save it as a visible artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-cover-letter.md"],
      text: expect.stringContaining("docs/hubble-1929-cover-letter.md"),
    });
    expect(existsSync(coverLetterPath)).toBe(true);
    const coverLetter = readFileSync(coverLetterPath, "utf-8");
    expect(coverLetter).toContain("# Cover Letter to the Editor");
    expect(coverLetter).toContain("Dear Editor");
    expect(coverLetter).toContain("configured OpenClaw/LLM path");
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).toContain(
      "Write the editor cover letter artifact to",
    );
    expect(sendOpenClawMessage.mock.calls[0]?.[0]).toContain(
      "docs/hubble-1929-cover-letter.md",
    );
    expect(putBrainPage).toHaveBeenCalledWith(
      expect.stringContaining("openclaw-web-alpha-project"),
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          relative_path: "docs/hubble-1929-cover-letter.md",
        }),
      }),
    );
  });

  it("materializes authored cover-letter artifact blocks from streamed OpenClaw replies", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const coverLetterPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-cover-letter.md",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-critique.md"),
      "# Critique\n\nClarify the central claim.\n",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-revision-plan.md"),
      "# Revision Plan\n\n## Statistical Uncertainty and Limitations\n\n- Add limitations.\n",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-revised-manuscript.md"),
      "# Revised Manuscript Draft\n\n## Statistical Uncertainty and Limitations\n\nAdded limitations.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      [
        "[agents/auth-profiles] synced openai-codex credentials from external cli",
        "",
        "```scienceswarm-artifact path=\"docs/hubble-1929-cover-letter.md\"",
        "# Cover Letter to the Editor",
        "",
        "Dear Editor,",
        "",
        "This letter was returned inside an authored artifact block.",
        "```",
        "",
        "The following artifacts are available in the workspace:",
        "- `docs/hubble-1929-cover-letter.md`",
        "- `docs/hubble-1929-revised-manuscript.md`",
      ].join("\n"),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-cover-letter-authored-block",
      },
      body: JSON.stringify({
        message:
          "Please draft a cover letter to the editor for this revised manuscript and save it as a visible artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(Array.isArray(finalEvent?.generatedFiles)).toBe(true);
    expect(finalEvent?.generatedFiles).toEqual(
      expect.arrayContaining(["docs/hubble-1929-cover-letter.md"]),
    );
    expect(String(finalEvent?.text ?? "")).toContain(
      "docs/hubble-1929-cover-letter.md",
    );
    expect(String(finalEvent?.text ?? "")).not.toContain("scienceswarm-artifact");
    expect(String(finalEvent?.text ?? "")).not.toContain("[agents/auth-profiles]");
    expect(existsSync(coverLetterPath)).toBe(true);
    expect(readFileSync(coverLetterPath, "utf-8")).toContain(
      "Dear Editor,",
    );
    expect(readFileSync(coverLetterPath, "utf-8")).toContain(
      "authored artifact block",
    );
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
  });

  it("retries editor cover-letter drafting with compact artifact paths when OpenClaw returns an empty response", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    const coverLetterPath = path.join(
      projectRoot,
      "docs",
      "hubble-1929-cover-letter.md",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-critique.md"),
      "# Critique\n\nClarify the central claim.\n",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-revision-plan.md"),
      "# Revision Plan\n\n## Statistical Uncertainty and Limitations\n\n- Add limitations.\n",
    );
    writeFileSync(
      path.join(projectRoot, "docs", "hubble-1929-revised-manuscript.md"),
      "# Revised Manuscript Draft\n\n## Statistical Uncertainty and Limitations\n\nAdded limitations.\n",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage
      .mockResolvedValueOnce("")
      .mockImplementationOnce(async () => {
        writeFileSync(
          coverLetterPath,
          [
            "# Cover Letter to the Editor",
            "",
            "Dear Editor,",
            "",
            "This retry still used the configured OpenClaw/LLM path.",
          ].join("\n"),
        );
        return "I drafted the cover letter and saved it to docs/hubble-1929-cover-letter.md.";
      });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-cover-letter-retry",
      },
      body: JSON.stringify({
        message:
          "Please draft a cover letter to the editor for this revised manuscript and save it as a visible artifact.",
        files: [],
        projectId: "alpha-project",
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const events = await readSseEvents(response);
    const finalEvent = events.at(-1);
    expect(finalEvent).toMatchObject({
      generatedFiles: ["docs/hubble-1929-cover-letter.md"],
      text: expect.stringContaining("docs/hubble-1929-cover-letter.md"),
    });
    expect(existsSync(coverLetterPath)).toBe(true);
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(2);
    const retryPrompt = sendOpenClawMessage.mock.calls[1]?.[0] ?? "";
    expect(retryPrompt).toContain(
      "Retry this artifact-writing request with compact context",
    );
    expect(retryPrompt).toContain(
      "Do not mention Codex, Claude Code, Pi, or any other external agent brand in the response.",
    );
    expect(retryPrompt).toContain(
      "Do not promise future background monitoring, follow-up messages, or later progress updates after your final response.",
    );
    expect(retryPrompt).toContain(
      path.join(projectRoot, "docs", "hubble-1929-revised-manuscript.md"),
    );
    expect(retryPrompt).toContain(
      path.join(projectRoot, "docs", "hubble-1929-cover-letter.md"),
    );
  });

  it("does not treat future approval language in an audit request as plan approval", async () => {
    createProjectRoot("alpha-project");
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      "I prepared a critique and approval-gated revision plan.",
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "revise-resubmit-audit-approval-language",
      },
      body: JSON.stringify({
        message:
          "Please audit the uploaded Hubble 1929 paper thoroughly for revise-and-resubmit. Identify the main scientific and presentation issues, propose a prioritized revision plan, and make the plan concrete enough that I can approve it before you revise the manuscript.",
        files: [
          { name: "hubble-1929.pdf", workspacePath: "papers/hubble-1929.pdf" },
        ],
        projectId: "alpha-project",
        streamPhases: false,
      }),
    });

    const response = await POST(request);
    const payload = (await response.json()) as { response?: string };
    expect(payload.response).toContain("I prepared a critique");
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
  });

  it("treats before-approval data/code questions as clarification, not plan changes", async () => {
    createProjectRoot("alpha-project");
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      "The original CSV and code will stay read-only; provenance remains visible in docs/revision-package-analysis-rerun.md.",
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "mendel-clarification-not-plan-change",
      },
      body: JSON.stringify({
        message:
          "Before I approve the plan, please explain in plain language what will happen to data/mendel-counts.csv and code/chisq.py when you run the full revision package. Will you modify the original CSV or code, rerun the script, create new outputs, and where will the provenance be visible?",
        files: [
          {
            name: "mendel-counts.csv",
            size: "2 KB",
            source: "workspace",
            workspacePath: "data/mendel-counts.csv",
          },
          {
            name: "chisq.py",
            size: "8 KB",
            source: "workspace",
            workspacePath: "code/chisq.py",
          },
        ],
        projectId: "alpha-project",
      }),
    });

    const response = await POST(request);
    const body = (await response.json()) as { response?: string };

    expect(response.status).toBe(200);
    expect(body.response).toContain("read-only");
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
    const openClawPrompt = sendOpenClawMessage.mock.calls[0]?.[0] ?? "";
    expect(openClawPrompt).toContain("Clarification request rules");
    expect(openClawPrompt).not.toContain("If the user asks for a plan change");
    expect(openClawPrompt).not.toContain(
      "write the revised manuscript artifact",
    );
  });

  it("resolves contextual bare references after phrases like 'read the file X'", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    writeFileSync(path.join(projectRoot, "RESULTS.md"), "# Results\n");
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    readFile.mockResolvedValueOnce(Buffer.from("# Results\n"));
    parseFile.mockResolvedValueOnce({
      text: "# Results",
      pages: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce("Used RESULTS.md");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "Read the file results in the current project and summarize it.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      "Resolved project file references for this turn:",
    );
    expect(openClawMessage).toContain("- results -> RESULTS.md");
    expect(openClawMessage).toContain("File: RESULTS.md (1 pages)");
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: expect.stringContaining("RESULTS.md"),
    });
  });

  it("resolves near-name project file references by unique fuzzy match", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    writeFileSync(path.join(projectRoot, "RESULTS.md"), "# Results\n");
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    readFile.mockResolvedValueOnce(Buffer.from("# Results\n"));
    parseFile.mockResolvedValueOnce({
      text: "# Results",
      pages: 1,
    });
    sendOpenClawMessage.mockResolvedValueOnce("Used RESULTS.md");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Read reslts in the current project and summarize it.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      "Resolved project file references for this turn:",
    );
    expect(openClawMessage).toContain("- reslts -> RESULTS.md");
    expect(openClawMessage).toContain("File: RESULTS.md (1 pages)");
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: expect.stringContaining("RESULTS.md"),
    });
  });

  it("does not auto-attach ambiguous fuzzy project file references", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    writeFileSync(path.join(projectRoot, "RESULTS.md"), "# Results\n");
    mkdirSync(path.join(projectRoot, "results"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, "results", "results.csv"),
      "label,value\nA,1\n",
    );
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("Which results file?");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Read results in the current project and summarize it.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      "Ambiguous project file references were not auto-attached. Ask the user to confirm one of:",
    );
    expect(openClawMessage).toContain(
      "results: RESULTS.md, results/results.csv",
    );
    expect(openClawMessage).not.toContain("File: RESULTS.md");
    expect(readFile).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: "Which results file?",
    });
  });

  it("imports OpenClaw-generated media and sibling runtime outputs into the project workspace", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const homeRoot = mkdtempSync(path.join(tmpdir(), "openclaw-home-"));
    vi.stubEnv("HOME", homeRoot);

    const mediaPath = path.join(
      homeRoot,
      ".openclaw",
      "media",
      "tool-image-generation",
      "ratio-trend.jpg",
    );
    const dataPath = path.join(
      homeRoot,
      ".openclaw",
      "workspace",
      "ratio-trend-results.csv",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      mkdirSync(path.dirname(mediaPath), { recursive: true });
      mkdirSync(path.dirname(dataPath), { recursive: true });
      writeFileSync(mediaPath, "binary-image");
      writeFileSync(dataPath, "label,value\nA,1\nB,2\n");
      return `I have generated the figure and saved it as \`${mediaPath}\`.`;
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Create a chart from results.md in the current project data.",
        projectId: "alpha-project",
        files: [
          { name: "results.md", workspacePath: "results.md", size: "1 KB" },
        ],
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: expect.stringContaining("figures/ratio-trend.jpg"),
      generatedFiles: expect.arrayContaining([
        "figures/ratio-trend.jpg",
        "data/ratio-trend-results.csv",
      ]),
      generatedArtifacts: expect.arrayContaining([
        expect.objectContaining({
          projectPath: "figures/ratio-trend.jpg",
          sourceFiles: ["results.md"],
          prompt: "Create a chart from results.md in the current project data.",
          tool: "OpenClaw CLI",
        }),
      ]),
    });
    expect(
      existsSync(path.join(projectRoot, "figures", "ratio-trend.jpg")),
    ).toBe(true);
    expect(
      existsSync(path.join(projectRoot, "data", "ratio-trend-results.csv")),
    ).toBe(true);
  });

  it("rewrites internal OpenClaw workspace paths to the imported project workspace path", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const homeRoot = mkdtempSync(path.join(tmpdir(), "openclaw-home-"));
    vi.stubEnv("HOME", homeRoot);

    const openClawChartPath = path.join(
      homeRoot,
      ".openclaw",
      "workspace",
      "results",
      "summary-chart.svg",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      mkdirSync(path.dirname(openClawChartPath), { recursive: true });
      writeFileSync(
        openClawChartPath,
        '<svg><rect width="10" height="10" /></svg>',
      );
      return "Saved chart to results/summary-chart.svg";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Create a chart and save it to the project.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: "Saved chart to figures/summary-chart.svg",
      generatedFiles: ["figures/summary-chart.svg"],
      generatedArtifacts: [
        expect.objectContaining({
          projectPath: "figures/summary-chart.svg",
          tool: "OpenClaw CLI",
        }),
      ],
    });
    expect(
      existsSync(path.join(projectRoot, "figures", "summary-chart.svg")),
    ).toBe(true);
  });

  it("updates an existing visible artifact when OpenClaw edits the matching runtime workspace path", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const stateRoot = ensureScienceSwarmDir();
    const existingPath = path.join(
      projectRoot,
      "docs",
      "paper-results-section.md",
    );
    const runtimePath = path.join(
      stateRoot,
      "openclaw",
      "workspace",
      "docs",
      "paper-results-section.md",
    );
    mkdirSync(path.dirname(existingPath), { recursive: true });
    writeFileSync(
      existingPath,
      "# Results\n\n## Limitations\n\nInitial caveats.\n",
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    utimesSync(existingPath, oldTimestamp, oldTimestamp);

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      mkdirSync(path.dirname(runtimePath), { recursive: true });
      writeFileSync(
        runtimePath,
        [
          "# Results",
          "",
          "## Reviewer-facing Caveats",
          "",
          "- Accuracy changes are descriptive until replicated.",
          "- Latency and memory should be treated as deployment constraints.",
        ].join("\n"),
      );
      return "Successfully replaced 1 block(s) in docs/paper-results-section.md.";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "Revise docs/paper-results-section.md in place with reviewer-facing caveats.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: expect.stringContaining("docs/paper-results-section.md"),
      generatedFiles: ["docs/paper-results-section.md"],
      generatedArtifacts: [
        expect.objectContaining({
          projectPath: "docs/paper-results-section.md",
          tool: "OpenClaw CLI",
        }),
      ],
    });
    expect(readFileSync(existingPath, "utf-8")).toContain(
      "## Reviewer-facing Caveats",
    );
    expect(
      existsSync(path.join(projectRoot, "docs", "paper-results-section-2.md")),
    ).toBe(false);
  });

  it("treats markdown-emphasized output paths as satisfying explicit requested artifacts", async () => {
    const projectRoot = createProjectRoot("project-alpha-recovery-7747");
    const stateRoot = ensureScienceSwarmDir();
    const summaryPath = path.join(
      stateRoot,
      "openclaw",
      "workspace",
      "reports",
      "baseline_vs_variant_summary.md",
    );
    const resultsPath = path.join(
      stateRoot,
      "openclaw",
      "workspace",
      "reports",
      "baseline_vs_variant_results.csv",
    );

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      mkdirSync(path.dirname(summaryPath), { recursive: true });
      writeFileSync(
        summaryPath,
        [
          "# Baseline vs Variant Summary",
          "",
          "- Improved: variant accuracy +4.1 points",
          "- Regressed: latency +18 ms",
          "- Runtime cost: 1 extra optimization step per batch",
        ].join("\n"),
      );
      writeFileSync(
        resultsPath,
        [
          "condition,accuracy,latency_ms",
          "baseline,0.71,42",
          "variant,0.751,60",
        ].join("\n"),
      );
      return [
        "Summary written to **reports/baseline_vs_variant_summary.md**.",
        "Results written to **reports/baseline_vs_variant_results.csv**.",
      ].join(" ");
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message:
          "Build and run a tiny reproducible baseline-versus-variant experiment for a project-alpha sequence task. Save the outputs as reports/baseline_vs_variant_summary.md and reports/baseline_vs_variant_results.csv in this workspace.",
        projectId: "project-alpha-recovery-7747",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: expect.stringContaining("docs/baseline_vs_variant_summary.md"),
      generatedFiles: expect.arrayContaining([
        "docs/baseline_vs_variant_summary.md",
        "data/baseline_vs_variant_results.csv",
      ]),
      generatedArtifacts: expect.arrayContaining([
        expect.objectContaining({
          projectPath: "docs/baseline_vs_variant_summary.md",
          tool: "OpenClaw CLI",
        }),
        expect.objectContaining({
          projectPath: "data/baseline_vs_variant_results.csv",
          tool: "OpenClaw CLI",
        }),
      ]),
    });
    expect(
      readFileSync(
        path.join(projectRoot, "docs", "baseline_vs_variant_summary.md"),
        "utf-8",
      ),
    ).toContain("Improved: variant accuracy +4.1 points");
    expect(
      readFileSync(
        path.join(projectRoot, "data", "baseline_vs_variant_results.csv"),
        "utf-8",
      ),
    ).toContain("variant,0.751,60");
    expect(
      existsSync(
        path.join(projectRoot, "reports", "baseline_vs_variant_summary.md"),
      ),
    ).toBe(false);
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
  });

  it("does not import absolute paths that escape the project and OpenClaw roots", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const outsideRoot = mkdtempSync(path.join(tmpdir(), "openclaw-outside-"));
    const outsideFile = path.join(outsideRoot, "secret-chart.svg");
    writeFileSync(outsideFile, '<svg><circle cx="5" cy="5" r="5" /></svg>');

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(`Saved chart to ${outsideFile}`);

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Create a chart and save it to the project.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: `Saved chart to ${outsideFile}`,
      generatedFiles: [],
    });
    expect(
      existsSync(path.join(projectRoot, "figures", "secret-chart.svg")),
    ).toBe(false);
  });

  it("does not auto-import unrelated recent files from global OpenClaw runtime roots", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const homeRoot = mkdtempSync(path.join(tmpdir(), "openclaw-home-"));
    vi.stubEnv("HOME", homeRoot);

    const unrelatedOutput = path.join(
      homeRoot,
      ".openclaw",
      "media",
      "tool-image-generation",
      "unrelated-chart.jpg",
    );
    mkdirSync(path.dirname(unrelatedOutput), { recursive: true });
    writeFileSync(unrelatedOutput, "binary-image");

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      "Finished generating the figure.",
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Create a chart and save it to the project.",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: "Finished generating the figure.",
      generatedFiles: [],
    });
    expect(
      existsSync(path.join(projectRoot, "figures", "unrelated-chart.jpg")),
    ).toBe(false);
  });

  it("uses the OpenClaw CLI path before the direct local-model path when tools mode is selected", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const agentCfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(agentCfg);
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    isLocalProviderConfigured.mockReturnValue(true);
    localHealthCheck.mockResolvedValueOnce({
      running: true,
      models: ["gemma4"],
      url: "http://localhost:11434",
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw answer");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Hello",
        projectId: "alpha-project",
        mode: "openclaw-tools",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    const [[openClawMessage, openClawOptions]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain(
      `[Workspace: ${projectRoot} — use ABSOLUTE paths for all read/write/exec operations]`,
    );
    expect(openClawOptions).toEqual(
      expect.objectContaining({
        cwd: projectRoot,
      }),
    );
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("uses selected OpenClaw for normal reasoning before direct local fallback", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    isLocalProviderConfigured.mockReturnValue(true);
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw reasoning answer");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Explain the trend",
        projectId: "alpha-project",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    expect(response.headers.get("X-Chat-Mode")).toBe("reasoning");
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      mode: "reasoning",
      response: "OpenClaw reasoning answer",
    });
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
    expect(streamChat).not.toHaveBeenCalled();
    expect(localHealthCheck).not.toHaveBeenCalled();
  });

  it("sanitizes internal OpenClaw status lines from non-stream chat responses", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce([
      "[agents/auth-profiles] synced openai-codex credentials from external cli",
      "",
      "OpenClaw reasoning answer",
    ].join("\n"));

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Explain the trend",
        projectId: "alpha-project",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: "OpenClaw reasoning answer",
    });
  });

  it("maps OpenClaw context overflow to a recoverable scientist-facing failure", async () => {
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce(
      [
        "[agent/embedded] auto-compaction succeeded for openai/gpt-5.4; retrying prompt",
        "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
      ].join("\n"),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "context-overflow-test",
      },
      body: JSON.stringify({
        message: "Record this failure case.",
        messages: [{ role: "user", content: "Record this failure case." }],
        backend: "openclaw",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.response).toContain("context became too large");
    expect(body.response).toContain("preserved in the workspace");
    expect(body.response).not.toContain("[agent/embedded]");
    expect(body.response).not.toContain("gpt-5.4");
    expect(body.generatedFiles).toEqual([]);
  });

  it("ignores an explicit `backend: \"direct\"` request and still routes through OpenClaw", async () => {
    // Previously a client could force the local-direct short-circuit by
    // sending `backend: "direct"` in the request body. That bypass is gone;
    // OpenClaw always handles the chat when it is the configured and
    // connected agent.
    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw direct-override answer");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Explain the trend",
        projectId: "alpha-project",
        backend: "direct",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: "OpenClaw direct-override answer",
    });
    expect(sendOpenClawMessage).toHaveBeenCalledOnce();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("includes OpenClaw thinking traces from the session record when available", async () => {
    ensureScienceSwarmDir();
    const sessionId = "thinking-session";
    const sessionDir = path.join(
      ensureScienceSwarmDir(),
      "openclaw",
      "agents",
      "main",
      "sessions",
    );
    mkdirSync(sessionDir, { recursive: true });
    const sessionContents = `${JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspecting the imported project manifest." },
          { type: "text", text: "OpenClaw reasoning answer" },
        ],
      },
    })}\n`;
    writeFileSync(
      path.join(sessionDir, `${sessionId}.jsonl`),
      sessionContents,
      "utf8",
    );
    readFile.mockResolvedValueOnce(sessionContents);

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw reasoning answer");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Explain the trend",
        projectId: "alpha-project",
        conversationId: sessionId,
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      response: "OpenClaw reasoning answer",
      thinking: "Inspecting the imported project manifest.",
    });
  });

  it("streams OpenClaw thinking traces before the final text event", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const sessionId = "thinking-session-stream";
    const sessionDir = path.join(
      ensureScienceSwarmDir(),
      "openclaw",
      "agents",
      "main",
      "sessions",
    );
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
    let sessionContents = "";
    writeFileSync(sessionFile, sessionContents, "utf8");
    readFile.mockImplementation(async () => sessionContents);

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockImplementationOnce(async () => {
      sessionContents = `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Inspecting the imported project manifest.\n" },
          ],
        },
      })}\n`;
      writeFileSync(sessionFile, sessionContents, "utf8");
      await new Promise((resolve) => {
        setTimeout(resolve, 120);
      });
      sessionContents = `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "Inspecting the imported project manifest.\nCounting the latest thinking deltas.",
            },
          ],
        },
      })}\n`;
      writeFileSync(sessionFile, sessionContents, "utf8");
      await new Promise((resolve) => {
        setTimeout(resolve, 120);
      });
      return "OpenClaw reasoning answer";
    });

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Save the result in this project.",
        projectId: path.basename(projectRoot),
        conversationId: sessionId,
        streamPhases: true,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");

    const events = await readSseEvents(response);
    let finalTextIndex = -1;
    events.forEach((event, index) => {
      if (typeof event.text === "string") {
        finalTextIndex = index;
      }
    });
    const thinkingEvents = events.filter(
      (event) => typeof event.thinking === "string",
    );
    const firstThinkingIndex = events.findIndex(
      (event) => typeof event.thinking === "string",
    );

    expect(thinkingEvents).toEqual([
      { thinking: "Inspecting the imported project manifest.\n" },
      { thinking: "Counting the latest thinking deltas." },
    ]);
    expect(firstThinkingIndex).toBeGreaterThan(-1);
    expect(finalTextIndex).toBeGreaterThan(firstThinkingIndex);
    expect(events[finalTextIndex]).toMatchObject({
      text: "OpenClaw reasoning answer",
      conversationId: sessionId,
      backend: "openclaw",
    });
    expect(events[finalTextIndex]).not.toHaveProperty("thinking");
  });

  it("does not reuse stale OpenClaw thinking when the latest assistant turn has none", async () => {
    ensureScienceSwarmDir();
    const sessionId = "thinking-session-without-latest-trace";
    const sessionDir = path.join(
      ensureScienceSwarmDir(),
      "openclaw",
      "agents",
      "main",
      "sessions",
    );
    mkdirSync(sessionDir, { recursive: true });
    const sessionContents = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Inspecting the imported project manifest." },
            { type: "text", text: "Earlier OpenClaw reasoning answer" },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Latest OpenClaw reasoning answer" }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")
      .concat("\n");
    writeFileSync(
      path.join(sessionDir, `${sessionId}.jsonl`),
      sessionContents,
      "utf8",
    );
    readFile.mockResolvedValueOnce(sessionContents);

    resolveAgentConfig.mockReturnValue({
      type: "openclaw",
      url: "http://localhost:19002",
    });
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("Latest OpenClaw reasoning answer");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Explain the latest trend",
        projectId: "alpha-project",
        conversationId: sessionId,
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Chat-Backend")).toBe("openclaw");
    expect(body).toMatchObject({
      backend: "openclaw",
      response: "Latest OpenClaw reasoning answer",
    });
    expect(body.thinking).toBeUndefined();
  });

  it("normalizes the provided conversationId before using it as the OpenClaw session id", async () => {
    const projectRoot = createProjectRoot("alpha-project");
    const agentCfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(agentCfg);
    openClawHealthCheck.mockResolvedValueOnce({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 1,
      sessions: 2,
    });
    sendOpenClawMessage.mockResolvedValueOnce("OpenClaw continued answer");

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Follow up",
        projectId: "alpha-project",
        mode: "openclaw-tools",
        conversationId: "web:alpha-project:existing-session",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    const [[openClawMessage, openClawOptions]] = sendOpenClawMessage.mock.calls;
    expect(openClawMessage).toContain("Follow up");
    expect(openClawMessage).toContain(
      `[Workspace: ${projectRoot} — use ABSOLUTE paths for all read/write/exec operations]`,
    );
    expect(openClawOptions).toEqual(
      expect.objectContaining({
        cwd: projectRoot,
        session: "web-alpha-project-existing-session",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      backend: "openclaw",
      conversationId: "web-alpha-project-existing-session",
    });
  });

  // The pair of tests that used to live here ("injects second-brain context
  // into the local Ollama streaming path" and "does not apply the cloud
  // privacy guard to the local Ollama chat path") exercised the local-direct
  // short-circuit. That branch was deleted so the chat always dispatches
  // through OpenClaw.

  it("still enforces cloud privacy when the configured Ollama endpoint is remote", async () => {
    isLocalProviderConfigured.mockReturnValue(true);
    localHealthCheck.mockResolvedValueOnce({
      running: true,
      models: ["gemma4:latest"],
      url: "http://gpu-box.internal:11434",
    });
    enforceCloudPrivacy.mockResolvedValueOnce(
      Response.json(
        {
          error:
            "Project alpha-project has no privacy manifest; remote chat is blocked.",
        },
        { status: 403 },
      ),
    );

    const request = new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-real-ip": "198.51.100.25",
      },
      body: JSON.stringify({
        message: "Hello from remote local provider",
        projectId: "alpha-project",
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(streamChat).not.toHaveBeenCalled();
  });

});
