import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readChatThread, writeChatThread } from "@/lib/chat-thread-store";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

let dataRoot: string;

describe("chat thread route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-chat-thread-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
  });

  afterEach(async () => {
    delete process.env.SCIENCESWARM_DIR;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("returns an empty thread for a new project", async () => {
    const { GET } = await import("@/app/api/chat/thread/route");
    const response = await GET(new Request("http://localhost/api/chat/thread?project=alpha-project"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 1,
      study: "alpha-project",
      project: "alpha-project",
      conversationId: null,
      conversationBackend: null,
      messages: [],
      artifactProvenance: [],
    });
  });

  it("persists a project thread under local brain state and reads it back", async () => {
    const { GET, POST } = await import("@/app/api/chat/thread/route");

    const writeResponse = await POST(new Request("http://localhost/api/chat/thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha-project",
        conversationId: "conv-alpha",
        // Legacy values from older API clients are normalised to "openclaw"
        // by the route's normalizeConversationBackend; the persisted file
        // therefore stores the canonical value.
        conversationBackend: "agent",
        messages: [
          {
            id: "m1",
            role: "user",
            content: "hi",
            timestamp: "2026-04-11T10:00:00.000Z",
            channel: "web",
          },
          {
            id: "m2",
            role: "assistant",
            content: "hello",
            thinking: "Inspecting the prior import manifest before answering.",
            timestamp: "2026-04-11T10:00:01.000Z",
            chatMode: "openclaw-tools",
            captureClarification: {
              captureId: "capture-1",
              rawPath: "raw/captures/web/2026-04-11/capture-1.json",
              question: "Which project should this capture belong to?",
              choices: ["alpha", "beta"],
              capturedContent: "note: hello",
            },
            taskPhases: [
              { id: "reading-file", label: "Reading file", status: "completed" },
              { id: "done", label: "Done", status: "completed" },
            ],
          },
        ],
        artifactProvenance: [
          {
            projectPath: "figures/ratio-trend.svg",
            sourceFiles: ["results.md"],
            prompt: "Create a chart from results.md",
            tool: "OpenClaw CLI",
            createdAt: "2026-04-11T10:00:02.000Z",
          },
        ],
      }),
    }));

    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.json()).resolves.toEqual({ ok: true });

    const persistedPath = path.join(
      dataRoot,
      "projects",
      "alpha-project",
      ".brain",
      "state",
      "chat.json",
    );
    expect(await readFile(persistedPath, "utf-8")).toContain("\"conversationId\": \"conv-alpha\"");
    expect(await readFile(persistedPath, "utf-8")).toContain("\"conversationBackend\": \"openclaw\"");

    const readResponse = await GET(new Request("http://localhost/api/chat/thread?project=alpha-project"));
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toEqual({
      version: 1,
      study: "alpha-project",
      project: "alpha-project",
      conversationId: "conv-alpha",
      conversationBackend: "openclaw",
      messages: [
        {
          id: "m1",
          role: "user",
          content: "hi",
          timestamp: "2026-04-11T10:00:00.000Z",
          channel: "web",
        },
        {
          id: "m2",
          role: "assistant",
          content: "hello",
          thinking: "Inspecting the prior import manifest before answering.",
          timestamp: "2026-04-11T10:00:01.000Z",
          chatMode: "openclaw-tools",
          captureClarification: {
            captureId: "capture-1",
            rawPath: "raw/captures/web/2026-04-11/capture-1.json",
            question: "Which project should this capture belong to?",
            choices: ["alpha", "beta"],
            capturedContent: "note: hello",
          },
          taskPhases: [
            { id: "reading-file", label: "Reading file", status: "completed" },
            { id: "done", label: "Done", status: "completed" },
          ],
        },
      ],
      artifactProvenance: [
        {
          projectPath: "figures/ratio-trend.svg",
          sourceFiles: ["results.md"],
          prompt: "Create a chart from results.md",
          tool: "OpenClaw CLI",
          createdAt: "2026-04-11T10:00:02.000Z",
        },
      ],
    });
  });

  it("falls back to legacy project when canonical study is blank", async () => {
    const { GET, POST } = await import("@/app/api/chat/thread/route");

    const writeResponse = await POST(new Request("http://localhost/api/chat/thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        study: "",
        project: "alpha-project",
        messages: [],
        artifactProvenance: [],
      }),
    }));
    expect(writeResponse.status).toBe(200);

    const readResponse = await GET(new Request("http://localhost/api/chat/thread?study=&project=alpha-project"));
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      study: "alpha-project",
      project: "alpha-project",
    });
  });

  it("sanitizes internal OpenClaw noise when reading a persisted thread", async () => {
    await writeChatThread({
      version: 1,
      project: "alpha-project",
      conversationId: "conv-alpha",
      conversationBackend: "openclaw",
      messages: [
        {
          id: "m0",
          role: "user",
          content: "[agents/auth-profiles] should remain in user text",
          timestamp: "2026-04-11T10:00:00.500Z",
        },
        {
          id: "m1",
          role: "assistant",
          content: [
            "[agents/auth-profiles] synced openai-codex credentials from external cli",
            "[agent/embedded] auto-compaction succeeded for openai/gpt-5.4; retrying prompt",
            "",
            "Visible answer",
          ].join("\n"),
          thinking: [
            "[session] paired gateway transport",
            "",
            "Reasoning that should remain visible.",
          ].join("\n"),
          timestamp: "2026-04-11T10:00:01.000Z",
        },
      ],
      artifactProvenance: [],
    });

    const persistedPath = path.join(
      dataRoot,
      "projects",
      "alpha-project",
      ".brain",
      "state",
      "chat.json",
    );
    await expect(readFile(persistedPath, "utf-8")).resolves.toContain(
      "[agents/auth-profiles] synced openai-codex credentials from external cli",
    );

    const { GET } = await import("@/app/api/chat/thread/route");
    const response = await GET(
      new Request("http://localhost/api/chat/thread?project=alpha-project"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      messages: [
        {
          id: "m0",
          role: "user",
          content: "[agents/auth-profiles] should remain in user text",
          timestamp: "2026-04-11T10:00:00.500Z",
        },
        {
          id: "m1",
          role: "assistant",
          content: "Visible answer",
          thinking: "Reasoning that should remain visible.",
          timestamp: "2026-04-11T10:00:01.000Z",
        },
      ],
    });
  });

  it("preserves native runtime output when reading a non-OpenClaw thread", async () => {
    const { GET, POST } = await import("@/app/api/chat/thread/route");

    const writeResponse = await POST(new Request("http://localhost/api/chat/thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha-project",
        conversationId: "claude-native-session",
        conversationBackend: "claude-code",
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: [
              "[session] claude-code owns this line",
              "[agents/auth-profiles] this is literal model output, not OpenClaw noise",
              "Visible Claude answer",
            ].join("\n"),
            thinking: "[session] Claude stream metadata should stay untouched",
            timestamp: "2026-04-11T10:00:01.000Z",
          },
        ],
        artifactProvenance: [],
      }),
    }));

    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.json()).resolves.toEqual({ ok: true });

    const persistedPath = path.join(
      dataRoot,
      "projects",
      "alpha-project",
      ".brain",
      "state",
      "chat.json",
    );
    const persisted = await readFile(persistedPath, "utf-8");
    expect(persisted).toContain("\"conversationBackend\": \"claude-code\"");

    const readResponse = await GET(new Request("http://localhost/api/chat/thread?project=alpha-project"));
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      conversationId: "claude-native-session",
      conversationBackend: "claude-code",
      messages: [
        {
          content: [
            "[session] claude-code owns this line",
            "[agents/auth-profiles] this is literal model output, not OpenClaw noise",
            "Visible Claude answer",
          ].join("\n"),
          thinking: "[session] Claude stream metadata should stay untouched",
        },
      ],
    });
  });

  it("maps persisted OpenClaw context overflow to a recoverable message", async () => {
    await writeChatThread({
      version: 1,
      project: "alpha-project",
      conversationId: "conv-alpha",
      conversationBackend: "openclaw",
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: [
            "[agent/embedded] auto-compaction succeeded for openai/gpt-5.4; retrying prompt",
            "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
          ].join("\n"),
          timestamp: "2026-04-11T10:00:01.000Z",
        },
      ],
      artifactProvenance: [],
    });

    const { GET } = await import("@/app/api/chat/thread/route");
    const response = await GET(
      new Request("http://localhost/api/chat/thread?project=alpha-project"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages[0].content).toContain("context became too large");
    expect(body.messages[0].content).toContain("preserved in the workspace");
    expect(body.messages[0].content).not.toContain("[agent/embedded]");
    expect(body.messages[0].content).not.toContain("gpt-5.4");
  });

  it("keeps valid artifact provenance entries even when one entry is malformed", async () => {
    const { GET, POST } = await import("@/app/api/chat/thread/route");

    const response = await POST(new Request("http://localhost/api/chat/thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha-project",
        conversationId: "conv-alpha",
        messages: [],
        artifactProvenance: [
          {
            projectPath: "figures/ratio-trend.svg",
            sourceFiles: ["results.md"],
            prompt: "Create a chart from results.md",
            tool: "OpenClaw CLI",
            createdAt: "2026-04-11T10:00:02.000Z",
          },
          {
            projectPath: 123,
            sourceFiles: ["results.md"],
            prompt: "bad entry",
            tool: "OpenClaw CLI",
            createdAt: "2026-04-11T10:00:02.000Z",
          },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    const readResponse = await GET(new Request("http://localhost/api/chat/thread?project=alpha-project"));
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      artifactProvenance: [
        {
          projectPath: "figures/ratio-trend.svg",
          sourceFiles: ["results.md"],
          prompt: "Create a chart from results.md",
          tool: "OpenClaw CLI",
          createdAt: "2026-04-11T10:00:02.000Z",
        },
      ],
    });
  });

  it("migrates a legacy global chat thread into the project root on read", async () => {
    const legacyPath = path.join(dataRoot, "brain", "state", "chat", "alpha-project.json");
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(path.dirname(legacyPath), { recursive: true }).then(() =>
        writeFile(
          legacyPath,
          JSON.stringify({
            version: 1,
            project: "alpha-project",
            conversationId: "legacy-conv",
            messages: [
              {
                id: "legacy-1",
                role: "user",
                content: "hello from legacy storage",
                timestamp: "2026-04-11T10:00:00.000Z",
              },
            ],
          }, null, 2),
          "utf-8",
        ),
      ),
    );

    const { GET } = await import("@/app/api/chat/thread/route");
    const response = await GET(new Request("http://localhost/api/chat/thread?project=alpha-project"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      conversationId: "legacy-conv",
    });
    await expect(
      readFile(
        path.join(dataRoot, "projects", "alpha-project", ".brain", "state", "chat.json"),
        "utf-8",
      ),
    ).resolves.toContain("\"legacy-conv\"");
  });

  it("uses an explicit project-local state root without falling back to the default root", async () => {
    const explicitStateRoot = path.join(dataRoot, "projects", "alpha-project", ".brain", "state");

    await writeChatThread({
      version: 1,
      project: "alpha-project",
      conversationId: "explicit-conv",
      messages: [],
    }, explicitStateRoot);

    await expect(
      readFile(path.join(explicitStateRoot, "chat.json"), "utf-8"),
    ).resolves.toContain("\"explicit-conv\"");
    await expect(readChatThread("alpha-project", explicitStateRoot)).resolves.toMatchObject({
      conversationId: "explicit-conv",
    });
  });

  // Belt-and-suspenders: even if a thread file on disk still has the legacy
  // backend strings (e.g. someone restored a backup before running the
  // migration script), the read path normalises them to "openclaw" so the
  // hook never sees a stale value.
  it.each(["agent", "direct"] as const)(
    "normalises legacy on-disk conversationBackend %s to openclaw on read",
    async (legacyBackend) => {
      const explicitStateRoot = path.join(dataRoot, "projects", "alpha-project", ".brain", "state");
      const chatPath = path.join(explicitStateRoot, "chat.json");
      const fsPromises = await import("node:fs/promises");
      await fsPromises.mkdir(explicitStateRoot, { recursive: true });
      await fsPromises.writeFile(
        chatPath,
        JSON.stringify({
          version: 1,
          project: "alpha-project",
          conversationId: "legacy-conv",
          conversationBackend: legacyBackend,
          messages: [],
        }, null, 2),
        "utf-8",
      );

      await expect(readChatThread("alpha-project", explicitStateRoot)).resolves.toMatchObject({
        conversationId: "legacy-conv",
        conversationBackend: "openclaw",
      });
      // The on-disk file is intentionally untouched by readChatThread; the
      // explicit migration script is the only path that rewrites it.
      await expect(readFile(chatPath, "utf-8")).resolves.toContain(`"conversationBackend": "${legacyBackend}"`);
    },
  );
});
