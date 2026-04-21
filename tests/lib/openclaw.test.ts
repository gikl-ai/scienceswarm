import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import { getConversationMessagesSince, healthCheck, sendAgentMessage } from "@/lib/openclaw";

function mockExecFile(stdout: unknown, stderr = "") {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("expected callback");
    callback(null, { stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr });
  });
}

describe("OpenClaw healthCheck", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    // Prevent the HTTP fast path from hitting a real local gateway;
    // these tests exercise the CLI-based probes exclusively.
    globalThis.fetch = () => Promise.reject(new Error("mocked: no gateway"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses current OpenClaw status output", async () => {
    mockExecFile({
      gateway: { url: "ws://127.0.0.1:19002" },
      channelSummary: [
        "Slack: not configured",
        "Telegram: configured",
        "  - default (project-alpha-telegram) (token:tokenFile)",
      ],
      agents: { agents: [{ id: "main" }] },
      sessions: { count: 3 },
    });

    await expect(healthCheck()).resolves.toEqual({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: ["Telegram"],
      agents: 1,
      sessions: 3,
    });
  });

  it("continues to parse the legacy OpenClaw status output", async () => {
    mockExecFile({
      gateway: { url: "ws://127.0.0.1:18789" },
      channels: [
        { name: "Telegram", enabled: true },
        { name: "Slack", enabled: false },
      ],
      agents: { count: 2 },
      sessions: { active: 4 },
    });

    await expect(healthCheck()).resolves.toEqual({
      status: "connected",
      gateway: "ws://127.0.0.1:18789",
      channels: ["Telegram"],
      agents: 2,
      sessions: 4,
    });
  });

  it("prefers current fields when a mixed status shape is returned", async () => {
    mockExecFile({
      gateway: { url: "ws://127.0.0.1:19002" },
      channelSummary: ["Telegram: configured"],
      channels: [{ name: "Legacy", enabled: true }],
      agents: { count: 99, agents: [{ id: "main" }] },
      sessions: { active: 99, count: 3 },
    });

    await expect(healthCheck()).resolves.toMatchObject({
      channels: ["Telegram"],
      agents: 1,
      sessions: 3,
    });
  });

  it("does not report connected when OpenClaw status says the gateway is unreachable", async () => {
    mockExecFile({
      gateway: {
        url: "ws://127.0.0.1:18799",
        reachable: false,
        error: "gateway closed (1006)",
      },
      channelSummary: ["Telegram: configured"],
    });
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("expected callback");
      callback(new Error("health unavailable"));
    });

    await expect(healthCheck()).resolves.toMatchObject({
      status: "disconnected",
      gateway: "",
    });
  });

  it("treats the runtime as connected when embedded turns are ready even if gateway auth blocks the health probe", async () => {
    mockExecFile({
      gateway: {
        url: "ws://127.0.0.1:18799",
        reachable: false,
        error: "gateway closed (1008): unauthorized",
      },
      channelSummary: ["Telegram: configured"],
      agents: { agents: [{ id: "main" }] },
      sessions: { count: 2 },
    });
    mockExecFile({
      resolvedDefault: "ollama/gemma4:latest",
      auth: {
        missingProvidersInUse: [],
      },
    });

    await expect(healthCheck()).resolves.toEqual({
      status: "connected",
      gateway: "ws://127.0.0.1:18799",
      channels: ["Telegram"],
      agents: 1,
      sessions: 2,
    });
  });

  it("uses the configured gateway in the health fallback path", async () => {
    vi.stubEnv("OPENCLAW_URL", "ws://127.0.0.1:19002/ws");
    execFileMock
      .mockImplementationOnce((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback !== "function") throw new Error("expected callback");
        callback(new Error("status unavailable"));
      })
      .mockImplementationOnce((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback !== "function") throw new Error("expected callback");
        callback(null, { stdout: "gateway reachable", stderr: "" });
      });

    await expect(healthCheck()).resolves.toMatchObject({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
    });
  });
});

