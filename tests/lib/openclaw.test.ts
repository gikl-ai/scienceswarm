import path from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  execFileMock,
  execFileSyncMock,
  sendMessageViaGatewayMock,
  sendChatViaGatewayMock,
  isGatewayConnectedMock,
  MockGatewayPostAckError,
  mockIsGatewayPostAckError,
} = vi.hoisted(() => {
  // Hoisted post-ACK sentinel mirrors the real export. The mocked module
  // below re-exports these so `isGatewayPostAckError(err)` keeps working in
  // the openclaw.ts caller after the WS path fails.
  class _MockGatewayPostAckError extends Error {
    readonly code = "GATEWAY_POST_ACK_FAILURE" as const;
    readonly sessionKey: string;
    constructor(sessionKey: string, message: string, options?: { cause?: unknown }) {
      super(message, options);
      this.name = "GatewayPostAckError";
      this.sessionKey = sessionKey;
    }
  }
  return {
    execFileMock: vi.fn(),
    execFileSyncMock: vi.fn(),
    sendMessageViaGatewayMock: vi.fn(),
    sendChatViaGatewayMock: vi.fn(),
    isGatewayConnectedMock: vi.fn(() => false),
    MockGatewayPostAckError: _MockGatewayPostAckError,
    mockIsGatewayPostAckError: (err: unknown): err is InstanceType<typeof _MockGatewayPostAckError> =>
      err instanceof _MockGatewayPostAckError,
  };
});

vi.mock("child_process", () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

// Force the WS gateway path to fail in unit tests so sendAgentMessage falls
// back to the CLI assertions below. Without this, sendAgentMessage with a
// `session` would try to read the local OpenClaw config + open a WS to the
// real local gateway on the dev machine.
vi.mock("@/lib/openclaw/gateway-ws-client", () => ({
  sendMessageViaGateway: sendMessageViaGatewayMock,
  sendChatViaGateway: sendChatViaGatewayMock,
  isGatewayConnected: isGatewayConnectedMock,
  GatewayPostAckError: MockGatewayPostAckError,
  isGatewayPostAckError: mockIsGatewayPostAckError,
}));

import {
  gatewayHealthCheck,
  getConversationMessagesSince,
  healthCheck,
  sendAgentMessage,
  sendOpenClawChatMessage,
} from "@/lib/openclaw";

function mockExecFile(stdout: unknown, stderr = "") {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("expected callback");
    callback(null, { stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr });
  });
}

function mockExecFileError(stderr: string, stdout = "") {
  execFileMock.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("expected callback");
    const err = Object.assign(new Error(stderr), {
      code: 1,
      stderr,
      stdout,
    });
    callback(err);
  });
}

describe("OpenClaw healthCheck", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    sendMessageViaGatewayMock.mockReset();
    sendChatViaGatewayMock.mockReset();
    isGatewayConnectedMock.mockReset();
    isGatewayConnectedMock.mockReturnValue(false);
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

  it("reports connected when status probes fail but embedded turns are ready", async () => {
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
        callback(new Error("health unavailable"));
      })
      .mockImplementationOnce((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback !== "function") throw new Error("expected callback");
        callback(null, {
          stdout: JSON.stringify({
            resolvedDefault: "ollama/gemma4:latest",
            auth: { missingProvidersInUse: [] },
          }),
          stderr: "",
        });
      });

    await expect(healthCheck()).resolves.toEqual({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 0,
      sessions: 0,
    });
  });

  it("accepts prefixed JSON noise in the embedded-turn readiness probe", async () => {
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
        callback(new Error("health unavailable"));
      })
      .mockImplementationOnce((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback !== "function") throw new Error("expected callback");
        callback(null, {
          stdout: [
            "[agents/auth-profiles] synced openai-codex credentials from external cli",
            JSON.stringify({
              resolvedDefault: "ollama/gemma4:latest",
              auth: { missingProvidersInUse: [] },
            }),
          ].join("\n"),
          stderr: "",
        });
      });

    await expect(healthCheck()).resolves.toEqual({
      status: "connected",
      gateway: "ws://127.0.0.1:19002",
      channels: [],
      agents: 0,
      sessions: 0,
    });
  });
});

