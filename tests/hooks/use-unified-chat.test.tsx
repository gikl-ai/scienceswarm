// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, act, useState } from "react";
import { useUnifiedChat } from "@/hooks/use-unified-chat";

const RUNTIME_ACTIVE_FILE_TEST_CONTENT = [
  "Current file contents",
  "--- End selected workspace context ---",
  "x".repeat(8_050),
].join("\n");

function ChatHarness({ projectName }: { projectName: string }) {
  const [lastAddResult, setLastAddResult] = useState("");
  const {
    messages,
    sendMessage,
    conversationId,
    error,
    backend,
    setBackend,
    chatMode,
    setChatMode,
    isStreaming,
    canCancelActiveTurn,
    cancelActiveTurn,
    workspaceTree,
    artifactProvenance,
    generatedArtifacts,
    runtimeCompareResult,
    uploadedFiles,
    addWorkspaceFileToChatContext,
    checkChanges,
  } = useUnifiedChat(projectName);

  return (
    <div>
      <button onClick={() => void sendMessage("Hello from the browser")}>Send</button>
      <button onClick={() => void sendMessage("Run the training experiment and save the report in the workspace")}>
        Send execution request
      </button>
      <button onClick={() => void sendMessage("Second queued message")}>Send second</button>
      <button onClick={() => void sendMessage("Review @Example Paper for me")}>Send explicit file</button>
      <button onClick={() => void sendMessage("Describe how all files are synchronized")}>Send broad all files</button>
      <button
        onClick={() =>
          void sendMessage("Ask Codex for a second opinion", {
            runtimeHostId: "codex",
            runtimeMode: "chat",
            projectPolicy: "cloud-ok",
          })
        }
      >
        Send Codex runtime
      </button>
      <button
        onClick={() =>
          void sendMessage("Summarize the selected file with Codex", {
            runtimeHostId: "codex",
            runtimeMode: "chat",
            projectPolicy: "cloud-ok",
            activeFile: {
              path: "notes/current.md",
              content: RUNTIME_ACTIVE_FILE_TEST_CONTENT,
            },
          })
        }
      >
        Send Codex runtime current file
      </button>
      <button
        onClick={() =>
          void sendMessage("Summarize attached files with Codex", {
            runtimeHostId: "codex",
            runtimeMode: "chat",
            projectPolicy: "cloud-ok",
          })
        }
      >
        Send Codex runtime attached files
      </button>
      <button
        onClick={() =>
          void sendMessage("Summarize this file", {
            path: "notes/current.md",
            content: "Current file contents",
          })
        }
      >
        Send current file
      </button>
      <button
        onClick={() =>
          void sendMessage("Hello from the browser", {
            path: "notes/current.md",
            content: "Current file contents",
          })
        }
      >
        Send implicit current file
      </button>
      <button onClick={() => void sendMessage("/audit-revise draft a revision checklist")}>Send slash</button>
      <button onClick={() => setBackend("openclaw")}>Switch OpenClaw</button>
      <button onClick={() => setChatMode("openclaw-tools")}>Use OpenClaw tools</button>
      <button onClick={() => setChatMode("reasoning")}>Use Reasoning</button>
      <button onClick={() => void checkChanges()}>Check changes</button>
      <button
        onClick={() => {
          setLastAddResult(String(addWorkspaceFileToChatContext({
            path: "Brain/Missing Slug",
            name: "Missing Slug",
            source: "gbrain",
          })));
        }}
      >
        Add invalid gbrain context
      </button>
      <button
        onClick={() => {
          setLastAddResult(String(addWorkspaceFileToChatContext({
            path: "gbrain:wiki/papers/example.md",
            name: "Example Paper",
            source: "gbrain",
            brainSlug: "wiki/papers/example.md",
          })));
        }}
      >
        Add valid gbrain context
      </button>
      <button
        onClick={() => {
          setLastAddResult(String(addWorkspaceFileToChatContext({
            path: "notes/context.md",
            name: "Context Note",
            source: "workspace",
            content: `Context note body for direct runtime.\n${"x".repeat(8_100)}\nAFTER-CAP`,
          })));
        }}
      >
        Add text context
      </button>
      <button onClick={() => void cancelActiveTurn()}>Stop runtime</button>
      <div data-testid="conversation-id">{conversationId || ""}</div>
      <div data-testid="backend">{backend}</div>
      <div data-testid="runtime-compare-result">
        {runtimeCompareResult?.childResults.map((child) => `${child.hostId}:${child.status}`).join("\n") ?? ""}
      </div>
      <div data-testid="chat-mode">{chatMode}</div>
      <div data-testid="is-streaming">{String(isStreaming)}</div>
      <div data-testid="can-cancel">{String(canCancelActiveTurn)}</div>
      <div data-testid="workspace-root-count">{String(workspaceTree.length)}</div>
      <div data-testid="uploaded-files-log">
        {uploadedFiles.map((file) => `${file.source}:${file.workspacePath}:${file.brainSlug || ""}`).join("\n")}
      </div>
      <div data-testid="last-add-result">{lastAddResult}</div>
      <div data-testid="artifact-count">{String(artifactProvenance.length)}</div>
      <div data-testid="generated-artifact-count">{String(generatedArtifacts.length)}</div>
      <div data-testid="generated-artifact-log">
        {generatedArtifacts.map((artifact) => artifact.path).join("\n")}
      </div>
      <div data-testid="error">{error || ""}</div>
      <div data-testid="message-count">{messages.length}</div>
      <div data-testid="artifact-log">
        {artifactProvenance.map((artifact) => `${artifact.projectPath}:${artifact.prompt}:${artifact.tool}`).join("\n")}
      </div>
      <div data-testid="message-log">
        {messages.map((message) => `${message.role}:${message.content}`).join("\n")}
      </div>
      <div data-testid="thinking-log">
        {messages.map((message) => `${message.role}:${message.thinking || ""}`).join("\n")}
      </div>
      <div data-testid="activity-log">
        {messages.map((message) => `${message.role}:${(message.activityLog || []).join(" | ")}`).join("\n")}
      </div>
      <div data-testid="progress-log">
        {messages.map((message) =>
          `${message.role}:${(message.progressLog || []).map((entry) => `${entry.kind}:${entry.text}`).join(" | ")}`
        ).join("\n")}
      </div>
      <div data-testid="progress-log-meta">
        {messages.map((message) =>
          `${message.role}:${(message.progressLog || []).map((entry) =>
            [
              entry.source || "",
              entry.phase || "",
              entry.status || "",
              entry.label || "",
              typeof entry.timestampMs === "number" ? String(entry.timestampMs) : "",
            ].join("/")
          ).join(" | ")}`
        ).join("\n")}
      </div>
      <div data-testid="phase-log">
        {messages.map((message) =>
          `${message.role}:${(message.taskPhases || []).map((phase) => `${phase.label}:${phase.status}`).join("|")}`
        ).join("\n")}
      </div>
    </div>
  );
}

function NavigateAwayOnAppendHarness({
  projectName,
  onNavigateAway,
}: {
  projectName: string;
  onNavigateAway: () => void;
}) {
  const { setMessages } = useUnifiedChat(projectName);

  return (
    <button
      onClick={() => {
        setMessages((prev) => [
          ...prev,
          {
            id: "instant-assistant",
            role: "assistant",
            content: "Instant reply before navigation",
            timestamp: new Date("2026-04-22T10:30:00.000Z"),
          },
        ]);
        queueMicrotask(onNavigateAway);
      }}
    >
      Append and leave
    </button>
  );
}

function createSseResponse(events: unknown[], backend = "openclaw"): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Chat-Backend": backend,
    },
  });
}

function createDeferredSseResponse(backend = "openclaw"): {
  response: Response;
  send: (event: unknown) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const response = new Response(new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  }), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Chat-Backend": backend,
    },
  });

  return {
    response,
    send(event: unknown) {
      streamController?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      streamController?.enqueue(encoder.encode("data: [DONE]\n\n"));
      streamController?.close();
    },
  };
}