describe("sendAgentMessage output sanitization", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
  });

  it("returns only the user-facing tail after a channel marker", async () => {
    mockExecFile(
      [
        "Thought",
        "I should reason through this internally first.",
        "<channel|>hello",
      ].join("\n"),
    );

    await expect(
      sendAgentMessage("Reply with hello", {
        agent: "main",
        session: "web:test:sanitize",
      }),
    ).resolves.toBe("hello");
  });

  it("routes agent messages through the ScienceSwarm state-dir OpenClaw config", async () => {
    vi.stubEnv("SCIENCESWARM_DIR", "/tmp/scienceswarm-openclaw-test");
    mockExecFile("<channel|>state-dir ok");

    await expect(
      sendAgentMessage("Reply with hello", {
        agent: "main",
        session: "web:test:state-dir",
      }),
    ).resolves.toBe("state-dir ok");

    const execOptions = execFileMock.mock.calls[0]?.[2] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(execOptions?.env?.OPENCLAW_STATE_DIR).toBe(
      "/tmp/scienceswarm-openclaw-test/openclaw",
    );
    expect(execOptions?.env?.OPENCLAW_CONFIG_PATH).toBe(
      "/tmp/scienceswarm-openclaw-test/openclaw/openclaw.json",
    );
  });

  it("strips diagnostic lines and internal agent chatter from web-chat output", async () => {
    mockExecFile(
      [
        "Gateway agent failed; falling back to embedded: GatewayClientRequestError: boom",
        "[diagnostic] lane task error: lane=main durationMs=12 error=\"boom\"",
        "<channel|>I will use the coding-agent skill to write the chart.",
        "[diagnostic] lane task error: lane=main durationMs=13 error=\"boom\"",
        "This requires spawning a background agent process.",
        "The chart is ready at results/r3_chart.svg.",
        "⚠️ 🤖 Subagents: `agent:main:subagent:example` failed",
      ].join("\n"),
    );

    await expect(
      sendAgentMessage("Create a chart", {
        agent: "main",
        session: "web:test:sanitize",
      }),
    ).resolves.toBe("The chart is ready at results/r3_chart.svg.");
  });

  it("preserves literal user-facing angle-bracket syntax outside the internal marker allowlist", async () => {
    mockExecFile("Keep the literal syntax <user|> in the response.");

    await expect(
      sendAgentMessage("Explain", {
        agent: "main",
        session: "web:test:sanitize",
      }),
    ).resolves.toBe("Keep the literal syntax <user|> in the response.");
  });

  it("preserves user-facing lines that mention coding-agent outside the internal chatter shape", async () => {
    mockExecFile("I will use the coding-agent approach you described for parallel processing.");

    await expect(
      sendAgentMessage("Explain", {
        agent: "main",
        session: "web:test:sanitize",
      }),
    ).resolves.toBe(
      "I will use the coding-agent approach you described for parallel processing.",
    );
  });

  it("preserves user-facing lines that mention a background agent outside the internal chatter shape", async () => {
    mockExecFile("I will use a background agent to process your files.");

    await expect(
      sendAgentMessage("Explain", {
        agent: "main",
        session: "web:test:sanitize",
      }),
    ).resolves.toBe("I will use a background agent to process your files.");
  });

  it("preserves user-facing lines that mention a sub-agent outside the internal chatter shape", async () => {
    mockExecFile("I will use a sub-agent to process your files.");

    await expect(
      sendAgentMessage("Explain", {
        agent: "main",
        session: "web:test:sanitize",
      }),
    ).resolves.toBe("I will use a sub-agent to process your files.");
  });

  it("strips non-SGR ANSI control sequences while preserving visible text", async () => {
    mockExecFile(
      [
        "\u001B[2J",
        "\u001B]8;;https://example.com\u0007",
        "link",
        "\u001B]8;;\u0007",
        "\u001B[?25l",
      ].join(""),
    );

    await expect(
      sendAgentMessage("Explain", {
        agent: "main",
        session: "web:test:sanitize",
      }),
    ).resolves.toBe("link");
  });

  it("preserves normal multiline assistant text when there are no internal markers", async () => {
    mockExecFile("Line one.\nLine two.");

    await expect(
      sendAgentMessage("Explain", {
        agent: "main",
        session: "web:test:sanitize",
      }),
    ).resolves.toBe("Line one.\nLine two.");
  });

  it("keeps ScienceSwarm state-dir isolation for agent messages", async () => {
    const root = "/tmp/scienceswarm-openclaw-agent-test";
    vi.stubEnv("SCIENCESWARM_DIR", root);
    mockExecFile("ok");

    await expect(
      sendAgentMessage("Explain", {
        agent: "main",
        session: "web-test-state-dir",
        cwd: `${root}/projects/project-alpha`,
      }),
    ).resolves.toBe("ok");

    const options = execFileMock.mock.calls[0]?.[2] as
      | { cwd?: string; env?: NodeJS.ProcessEnv }
      | undefined;
    expect(options?.cwd).toBe(`${root}/projects/project-alpha`);
    expect(options?.env?.OPENCLAW_STATE_DIR).toBe(`${root}/openclaw`);
    expect(options?.env?.OPENCLAW_CONFIG_PATH).toBe(`${root}/openclaw/openclaw.json`);
  });

  it("falls back to pre-marker text when a trailing marker has no content", async () => {
    mockExecFile("The chart is ready at results/r3_chart.svg.\n<channel|>\n");

    await expect(
      sendAgentMessage("Explain", {
        agent: "main",
        session: "web:test:sanitize",
      }),
    ).resolves.toBe("The chart is ready at results/r3_chart.svg.");
  });

  it("falls back to the inter-marker content when the final marker is empty", async () => {
    mockExecFile("<assistant|>Here is the answer.\n<channel|>\n");

    await expect(
      sendAgentMessage("Explain", {
        agent: "main",
        session: "web:test:sanitize",
      }),
    ).resolves.toBe("Here is the answer.");
  });
});

