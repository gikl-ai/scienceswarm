import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { writeProjectManifest } from "@/lib/state/project-manifests";
import type { ProjectManifest } from "@/brain/types";

const ROOT = path.join(tmpdir(), "scienceswarm-privacy-policy");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

const {
  resolveAgentConfig,
  agentHealthCheck,
  sendAgentMessage,
  openClawHealthCheck,
  sendOpenClawMessage,
  streamChat,
  injectBrainContextIntoUserMessage,
  startConversation,
  sendPendingMessage,
} = vi.hoisted(() => ({
  resolveAgentConfig: vi.fn(),
  agentHealthCheck: vi.fn(),
  sendAgentMessage: vi.fn(),
  openClawHealthCheck: vi.fn(),
  sendOpenClawMessage: vi.fn(),
  streamChat: vi.fn(),
  injectBrainContextIntoUserMessage: vi.fn((message: string) => message),
  startConversation: vi.fn(),
  sendPendingMessage: vi.fn(),
}));

vi.mock("@/lib/agent-client", () => ({
  resolveAgentConfig,
  agentHealthCheck,
  sendAgentMessage,
}));

vi.mock("@/lib/openclaw", () => ({
  healthCheck: openClawHealthCheck,
  gatewayHealthCheck: openClawHealthCheck,
  sendAgentMessage: sendOpenClawMessage,
  sendOpenClawChatMessage: sendOpenClawMessage,
}));

vi.mock("@/lib/message-handler", () => ({
  streamChat,
}));

vi.mock("@/brain/chat-inject", () => ({
  injectBrainContextIntoUserMessage,
}));

vi.mock("@/lib/openhands", () => ({
  startConversation,
  sendPendingMessage,
  getEvents: vi.fn(),
  getConversation: vi.fn(),
  getStartTaskStatus: vi.fn(),
  OPENHANDS_URL: "http://openhands.test",
}));

import { POST as chatPost } from "@/app/api/chat/unified/route";
import { POST as agentPost } from "@/app/api/agent/route";

function manifest(projectId: string, privacy: ProjectManifest["privacy"]): ProjectManifest {
  return {
    version: 1,
    projectId,
    slug: projectId,
    title: projectId,
    privacy,
    status: "active",
    projectPagePath: `wiki/projects/${projectId}.md`,
    sourceRefs: [],
    decisionPaths: [],
    taskPaths: [],
    artifactPaths: [],
    frontierPaths: [],
    activeThreads: [],
    dedupeKeys: [],
    updatedAt: "2026-04-08T00:00:00.000Z",
  };
}

beforeEach(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = ROOT;
  await writeProjectManifest(manifest("alpha", "local-only"), path.join(ROOT, "brain", "state"));
  await writeProjectManifest(manifest("beta", "cloud-ok"), path.join(ROOT, "brain", "state"));
  await writeProjectManifest(manifest("gamma", "execution-ok"), path.join(ROOT, "brain", "state"));
  resolveAgentConfig.mockReset();
  agentHealthCheck.mockReset();
  sendAgentMessage.mockReset();
  openClawHealthCheck.mockReset();
  sendOpenClawMessage.mockReset();
  // Default: agent configured and connected
  resolveAgentConfig.mockReturnValue({ type: "openclaw", url: "http://localhost:19002" });
  agentHealthCheck.mockResolvedValue({ status: "connected" });
  openClawHealthCheck.mockResolvedValue({
    status: "connected",
    gateway: "ws://127.0.0.1:19002",
    channels: [],
    agents: 1,
    sessions: 1,
  });
  streamChat.mockReset();
  injectBrainContextIntoUserMessage.mockReset();
  startConversation.mockReset();
  sendPendingMessage.mockReset();
  injectBrainContextIntoUserMessage.mockImplementation((message: string) => message);
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  if (ORIGINAL_SCIENCESWARM_DIR) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
});

describe("privacy policy", () => {
  it("blocks remote chat for local-only projects", async () => {
    const response = await chatPost(new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        projectId: "alpha",
      }),
    }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("local-only");
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(streamChat).not.toHaveBeenCalled();
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("blocks OpenHands execution until a project is execution-ok", async () => {
    const response = await agentPost(new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        projectId: "beta",
        message: "build the memo",
      }),
    }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("execution-ok");
    expect(startConversation).not.toHaveBeenCalled();
  });

  it("allows selected chat for cloud-ok projects", async () => {
    sendOpenClawMessage.mockResolvedValue("cloud-ok response");

    const response = await chatPost(new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        projectId: "beta",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.response).toBe("cloud-ok response");
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(1);
  });

  it("allows OpenHands execution for execution-ok projects", async () => {
    startConversation.mockResolvedValue({
      id: "task-1",
      status: "READY",
      app_conversation_id: "conv-1",
      sandbox_id: "sandbox-1",
    });

    const response = await agentPost(new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        projectId: "gamma",
        message: "build the memo",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.conversationId).toBe("conv-1");
    expect(startConversation).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-site browser requests before execution starts", async () => {
    const response = await agentPost(new Request("http://localhost/api/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        action: "start",
        projectId: "gamma",
        message: "build the memo",
      }),
    }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Forbidden");
    expect(startConversation).not.toHaveBeenCalled();
  });

  it("allows selected chat without project context", async () => {
    sendOpenClawMessage.mockResolvedValue("no-project response");

    const response = await chatPost(new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.response).toBe("no-project response");
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(1);
  });

  it("allows selected chat for legacy projects (project.json without state manifest)", async () => {
    // Simulate a project created before the manifest system was introduced:
    // it has a project.json on disk but no project-local `.brain/state/manifest.json`.
    const legacySlug = "legacy-project-alpha";
    const legacyDir = path.join(ROOT, "projects", legacySlug);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      path.join(legacyDir, "project.json"),
      JSON.stringify({
        id: legacySlug,
        name: "Legacy Project Alpha",
        description: "Created before manifests existed",
        createdAt: "2026-04-01T00:00:00.000Z",
        lastActive: "2026-04-01T00:00:00.000Z",
        status: "active",
      }),
      "utf-8",
    );

    sendOpenClawMessage.mockResolvedValue("legacy upgraded response");

    const response = await chatPost(new Request("http://localhost/api/chat/unified", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "hello",
        projectId: legacySlug,
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.response).toBe("legacy upgraded response");
    expect(sendOpenClawMessage).toHaveBeenCalledTimes(1);

    // The lazy upgrade must persist a manifest on disk so subsequent reads
    // hit the fast path instead of re-upgrading on every request.
    const { readProjectManifest } = await import("@/lib/state/project-manifests");
    const persisted = await readProjectManifest(legacySlug);
    expect(persisted).not.toBeNull();
    expect(persisted?.privacy).toBe("cloud-ok");

    // The default cloud-ok privacy must still block OpenHands execution —
    // the lazy upgrade should never silently grant execution-ok.
    const execResponse = await agentPost(new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        projectId: legacySlug,
        message: "run something",
      }),
    }));
    expect(execResponse.status).toBe(403);
    const execBody = await execResponse.json();
    expect(execBody.error).toContain("execution-ok");
    expect(startConversation).not.toHaveBeenCalled();
  });

  it("blocks execution without project context", async () => {
    const response = await agentPost(new Request("http://localhost/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        message: "build the memo",
      }),
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("projectId is required");
    expect(startConversation).not.toHaveBeenCalled();
  });
});
