import { afterEach, describe, expect, it, vi } from "vitest";

async function loadModule() {
  vi.resetModules();
  return import("@/lib/openhands");
}

describe("src/lib/openhands.ts", () => {
  afterEach(() => {
    // Every test here stubs global fetch (and some stub env vars).
    // Unstub both so the stubs cannot leak into tests that load
    // later in the suite and would otherwise inherit a vi.fn() as
    // their `fetch`. Identified by cubic on #338.
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("starts conversations against the configured OpenHands URL with a null initial_message", async () => {
    // OH 1.6: initial_message must be null in the start payload.
    // The user prompt is delivered separately via queuePendingMessage,
    // because OH 1.6 does not dispatch initial_message to the agent
    // loop in headless setups. See src/lib/openhands.ts comments.
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");
    vi.stubEnv("LLM_MODEL", "gpt-5.4-mini");

    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({ id: "task-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { startConversation } = await loadModule();
    const payload = await startConversation({
      message: "Run a repo audit",
      repository: "gikl-ai/scienceswarm",
    });

    expect(payload).toEqual({ id: "task-1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://openhands.test/api/v1/app-conversations");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      initial_message: null,
      selected_repository: "gikl-ai/scienceswarm",
      selected_branch: "main",
      git_provider: "github",
      llm_model: "gpt-5.4-mini",
    });
  });

  it("defaults to the local OpenHands model when LLM_PROVIDER=local", async () => {
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.stubEnv("OLLAMA_MODEL", "gemma4:latest");
    vi.stubEnv("OPENAI_API_KEY", "");

    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({ id: "task-2" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { startConversation } = await loadModule();
    await startConversation({ message: "Run a local task" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://openhands.test/api/v1/app-conversations");
    expect(JSON.parse(String(init.body))).toMatchObject({
      llm_model: "openai/gemma4:latest",
    });
  });

  it("keeps an explicit req.model override even in local mode", async () => {
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.stubEnv("OLLAMA_MODEL", "gemma4:latest");

    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({ id: "task-3" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { startConversation } = await loadModule();
    await startConversation({ message: "Override", model: "openai/qwen3:14b" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      llm_model: "openai/qwen3:14b",
    });
  });

  it("queues a pending message under the task-<hex> prefix", async () => {
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { queuePendingMessage } = await loadModule();
    await queuePendingMessage("fe6bdb1c701c4123a77552803603c522", "hello");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://openhands.test/api/v1/conversations/task-fe6bdb1c701c4123a77552803603c522/pending-messages",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("queues a pending message against an already-resolved conversation id without re-prefixing", async () => {
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { queuePendingMessage } = await loadModule();
    await queuePendingMessage(
      "2740bd76-294d-4054-a9d4-4dcfa67cd272",
      "follow-up",
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://openhands.test/api/v1/conversations/2740bd76-294d-4054-a9d4-4dcfa67cd272/pending-messages",
    );
  });

  it("getEvents uses the OH 1.6 sort_order enum (TIMESTAMP_DESC) by default", async () => {
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({ items: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getEvents } = await loadModule();
    await getEvents("conv-1");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "http://openhands.test/api/v1/conversation/conv-1/events/search?limit=50&sort_order=TIMESTAMP_DESC",
    );
  });

  it("getEvents unwraps the OH 1.6 `{items: [...]}` response into a plain array", async () => {
    // Prevents the OH 1.5 → 1.6 shape regression that silently broke
    // run-artifact, unified chat, and the /api/agent events proxy:
    // every consumer wants an array, so getEvents normalizes here.
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({
        items: [
          { id: "1", kind: "MessageEvent", source: "agent" },
          { id: "2", kind: "ObservationEvent", source: "environment" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getEvents } = await loadModule();
    const events = await getEvents("conv-1");

    expect(Array.isArray(events)).toBe(true);
    expect(events).toHaveLength(2);
    expect((events[0] as { id: string }).id).toBe("1");
  });

  it("getEvents still accepts the legacy OH 1.5 raw-array response", async () => {
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json([
        { id: "1", source: "agent", message: "hi" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getEvents } = await loadModule();
    const events = await getEvents("conv-1");

    expect(Array.isArray(events)).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("getEvents returns an empty array for unexpected response shapes", async () => {
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({ pagination: { next: null } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getEvents } = await loadModule();
    const events = await getEvents("conv-1");

    expect(events).toEqual([]);
  });

  it("surfaces upstream start failures with status and body text", async () => {
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("gateway timeout", { status: 504 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { startConversation } = await loadModule();

    await expect(startConversation({ message: "hi" })).rejects.toThrow(
      "OpenHands start failed: 504 gateway timeout",
    );
  });

  it("encodes file paths when reading a file", async () => {
    vi.stubEnv("OPENHANDS_URL", "http://openhands.test");

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("paper body", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { readFile } = await loadModule();
    const content = await readFile("conv-7", "/workspace/paper draft.tex");

    expect(content).toBe("paper body");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://openhands.test/api/v1/app-conversations/conv-7/file?file_path=%2Fworkspace%2Fpaper%20draft.tex",
    );
  });

  it("derives a websocket URL from the OpenHands base URL", async () => {
    vi.stubEnv("OPENHANDS_URL", "https://openhands.example");

    const { getWebSocketUrl } = await loadModule();

    expect(getWebSocketUrl("conv-9")).toBe(
      "wss://openhands.example?conversation_id=conv-9&latest_event_id=-1",
    );
  });
});