describe("OpenClaw conversation polling", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
  });

  it("parses timestamps chronologically instead of relying on raw string order", async () => {
    mockExecFile([
      {
        id: "early",
        userId: "assistant",
        channel: "telegram",
        content: "First",
        timestamp: "2026-04-15T05:00:00Z",
        conversationId: "web:test:1",
      },
      {
        id: "later",
        userId: "assistant",
        channel: "telegram",
        content: "Second",
        timestamp: "2026-04-15T05:00:00.500Z",
        conversationId: "web:test:1",
      },
      {
        id: "invalid",
        userId: "assistant",
        channel: "telegram",
        content: "Skip me",
        timestamp: "not-a-date",
        conversationId: "web:test:1",
      },
    ]);

    await expect(
      getConversationMessagesSince("web:test:1", "2026-04-15T04:59:59.900Z"),
    ).resolves.toEqual([
      expect.objectContaining({ id: "early" }),
      expect.objectContaining({ id: "later" }),
    ]);
  });

  it("keeps assistant web completions while excluding duplicate web user prompts", async () => {
    mockExecFile([
      {
        id: "user-1",
        userId: "web-user",
        role: "user",
        channel: "web",
        content: "Please generate a chart",
        timestamp: "2026-04-15T05:00:00.000Z",
        conversationId: "web:test:1",
      },
      {
        id: "assistant-1",
        userId: "assistant",
        role: "assistant",
        channel: "web",
        content: "The chart is ready in results/r3-chart.svg.",
        timestamp: "2026-04-15T05:00:02.000Z",
        conversationId: "web:test:1",
      },
    ]);

    await expect(
      getConversationMessagesSince("web:test:1", "2026-04-15T04:59:59.900Z"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "assistant-1",
        channel: "web",
        content: "The chart is ready in results/r3-chart.svg.",
      }),
    ]);
  });
});
