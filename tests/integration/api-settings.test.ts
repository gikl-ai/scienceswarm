import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/settings/route";
import { TEST_TELEGRAM_BOT_TOKEN } from "../helpers/telegram-fixtures";

const ORIGINAL_STRICT_LOCAL_ONLY = process.env.SCIENCESWARM_STRICT_LOCAL_ONLY;
const ORIGINAL_LLM_PROVIDER = process.env.LLM_PROVIDER;
const mockListPendingTelegramPairingRequests = vi.hoisted(() => vi.fn());
const mockSelectLatestPendingTelegramPairing = vi.hoisted(() => vi.fn());

const mockLocalHealth = vi.fn().mockResolvedValue({
  running: true,
  models: [],
  url: "http://localhost:11434",
});
const DEFAULT_OLLAMA_INSTALL_STATUS = {
  hostPlatform: "darwin" as const,
  hostArchitecture: "x86_64" as const,
  binaryInstalled: true,
  binaryPath: "/usr/local/bin/ollama",
  binaryVersion: "0.7.0",
  binaryArchitecture: "x86_64" as const,
  binaryCompatible: true,
  reinstallRecommended: false,
  preferredInstaller: "homebrew" as const,
  installCommand: "brew install ollama",
  installHint: "Install Ollama with Homebrew on macOS.",
  installUrl: "https://ollama.com/download",
  serviceManager: "brew" as const,
  startCommand: "brew services start ollama",
  stopCommand: "brew services stop ollama",
};
const mockGetOllamaInstallStatus = vi.fn().mockResolvedValue(DEFAULT_OLLAMA_INSTALL_STATUS);

vi.mock("@/lib/local-llm", () => ({
  healthCheck: () => mockLocalHealth(),
}));

vi.mock("@/lib/ollama-install", () => ({
  getOllamaInstallStatus: () => mockGetOllamaInstallStatus(),
}));

vi.mock("@/lib/openclaw/telegram-link", () => ({
  listPendingTelegramPairingRequests: mockListPendingTelegramPairingRequests,
  selectLatestPendingTelegramPairing: mockSelectLatestPendingTelegramPairing,
}));

// Stub fs so we don't touch the real .env
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue("OPENAI_API_KEY=sk-test1234567890abcdef\nLLM_MODEL=gpt-4.1\nAGENT_BACKEND=none\n"),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

const mockSpawn = vi.fn();