describe("OpenClaw gatewayHealthCheck", () => {
  const originalFetch = globalThis.fetch;
  let tempRoot = "";

  beforeEach(() => {
    vi.unstubAllEnvs();
    tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-gateway-health-"));
    vi.stubEnv("SCIENCESWARM_DIR", tempRoot);
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    isGatewayConnectedMock.mockReset();
    isGatewayConnectedMock.mockReturnValue(false);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeGatewayToken(): void {
    const configPath = path.join(tempRoot, "openclaw", "openclaw.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ gateway: { auth: { token: "test-token" } } }),
      "utf8",
    );
  }

  it("reports connected from the gateway health endpoint without invoking the CLI", async () => {
    writeGatewayToken();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await expect(gatewayHealthCheck()).resolves.toEqual({
      status: "connected",
      gateway: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("reports disconnected when the gateway is reachable but auth config is missing", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await expect(gatewayHealthCheck()).resolves.toEqual({
      status: "disconnected",
      gateway: "",
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("reports disconnected when an active WebSocket exists but auth config is missing", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    isGatewayConnectedMock.mockReturnValue(true);

    await expect(gatewayHealthCheck()).resolves.toEqual({
      status: "disconnected",
      gateway: "",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("reports connected from an authenticated gateway WebSocket without probing HTTP", async () => {
    writeGatewayToken();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    isGatewayConnectedMock.mockReturnValue(true);

    await expect(gatewayHealthCheck()).resolves.toEqual({
      status: "connected",
      gateway: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not hide runtime failures from the authenticated gateway check", async () => {
    writeGatewayToken();
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    isGatewayConnectedMock.mockImplementation(() => {
      throw new Error("gateway auth state unavailable");
    });

    await expect(gatewayHealthCheck()).rejects.toThrow(
      "gateway auth state unavailable",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reports disconnected when the gateway health endpoint is unavailable", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 503 }));

    await expect(gatewayHealthCheck()).resolves.toEqual({
      status: "disconnected",
      gateway: "",
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("sendAgentMessage output sanitization", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    sendMessageViaGatewayMock.mockReset();
    sendChatViaGatewayMock.mockReset();
    // Force the WS gateway to fail so sendAgentMessage falls back to the
    // CLI path the assertions below exercise.
    sendMessageViaGatewayMock.mockRejectedValue(
      new Error("mocked: gateway unavailable"),
    );
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
    expect(sendMessageViaGatewayMock).not.toHaveBeenCalled();
    expect(options?.cwd).toBe(`${root}/projects/project-alpha`);
    expect(options?.env?.OPENCLAW_STATE_DIR).toBe(`${root}/openclaw`);
    expect(options?.env?.OPENCLAW_CONFIG_PATH).toBe(`${root}/openclaw/openclaw.json`);
  });

  it("uses chat.send for web chat sessions even when cwd is provided, and records session cwd metadata", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "scienceswarm-openclaw-web-session-"),
    );
    vi.stubEnv("SCIENCESWARM_DIR", root);
    sendChatViaGatewayMock.mockReset();
    sendChatViaGatewayMock.mockResolvedValueOnce({
      text: "ws web ok",
      events: [],
      runId: "run-alpha",
    });

    await expect(
      sendAgentMessage("Explain", {
        session: "web:test:gateway-web",
        channel: "web",
        cwd: path.join(root, "projects", "project-alpha"),
      }),
    ).resolves.toBe("ws web ok");

    expect(sendChatViaGatewayMock).toHaveBeenCalledWith(
      "web:test:gateway-web",
      "Explain",
      expect.objectContaining({
        timeoutMs: 600_000,
        deliver: false,
      }),
    );
    expect(sendMessageViaGatewayMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(
      readFileSync(
        path.join(
          root,
          "openclaw",
          "agents",
          "main",
          "sessions",
          "web:test:gateway-web.jsonl",
        ),
        "utf8",
      ),
    ).toContain(
      JSON.stringify({
        type: "session",
        id: "web:test:gateway-web",
        cwd: path.join(root, "projects", "project-alpha"),
      }),
    );
  });

  it("deduplicates concurrent web session metadata writes for the same session", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "scienceswarm-openclaw-web-dedupe-"),
    );
    vi.stubEnv("SCIENCESWARM_DIR", root);
    sendChatViaGatewayMock.mockReset();
    sendChatViaGatewayMock.mockImplementation(async () => ({
      text: "ws web ok",
      events: [],
      runId: "run-alpha",
    }));

    await Promise.all([
      sendAgentMessage("Explain", {
        session: "web:test:dedupe",
        channel: "web",
        cwd: path.join(root, "projects", "project-alpha"),
      }),
      sendAgentMessage("Explain again", {
        session: "web:test:dedupe",
        channel: "web",
        cwd: path.join(root, "projects", "project-alpha"),
      }),
    ]);

    const sessionFile = path.join(
      root,
      "openclaw",
      "agents",
      "main",
      "sessions",
      "web:test:dedupe.jsonl",
    );
    const sessionLines = readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .filter((line) => JSON.parse(line).type === "session");

    expect(sessionLines).toHaveLength(1);
  });

  it("skips local session-log writes for invalid session ids", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "scienceswarm-openclaw-invalid-session-"),
    );
    vi.stubEnv("SCIENCESWARM_DIR", root);
    sendChatViaGatewayMock.mockReset();
    sendChatViaGatewayMock.mockResolvedValue({
      text: "ws web ok",
      events: [],
      runId: "run-alpha",
    });

    for (const session of ["../escape", "web:test/../../escape", "web:test\\escape"]) {
      await expect(
        sendAgentMessage("Explain", {
          session,
          channel: "web",
          cwd: path.join(root, "projects", "project-alpha"),
        }),
      ).resolves.toBe("ws web ok");
    }

    expect(
      existsSync(
        path.join(root, "openclaw", "agents", "main", "sessions"),
      ),
    ).toBe(false);
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

  it("does NOT fall back to the CLI when the gateway accepted the message but the turn failed (post-ACK)", async () => {
    // Regression for duplicate-delivery: if the gateway already received the
    // message (sessions.send ACKed) and only the turn-completion wait failed
    // (timeout, WS drop), running the CLI with the same --session-id would
    // deliver the user message twice. The post-ACK sentinel must propagate.
    sendMessageViaGatewayMock.mockReset();
    sendMessageViaGatewayMock.mockRejectedValueOnce(
      new MockGatewayPostAckError(
        "web:test:no-double-deliver",
        "OpenClaw gateway accepted the message but the turn timed out",
      ),
    );

    await expect(
      sendAgentMessage("Run a long task", {
        agent: "main",
        session: "web:test:no-double-deliver",
      }),
    ).rejects.toMatchObject({ name: "GatewayPostAckError" });

    // The CLI MUST NOT have been invoked; that's how duplicate delivery
    // would have happened.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("falls back to the CLI on a pre-ACK gateway failure (no duplicate delivery risk)", async () => {
    // Pre-ACK failures (connect/auth/send-rpc errors) mean the gateway never
    // received the message, so retrying via the CLI on the same session is
    // safe. Confirm the existing fallback still works for plain Errors.
    sendMessageViaGatewayMock.mockReset();
    sendMessageViaGatewayMock.mockRejectedValueOnce(
      new Error("mocked: gateway unreachable"),
    );
    mockExecFile("<channel|>fallback worked");

    await expect(
      sendAgentMessage("Hello", {
        agent: "main",
        session: "web:test:pre-ack-fallback",
      }),
    ).resolves.toBe("fallback worked");

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT fall back to the CLI on a pre-ACK gateway failure for web chat sessions", async () => {
    sendChatViaGatewayMock.mockReset();
    sendChatViaGatewayMock.mockRejectedValueOnce(
      new Error("mocked: gateway unreachable"),
    );

    await expect(
      sendAgentMessage("Hello", {
        session: "web:test:web-only-no-cli-fallback",
        channel: "web",
        cwd: "/tmp/project-alpha",
      }),
    ).rejects.toThrow("gateway unreachable");

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("exposes a strict OpenClaw web-chat sender that bypasses legacy sessions.send", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "scienceswarm-openclaw-strict-chat-"),
    );
    vi.stubEnv("SCIENCESWARM_DIR", root);
    sendChatViaGatewayMock.mockReset();
    sendChatViaGatewayMock.mockResolvedValueOnce({
      text: "strict ok",
      events: [],
      runId: "run-alpha",
    });

    await expect(
      sendOpenClawChatMessage("Hello", {
        session: "web:test:strict-chat",
        cwd: path.join(root, "projects", "project-alpha"),
        onEvent: vi.fn(),
      }),
    ).resolves.toBe("strict ok");

    expect(sendChatViaGatewayMock).toHaveBeenCalledWith(
      "web:test:strict-chat",
      "Hello",
      expect.objectContaining({
        deliver: false,
        timeoutMs: 600_000,
      }),
    );
    expect(sendMessageViaGatewayMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("waits and retries transient session-file locks on the CLI path", async () => {
    vi.stubEnv("OPENCLAW_SESSION_LOCK_RETRY_DELAY_MS", "0");
    mockExecFileError(
      "FailoverError: session file locked (timeout 10000ms): pid=38781 /tmp/openclaw/sessions/web-alpha.jsonl.lock",
    );
    mockExecFile("<channel|>analysis saved");

    await expect(
      sendAgentMessage("Save the analysis", {
        session: "web-alpha",
        cwd: "/tmp/project-alpha",
      }),
    ).resolves.toBe("analysis saved");

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe("OpenClaw conversation polling", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    sendMessageViaGatewayMock.mockReset();
    sendChatViaGatewayMock.mockReset();
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

  it("falls back to the durable session log when CLI history is unavailable", async () => {
    const scienceswarmDir = mkdtempSync(
      path.join(tmpdir(), "scienceswarm-openclaw-history-"),
    );
    vi.stubEnv("SCIENCESWARM_DIR", scienceswarmDir);

    const sessionId = "web-alpha-project-session-1";
    const sessionFile = path.join(
      scienceswarmDir,
      "openclaw",
      "agents",
      "main",
      "sessions",
      `${sessionId}.jsonl`,
    );
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          id: sessionId,
          timestamp: "2026-04-15T05:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          timestamp: "2026-04-15T05:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Run the experiment." }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-thinking",
          timestamp: "2026-04-15T05:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Planning." }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-final",
          timestamp: "2026-04-15T05:00:03.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Finished. Saved reports/baseline_vs_variant_summary.md.",
              },
            ],
          },
        }),
      ].join("\n"),
    );

    await expect(
      getConversationMessagesSince(sessionId, "2026-04-15T05:00:00.500Z"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "assistant-final",
        channel: "web",
        content: "Finished. Saved reports/baseline_vs_variant_summary.md.",
      }),
    ]);

    rmSync(scienceswarmDir, { recursive: true, force: true });
  });
});