describe("useUnifiedChat persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not hydrate stale project chat when no project is selected", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.__no-project__",
      JSON.stringify({
        version: 1,
        conversationId: "web:my-project:session-1",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "stale-project",
            role: "system",
            content: "Project **my-project** loaded.",
            timestamp: "2026-04-14T20:00:00.000Z",
          },
          {
            id: "stale-answer",
            role: "assistant",
            content: "Stale project answer",
            timestamp: "2026-04-14T20:00:01.000Z",
          },
        ],
      }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/chat/unified?action=health");
    });
    expect(screen.getByTestId("message-count").textContent).toBe("0");
    expect(screen.getByTestId("conversation-id").textContent).toBe("");
    expect(screen.getByTestId("message-log").textContent).not.toContain("my-project");
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("/api/chat/thread?project="),
        expect.stringContaining("/api/workspace"),
      ]),
    );
  });

  it("restores the prior project conversation and conversationId after remount", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json({
          response: "Persisted answer",
          conversationId: "conv-alpha",
          messages: [],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const firstRender = render(<ChatHarness projectName="alpha-project" />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-alpha");
    });
    expect(screen.getByTestId("message-log").textContent).toContain("user:Hello from the browser");
    expect(screen.getByTestId("message-log").textContent).toContain("assistant:Persisted answer");

    firstRender.unmount();

    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-alpha");
    });
    expect(screen.getByTestId("message-log").textContent).toContain("user:Hello from the browser");
    expect(screen.getByTestId("message-log").textContent).toContain("assistant:Persisted answer");
  });

  it("stores runtime host ids for new non-OpenClaw sessions", async () => {
    let resolveHealth: (response: Response) => void = () => {};
    const delayedHealth = new Promise<Response>((resolve) => {
      resolveHealth = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/chat/unified?action=health") {
        return delayedHealth;
      }
      if (url === "/api/runtime/sessions/stream") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        expect(body).toMatchObject({
          hostId: "codex",
          projectId: "alpha-project",
          projectPolicy: "cloud-ok",
          approvalState: "not-required",
        });
        return createSseResponse([
          {
            event: {
              type: "message",
              payload: { text: "Codex runtime response\n[session] keep this native line" },
            },
          },
          {
            session: {
              id: "rt-session-codex",
              conversationId: "native-codex-session",
              status: "completed",
            },
          },
        ]);
      }
      if (url.startsWith("/api/workspace")) {
        return Response.json({ files: [] });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    fireEvent.click(screen.getByRole("button", { name: "Send Codex runtime" }));

    await screen.findByText(/Codex runtime response/);
    await act(async () => {
      resolveHealth(Response.json({ openclaw: "connected" }));
      await delayedHealth;
    });
    expect(screen.getByTestId("message-log").textContent).toContain("[session] keep this native line");
    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("codex");
      expect(screen.getByTestId("conversation-id").textContent).toBe("native-codex-session");
    });

    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("scienceswarm.chat.alpha-project") ?? "{}",
      ) as { conversationBackend?: string };
      expect(stored.conversationBackend).toBe("codex");
    });
  });

  it("streams direct runtime events into the active assistant message", async () => {
    const runtimeStream = createDeferredSseResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/chat/unified?action=health") {
        return Response.json({ openclaw: "connected" });
      }
      if (url === "/api/runtime/sessions/stream") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        expect(body).toMatchObject({
          hostId: "codex",
          projectId: "alpha-project",
          projectPolicy: "cloud-ok",
          approvalState: "not-required",
        });
        return runtimeStream.response;
      }
      if (url.startsWith("/api/workspace")) {
        return Response.json({ files: [] });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    fireEvent.click(screen.getByRole("button", { name: "Send Codex runtime" }));

    await act(async () => {
      runtimeStream.send({
        event: {
          type: "message",
          payload: { text: "Streaming Codex" },
        },
      });
    });

    await screen.findByText(/Streaming Codex/);

    await act(async () => {
      runtimeStream.send({
        event: {
          type: "message",
          payload: {
            text: "Streaming Codex final answer",
            nativeSessionId: "native-codex-session",
          },
        },
      });
      runtimeStream.send({
        session: {
          id: "rt-session-codex",
          conversationId: "native-codex-session",
          status: "completed",
        },
      });
      runtimeStream.close();
    });

    await screen.findByText(/Streaming Codex final answer/);
    expect(screen.getByTestId("conversation-id").textContent).toBe("native-codex-session");
    expect(screen.getByTestId("backend").textContent).toBe("codex");
  });

  it("includes explicitly selected active file context in direct runtime prompts", async () => {
    const runtimeBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/chat/unified?action=health") {
        return Response.json({ openclaw: "connected" });
      }
      if (url === "/api/runtime/sessions/stream") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        runtimeBodies.push(body);
        return createSseResponse([
          {
            event: {
              type: "message",
              payload: { text: "Codex saw the selected file" },
            },
          },
          {
            session: {
              id: "rt-session-codex",
              conversationId: "native-codex-session",
              status: "completed",
            },
          },
        ]);
      }
      if (url.startsWith("/api/workspace")) {
        return Response.json({ files: [] });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    fireEvent.click(screen.getByRole("button", { name: "Send Codex runtime current file" }));

    await screen.findByText(/Codex saw the selected file/);
    expect(runtimeBodies).toHaveLength(1);
    expect(runtimeBodies[0]).toMatchObject({
      hostId: "codex",
      projectId: "alpha-project",
      projectPolicy: "cloud-ok",
      approvalState: "not-required",
      inputFileRefs: ["notes/current.md"],
      dataIncluded: expect.arrayContaining([
        expect.objectContaining({
          kind: "workspace-file",
          label: "notes/current.md",
          bytes: 8_000,
        }),
      ]),
    });
    const runtimePrompt = String(runtimeBodies[0].prompt);
    expect(runtimePrompt).toContain("Explicitly selected workspace context (JSON):");
    expect(runtimePrompt).not.toContain("--- Explicitly selected workspace context ---");
    const contextPayload = JSON.parse(runtimePrompt.slice(runtimePrompt.indexOf("{"))) as {
      kind: string;
      path: string;
      content: string;
      truncated: boolean;
      originalCharacters: number;
      includedCharacters: number;
      omittedCharacters: number;
    };
    expect(contextPayload).toMatchObject({
      kind: "selected-workspace-file",
      path: "notes/current.md",
      content: RUNTIME_ACTIVE_FILE_TEST_CONTENT.slice(0, 8_000),
      truncated: true,
      originalCharacters: RUNTIME_ACTIVE_FILE_TEST_CONTENT.length,
      includedCharacters: 8_000,
      omittedCharacters: RUNTIME_ACTIVE_FILE_TEST_CONTENT.length - 8_000,
    });
    expect(screen.getByTestId("message-log").textContent).toContain(
      "user:Summarize the selected file with Codex",
    );
  });

  it("includes explicitly selected text file context in direct runtime prompts", async () => {
    const runtimeBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/chat/unified?action=health") {
        return Response.json({ openclaw: "connected" });
      }
      if (url === "/api/runtime/sessions/stream") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        runtimeBodies.push(body);
        return createSseResponse([
          {
            event: {
              type: "message",
              sessionId: "rt-session-codex",
              payload: { text: "Codex saw the attached note" },
            },
          },
          {
            session: {
              id: "rt-session-codex",
              conversationId: "native-codex-session",
              status: "completed",
            },
          },
        ]);
      }
      if (url.startsWith("/api/workspace")) {
        return Response.json({ files: [] });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    fireEvent.click(screen.getByRole("button", { name: "Add text context" }));
    fireEvent.click(screen.getByRole("button", { name: "Send Codex runtime attached files" }));

    await screen.findByText(/Codex saw the attached note/);
    expect(runtimeBodies).toHaveLength(1);
    expect(runtimeBodies[0]).toMatchObject({
      inputFileRefs: ["notes/context.md"],
      dataIncluded: expect.arrayContaining([
        expect.objectContaining({
          kind: "workspace-file",
          label: "notes/context.md",
          bytes: 8_000,
        }),
      ]),
    });
    const runtimePrompt = String(runtimeBodies[0].prompt);
    expect(runtimePrompt).toContain("Explicitly selected attached file context (JSON):");
    expect(runtimePrompt).toContain("Context note body for direct runtime.");
    expect(runtimePrompt).not.toContain("AFTER-CAP");
  });

  it("cancels an active direct runtime stream by runtime session id", async () => {
    const runtimeStream = createDeferredSseResponse();
    const cancelRequests: string[] = [];
    let streamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url === "/api/chat/unified?action=health") {
        return Response.json({ openclaw: "connected" });
      }
      if (url === "/api/runtime/sessions/stream") {
        streamSignal = init?.signal ?? undefined;
        return runtimeStream.response;
      }
      if (url === "/api/runtime/sessions/rt-session-codex/cancel" && method === "POST") {
        cancelRequests.push(url);
        return Response.json({
          sessionId: "rt-session-codex",
          result: { cancelled: true },
        });
      }
      if (url.startsWith("/api/workspace")) {
        return Response.json({ files: [] });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    fireEvent.click(screen.getByRole("button", { name: "Send Codex runtime" }));
    await act(async () => {
      runtimeStream.send({
        event: {
          id: "rt-session-codex:runtime-started",
          sessionId: "rt-session-codex",
          type: "status",
          payload: { status: "running" },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("can-cancel").textContent).toBe("true");
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop runtime" }));

    await waitFor(() => {
      expect(cancelRequests).toEqual(["/api/runtime/sessions/rt-session-codex/cancel"]);
      expect(streamSignal?.aborted).toBe(true);
      expect(screen.getByTestId("can-cancel").textContent).toBe("false");
    });
  });

  it("drops persisted assistant replay duplicates when restoring a project thread", async () => {
    const duplicatedMessages = [
      {
        id: "user-1",
        role: "user",
        content: "Run the first analysis.",
        timestamp: "2026-04-14T20:00:00.000Z",
        channel: "web",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Replay completion.",
        timestamp: "2026-04-14T20:00:05.000Z",
      },
      {
        id: "user-2",
        role: "user",
        content: "Run the second analysis.",
        timestamp: "2026-04-14T20:01:00.000Z",
        channel: "web",
      },
      {
        id: "assistant-replay",
        role: "assistant",
        channel: "web",
        content: "Replay   completion.",
        timestamp: "2026-04-14T20:01:05.000Z",
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "Second completion.",
        timestamp: "2026-04-14T20:01:10.000Z",
      },
    ];

    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "web:alpha-project:session-1",
        conversationBackend: "openclaw",
        messages: duplicatedMessages,
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: "web:alpha-project:session-1",
          conversationBackend: "openclaw",
          messages: duplicatedMessages,
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      const messageLog = screen.getByTestId("message-log").textContent ?? "";
      expect(messageLog.match(/assistant:Replay completion\./g)?.length ?? 0).toBe(1);
      expect(messageLog).toContain("assistant:Second completion.");
    });
  });

  it("keeps the remembered thread across a settings round-trip before hydration cleanup commits", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "web:alpha-project:session-1",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "user-1",
            role: "user",
            channel: "web",
            content: "remembered prompt",
            timestamp: "2026-04-11T08:00:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Persisted answer",
            timestamp: "2026-04-11T08:00:01.000Z",
          },
        ],
      }),
    );

    const threadResolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return new Promise<Response>((resolve) => {
          threadResolvers.push(resolve);
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(
          Response.json({
            agent: { type: "openclaw", status: "connected" },
            openclaw: "connected",
            nanoclaw: "disconnected",
            openhands: "disconnected",
          }),
        );
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    function SettingsRoundTripHarness() {
      const [route, setRoute] = useState<"project" | "settings">("project");

      return (
        <div>
          <button onClick={() => setRoute("settings")}>Go settings</button>
          <button onClick={() => setRoute("project")}>Back project</button>
          {route === "project" ? (
            <ChatHarness projectName="alpha-project" />
          ) : (
            <div>Settings</div>
          )}
        </div>
      );
    }

    render(
      <StrictMode>
        <SettingsRoundTripHarness />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe(
        "web:alpha-project:session-1",
      );
    });
    expect(screen.getByTestId("message-log").textContent).toContain(
      "user:remembered prompt",
    );
    expect(screen.getByTestId("message-log").textContent).toContain(
      "assistant:Persisted answer",
    );

    fireEvent.click(screen.getByRole("button", { name: "Go settings" }));
    await waitFor(() => {
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Back project" }));
    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe(
        "web:alpha-project:session-1",
      );
    });
    expect(screen.getByTestId("message-log").textContent).toContain(
      "user:remembered prompt",
    );
    expect(screen.getByTestId("message-log").textContent).toContain(
      "assistant:Persisted answer",
    );

    await act(async () => {
      for (const resolve of threadResolvers.splice(0)) {
        resolve(
          Response.json({
            version: 1,
            project: "alpha-project",
            conversationId: null,
            messages: [],
          }),
        );
      }
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe(
        "web:alpha-project:session-1",
      );
    });
    expect(screen.getByTestId("message-log").textContent).toContain(
      "user:remembered prompt",
    );
    expect(screen.getByTestId("message-log").textContent).toContain(
      "assistant:Persisted answer",
    );

    const persisted = JSON.parse(
      window.localStorage.getItem("scienceswarm.chat.alpha-project") || "null",
    ) as {
      messages?: Array<{ role?: string; content?: string }>;
    } | null;

    expect(persisted?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "remembered prompt",
        }),
        expect.objectContaining({
          role: "assistant",
          content: "Persisted answer",
        }),
      ]),
    );
  });

  it("restores structured progress metadata from persisted chat state", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "web:alpha-project:session-1",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            content: "Persisted answer",
            timestamp: "2026-04-11T08:00:01.000Z",
            progressLog: [
              {
                kind: "activity",
                text: "Read docs/results_table.csv",
                source: "agent",
                phase: "result",
                status: "complete",
                label: "Read",
                timestampMs: 1713523200123,
              },
            ],
          },
        ],
      }),
    );

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return new Promise<Response>(() => {});
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(
          Response.json({
            agent: { type: "openclaw", status: "connected" },
            openclaw: "connected",
            nanoclaw: "disconnected",
            openhands: "disconnected",
          }),
        );
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("progress-log").textContent).toContain(
        "assistant:activity:Read docs/results_table.csv",
      );
    });

    expect(screen.getByTestId("progress-log-meta").textContent).toContain(
      "assistant:agent/result/complete/Read/1713523200123",
    );
  });

  it("does not POST the restored thread back to the server on the first hydration render", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "web:alpha-project:session-1",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "user-1",
            role: "user",
            channel: "web",
            content: "remembered prompt",
            timestamp: "2026-04-11T08:00:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Persisted answer",
            timestamp: "2026-04-11T08:00:01.000Z",
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: "web:alpha-project:session-1",
          conversationBackend: "openclaw",
          messages: [
            {
              id: "server-user-1",
              role: "user",
              channel: "web",
              content: "remembered prompt",
              timestamp: "2026-04-11T08:00:00.000Z",
            },
            {
              id: "server-assistant-1",
              role: "assistant",
              content: "Persisted answer",
              timestamp: "2026-04-11T08:00:01.000Z",
            },
          ],
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe(
        "web:alpha-project:session-1",
      );
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          url === "/api/chat/thread" && (init?.method ?? "GET") === "POST",
      ),
    ).toHaveLength(0);
  });

  it("flushes the live project thread back to local storage on pagehide", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        capturedBodies.push(body);
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json({
          response: "Persisted answer",
          conversationId: "web:alpha-project:session-1",
          messages: [],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe(
        "web:alpha-project:session-1",
      );
    });
    expect(screen.getByTestId("message-log").textContent).toContain(
      "assistant:Persisted answer",
    );

    window.localStorage.removeItem("scienceswarm.chat.alpha-project");
    expect(window.localStorage.getItem("scienceswarm.chat.alpha-project")).toBeNull();

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    const restored = JSON.parse(
      window.localStorage.getItem("scienceswarm.chat.alpha-project") || "null",
    ) as {
      conversationId?: string | null;
      messages?: Array<{ role?: string; content?: string }>;
    } | null;

    expect(restored?.conversationId).toBe("web:alpha-project:session-1");
    expect(restored?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Hello from the browser",
        }),
        expect.objectContaining({
          role: "assistant",
          content: "Persisted answer",
        }),
      ]),
    );
    expect(capturedBodies).not.toHaveLength(0);
  });

  it("reuses the restored OpenClaw conversationId for reasoning follow-up turns after remount", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "web:alpha-project:session-1",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Define the baseline.",
            timestamp: "2026-04-14T20:00:00.000Z",
            channel: "web",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Baseline defined.",
            timestamp: "2026-04-14T20:00:01.000Z",
          },
        ],
      }),
    );

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: "web:alpha-project:session-1",
          conversationBackend: "openclaw",
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Define the baseline.",
              timestamp: "2026-04-14T20:00:00.000Z",
              channel: "web",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "Baseline defined.",
              timestamp: "2026-04-14T20:00:01.000Z",
            },
          ],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json(
          {
            response: "Follow-up answer",
            conversationId: "web:alpha-project:session-1",
            messages: [],
          },
          { headers: { "X-Chat-Backend": "openclaw" } },
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("web:alpha-project:session-1");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Follow-up answer");
    });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]?.conversationId).toBe("web:alpha-project:session-1");
    expect(capturedBodies[0]?.mode).toBe("reasoning");
  });

  it("starts with an empty thread and skips thread persistence when no project is selected", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "local",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
        });
      }

      if (url === "/api/workspace?action=tree") {
        return Response.json({ tree: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ChatHarness projectName="" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    expect(screen.getByTestId("message-count").textContent).toBe("0");
    expect(screen.getByTestId("message-log").textContent).toBe("");

    const calledUrls = fetchMock.mock.calls.map(([input]) =>
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    expect(calledUrls.some((url) => url.startsWith("/api/chat/thread"))).toBe(false);

    view.unmount();
  });

  it("restores an in-flight assistant turn with task phases after remount", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "web:alpha-project:session-1",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Draft a five-step research plan.",
            timestamp: "2026-04-14T20:00:00.000Z",
            channel: "web",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "",
            timestamp: "2026-04-14T20:00:02.000Z",
            chatMode: "openclaw-tools",
            taskPhases: [
              { id: "reading-file", label: "Reading file", status: "completed" },
              { id: "drafting-plan", label: "Drafting plan", status: "active" },
              { id: "done", label: "Done", status: "pending" },
            ],
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("web:alpha-project:session-1");
    });

    expect(screen.getByTestId("message-log").textContent).toContain("user:Draft a five-step research plan.");
    expect(screen.getByTestId("phase-log").textContent).toContain(
      "assistant:Reading file:completed|Drafting plan:active|Done:pending",
    );
  });

  it("does not restore stale active task phases on completed assistant answers", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "web:alpha-project:session-1",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Summarize the ablation run.",
            timestamp: "2026-04-14T20:00:00.000Z",
            channel: "web",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Saved the ablation run summary.",
            timestamp: "2026-04-14T20:00:02.000Z",
            chatMode: "openclaw-tools",
            taskPhases: [
              { id: "reading-file", label: "Reading file", status: "completed" },
              { id: "importing-result", label: "Importing result", status: "active" },
              { id: "done", label: "Done", status: "pending" },
            ],
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("web:alpha-project:session-1");
    });

    expect(screen.getByTestId("message-log").textContent).toContain(
      "assistant:Saved the ablation run summary.",
    );
    expect(screen.getByTestId("phase-log").textContent).not.toContain("Importing result:active");
    expect(screen.getByTestId("phase-log").textContent).not.toContain("Done:pending");
  });

  it("requires a non-empty brain slug before adding gbrain chat context", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("0");
    });

    fireEvent.click(screen.getByRole("button", { name: "Add invalid gbrain context" }));

    expect(screen.getByTestId("last-add-result").textContent).toBe("false");
    expect(screen.getByTestId("uploaded-files-log").textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Add valid gbrain context" }));

    expect(screen.getByTestId("last-add-result").textContent).toBe("true");
    expect(screen.getByTestId("uploaded-files-log").textContent).toContain(
      "gbrain:gbrain:wiki/papers/example.md:wiki/papers/example.md",
    );
  });

  // The three file-filtering tests and the local-direct history-cap tests
  // that used to live here covered `isLocalDirectContext()` — an
  // optimization that only fired when `backend === "direct"` to shrink the
  // prompt for raw local models. That branch is unreachable now that every
  // chat turn goes through OpenClaw (which receives file references and
  // decides itself which ones to open), so the optimization was removed
  // along with the tests.

  it("preserves full history and uploaded files for non-local direct fallback chats", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: null,
        messages: Array.from({ length: 20 }, (_, index) => ({
          id: `m-${index}`,
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Historical message ${index}`,
          timestamp: new Date(2026, 0, 1, 0, index).toISOString(),
        })),
      }),
    );

    const capturedBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return createSseResponse([{ text: "ok" }], "direct");
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Add valid gbrain context" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(capturedBodies).toHaveLength(1);
    });

    const messages = capturedBodies[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(21);
    expect(messages[0]).toEqual({ role: "user", content: "Historical message 0" });
    expect(messages.at(-1)).toEqual({ role: "user", content: "Hello from the browser" });
    expect(capturedBodies[0]?.files).toEqual([
      expect.objectContaining({
        workspacePath: "gbrain:wiki/papers/example.md",
        brainSlug: "wiki/papers/example.md",
      }),
    ]);
  });

  it("drops internal file-open and workspace-sync system noise from restored chat", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: null,
        messages: [
          {
            id: "loaded",
            role: "system",
            content: "Project **alpha-project** loaded.",
            timestamp: "2026-04-14T20:00:00.000Z",
          },
          {
            id: "user-message",
            role: "user",
            content: "[agents/auth-profiles] leave this user-authored note intact",
            timestamp: "2026-04-14T20:00:00.500Z",
          },
          {
            id: "opened-file",
            role: "system",
            content: "[User opened file: papers/example.pdf] (pdf file, preview shown in chat)",
            timestamp: "2026-04-14T20:00:01.000Z",
          },
          {
            id: "sync-noise",
            role: "system",
            content: "new files synced: papers/example.pdf\nupdated since import: data/results.csv",
            timestamp: "2026-04-14T20:00:02.000Z",
          },
          {
            id: "assistant",
            role: "assistant",
            content: [
              "[agents/auth-profiles] synced openai-codex credentials from external cli",
              "",
              "Keep this useful response.",
            ].join("\n"),
            timestamp: "2026-04-14T20:00:03.000Z",
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Keep this useful response.");
    });

    const messageLog = screen.getByTestId("message-log").textContent ?? "";
    expect(messageLog).toContain("Project **alpha-project** loaded.");
    expect(messageLog).toContain("[agents/auth-profiles] leave this user-authored note intact");
    expect(messageLog).not.toContain("[User opened file:");
    expect(messageLog).not.toContain("new files synced:");
    expect(messageLog).not.toContain("updated since import:");
    expect(messageLog).not.toContain("[agents/auth-profiles] synced openai-codex credentials from external cli");
  });

  it("keeps workspace change checks out of the visible chat pane", async () => {
    let treeVersion = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({
          tree: treeVersion === 0 ? [] : [{ name: "papers", type: "directory", children: [{ name: "new.pdf", type: "file" }] }],
        });
      }

      if (url === "/api/workspace" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        if (body.action === "check-changes") {
          treeVersion = 1;
          return Response.json({
            added: [{ workspacePath: "papers/new.pdf" }],
            updated: [{ workspacePath: "data/results.csv" }],
            missing: [],
            changed: [],
          });
        }
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("0");
    });

    fireEvent.click(screen.getByRole("button", { name: "Check changes" }));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("1");
      expect(screen.getByTestId("generated-artifact-log").textContent).toContain("papers/new.pdf");
    });

    const messageLog = screen.getByTestId("message-log").textContent ?? "";
    expect(messageLog).not.toContain("new files synced:");
    expect(messageLog).not.toContain("updated since import:");
  });

  it("queues a second chat turn while the first response is still pending", async () => {
    let chatRequestCount = 0;
    let resolveFirstResponse: (value: Response) => void = () => {
      throw new Error("Expected the first chat request to be pending");
    };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Promise.resolve(Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        }));
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        }));
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      if (url === "/api/chat/unified" && method === "POST") {
        chatRequestCount += 1;
        if (chatRequestCount === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirstResponse = resolve;
          });
        }

        return Promise.resolve(Response.json({
          response: "Second answer",
          conversationId: "conv-alpha",
          messages: [],
        }));
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(chatRequestCount).toBe(1);
      expect(screen.getByTestId("is-streaming").textContent).toBe("true");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send second" }));

    await waitFor(() => {
      const messageLog = screen.getByTestId("message-log").textContent ?? "";
      expect(messageLog).toContain("user:Second queued message");
      expect(messageLog).toContain("assistant:Queued...");
    });
    expect(chatRequestCount).toBe(1);

    await act(async () => {
      resolveFirstResponse(Response.json({
        response: "First answer",
        conversationId: "conv-alpha",
        messages: [],
      }));
    });

    await waitFor(() => {
      expect(chatRequestCount).toBe(2);
      const messageLog = screen.getByTestId("message-log").textContent ?? "";
      expect(messageLog).toContain("assistant:First answer");
      expect(messageLog).toContain("assistant:Second answer");
    });

    const chatPosts = fetchMock.mock.calls.filter(([url, init]) =>
      url === "/api/chat/unified" && (init as RequestInit | undefined)?.method === "POST",
    );
    const secondBody = JSON.parse(String((chatPosts[1]?.[1] as RequestInit | undefined)?.body));
    expect(secondBody.messages).toEqual(
      expect.arrayContaining([
        { role: "user", content: "Hello from the browser" },
        { role: "user", content: "Second queued message" },
      ]),
    );
    expect(JSON.stringify(secondBody.messages)).not.toContain("Queued...");
    expect(JSON.stringify(secondBody.messages)).not.toContain("[User opened file:");
  });

  it("seeds the first OpenClaw poll from the latest persisted message timestamp", async () => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "web:alpha-project:session-1",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "Earlier cross-channel note",
            timestamp: "2026-04-14T19:59:58.000Z",
            channel: "telegram",
          },
          {
            id: "m2",
            role: "assistant",
            content: "Latest persisted note",
            timestamp: "2026-04-14T20:00:05.000Z",
            channel: "telegram",
          },
        ],
      }),
    );
    const scheduledIntervals: Array<() => void | Promise<void>> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === "function") {
        scheduledIntervals.push(callback as () => void | Promise<void>);
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url.startsWith("/api/chat/unified?action=poll")) {
        return Response.json({ messages: [], backend: "openclaw" });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
      expect(screen.getByTestId("conversation-id").textContent).toBe("web:alpha-project:session-1");
    });

    expect(scheduledIntervals.length).toBeGreaterThan(0);
    for (const callback of scheduledIntervals) {
      await callback?.();
    }

    const pollCall = fetchMock.mock.calls.find(([url]) =>
      typeof url === "string" && url.startsWith("/api/chat/unified?action=poll"),
    );
    expect(pollCall).toBeTruthy();
    const pollUrl = new URL(String(pollCall?.[0]), "http://localhost");
    expect(pollUrl.searchParams.get("since")).toBe("2026-04-14T20:00:05.000Z");
    expect(pollUrl.searchParams.get("conversationId")).toBe("web:alpha-project:session-1");
  });

  it("appends assistant web completions and refreshes the workspace tree when the OpenClaw poller imports files", async () => {
    const scheduledIntervals: Array<() => void | Promise<void>> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === "function") {
        scheduledIntervals.push(callback as () => void | Promise<void>);
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    let treeVersion = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({
          tree: treeVersion === 0 ? [] : [{ name: "figures", type: "directory", children: [{ name: "r3-chart.jpg", type: "file" }] }],
        });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json(
          {
            response: "Starting image generation now.",
            conversationId: "web:alpha-project:session-1",
            messages: [],
          },
          { headers: { "X-Chat-Backend": "openclaw", "X-Chat-Mode": "openclaw-tools" } },
        );
      }

      if (url.startsWith("/api/chat/unified?action=poll")) {
        treeVersion = 1;
        return Response.json({
          backend: "openclaw",
          generatedFiles: ["figures/r3-chart.jpg"],
          generatedArtifacts: [
            {
              projectPath: "figures/r3-chart.jpg",
              sourceFiles: ["results.md"],
              prompt: "",
              tool: "OpenClaw CLI",
              createdAt: "2026-04-15T07:00:05.000Z",
            },
          ],
          messages: [
            {
              id: "assistant-finished",
              role: "assistant",
              channel: "web",
              content: "Done. I saved the image to figures/r3-chart.jpg.",
              timestamp: "2026-04-15T07:00:05.000Z",
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("0");
    });

    fireEvent.click(screen.getByRole("button", { name: "Use OpenClaw tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Starting image generation now.");
      expect(screen.getByTestId("conversation-id").textContent).toBe("web:alpha-project:session-1");
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    await act(async () => {
      for (const callback of scheduledIntervals) {
        await callback?.();
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain(
        "assistant:Done. I saved the image to figures/r3-chart.jpg.",
      );
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("1");
      expect(screen.getByTestId("artifact-count").textContent).toBe("1");
      expect(screen.getByTestId("artifact-log").textContent).toContain("figures/r3-chart.jpg:Hello from the browser:OpenClaw CLI");
      expect(screen.getByTestId("generated-artifact-log").textContent).toContain("figures/r3-chart.jpg");
      expect(screen.getByTestId("generated-artifact-log").textContent).toContain("figures/r3-chart.jpg");
    });
  });

  it("adopts a recovered poll conversationId and replaces the transient assistant scratchpad", async () => {
    const scheduledIntervals: Array<() => void | Promise<void>> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === "function") {
        scheduledIntervals.push(callback as () => void | Promise<void>);
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    let treeVersion = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Run the experiment.",
              timestamp: "2026-04-15T07:00:00.000Z",
              channel: "web",
            },
            {
              id: "assistant-pending",
              role: "assistant",
              content: "",
              thinking: "Working through the experiment setup.",
              timestamp: "2026-04-15T07:00:01.000Z",
              taskPhases: [
                { id: "reading-file", label: "Reading file", status: "completed" },
                { id: "running-ablation", label: "Running ablation", status: "active" },
                { id: "done", label: "Done", status: "pending" },
              ],
            },
          ],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({
          tree:
            treeVersion === 0
              ? []
              : [{ name: "results", type: "directory", children: [{ name: "summary.md", type: "file" }] }],
        });
      }

      if (url.startsWith("/api/chat/unified?action=poll")) {
        treeVersion = 1;
        return Response.json({
          backend: "openclaw",
          conversationId: "web-alpha-project-session-1",
          generatedFiles: ["results/summary.md"],
          messages: [
            {
              id: "assistant-final",
              role: "assistant",
              channel: "web",
              content: "Finished the experiment and saved results/summary.md.",
              timestamp: "2026-04-15T07:00:05.000Z",
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
      expect(screen.getByTestId("message-count").textContent).toBe("2");
    });

    await act(async () => {
      for (const callback of scheduledIntervals) {
        await callback?.();
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("web-alpha-project-session-1");
      expect(screen.getByTestId("message-count").textContent).toBe("2");
      expect(screen.getByTestId("message-log").textContent).toContain(
        "assistant:Finished the experiment and saved results/summary.md.",
      );
      expect(screen.getByTestId("phase-log").textContent).not.toContain("Running ablation:active");
      expect(screen.getByTestId("phase-log").textContent).not.toContain("Done:pending");
      expect(screen.getByTestId("generated-artifact-count").textContent).toBe("1");
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("1");
    });

    const storedThread = JSON.parse(
      window.localStorage.getItem("scienceswarm.chat.alpha-project") ?? "{}",
    ) as { conversationId?: string | null };
    expect(storedThread.conversationId).toBe("web-alpha-project-session-1");
  });

  it("suppresses duplicate polled user echoes that mirror the local web turn", async () => {
    const scheduledIntervals: Array<() => void | Promise<void>> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === "function") {
        scheduledIntervals.push(callback as () => void | Promise<void>);
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    const duplicateTimestamp = new Date().toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json(
          {
            response: "Initial assistant response.",
            conversationId: "web:alpha-project:session-1",
            messages: [],
          },
          { headers: { "X-Chat-Backend": "openclaw", "X-Chat-Mode": "reasoning" } },
        );
      }

      if (url.startsWith("/api/chat/unified?action=poll")) {
        return Response.json({
          backend: "openclaw",
          messages: [
            {
              id: "remote-echo-user",
              role: "user",
              content: "Hello from the browser",
              timestamp: duplicateTimestamp,
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Initial assistant response.");
      expect(screen.getByTestId("message-count").textContent).toBe("4");
    });

    await act(async () => {
      for (const callback of scheduledIntervals) {
        await callback?.();
      }
    });

    await waitFor(() => {
      const messageLog = screen.getByTestId("message-log").textContent ?? "";
      expect(messageLog.match(/user:Hello from the browser/g)?.length ?? 0).toBe(1);
      expect(screen.getByTestId("message-count").textContent).toBe("4");
    });
  });

  it("suppresses duplicate polled assistant completions that replay the direct web response", async () => {
    const scheduledIntervals: Array<() => void | Promise<void>> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === "function") {
        scheduledIntervals.push(callback as () => void | Promise<void>);
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    const duplicateTimestamp = new Date().toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json(
          {
            response: "Initial assistant response.",
            conversationId: "web:alpha-project:session-1",
            messages: [],
          },
          { headers: { "X-Chat-Backend": "openclaw", "X-Chat-Mode": "reasoning" } },
        );
      }

      if (url.startsWith("/api/chat/unified?action=poll")) {
        return Response.json({
          backend: "openclaw",
          messages: [
            {
              id: "remote-echo-assistant",
              role: "assistant",
              channel: "web",
              content: "Initial   assistant\nresponse.",
              timestamp: duplicateTimestamp,
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Initial assistant response.");
      expect(screen.getByTestId("message-count").textContent).toBe("4");
    });

    await act(async () => {
      for (const callback of scheduledIntervals) {
        await callback?.();
      }
    });

    await waitFor(() => {
      const messageLog = screen.getByTestId("message-log").textContent ?? "";
      expect(messageLog.match(/assistant:Initial assistant response\./g)?.length ?? 0).toBe(1);
      expect(screen.getByTestId("message-count").textContent).toBe("4");
    });
  });

  it("advances the OpenClaw poll cursor after streamed web replies", async () => {
    const scheduledIntervals: Array<() => void | Promise<void>> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === "function") {
        scheduledIntervals.push(callback as () => void | Promise<void>);
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    const previousCursor = "2000-01-01T00:00:00.000Z";
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "web-alpha-project-session-1",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "assistant-old",
            role: "assistant",
            channel: "web",
            content: "Earlier answer",
            timestamp: previousCursor,
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: "web-alpha-project-session-1",
          conversationBackend: "openclaw",
          messages: [
            {
              id: "assistant-old",
              role: "assistant",
              channel: "web",
              content: "Earlier answer",
              timestamp: previousCursor,
            },
          ],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            text: "Streamed cursor answer.",
            conversationId: "web-alpha-project-session-1",
            backend: "openclaw",
          },
        ]);
      }

      if (url.startsWith("/api/chat/unified?action=poll")) {
        return Response.json({
          backend: "openclaw",
          conversationId: "web-alpha-project-session-1",
          messages: [],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Streamed cursor answer.");
    });

    await act(async () => {
      for (const callback of scheduledIntervals) {
        await callback?.();
      }
    });

    const pollCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("/api/chat/unified?action=poll"),
    );
    expect(pollCall).toBeTruthy();
    const pollUrl = new URL(String(pollCall?.[0]), "http://localhost");
    expect(Date.parse(pollUrl.searchParams.get("since") ?? "")).toBeGreaterThan(
      Date.parse(previousCursor),
    );
    expect(pollUrl.searchParams.get("conversationId")).toBe("web-alpha-project-session-1");
  });
  it("tracks generated files returned directly from a chat turn before the workspace tabs refresh", async () => {
    let treeVersion = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({
          tree:
            treeVersion === 0
              ? []
              : [{ name: "results", type: "directory", children: [{ name: "summary.md", type: "file" }] }],
        });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        treeVersion = 1;
        return Response.json({
          response: "Generated a fresh summary.",
          conversationId: "web:alpha-project:session-1",
          generatedFiles: ["results/summary.md"],
          messages: [],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("generated-artifact-count").textContent).toBe("1");
      expect(screen.getByTestId("generated-artifact-log").textContent).toContain("results/summary.md");
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("1");
    });
  });

  it("records streamed OpenClaw task phases on the active assistant message", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            taskPhases: [
              { id: "reading-file", label: "Reading file", status: "active" },
              { id: "extracting-table", label: "Extracting table", status: "pending" },
              { id: "generating-chart", label: "Generating chart", status: "pending" },
              { id: "importing-result", label: "Importing result", status: "pending" },
              { id: "done", label: "Done", status: "pending" },
            ],
          },
          {
            taskPhases: [
              { id: "reading-file", label: "Reading file", status: "completed" },
              { id: "extracting-table", label: "Extracting table", status: "active" },
              { id: "generating-chart", label: "Generating chart", status: "pending" },
              { id: "importing-result", label: "Importing result", status: "pending" },
              { id: "done", label: "Done", status: "pending" },
            ],
          },
          {
            text: "Saved chart to results/summary-chart.svg",
            conversationId: "web:alpha-project:session-1",
            taskPhases: [
              { id: "reading-file", label: "Reading file", status: "completed" },
              { id: "extracting-table", label: "Extracting table", status: "completed" },
              { id: "generating-chart", label: "Generating chart", status: "completed" },
              { id: "importing-result", label: "Importing result", status: "completed" },
              { id: "done", label: "Done", status: "completed" },
            ],
          },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain(
        "assistant:Saved chart to results/summary-chart.svg",
      );
      expect(screen.getByTestId("phase-log").textContent).toContain(
        "assistant:Reading file:completed|Extracting table:completed|Generating chart:completed|Importing result:completed|Done:completed",
      );
      expect(screen.getByTestId("conversation-id").textContent).toBe("web:alpha-project:session-1");
    });
  });

  it("flushes the active thread back to the brain state store on pagehide", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "conv-alpha",
        messages: [
          {
            id: "m1",
            role: "user",
            content: "remember me",
            timestamp: "2026-04-11T08:00:00.000Z",
          },
          {
            id: "m2",
            role: "assistant",
            content: "I remember you.",
            timestamp: "2026-04-11T08:00:01.000Z",
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json(
          {
            error: "Local model gemma4 is not ready. Open Settings -> Local Model via Ollama, pull it, and try again.",
          },
          { status: 503, headers: { "X-Chat-Backend": "none", "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-alpha");
    });

    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) =>
          url === "/api/chat/thread" && (init as RequestInit | undefined)?.keepalive === true,
        ),
      ).toBe(true);
    });

    const keepaliveCall = fetchMock.mock.calls.find(([url, init]) =>
      url === "/api/chat/thread" && (init as RequestInit | undefined)?.keepalive === true,
    );
    expect(keepaliveCall).toBeTruthy();
    const [, keepaliveInit] = keepaliveCall as [string, RequestInit];
    const body = JSON.parse(String(keepaliveInit.body));
    expect(body).toMatchObject({
      project: "alpha-project",
      conversationId: "conv-alpha",
    });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({ role: "user", content: "remember me" });
  });

  it("resets the unload guard after pageshow so a later pagehide flushes again", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "conv-alpha",
        messages: [
          {
            id: "m1",
            role: "user",
            content: "remember me",
            timestamp: "2026-04-11T08:00:00.000Z",
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json(
          {
            error: "Local model gemma4 is not ready. Open Settings -> Local Model via Ollama, pull it, and try again.",
          },
          { status: 503, headers: { "X-Chat-Backend": "none", "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-alpha");
    });

    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url, init]) =>
          url === "/api/chat/thread" && (init as RequestInit | undefined)?.keepalive === true,
        ),
      ).toHaveLength(1);
    });

    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("pagehide"));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url, init]) =>
          url === "/api/chat/thread" && (init as RequestInit | undefined)?.keepalive === true,
        ),
      ).toHaveLength(2);
    });
  });

  it("caps keepalive thread flushes so unload sync stays below the browser body limit", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "conv-alpha",
        messages: Array.from({ length: 80 }, (_, index) => ({
          id: `m${index + 1}`,
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message-${index + 1}-${"x".repeat(1200)}`,
          timestamp: "2026-04-11T08:00:00.000Z",
        })),
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-alpha");
    });

    window.dispatchEvent(new Event("pagehide"));

    const keepaliveCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) =>
        url === "/api/chat/thread" && (init as RequestInit | undefined)?.keepalive === true,
      );
      expect(call).toBeTruthy();
      return call;
    });

    const [, keepaliveInit] = keepaliveCall as [string, RequestInit];
    const body = JSON.parse(String(keepaliveInit.body));
    expect(body.messages).toHaveLength(50);
    expect(body.messages[0]).toMatchObject({ id: "m31" });
    expect(body.messages.at(-1)).toMatchObject({ id: "m80" });
  });

  it("flushes the active thread back to the brain state store on unmount", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "conv-alpha",
        messages: [
          {
            id: "m1",
            role: "user",
            content: "remember me",
            timestamp: "2026-04-11T08:00:00.000Z",
          },
          {
            id: "m2",
            role: "assistant",
            content: "I remember you.",
            timestamp: "2026-04-11T08:00:01.000Z",
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-alpha");
    });

    view.unmount();

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) =>
          url === "/api/chat/thread" && (init as RequestInit | undefined)?.keepalive === true,
        ),
      ).toBe(true);
    });

    const keepaliveCall = fetchMock.mock.calls.find(([url, init]) =>
      url === "/api/chat/thread" && (init as RequestInit | undefined)?.keepalive === true,
    );
    expect(keepaliveCall).toBeTruthy();
  });

  it("keeps the latest chat message when navigation unmounts the hook in the same interaction", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: "conv-alpha",
        messages: [
          {
            id: "m1",
            role: "user",
            content: "remember me",
            timestamp: "2026-04-11T08:00:00.000Z",
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    function Wrapper() {
      const [mounted, setMounted] = useState(true);
      return mounted ? (
        <NavigateAwayOnAppendHarness
          projectName="alpha-project"
          onNavigateAway={() => setMounted(false)}
        />
      ) : (
        <div>navigated away</div>
      );
    }

    render(<Wrapper />);

    fireEvent.click(screen.getByRole("button", { name: "Append and leave" }));

    await waitFor(() => {
      expect(screen.getByText("navigated away")).toBeInTheDocument();
    });

    const persisted = JSON.parse(
      window.localStorage.getItem("scienceswarm.chat.alpha-project") || "null",
    ) as {
      messages?: Array<{ role?: string; content?: string }>;
    } | null;

    expect(persisted?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "Instant reply before navigation",
        }),
      ]),
    );
  });

  it("keeps conversations isolated per project", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/chat/thread?project=beta-project") {
        return Response.json({
          version: 1,
          project: "beta-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/workspace?action=tree&projectId=beta-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json({
          response: "Persisted answer",
          conversationId: "conv-alpha",
          messages: [],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ChatHarness projectName="alpha-project" />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-alpha");
    });

    view.rerender(<ChatHarness projectName="beta-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("");
    });
    expect(screen.getByTestId("message-log").textContent).toContain("Project **beta-project** loaded.");
    expect(screen.getByTestId("message-log").textContent).not.toContain("Hello from the browser");
  });

  it("ignores late OpenClaw completions after switching projects", async () => {
    const pendingReply: { resolve: ((response: Response) => void) | null } = { resolve: null };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        }));
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Promise.resolve(Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        }));
      }

      if (url === "/api/chat/thread?project=beta-project") {
        return Promise.resolve(Response.json({
          version: 1,
          project: "beta-project",
          conversationId: null,
          messages: [],
        }));
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      if (url === "/api/workspace?action=tree&projectId=beta-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return new Promise<Response>((resolve) => {
          pendingReply.resolve = resolve;
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Use OpenClaw tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) =>
        url === "/api/chat/unified" && (init as RequestInit | undefined)?.method === "POST",
      )).toBe(true);
    });

    view.rerender(<ChatHarness projectName="beta-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("Project **beta-project** loaded.");
      expect(screen.getByTestId("message-log").textContent).not.toContain("Hello from the browser");
      expect(screen.getByTestId("conversation-id").textContent).toBe("");
    });

    expect(pendingReply.resolve).toBeTruthy();
    if (!pendingReply.resolve) {
      throw new Error("Expected the delayed chat request to be pending");
    }
    pendingReply.resolve(
      Response.json(
        {
          response: "Late OpenClaw answer",
          conversationId: "web:alpha-project:session-1",
          messages: [],
        },
        { headers: { "X-Chat-Backend": "openclaw" } },
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).not.toContain("Late OpenClaw answer");
      expect(screen.getByTestId("conversation-id").textContent).toBe("");
    });
  });

  it("drops blank assistant placeholders without task phases on reload", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha-project",
      JSON.stringify({
        version: 1,
        conversationId: null,
        messages: [
          {
            id: "sys-1",
            role: "system",
            content: "Project **alpha-project** loaded.",
            timestamp: "2026-04-14T20:00:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Persisted answer",
            timestamp: "2026-04-14T20:00:01.000Z",
          },
          {
            id: "assistant-empty-old",
            role: "assistant",
            content: "",
            timestamp: "2026-04-14T20:00:01.500Z",
          },
          {
            id: "user-2",
            role: "user",
            content: "hi",
            timestamp: "2026-04-14T20:00:02.000Z",
          },
          {
            id: "assistant-empty",
            role: "assistant",
            content: "",
            timestamp: "2026-04-14T20:00:03.000Z",
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json(
          {
            error: "Local model gemma4 is not ready. Open Settings -> Local Model via Ollama, pull it, and try again.",
          },
          { status: 503, headers: { "X-Chat-Backend": "none", "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("message-count").textContent).toBe("3");
    });
    const restoredMessages = (screen.getByTestId("message-log").textContent || "").split("\n");
    expect(restoredMessages).toContain("assistant:Persisted answer");
    expect(restoredMessages).toContain("user:hi");
    expect(restoredMessages.filter((message) => message === "assistant:")).toHaveLength(0);
  });

  it("uses OpenClaw tools mode over the direct local-model path when selected", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          ollama: "connected",
          ollamaModels: [],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json({
          response: "OpenClaw answer",
          conversationId: "conv-openclaw",
          messages: [],
        }, { headers: { "X-Chat-Backend": "openclaw" } });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
      expect(screen.getByTestId("chat-mode").textContent).toBe("reasoning");
    });

    fireEvent.click(screen.getByRole("button", { name: "Use OpenClaw tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-openclaw");
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });
    expect(screen.getByTestId("message-log").textContent).toContain("assistant:OpenClaw answer");
    const chatPost = fetchMock.mock.calls.find(([url, init]) =>
      url === "/api/chat/unified" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(chatPost).toBeTruthy();
    const body = JSON.parse(String((chatPost?.[1] as RequestInit | undefined)?.body));
    expect(body.mode).toBe("openclaw-tools");
    expect(body.streamPhases).toBe(true);
  });

  it("forwards the live OpenClaw conversationId on follow-up turns", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          ollama: "connected",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          response: body.conversationId ? "Second answer" : "First answer",
          conversationId: body.conversationId ?? "conv-openclaw",
          messages: [],
        }, { headers: { "X-Chat-Backend": "openclaw" } });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Use OpenClaw tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Second answer");
    });

    const chatPosts = fetchMock.mock.calls.filter(([url, init]) =>
      url === "/api/chat/unified" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(chatPosts).toHaveLength(2);
    const secondBody = JSON.parse(String((chatPosts[1]?.[1] as RequestInit | undefined)?.body));
    expect(secondBody.conversationId).toBe("conv-openclaw");
    expect(secondBody.mode).toBe("openclaw-tools");
  });

  it("keeps forwarding the live OpenClaw conversationId after switching back to reasoning mode", async () => {
    let chatRequestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        chatRequestCount += 1;
        return Response.json({
          response: chatRequestCount === 1 ? "OpenClaw answer" : "Reasoning follow-up answer",
          conversationId: chatRequestCount === 1 ? "web:alpha-project:session-1" : body.conversationId,
          messages: [],
        }, { headers: { "X-Chat-Backend": "openclaw" } });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Use OpenClaw tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("web:alpha-project:session-1");
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Use Reasoning" }));

    await waitFor(() => {
      expect(screen.getByTestId("chat-mode").textContent).toBe("reasoning");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const chatPosts = fetchMock.mock.calls.filter(([url, init]) =>
        url === "/api/chat/unified" && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(chatPosts).toHaveLength(2);
    });

    const chatPosts = fetchMock.mock.calls.filter(([url, init]) =>
      url === "/api/chat/unified" && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(chatPosts).toHaveLength(2);
    const secondBody = JSON.parse(String((chatPosts[1]?.[1] as RequestInit | undefined)?.body));
    expect(secondBody.conversationId).toBe("web:alpha-project:session-1");
    expect(secondBody.mode).toBe("reasoning");
  });

  it("reuses the live OpenClaw conversationId for execution-style reasoning turns", async () => {
    let chatRequestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          ollama: "connected",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        chatRequestCount += 1;
        return Response.json({
          response: chatRequestCount === 1 ? "OpenClaw answer" : "Follow-up answer",
          conversationId: body.conversationId ?? "conv-openclaw",
          messages: [],
        }, { headers: { "X-Chat-Backend": "openclaw" } });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Use OpenClaw tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Use Reasoning" }));
    await waitFor(() => {
      expect(screen.getByTestId("chat-mode").textContent).toBe("reasoning");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send execution request" }));

    await waitFor(() => {
      const chatPosts = fetchMock.mock.calls.filter(([url, init]) =>
        url === "/api/chat/unified" && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(chatPosts).toHaveLength(2);
    });

    const chatPosts = fetchMock.mock.calls.filter(([url, init]) =>
      url === "/api/chat/unified" && (init as RequestInit | undefined)?.method === "POST",
    );
    const secondBody = JSON.parse(String((chatPosts[1]?.[1] as RequestInit | undefined)?.body));
    expect(secondBody.mode).toBe("reasoning");
    expect(secondBody.message).toBe("Run the training experiment and save the report in the workspace");
    expect(secondBody.conversationId).toBe("conv-openclaw");
  });

  it("refreshes the workspace tree after a direct SSE fallback completes", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"text":"Streamed answer"}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "X-Chat-Backend": "direct",
          },
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Streamed answer");
    });

    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/workspace?action=tree&projectId=alpha-project"),
    ).toHaveLength(2);
  });

  it("keeps ordered timing meta events out of the visible transcript", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          { timing: { type: "chat_timing", name: "request_start", elapsedMs: 0 } },
          { timing: { type: "chat_timing", name: "readiness_complete", elapsedMs: 12 } },
          { timing: { type: "chat_timing", name: "gateway_ack", elapsedMs: 18 } },
          { timing: { type: "chat_timing", name: "first_gateway_event", elapsedMs: 21 } },
          { timing: { type: "chat_timing", name: "final_assistant_text", elapsedMs: 55 } },
          { text: "Streamed answer" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Streamed answer");
    });

    expect(screen.getByTestId("progress-log").textContent).not.toContain("Timing:");
  });

  it("accumulates direct-stream thinking traces and restores them after remount", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          ollama: "connected",
          ollamaModels: ["gemma4:26b"],
          configuredLocalModel: "gemma4:26b",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          { thinking: "Scanning the import manifest...\n" },
          { thinking: "Counting PDF entries by committed file ref." },
          { text: "I found 12 imported PDFs." },
        ], "direct");
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const firstRender = render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:I found 12 imported PDFs.");
    });
    expect(screen.getByTestId("thinking-log").textContent).toContain(
      "assistant:Scanning the import manifest...",
    );
    expect(screen.getByTestId("thinking-log").textContent).toContain(
      "Counting PDF entries by committed file ref.",
    );

    const directPost = fetchMock.mock.calls.find(([url, maybeInit]) =>
      url === "/api/chat/unified" && (maybeInit as RequestInit | undefined)?.method === "POST",
    );
    expect(directPost).toBeTruthy();
    expect(JSON.parse(String((directPost?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      backend: "openclaw",
    });

    firstRender.unmount();
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("thinking-log").textContent).toContain(
        "assistant:Scanning the import manifest...",
      );
    });
    expect(screen.getByTestId("progress-log").textContent).toContain(
      "thinking:Scanning the import manifest... | thinking:Counting PDF entries by committed file ref.",
    );
    expect(screen.getByTestId("message-log").textContent).toContain(
      "assistant:I found 12 imported PDFs.",
    );
  });

  it("replaces streamed thinking when the server sends a full snapshot", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          ollama: "connected",
          ollamaModels: ["gemma4:26b"],
          configuredLocalModel: "gemma4:26b",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          { thinking: "Inspecting uploaded files...\n" },
          { thinking: "Inspecting uploaded files...\nTracing the latest assistant turn.", replaceThinking: true },
          { text: "I found the bug." },
        ], "openclaw");
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:I found the bug.");
    });
    expect(screen.getByTestId("thinking-log").textContent).toContain(
      "assistant:Inspecting uploaded files...\nTracing the latest assistant turn.",
    );
    expect(screen.getByTestId("thinking-log").textContent).not.toContain(
      "Inspecting uploaded files...\nInspecting uploaded files...",
    );
  });

  it("captures OpenClaw gateway session.message thinking and activity details", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "session.message",
              payload: {
                stream: "thinking",
                text: "Planning how to inspect the chart files.",
                message: {
                  role: "assistant",
                  content: [
                    { type: "thinking", thinking: "Planning how to inspect the chart files." },
                    { type: "tool_call", name: "read_file", input: { path: "docs/results_table.csv" } },
                    { type: "tool_result", name: "read_file", output: "Loaded 42 rows." },
                    { type: "text", text: "Draft answer in progress." },
                  ],
                },
              },
            },
          },
          { text: "Final answer" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Final answer");
    });
    expect(screen.getByTestId("thinking-log").textContent).toContain(
      "assistant:Planning how to inspect the chart files.",
    );
    expect(screen.getByTestId("thinking-log").textContent).not.toContain(
      "Planning how to inspect the chart files.\nPlanning how to inspect the chart files.",
    );
    expect(screen.getByTestId("activity-log").textContent).not.toContain("Tool read_file: docs/results_table.csv");
    expect(screen.getByTestId("activity-log").textContent).toContain(
      "Tool read_file result: Loaded 42 rows.",
    );
    expect(screen.getByTestId("progress-log").textContent).toContain(
      "thinking:Planning how to inspect the chart files. | activity:Read docs/results_table.csv",
    );
    expect(screen.getByTestId("progress-log").textContent).not.toContain(
      "Read file result: Loaded 42 rows.",
    );
  });

  it("maps structured read tool calls from the OpenClaw canvas runtime to project-facing paths", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "session.message",
              payload: {
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_call",
                      name: "read",
                      input: {
                        path: "/Users/example/.scienceswarm/openclaw/canvas/documents/cat-svg-preview/index.html",
                      },
                    },
                  ],
                },
              },
            },
          },
          { text: "Preview opened" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Preview opened");
    });
    expect(screen.getByTestId("progress-log").textContent).toContain(
      "activity:Read figures/cat-svg-preview/index.html",
    );
    expect(screen.getByTestId("activity-log").textContent).not.toContain(
      "Tool read: figures/cat-svg-preview/index.html",
    );
  });

  it("normalizes JSON-shaped tool progress rows while preserving plain rows and markdown", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "session.message",
              payload: {
                text:
                  "Use search: {\"pattern\":\"**needle**\",\"path\":\"/Users/example/.scienceswarm/projects/alpha-project/docs/results_table.csv\"}",
              },
            },
          },
          {
            progress: {
              method: "session.message",
              payload: {
                text: "Read docs/summary.md",
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });

    const progressLog = screen.getByTestId("progress-log").textContent ?? "";
    expect(progressLog).toContain(
      "activity:Search **needle** in docs/results_table.csv | activity:Read docs/summary.md",
    );
    expect(progressLog).not.toContain("Use search:");
    expect(progressLog).not.toContain("/Users/example/.scienceswarm/projects/alpha-project/docs/results_table.csv");

    const activityLog = screen.getByTestId("activity-log").textContent ?? "";
    expect(activityLog).not.toContain("Search **needle** in docs/results_table.csv | Read docs/summary.md");
  });

  it("formats structured image generation tool calls without dumping raw JSON into progress", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "session.message",
              payload: {
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_call",
                      name: "image_generate",
                      input: {
                        prompt: "A charming cat sitting and looking at the viewer, warm soft lighting.",
                        filename: "cat-image.png",
                        size: "1024x1024",
                        count: 1,
                      },
                    },
                  ],
                },
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });
    expect(screen.getByTestId("progress-log").textContent).toContain(
      "activity:Generate image cat-image.png (1024x1024)",
    );
    expect(screen.getByTestId("progress-log").textContent).not.toContain(
      "{\"prompt\":\"A charming cat sitting and looking at the viewer, warm soft lighting.",
    );
    expect(screen.getByTestId("activity-log").textContent).not.toContain(
      "Tool image_generate: cat-image.png (1024x1024)",
    );
  });

  it("formats write tool calls as file actions instead of raw JSON", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "session.message",
              payload: {
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      name: "write",
                      arguments: {
                        path: "/Users/example/.scienceswarm/projects/alpha-project/scripts/generate_mouse_chasing_cat_gif.py",
                        content: "#!/usr/bin/env python3\nprint('hello')\n",
                      },
                    },
                  ],
                },
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });
    expect(screen.getByTestId("progress-log").textContent).toContain(
      "activity:Write scripts/generate_mouse_chasing_cat_gif.py",
    );
    expect(screen.getByTestId("progress-log").textContent).not.toContain(
      "\"content\":\"#!/usr/bin/env python3",
    );
  });

  it("formats exec tool calls with normalized project-relative commands", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "session.message",
              payload: {
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      name: "exec",
                      arguments: {
                        cmd:
                          "/usr/bin/python3 " +
                          "/Users/example/.scienceswarm/projects/alpha-project/scripts/generate_mouse_chasing_cat_gif.py",
                      },
                    },
                  ],
                },
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });
    expect(screen.getByTestId("progress-log").textContent).toContain(
      "activity:Run python3 scripts/generate_mouse_chasing_cat_gif.py",
    );
    expect(screen.getByTestId("progress-log").textContent).not.toContain(
      "/usr/bin/python3",
    );
    expect(screen.getByTestId("progress-log").textContent).not.toContain(
      "/Users/example/.scienceswarm/projects/alpha-project/scripts/generate_mouse_chasing_cat_gif.py",
    );
  });

  it("surfaces update_plan steps as readable progress entries", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "session.message",
              payload: {
                message: {
                  role: "toolResult",
                  toolName: "update_plan",
                  content: [],
                  details: {
                    status: "updated",
                    plan: [
                      { step: "Inspect the imported markdown table", status: "in_progress" },
                      { step: "Generate the output chart", status: "pending" },
                    ],
                  },
                },
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });
    expect(screen.getByTestId("progress-log").textContent).toContain(
      "activity:Plan: Inspect the imported markdown table -> Generate the output chart",
    );
  });

  it("captures gateway thinking snapshots sent through agent progress events", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "agent",
              payload: {
                stream: "thinking",
                data: {
                  text: "Inspecting the imported project manifest.",
                },
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });
    expect(screen.getByTestId("thinking-log").textContent).toContain(
      "assistant:Inspecting the imported project manifest.",
    );
    expect(screen.getByTestId("progress-log").textContent).toContain(
      "thinking:Inspecting the imported project manifest.",
    );
  });

  it("captures gateway agent tool stream events as ordered progress rows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "agent",
              payload: {
                stream: "tool",
                data: {
                  phase: "start",
                  name: "read_file",
                  input: { path: "docs/results_table.csv" },
                },
              },
            },
          },
          {
            progress: {
              method: "agent",
              payload: {
                stream: "tool",
                data: {
                  phase: "result",
                  name: "read_file",
                  output: "Loaded 42 rows.",
                },
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });
    const progressLog = screen.getByTestId("progress-log").textContent ?? "";
    expect(progressLog).toContain("assistant:activity:Sending request to OpenClaw");
    expect(progressLog).toContain("activity:Waiting for OpenClaw to respond");
    expect(progressLog).toContain("activity:Read docs/results_table.csv");
    expect(screen.getByTestId("activity-log").textContent).not.toContain(
      "Tool read_file: docs/results_table.csv",
    );
    expect(screen.getByTestId("activity-log").textContent).toContain(
      "Tool read_file result: Loaded 42 rows.",
    );
  });

  it("records structured metadata for server send phases and agent tool progress", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "agent.tool.start",
              payload: {
                data: {
                  phase: "start",
                  name: "read_file",
                  input: { path: "docs/results_table.csv" },
                },
              },
            },
          },
          {
            progress: {
              method: "agent.tool.result",
              payload: {
                data: {
                  phase: "result",
                  name: "read_file",
                  output: "Loaded 42 rows.",
                },
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });

    const progressMeta = screen.getByTestId("progress-log-meta").textContent ?? "";
    expect(progressMeta).toMatch(/assistant:server\/send\/started\/Send\/\d+/);
    expect(progressMeta).toMatch(/server\/waiting\/running\/Wait\/\d+/);
    expect(progressMeta).toMatch(/agent\/start\/started\/Read\/\d+/);
  });

  it("does not duplicate new-format agent events that also carry legacy fields", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "agent.tool.start",
              payload: {
                stream: "tool",
                text: "duplicate top-level narration",
                data: {
                  phase: "start",
                  name: "read_file",
                  input: { path: "docs/results_table.csv" },
                },
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });
    const progressLog = screen.getByTestId("progress-log").textContent ?? "";
    expect(progressLog.match(/Read docs\/results_table\.csv/g)).toHaveLength(1);
    expect(progressLog).not.toContain("duplicate top-level narration");
  });

  it("narrates the OpenClaw send phases before the first stream delta arrives", async () => {
    const deferredStream = createDeferredSseResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return deferredStream.response;
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const progressLog = screen.getByTestId("progress-log").textContent ?? "";
      expect(progressLog).toContain("assistant:activity:Sending request to OpenClaw");
      expect(progressLog).toContain("activity:Waiting for OpenClaw to respond");
    });

    const progressLog = screen.getByTestId("progress-log").textContent ?? "";
    expect(progressLog).not.toContain("Turn started");
    expect(progressLog).not.toContain("Turn finished");
    const activityLog = screen.getByTestId("activity-log").textContent ?? "";
    expect(activityLog).not.toContain("Sending request to OpenClaw");
    expect(activityLog).not.toContain("Waiting for OpenClaw to respond");

    act(() => {
      deferredStream.send({ text: "Done" });
      deferredStream.close();
    });

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });
  });

  it("does not emit the waiting narration when a non-streaming chat response fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json({ error: "OpenClaw transport failed" }, { status: 500 });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe("OpenClaw transport failed");
    });

    const progressLog = screen.getByTestId("progress-log").textContent ?? "";
    expect(progressLog).toContain("assistant:activity:Sending request to OpenClaw");
    expect(progressLog).not.toContain("activity:Waiting for OpenClaw to respond");
  });

  it("captures lifecycle-only gateway progress as assistant activity", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "agent",
              payload: {
                stream: "lifecycle",
                data: {
                  phase: "start",
                },
              },
            },
          },
          {
            progress: {
              method: "agent",
              payload: {
                stream: "assistant",
                data: {
                  text: "Working on it",
                  delta: "Working on it",
                },
              },
            },
          },
          {
            progress: {
              method: "agent",
              payload: {
                stream: "lifecycle",
                data: {
                  phase: "end",
                },
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });
    expect(screen.getByTestId("activity-log").textContent).toContain("assistant:");
    expect(screen.getByTestId("activity-log").textContent).not.toContain("Turn started");
    expect(screen.getByTestId("activity-log").textContent).not.toContain("Turn finished");
    expect(screen.getByTestId("progress-log").textContent).toContain("assistant:");
    expect(screen.getByTestId("progress-log").textContent).not.toContain("Status: running");
    expect(screen.getByTestId("progress-log").textContent).not.toContain("Status: idle");
    expect(screen.getByTestId("progress-log").textContent).not.toContain("Turn started");
    expect(screen.getByTestId("progress-log").textContent).not.toContain("Turn finished");
  });

  it("suppresses lifecycle filler while preserving useful tool progress rows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              method: "agent",
              payload: {
                stream: "lifecycle",
                data: {
                  phase: "start",
                },
              },
            },
          },
          {
            progress: {
              method: "agent",
              payload: {
                stream: "tool",
                data: {
                  phase: "start",
                  name: "read_file",
                  input: { path: "docs/results_table.csv" },
                },
              },
            },
          },
          {
            progress: {
              method: "agent",
              payload: {
                stream: "lifecycle",
                data: {
                  phase: "running",
                },
              },
            },
          },
          {
            progress: {
              method: "agent",
              payload: {
                stream: "tool",
                data: {
                  phase: "result",
                  name: "read_file",
                  output: "Loaded 42 rows.",
                },
              },
            },
          },
          {
            progress: {
              method: "agent",
              payload: {
                stream: "lifecycle",
                data: {
                  phase: "end",
                },
              },
            },
          },
          { text: "Done" },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain("assistant:Done");
    });

    const progressLog = screen.getByTestId("progress-log").textContent ?? "";
    expect(progressLog).toContain("activity:Read docs/results_table.csv");
    expect(progressLog).not.toContain("Status: running");
    expect(progressLog).not.toContain("Status: idle");

    const activityLog = screen.getByTestId("activity-log").textContent ?? "";
    expect(activityLog).not.toContain("Tool read_file: docs/results_table.csv");
    expect(activityLog).toContain("Tool read_file result: Loaded 42 rows.");
    expect(activityLog).not.toContain("Turn started");
    expect(activityLog).not.toContain("Turn finished");
  });

  it("streams gateway chat.delta into the assistant bubble before chat.final replaces it", async () => {
    const deferredStream = createDeferredSseResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return deferredStream.response;
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) =>
        url === "/api/chat/unified" && (init?.method ?? "GET") === "POST",
      )).toBe(true);
    });

    await act(async () => {
      deferredStream.send({
        progress: {
          type: "event",
          method: "chat.delta",
          payload: {
            delta: "Draft answer",
            stream: "assistant",
            data: { delta: "Draft answer" },
          },
        },
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain(
        "assistant:Draft answer",
      );
    });
    expect(screen.getByTestId("message-log").textContent).not.toContain(
      "assistant:Draft answerDraft answer",
    );

    await act(async () => {
      deferredStream.send({
        progress: {
          type: "event",
          method: "chat.final",
          payload: {
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Canonical " },
                { type: "text", text: "final answer." },
              ],
            },
          },
        },
      });
      deferredStream.close();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain(
        "assistant:Canonical final answer.",
      );
    });
    expect(screen.getByTestId("message-log").textContent).not.toContain(
      "assistant:Draft answerCanonical final answer.",
    );
  });

  it("renders gateway chat error and aborted events as progress status rows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return createSseResponse([
          {
            progress: {
              type: "event",
              method: "chat.error",
              payload: { error: { message: "OpenClaw transport failed" } },
            },
          },
          {
            progress: {
              type: "event",
              method: "chat.aborted",
              payload: { reason: "User interrupted the run" },
            },
          },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("progress-log").textContent).toContain(
        "activity:Chat failed: OpenClaw transport failed | activity:Chat aborted: User interrupted the run",
      );
    });
    expect(screen.getByTestId("activity-log").textContent).not.toContain(
      "Sending request to OpenClaw | Waiting for OpenClaw to respond",
    );
  });

  it("automatically refreshes the workspace tree while the project view stays open", async () => {
    let treeCallCount = 0;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    const scheduledIntervals: Array<() => void | Promise<void>> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === "function") {
        scheduledIntervals.push(callback as () => void | Promise<void>);
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        treeCallCount += 1;
        return Response.json({
          tree: treeCallCount === 1
            ? []
            : [{ name: "results", type: "directory", children: [{ name: "summary.md", type: "file" }] }],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("0");
    });

    await act(async () => {
      await Promise.all(scheduledIntervals.map((callback) => callback()));
    });

    await waitFor(() => {
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("1");
    });
  });

  it("refreshes the workspace tree from the fast project watch when external writes land", async () => {
    let treeVersion = 0;
    let watchRevision = "rev-1";
    const scheduledIntervals: Array<() => void | Promise<void>> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === "function") {
        scheduledIntervals.push(callback as () => void | Promise<void>);
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({
          tree: treeVersion === 0
            ? []
            : [{ name: "results", type: "directory", children: [{ name: "summary.md", type: "file" }] }],
          watchRevision,
        });
      }

      if (url === "/api/workspace?action=watch&projectId=alpha-project&since=rev-1") {
        return Response.json({
          revision: watchRevision,
          changed: watchRevision !== "rev-1",
        });
      }

      if (url === "/api/workspace?action=watch&projectId=alpha-project") {
        return Response.json({
          revision: watchRevision,
          changed: false,
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("0");
    });

    treeVersion = 1;
    watchRevision = "rev-2";

    await act(async () => {
      await Promise.all(scheduledIntervals.map((callback) => callback()));
    });

    await waitFor(() => {
      expect(screen.getByTestId("workspace-root-count").textContent).toBe("1");
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/workspace?action=tree&projectId=alpha-project"),
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.some(([url]) => url === "/api/workspace?action=watch&projectId=alpha-project&since=rev-1"),
    ).toBe(true);
  });

  // The two "backend switch" tests that used to live here exercised the
  // user-triggered "Switch Direct" flow that invalidated in-flight OpenClaw
  // requests by bumping `userBackendOverrideVersionRef`. The Backend union
  // has been narrowed to `"openclaw"` so the UI no longer exposes any
  // direction to switch to; the tests lose their meaning along with the
  // "Switch Direct" harness button.

  it("times out a slash command that never starts and keeps the placeholder with a failure progress row", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        }));
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Promise.resolve(Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        }));
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      if (url === "/api/chat/command" && method === "POST") {
        return new Promise<Response>(() => {
          // Never resolves: simulates an unavailable slash-command runtime.
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send slash" }));
      await Promise.resolve();
    });
    expect(screen.getByTestId("is-streaming").textContent).toBe("true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();
    });

    expect(screen.getByTestId("is-streaming").textContent).toBe("false");

    expect(screen.getByTestId("error").textContent).toBe(
      "ScienceSwarm slash command did not start within 15 seconds. Check OpenClaw in Settings and retry.",
    );
    expect(screen.getByTestId("message-count").textContent).toBe("4");
    const restoredMessages = (screen.getByTestId("message-log").textContent || "").split("\n");
    expect(restoredMessages.filter((message) => message.startsWith("assistant:"))).toHaveLength(2);
    expect(screen.getByTestId("progress-log").textContent).toContain(
      "activity:Chat failed: ScienceSwarm slash command did not start within 15 seconds. Check OpenClaw in Settings and retry.",
    );
    expect(screen.getByTestId("activity-log").textContent).not.toContain(
      "Chat failed: ScienceSwarm slash command did not start within 15 seconds. Check OpenClaw in Settings and retry.",
    );
  });

  it("blocks send when local provider is selected but the configured model is missing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "local",
          ollama: "connected",
          ollamaModels: [],
          configuredLocalModel: "gemma4",
        });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json(
          {
            error: "Local model gemma4 is not ready. Open Settings -> Local Model via Ollama, pull it, and try again.",
          },
          { status: 503, headers: { "X-Chat-Backend": "none", "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain(
        "Local model gemma4 is not ready. Open Settings -> Local Model via Ollama, pull it, and try again.",
      );
    });
  });

  it("maps missing privacy manifest errors to a visible recovery path for slash commands", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          ollama: "connected",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/command" && method === "POST") {
        return Response.json(
          {
            error: "Project alpha-project has no privacy manifest; remote chat is blocked.",
          },
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send slash" }));

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain(
        "Use Create empty project or Import project in the workspace panel to generate its privacy manifest",
      );
    });
  });

  it("maps local-only remote chat errors to visible recovery guidance for slash commands", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          ollama: "connected",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/command" && method === "POST") {
        return Response.json(
          {
            error: "Project alpha-project is local-only; remote chat is blocked for this project.",
          },
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send slash" }));

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain(
        "Project alpha-project is set to local-only chat.",
      );
      expect(screen.getByTestId("error").textContent).toContain(
        "Use the visible project setup flow to enable remote chat before retrying this slash command.",
      );
    });
  });

  it("consumes streamed slash-command responses and clears the placeholder turn", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          ollama: "connected",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/command" && method === "POST") {
        return createSseResponse([
          {
            taskPhases: [
              { id: "running-skill", label: "Running skill", status: "active" },
              { id: "importing-result", label: "Importing result", status: "pending" },
              { id: "done", label: "Done", status: "pending" },
            ],
          },
          {
            text: "Saved revision checklist to docs/revision-plan.md",
            conversationId: "conv-slash",
            backend: "openclaw",
            generatedFiles: ["docs/revision-plan.md"],
            generatedArtifacts: [
              {
                projectPath: "docs/revision-plan.md",
                sourceFiles: [],
                prompt: "/audit-revise draft a revision checklist",
                tool: "OpenClaw CLI",
                createdAt: "2026-04-20T15:00:00.000Z",
              },
            ],
            taskPhases: [
              { id: "running-skill", label: "Running skill", status: "completed" },
              { id: "importing-result", label: "Importing result", status: "completed" },
              { id: "done", label: "Done", status: "completed" },
            ],
          },
        ]);
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send slash" }));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-id").textContent).toBe("conv-slash");
      expect(screen.getByTestId("is-streaming").textContent).toBe("false");
    });
    const messageLog = screen.getByTestId("message-log").textContent ?? "";
    expect(messageLog).toContain(
      "assistant:Saved revision checklist to docs/revision-plan.md",
    );
    expect(
      messageLog
        .split("\n")
        .filter((line) => line.startsWith("assistant:")),
    ).toHaveLength(2);
    expect(screen.getByTestId("phase-log").textContent).toContain(
      "assistant:Running skill:completed|Importing result:completed|Done:completed",
    );
    expect(screen.getByTestId("generated-artifact-log").textContent).toContain(
      "docs/revision-plan.md",
    );
  });

  it("blocks send when OpenClaw tools mode is selected but disconnected, even if a local model is configured", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "disconnected" },
          openclaw: "disconnected",
          nanoclaw: "disconnected",
          openhands: "connected",
          ollama: "connected",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        throw new Error("Chat should not POST when OpenClaw is disconnected");
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Use OpenClaw tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain("OpenClaw is not reachable");
    });
  });

  it("reuses the in-flight OpenClaw load probe when the project changes", async () => {
    const healthDeferred: { resolve: ((response: Response) => void) | null } = {
      resolve: null,
    };
    let healthProbeCount = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        healthProbeCount += 1;
        return await new Promise<Response>((resolve) => {
          healthDeferred.resolve = resolve;
        });
      }

      if (url === "/api/chat/thread?project=alpha-project" || url === "/api/chat/thread?project=beta-project") {
        return Response.json({
          version: 1,
          project: url.endsWith("beta-project") ? "beta-project" : "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (
        url === "/api/workspace?action=tree&projectId=alpha-project"
        || url === "/api/workspace?action=tree&projectId=beta-project"
      ) {
        return Response.json({ tree: [] });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(healthProbeCount).toBe(1);
    });

    view.rerender(<ChatHarness projectName="beta-project" />);

    await waitFor(() => {
      expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
        "/api/chat/thread?project=beta-project",
      );
    });
    expect(healthProbeCount).toBe(1);

    if (!healthDeferred.resolve) {
      throw new Error("Expected an in-flight health probe to expose a resolver");
    }

    healthDeferred.resolve(Response.json({
      agent: { type: "openclaw", status: "connected" },
      openclaw: "connected",
      nanoclaw: "disconnected",
      openhands: "connected",
      ollama: "connected",
      ollamaModels: ["gemma4:latest"],
      configuredLocalModel: "gemma4",
      llmProvider: "local",
    }));

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });
  });

  it("starts a fresh OpenClaw load probe for the next project after a failed preconnect", async () => {
    let healthProbeCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        healthProbeCount += 1;
        if (healthProbeCount === 1) {
          throw new Error("OpenClaw gateway booting");
        }

        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          ollama: "connected",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project" || url === "/api/chat/thread?project=beta-project") {
        return Response.json({
          version: 1,
          project: url.endsWith("beta-project") ? "beta-project" : "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (
        url === "/api/workspace?action=tree&projectId=alpha-project"
        || url === "/api/workspace?action=tree&projectId=beta-project"
      ) {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json({
          response: "Recovered after project-load preconnect failure",
          conversationId: "web:beta-project:session-1",
          messages: [],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(healthProbeCount).toBe(1);
    });

    view.rerender(<ChatHarness projectName="beta-project" />);

    await waitFor(() => {
      expect(healthProbeCount).toBe(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain(
        "assistant:Recovered after project-load preconnect failure",
      );
    });
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("rechecks OpenClaw health on send before surfacing a disconnected error", async () => {
    let healthProbeCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        healthProbeCount += 1;
        if (healthProbeCount === 1) {
          return Response.json({
            agent: { type: "openclaw", status: "disconnected" },
            openclaw: "disconnected",
            nanoclaw: "disconnected",
            openhands: "connected",
            ollama: "connected",
            ollamaModels: ["gemma4:latest"],
            configuredLocalModel: "gemma4",
            llmProvider: "local",
          });
        }

        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          ollama: "connected",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json({
          response: "Recovered answer",
          conversationId: "web:alpha-project:session-1",
          messages: [],
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("message-log").textContent).toContain(
        "assistant:Recovered answer",
      );
    });

    expect(screen.getByTestId("error").textContent).toBe("");
    expect(healthProbeCount).toBeGreaterThanOrEqual(2);
  });

  it("blocks reasoning-mode send and surfaces an error when OpenClaw is disconnected even if OpenHands is up", async () => {
    // This is the new guarantee introduced by the chat-only-through-OpenClaw
    // cut: previously a reasoning-mode turn would silently fall through to
    // OpenHands or the local-direct path when OpenClaw was unreachable, which
    // surfaced hallucinated tool calls in the UI. Now reasoning mode errors
    // out exactly the same way openclaw-tools mode does.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "disconnected" },
          openclaw: "disconnected",
          nanoclaw: "disconnected",
          openhands: "connected",
          ollama: "connected",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        throw new Error("Chat must not POST when OpenClaw is disconnected (reasoning mode)");
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain("OpenClaw is not reachable");
    });
  });

  it("clears the stale OpenClaw unreachable error after a later health refresh succeeds", async () => {
    const scheduledIntervals: Array<() => Promise<void> | void> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: TimerHandler) => {
      scheduledIntervals.push(callback as () => Promise<void> | void);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    let healthProbeCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        healthProbeCount += 1;
        if (healthProbeCount <= 2) {
          return Response.json({
            agent: { type: "openclaw", status: "disconnected" },
            openclaw: "disconnected",
            nanoclaw: "disconnected",
            openhands: "connected",
            ollama: "connected",
            ollamaModels: ["gemma4:latest"],
            configuredLocalModel: "gemma4",
            llmProvider: "local",
          });
        }

        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          ollama: "connected",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          llmProvider: "local",
        });
      }

      if (url === "/api/chat/thread?project=alpha-project") {
        return Response.json({
          version: 1,
          project: "alpha-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/workspace?action=tree&projectId=alpha-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        throw new Error("Chat should not POST when OpenClaw is disconnected");
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha-project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain("OpenClaw is not reachable");
    });

    await act(async () => {
      for (const callback of scheduledIntervals) {
        await callback?.();
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toBe("");
    });
    expect(healthProbeCount).toBeGreaterThanOrEqual(2);
  });

  it("polls by conversationId when the project slug is invalid but OpenClaw history exists", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.alpha%20project",
      JSON.stringify({
        version: 1,
        conversationId: "conv-openclaw",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            content: "Persisted answer",
            timestamp: "2026-04-15T02:00:00.000Z",
          },
        ],
      }),
    );

    const scheduledIntervals: Array<() => Promise<void> | void> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: TimerHandler) => {
      scheduledIntervals.push(callback as () => Promise<void> | void);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/chat/thread?project=alpha%20project") {
        return Response.json({
          version: 1,
          project: "alpha project",
          conversationId: "conv-openclaw",
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified?action=poll&since=2026-04-15T02%3A00%3A00.000Z&conversationId=conv-openclaw") {
        return Response.json({ messages: [], backend: "openclaw" });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ChatHarness projectName="alpha project" />);

    await waitFor(() => {
      expect(screen.getByTestId("backend").textContent).toBe("openclaw");
    });

    await act(async () => {
      for (const callback of scheduledIntervals) {
        await callback?.();
      }
    });

    const pollCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("/api/chat/unified?action=poll"),
    );
    expect(pollCalls).toHaveLength(1);
    expect(String(pollCalls[0]?.[0])).toBe(
      "/api/chat/unified?action=poll&since=2026-04-15T02%3A00%3A00.000Z&conversationId=conv-openclaw",
    );
  });
});