// Stub child_process so the start/stop ollama tests don't actually fire
// `brew services start ollama`, `nohup ollama serve`, or `pkill` against the
// developer's or CI machine. Both exec and execFile are exercised by the
// route — exec for fire-and-forget commands, execFile by hasCmd("which …")
// and via promisify for the openclaw config writer. execFile has multiple
// overloads (cmd+cb / cmd+args+cb / cmd+args+opts+cb), so the mock pulls the
// callback off the last argument and handles all three.
vi.mock("node:child_process", () => ({
  exec: vi.fn((_cmd: string, cb?: (err: null) => void) => {
    if (cb) cb(null);
  }),
  execFile: vi.fn((..._args: unknown[]) => {
    const cb = _args[_args.length - 1];
    if (typeof cb === "function") {
      (cb as (err: null, stdout: string, stderr: string) => void)(null, "", "");
    }
  }),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock the shared local-guard module
const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

function localRequest(
  method: string,
  body?: Record<string, unknown>,
): Request {
  const url = "http://localhost:3000/api/settings";
  if (method === "GET") {
    return new Request(url);
  }
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/settings", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test1234567890abcdef");
    mockIsLocal.mockResolvedValue(true);
    mockListPendingTelegramPairingRequests.mockReset();
    mockSelectLatestPendingTelegramPairing.mockReset();
  });

  it("returns settings with masked keys for local requests", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("agent");
    expect(body).toHaveProperty("openaiKey");
    expect(body).toHaveProperty("llmModel");
    expect(body).toHaveProperty("telegram");
    expect(body).toHaveProperty("slack");
    // Key should be masked
    expect(body.openaiKey).not.toBe("sk-test1234567890abcdef");
    expect(body.openaiKey).toMatch(/\.\.\./);
    expect(body.strictLocalOnly).toBe(false);
  });

  it("rejects non-local requests with 403", async () => {
    mockIsLocal.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("prefers system env over the .env file for strict local-only mode", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    vi.stubEnv("LLM_PROVIDER", "openai");

    const fs = await import("node:fs/promises");
    const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockResolvedValueOnce(
      "SCIENCESWARM_STRICT_LOCAL_ONLY=0\nLLM_PROVIDER=openai\nAGENT_BACKEND=none\n",
    );

    const res = await GET();
    const body = await res.json();

    expect(body.strictLocalOnly).toBe(true);
    expect(body.llmProvider).toBe("local");
  });

  it("prefers saved .env llm settings over stale process env values", async () => {
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.stubEnv("LLM_MODEL", "gpt-4.1");

    const fs = await import("node:fs/promises");
    const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockResolvedValueOnce(
      [
        "OPENAI_API_KEY=sk-test1234567890abcdef",
        "LLM_PROVIDER=openai",
        "LLM_MODEL=gpt-5.4",
        "OLLAMA_MODEL=gemma4:26b",
        "AGENT_BACKEND=none",
      ].join("\n"),
    );

    const res = await GET();
    const body = await res.json();

    expect(body.llmProvider).toBe("openai");
    expect(body.llmModel).toBe("gpt-5.4");
    expect(body.ollamaModel).toBe("gemma4:26b");
  });

  it("applies the saved default Ollama model fallback when no explicit model is set", async () => {
    const fs = await import("node:fs/promises");
    const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockResolvedValueOnce(
      [
        "OPENAI_API_KEY=sk-test1234567890abcdef",
        "SCIENCESWARM_DEFAULT_OLLAMA_MODEL=gemma4:e2b",
        "AGENT_BACKEND=none",
      ].join("\n"),
    );

    const res = await GET();
    const body = await res.json();

    expect(body.ollamaModel).toBe("gemma4:e2b");
  });

  it("skips pending Telegram pairing lookup when the Telegram user is already paired", async () => {
    const fs = await import("node:fs/promises");
    const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockResolvedValueOnce(
      [
        "AGENT_BACKEND=none",
        `TELEGRAM_BOT_TOKEN=${TEST_TELEGRAM_BOT_TOKEN}`,
        "TELEGRAM_USER_ID=8325267942",
        "TELEGRAM_BOT_USERNAME=mistbun_test_bot",
      ].join("\n"),
    );

    const res = await GET();
    const body = await res.json();

    expect(body.telegram).toMatchObject({
      configured: true,
      paired: true,
      userId: "8325267942",
      pendingPairing: null,
    });
    expect(mockListPendingTelegramPairingRequests).not.toHaveBeenCalled();
    expect(mockSelectLatestPendingTelegramPairing).not.toHaveBeenCalled();
  });

  it("returns the latest pending Telegram pairing when the bot is configured but not paired", async () => {
    const fs = await import("node:fs/promises");
    const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockResolvedValueOnce(
      [
        "AGENT_BACKEND=none",
        `TELEGRAM_BOT_TOKEN=${TEST_TELEGRAM_BOT_TOKEN}`,
        "TELEGRAM_BOT_USERNAME=mistbun_test_bot",
      ].join("\n"),
    );
    const pendingPairing = {
      id: "8325267942",
      meta: {
        username: "polarbear55555",
        firstName: "Alice",
        lastName: "Yamamoto",
      },
      createdAt: "2026-04-20T18:00:00.000Z",
      lastSeenAt: "2026-04-20T18:01:00.000Z",
    };
    mockListPendingTelegramPairingRequests.mockResolvedValueOnce([pendingPairing]);
    mockSelectLatestPendingTelegramPairing.mockReturnValueOnce(pendingPairing);

    const res = await GET();
    const body = await res.json();

    expect(body.telegram).toMatchObject({
      configured: true,
      paired: false,
      pendingPairing: {
        userId: "8325267942",
        username: "polarbear55555",
        firstName: "Alice",
        lastName: "Yamamoto",
        createdAt: "2026-04-20T18:00:00.000Z",
        lastSeenAt: "2026-04-20T18:01:00.000Z",
      },
    });
    expect(mockListPendingTelegramPairingRequests).toHaveBeenCalledTimes(1);
    expect(mockSelectLatestPendingTelegramPairing).toHaveBeenCalledWith([pendingPairing]);
  });

  it("falls back to null pending Telegram pairing when the lookup times out", async () => {
    const fs = await import("node:fs/promises");
    const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockResolvedValueOnce(
      [
        "AGENT_BACKEND=none",
        `TELEGRAM_BOT_TOKEN=${TEST_TELEGRAM_BOT_TOKEN}`,
        "TELEGRAM_BOT_USERNAME=mistbun_test_bot",
      ].join("\n"),
    );
    mockListPendingTelegramPairingRequests.mockResolvedValueOnce([]);

    const res = await GET();
    const body = await res.json();

    expect(body.telegram).toMatchObject({
      configured: true,
      paired: false,
      pendingPairing: null,
    });
    expect(mockListPendingTelegramPairingRequests).toHaveBeenCalledWith({ timeoutMs: 500 });
  });
});

describe("POST /api/settings", () => {
  beforeEach(async () => {
    mockIsLocal.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unreachable")));
    mockLocalHealth.mockResolvedValue({
      running: true,
      models: [],
      url: "http://localhost:11434",
    });
    mockGetOllamaInstallStatus.mockReset();
    mockGetOllamaInstallStatus.mockResolvedValue({ ...DEFAULT_OLLAMA_INSTALL_STATUS });
    mockSpawn.mockReset();
    const { exec, execFile } = await import("node:child_process");
    vi.mocked(exec).mockClear();
    vi.mocked(execFile).mockClear();
  });

  it("rejects missing action", async () => {
    const res = await POST(localRequest("POST", {}));
    expect(res.status).toBe(400);
  });

  it("rejects unknown action", async () => {
    const res = await POST(localRequest("POST", { action: "nope" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unknown action");
  });

  it("save-key requires key field", async () => {
    const res = await POST(localRequest("POST", { action: "save-key" }));
    expect(res.status).toBe(400);
  });

  it("save-key succeeds with key", async () => {
    const res = await POST(
      localRequest("POST", { action: "save-key", key: "sk-newkey123" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.masked).toMatch(/\.\.\./);
  });

  it("save-agent accepts any non-empty agent name", async () => {
    const empty = await POST(
      localRequest("POST", { action: "save-agent", agent: "" }),
    );
    expect(empty.status).toBe(400);

    const good = await POST(
      localRequest("POST", { action: "save-agent", agent: "nanoclaw" }),
    );
    expect(good.status).toBe(200);
    const body = await good.json();
    expect(body.ok).toBe(true);

    // Future agents work too
    const hermes = await POST(
      localRequest("POST", { action: "save-agent", agent: "hermes" }),
    );
    expect(hermes.status).toBe(200);
  });

  it("save-model requires model field", async () => {
    const res = await POST(localRequest("POST", { action: "save-model" }));
    expect(res.status).toBe(400);
  });

  it("save-model succeeds", async () => {
    const res = await POST(
      localRequest("POST", { action: "save-model", model: "gpt-5.4" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.model).toBe("gpt-5.4");
  });

  it("save-model rejects unsupported models", async () => {
    const res = await POST(
      localRequest("POST", { action: "save-model", model: "gpt-4.1" }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Unsupported OpenAI model",
    });
  });

  it("ollama-library returns sanitized official models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        expect(url).toBe("https://ollama.com/api/tags");
        return Response.json({
          models: [
            { name: "gemma4", size: 5 * 1024 ** 3 },
            { name: "invalid-size", size: 0 },
            { name: "qwen3:4b", size: 3 * 1024 ** 3 },
            { name: "gemma4", size: 99 },
            { name: "", size: 123 },
          ],
        });
      }),
    );

    const res = await POST(localRequest("POST", { action: "ollama-library" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      models: [
        { name: "qwen3:4b", size: 3 * 1024 ** 3 },
        { name: "gemma4", size: 5 * 1024 ** 3 },
      ],
    });
  });

  it("health action returns service statuses", async () => {
    const res = await POST(localRequest("POST", { action: "health" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("openhands");
    expect(body).toHaveProperty("openclaw");
    expect(body).toHaveProperty("openai");
    expect(body).toHaveProperty("agent");
  });

  it("health action disables remote checks in strict local-only mode", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-test1234567890abcdef");

    const res = await POST(localRequest("POST", { action: "health" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.strictLocalOnly).toBe(true);
    expect(body.llmProvider).toBe("local");
    expect(body.openai).toBe("disabled");
    expect(body.openhands).toBe("disconnected");
  });

  it("health action treats OpenHands 404 as disconnected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));

    const res = await POST(localRequest("POST", { action: "health" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openhands).toBe("disconnected");
  });

  it("save-telegram requires botToken", async () => {
    const res = await POST(
      localRequest("POST", { action: "save-telegram" }),
    );
    expect(res.status).toBe(400);
  });

  it("save-slack requires both tokens", async () => {
    const res = await POST(
      localRequest("POST", { action: "save-slack", botToken: "xoxb-123" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-local POST requests", async () => {
    mockIsLocal.mockResolvedValue(false);
    const res = await POST(
      new Request("http://example.com/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "health" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("save-strict-local-only persists the mode and forces the local provider", async () => {
    const res = await POST(
      localRequest("POST", { action: "save-strict-local-only", enabled: true }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      strictLocalOnly: true,
      llmProvider: "local",
    });
    expect(process.env.SCIENCESWARM_STRICT_LOCAL_ONLY).toBe("1");
    expect(process.env.LLM_PROVIDER).toBe("local");
  });

  it("blocks switching away from the local provider while strict local-only mode is enabled", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");

    const res = await POST(
      localRequest("POST", { action: "save-provider", provider: "openai" }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Strict local-only mode requires LLM_PROVIDER=local");
  });

  it("blocks OpenAI key validation while strict local-only mode is enabled", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");

    const res = await POST(
      localRequest("POST", { action: "test-key", key: "sk-test1234567890abcdef" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      valid: false,
      error: "Strict local-only mode is enabled. OpenAI validation is disabled.",
    });
  });

  it("blocks remote agent probing while strict local-only mode is enabled", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");

    const res = await POST(
      localRequest("POST", {
        action: "test-agent",
        agent: "openclaw",
        agentUrl: "http://localhost:19002",
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "Strict local-only mode is enabled. Remote agent probing is disabled.",
    });
  });

  it("start-ollama returns ok for local requests", async () => {
    const res = await POST(localRequest("POST", { action: "start-ollama" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("start-ollama falls back to direct serve when the service manager command fails", async () => {
    const { exec } = await import("node:child_process");
    vi.mocked(exec).mockImplementationOnce(((
      ...args: unknown[]
    ) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        (cb as (err: Error | null) => void)(new Error("brew start failed"));
      }
      return {} as never;
    }) as unknown as typeof exec);

    mockSpawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void; once: typeof EventEmitter.prototype.once };
      child.unref = vi.fn();
      return child;
    });

    const res = await POST(localRequest("POST", { action: "start-ollama" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/ollama/),
      ["serve"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });

  it("start-ollama returns ok:false when the ollama binary is missing", async () => {
    mockGetOllamaInstallStatus.mockResolvedValueOnce({
      ...DEFAULT_OLLAMA_INSTALL_STATUS,
      binaryInstalled: false,
      binaryPath: null,
      binaryVersion: null,
      binaryArchitecture: null,
      startCommand: null,
      stopCommand: null,
    });

    const res = await POST(localRequest("POST", { action: "start-ollama" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not installed");
  });

  it("stop-ollama returns ok for local requests", async () => {
    const res = await POST(localRequest("POST", { action: "stop-ollama" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("stop-ollama falls back to pkill when the service manager command fails", async () => {
    const { exec } = await import("node:child_process");
    vi.mocked(exec)
      .mockImplementationOnce(((
        ...args: unknown[]
      ) => {
        const cb = args[args.length - 1];
        if (typeof cb === "function") {
          (cb as (err: Error | null) => void)(new Error("brew stop failed"));
        }
        return {} as never;
      }) as unknown as typeof exec);

    const res = await POST(localRequest("POST", { action: "stop-ollama" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(vi.mocked(exec)).toHaveBeenNthCalledWith(
      2,
      "pkill -f 'ollama serve'",
      expect.any(Function),
    );
  });

  it("start-ollama rejects non-local requests with 403", async () => {
    mockIsLocal.mockResolvedValue(false);
    const res = await POST(
      new Request("http://example.com/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start-ollama" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("stop-ollama rejects non-local requests with 403", async () => {
    mockIsLocal.mockResolvedValue(false);
    const res = await POST(
      new Request("http://example.com/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop-ollama" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("pull-model sanitizes spawn failures instead of returning the raw exception", async () => {
    mockSpawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid?: number;
        unref: () => void;
      };
      child.pid = 1234;
      child.unref = vi.fn();
      queueMicrotask(() => {
        child.emit("error", new Error("socket hang up while starting ollama pull"));
      });
      return child;
    });

    const res = await POST(
      localRequest("POST", { action: "pull-model", ollamaModel: "gemma4" }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "Failed to start model pull",
    });
  });

  it("does not treat gemma4:26b as already present for a bare gemma4 pull request", async () => {
    mockLocalHealth.mockResolvedValueOnce({
      running: true,
      models: ["gemma4:26b"],
      url: "http://localhost:11434",
    });

    mockSpawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid?: number;
        unref: () => void;
      };
      child.pid = process.pid;
      child.unref = vi.fn();
      queueMicrotask(() => {
        child.emit("spawn");
      });
      return child;
    });

    const pullRes = await POST(
      localRequest("POST", { action: "pull-model", ollamaModel: "gemma4" }),
    );

    expect(pullRes.status).toBe(200);
    await expect(pullRes.json()).resolves.toEqual({
      ok: true,
      model: "gemma4",
      pulling: true,
    });
    expect(mockSpawn).toHaveBeenCalled();
  });
});

afterEach(() => {
  if (ORIGINAL_STRICT_LOCAL_ONLY === undefined) {
    delete process.env.SCIENCESWARM_STRICT_LOCAL_ONLY;
  } else {
    process.env.SCIENCESWARM_STRICT_LOCAL_ONLY = ORIGINAL_STRICT_LOCAL_ONLY;
  }
  if (ORIGINAL_LLM_PROVIDER === undefined) {
    delete process.env.LLM_PROVIDER;
  } else {
    process.env.LLM_PROVIDER = ORIGINAL_LLM_PROVIDER;
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/settings env read", () => {
  it("surfaces AGENT_BACKEND and LLM_MODEL from .env", async () => {
    const fs = await import("node:fs/promises");
    const readFileMock = fs.readFile as unknown as ReturnType<typeof vi.fn>;
    readFileMock.mockImplementation((path: string) => {
      if (typeof path === "string" && path.endsWith("/.env")) {
        return Promise.resolve("AGENT_BACKEND=nanoclaw\nLLM_MODEL=gpt-4o\n");
      }
      return Promise.reject(new Error("ENOENT"));
    });
    mockIsLocal.mockResolvedValue(true);

    const res = await GET();
    const body = await res.json();
    expect(body.agent).toBe("nanoclaw");
    expect(body.llmModel).toBe("gpt-4o");

    readFileMock.mockResolvedValue(
      "OPENAI_API_KEY=sk-test1234567890abcdef\nLLM_MODEL=gpt-4.1\nAGENT_BACKEND=none\n",
    );
  });
});
