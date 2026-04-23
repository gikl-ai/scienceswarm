import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
const mockHealthCheck = vi.fn(async () => ({
  status: "connected" as "connected" | "disconnected",
  gateway: "ws://127.0.0.1:18789",
  channels: [],
  agents: 0,
  sessions: 0,
}));
const mockExecFile = vi.fn();
const mockSpawn = vi.fn();

function connectedOpenClawStatus() {
  return {
    status: "connected" as const,
    gateway: "ws://127.0.0.1:18789",
    channels: [],
    agents: 0,
    sessions: 0,
  };
}

function disconnectedOpenClawStatus() {
  return {
    status: "disconnected" as const,
    gateway: "ws://127.0.0.1:18789",
    channels: [],
    agents: 0,
    sessions: 0,
  };
}

function mockGatewayStartsDisconnectedThenConnects() {
  mockHealthCheck
    .mockResolvedValueOnce(disconnectedOpenClawStatus())
    .mockResolvedValue(connectedOpenClawStatus());
}

/**
 * Fake ChildProcess that emits a clean exit on the next tick. `exitCode`
 * lets a test control what `gateway start` returned so we can exercise
 * the fallback to `gateway run --allow-unconfigured`.
 */
interface FakeChildOptions {
  pid?: number;
  exitCode?: number;
  autoExit?: boolean;
}

function makeFakeChild(opts: FakeChildOptions = {}): EventEmitter & {
  pid?: number;
  unref: () => void;
  kill: () => void;
} {
  const emitter = new EventEmitter() as EventEmitter & {
    pid?: number;
    unref: () => void;
    kill: () => void;
  };
  emitter.pid = opts.pid ?? 54321;
  emitter.unref = () => {};
  emitter.kill = () => {};
  if (opts.autoExit !== false) {
    setImmediate(() => {
      emitter.emit("exit", opts.exitCode ?? 0, null);
    });
  }
  return emitter;
}

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

vi.mock("@/lib/openclaw", () => ({
  healthCheck: () => mockHealthCheck(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("OPENAI_API_KEY=sk-test-openai\nLLM_MODEL=gpt-5.4\n"),
}));

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: (...args: unknown[]) => {
    void args;
    throw new Error("execFileSync is not mocked in this suite");
  },
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

function localRequest(body?: Record<string, unknown>): Request {
  return new Request("http://localhost/api/settings/openclaw", {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function installExecFileMock(options?: { model?: string | null; openclawInstalled?: boolean }) {
  const configuredModel = options?.model ?? "openai/gpt-5.4";
  const openclawInstalled = options?.openclawInstalled ?? true;

  mockExecFile.mockImplementation((file: string, maybeArgs: unknown, maybeOptions: unknown, maybeCb: unknown) => {
    const args = Array.isArray(maybeArgs) ? maybeArgs as string[] : [];
    const cb =
      typeof maybeOptions === "function"
        ? maybeOptions as (error: Error | null, stdout?: string, stderr?: string) => void
        : typeof maybeCb === "function"
          ? maybeCb as (error: Error | null, stdout?: string, stderr?: string) => void
          : null;

    if (!cb) return;

    if (file === "which" && args[0] === "openclaw") {
      if (openclawInstalled) {
        cb(null, "/usr/local/bin/openclaw\n", "");
      } else {
        cb(new Error("not found"), "", "");
      }
      return;
    }

    if (file === "which" && args[0] === "npm") {
      cb(null, "/usr/local/bin/npm\n", "");
      return;
    }

    if (file === "openclaw" && args[0] === "--version") {
      cb(null, "2026.4.5\n", "");
      return;
    }

    if (file === "openclaw" && args[0] === "config" && args[1] === "file") {
      cb(null, "~/.openclaw/openclaw.json\n", "");
      return;
    }

    if (file === "openclaw" && args[0] === "config" && args[1] === "get" && args[2] === "agents.defaults.model.primary") {
      cb(null, configuredModel ? `${configuredModel}\n` : "", "");
      return;
    }

    cb(null, "", "");
  });
}

describe("GET /api/settings/openclaw", () => {
  let prevScienceSwarmDir: string | undefined;
  let prevCwd = process.cwd();
  let tmpRoot: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockIsLocal.mockResolvedValue(true);
    mockHealthCheck.mockResolvedValue(connectedOpenClawStatus());
    globalThis.fetch = vi.fn(async () => {
      const status = await mockHealthCheck();
      if (status.status === "connected") {
        return Response.json({ ok: true, status: "live" });
      }
      return new Response("down", { status: 503 });
    });
    installExecFileMock();
    // Default mockSpawn: return a child that auto-exits clean so the
    // `gateway start` -> `gateway run` branch logic in the route
    // doesn't crash when a test doesn't care about the spawn.
    mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 0 }));

    // Every test gets its own SCIENCESWARM_DIR under tmp so the wrapper's
    // pidfile and .env writes land in a test-owned tree.
    prevScienceSwarmDir = process.env.SCIENCESWARM_DIR;
    tmpRoot = mkdtempSync(join(tmpdir(), "openclaw-route-test-"));
    prevCwd = process.cwd();
    process.chdir(tmpRoot);
    process.env.SCIENCESWARM_DIR = tmpRoot;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.chdir(prevCwd);
    if (prevScienceSwarmDir === undefined) {
      delete process.env.SCIENCESWARM_DIR;
    } else {
      process.env.SCIENCESWARM_DIR = prevScienceSwarmDir;
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("hooks into an existing system OpenClaw install instead of requiring a new install", async () => {
    const { GET } = await import("@/app/api/settings/openclaw/route");
    const response = await GET();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toMatchObject({
      installed: true,
      configured: true,
      running: true,
      source: "system",
      steps: {
        install: true,
        configure: true,
        start: true,
      },
    });
  });

  it("treats an already running local OpenClaw gateway as installed even when the CLI is absent", async () => {
    installExecFileMock({ openclawInstalled: false });

    const { GET } = await import("@/app/api/settings/openclaw/route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      installed: true,
      configured: true,
      running: true,
      source: "external",
      steps: {
        install: true,
        configure: true,
        start: true,
      },
    });
  });

  it("does not mark OpenClaw configured when only an API key exists but no model is set", async () => {
    mockHealthCheck.mockResolvedValue(disconnectedOpenClawStatus());
    installExecFileMock({ model: null });

    const { GET } = await import("@/app/api/settings/openclaw/route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      configured: false,
      running: false,
      steps: {
        configure: false,
      },
    });
  });

  it("treats install as a no-op when OpenClaw is already present", async () => {
    const { POST } = await import("@/app/api/settings/openclaw/route");
    const response = await POST(localRequest({ action: "install" }));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "openclaw"],
      expect.anything(),
      expect.anything(),
    );
  });

  it("treats install as a no-op when an attached OpenClaw runtime is already responding", async () => {
    installExecFileMock({ openclawInstalled: false });

    const { POST } = await import("@/app/api/settings/openclaw/route");
    const response = await POST(localRequest({ action: "install" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      alreadyInstalled: true,
      status: {
        source: "external",
        running: true,
      },
    });
    expect(mockExecFile).not.toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "openclaw"],
      expect.anything(),
      expect.anything(),
    );
  });

  it("treats start as a no-op when an attached OpenClaw runtime is already responding", async () => {
    installExecFileMock({ openclawInstalled: false });
    const fsPromises = await import("node:fs/promises");
    const readFileMock = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const prevImpl = readFileMock.getMockImplementation();
    readFileMock.mockResolvedValue("AGENT_BACKEND=none\nLLM_PROVIDER=local\n");

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const response = await POST(localRequest({ action: "start" }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        running: true,
        alreadyRunning: true,
      });
      const savedEnv = readFileSync(join(tmpRoot, ".env"), "utf-8");
      expect(savedEnv).toContain("AGENT_BACKEND=openclaw");
      expect(savedEnv).not.toContain("AGENT_BACKEND=none");
    } finally {
      if (prevImpl) {
        readFileMock.mockImplementation(prevImpl);
      } else {
        readFileMock.mockResolvedValue(
          "OPENAI_API_KEY=sk-test-openai\nLLM_MODEL=gpt-5.4\n",
        );
      }
    }
  });

  it("rejects configure when OpenClaw is attached externally", async () => {
    installExecFileMock({ openclawInstalled: false });

    const { POST } = await import("@/app/api/settings/openclaw/route");
    const response = await POST(localRequest({ action: "configure" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "OpenClaw is running as an external runtime. Configure it directly.",
    });
  });

  it("rejects stop when OPENCLAW_URL points at an external gateway", async () => {
    vi.stubEnv("OPENCLAW_URL", "https://openclaw.example/ws");

    const { POST } = await import("@/app/api/settings/openclaw/route");
    const response = await POST(localRequest({ action: "stop" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "OpenClaw is configured to use an external gateway URL. Stop that runtime directly.",
    });
  });

  it("configures with a default model when LLM_MODEL is absent from .env (unblocks new-user onboarding)", async () => {
    // Greptile P1 (PR #208): /api/setup never writes LLM_MODEL (it
    // writes LLM_PROVIDER + OLLAMA_MODEL), so a fresh installer who
    // finishes /setup and clicks Configure in OpenClawSection would
    // hit "Choose a model first" 400s forever. The fix: fall back to
    // the codebase-wide default (`gpt-5.4`) and let Configure succeed.
    const fsPromises = await import("node:fs/promises");
    const readFileMock = fsPromises.readFile as unknown as ReturnType<
      typeof vi.fn
    >;
    // Configure calls `readEnvFile` twice (key + model). Use a
    // persistent mock so both reads see a .env missing LLM_MODEL —
    // exactly the post-/setup shape for a brand-new user.
    const prevImpl = readFileMock.getMockImplementation();
    readFileMock.mockResolvedValue(
      "OPENAI_API_KEY=sk-test-openai\n",
    );
    // Scrub process.env as well so the route's fallback chain
    // (env → process.env → default) actually reaches the default.
    const prevModel = process.env.LLM_MODEL;
    delete process.env.LLM_MODEL;
    installExecFileMock();

    const configuredModels: string[] = [];
    mockExecFile.mockImplementation((file: string, maybeArgs: unknown, maybeOptions: unknown, maybeCb: unknown) => {
      const args = Array.isArray(maybeArgs) ? maybeArgs as string[] : [];
      const cb =
        typeof maybeOptions === "function"
          ? maybeOptions as (error: Error | null, stdout?: string, stderr?: string) => void
          : typeof maybeCb === "function"
            ? maybeCb as (error: Error | null, stdout?: string, stderr?: string) => void
            : null;
      if (!cb) return;
      if (file === "which" && args[0] === "openclaw") {
        cb(null, "/usr/local/bin/openclaw\n", "");
        return;
      }
      if (file === "openclaw" && args[0] === "models" && args[1] === "set") {
        configuredModels.push(args[2] ?? "");
      }
      cb(null, "", "");
    });

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const response = await POST(localRequest({ action: "configure" }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      // The normalized form of the default is `openai/gpt-5.4` —
      // that's what the CLI's `models set` actually receives.
      expect(data.model).toBe("openai/gpt-5.4");
      expect(configuredModels).toContain("openai/gpt-5.4");
    } finally {
      if (prevModel === undefined) {
        delete process.env.LLM_MODEL;
      } else {
        process.env.LLM_MODEL = prevModel;
      }
      // Restore the shared readFile mock so later tests in this file
      // still see the original "OPENAI_API_KEY + LLM_MODEL=gpt-5.4"
      // fixture. `beforeEach` also clears mocks, but an in-file restore
      // is defensive against ordering changes.
      if (prevImpl) {
        readFileMock.mockImplementation(prevImpl);
      } else {
        readFileMock.mockResolvedValue(
          "OPENAI_API_KEY=sk-test-openai\nLLM_MODEL=gpt-5.4\n",
        );
      }
    }
  });

  it("configures OpenClaw against the saved local Ollama model without requiring an OpenAI key", async () => {
    const fsPromises = await import("node:fs/promises");
    const readFileMock = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const prevImpl = readFileMock.getMockImplementation();
    const prevOpenAiKey = process.env.OPENAI_API_KEY;
    const prevProvider = process.env.LLM_PROVIDER;
    const prevOllamaModel = process.env.OLLAMA_MODEL;

    delete process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = "local";
    process.env.OLLAMA_MODEL = "gemma4:latest";
    readFileMock.mockResolvedValue(
      "LLM_PROVIDER=local\nOLLAMA_MODEL=gemma4:latest\n",
    );

    const configuredModels: string[] = [];
    const providerConfigs: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const modelSetEnvs: NodeJS.ProcessEnv[] = [];
    mockExecFile.mockImplementation((file: string, maybeArgs: unknown, maybeOptions: unknown, maybeCb: unknown) => {
      const args = Array.isArray(maybeArgs) ? maybeArgs as string[] : [];
      const options =
        typeof maybeOptions === "object" && maybeOptions !== null
          ? maybeOptions as { env?: NodeJS.ProcessEnv }
          : undefined;
      const cb =
        typeof maybeOptions === "function"
          ? maybeOptions as (error: Error | null, stdout?: string, stderr?: string) => void
          : typeof maybeCb === "function"
            ? maybeCb as (error: Error | null, stdout?: string, stderr?: string) => void
            : null;
      if (!cb) return;

      if (file === "which" && args[0] === "openclaw") {
        cb(null, "/usr/local/bin/openclaw\n", "");
        return;
      }

      if (file === "openclaw" && args[0] === "models" && args[1] === "set") {
        configuredModels.push(args[2] ?? "");
        if (options?.env) {
          modelSetEnvs.push(options.env);
        }
      }

      if (
        file === "openclaw"
        && args[0] === "config"
        && args[1] === "set"
        && args[2] === "models.providers.ollama"
      ) {
        providerConfigs.push({ args, env: options?.env });
      }

      cb(null, "", "");
    });

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const response = await POST(localRequest({ action: "configure" }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.model).toBe("ollama/gemma4:latest");
      expect(configuredModels).toContain("ollama/gemma4:latest");
      expect(providerConfigs.length).toBe(1);
      const providerConfig = JSON.parse(providerConfigs[0]!.args[3] ?? "{}") as {
        apiKey?: string;
        models?: Array<{ id?: string; reasoning?: boolean }>;
      };
      expect(providerConfig.apiKey).toBe("ollama-local");
      expect(providerConfig.models?.map((model) => model.id)).toContain("gemma4:latest");
      expect(
        providerConfig.models?.some(
          (model) => model.id === "gemma4:latest" && model.reasoning === true,
        ),
      ).toBe(true);
      expect(modelSetEnvs.some((env) => env.OLLAMA_API_KEY === "ollama-local")).toBe(true);
    } finally {
      if (prevOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prevOpenAiKey;
      }
      if (prevProvider === undefined) {
        delete process.env.LLM_PROVIDER;
      } else {
        process.env.LLM_PROVIDER = prevProvider;
      }
      if (prevOllamaModel === undefined) {
        delete process.env.OLLAMA_MODEL;
      } else {
        process.env.OLLAMA_MODEL = prevOllamaModel;
      }
      if (prevImpl) {
        readFileMock.mockImplementation(prevImpl);
      } else {
        readFileMock.mockResolvedValue(
          "OPENAI_API_KEY=sk-test-openai\nLLM_MODEL=gpt-5.4\n",
        );
      }
    }
  });

  it("persists the configured OpenClaw gateway port during configure", async () => {
    const prevPort = process.env.OPENCLAW_PORT;
    process.env.OPENCLAW_PORT = "23456";
    installExecFileMock();

    const configSets: string[][] = [];
    const openClawCalls: string[][] = [];
    mockExecFile.mockImplementation((file: string, maybeArgs: unknown, maybeOptions: unknown, maybeCb: unknown) => {
      const args = Array.isArray(maybeArgs) ? maybeArgs as string[] : [];
      const cb =
        typeof maybeOptions === "function"
          ? maybeOptions as (error: Error | null, stdout?: string, stderr?: string) => void
          : typeof maybeCb === "function"
            ? maybeCb as (error: Error | null, stdout?: string, stderr?: string) => void
            : null;
      if (!cb) return;

      if (file === "which" && args[0] === "openclaw") {
        cb(null, "/usr/local/bin/openclaw\n", "");
        return;
      }

      if (file === "openclaw") {
        openClawCalls.push(args);
      }

      if (file === "openclaw" && args[0] === "config" && args[1] === "set") {
        configSets.push(args);
      }

      cb(null, "", "");
    });

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const response = await POST(localRequest({ action: "configure" }));

      expect(response.status).toBe(200);
      expect(configSets).toContainEqual(["config", "set", "gateway.port", "23456"]);
      expect(openClawCalls).toContainEqual(["config", "validate"]);
    } finally {
      if (prevPort === undefined) {
        delete process.env.OPENCLAW_PORT;
      } else {
        process.env.OPENCLAW_PORT = prevPort;
      }
    }
  });

  it("prefers the saved .env local provider over conflicting process env values", async () => {
    const fsPromises = await import("node:fs/promises");
    const readFileMock = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const prevImpl = readFileMock.getMockImplementation();
    const prevOpenAiKey = process.env.OPENAI_API_KEY;
    const prevProvider = process.env.LLM_PROVIDER;
    const prevOllamaModel = process.env.OLLAMA_MODEL;

    process.env.OPENAI_API_KEY = "sk-shell-openai";
    process.env.LLM_PROVIDER = "openai";
    delete process.env.OLLAMA_MODEL;
    readFileMock.mockResolvedValue(
      "LLM_PROVIDER=local\nOLLAMA_MODEL=gemma4:latest\n",
    );

    const configuredModels: string[] = [];
    mockExecFile.mockImplementation((file: string, maybeArgs: unknown, maybeOptions: unknown, maybeCb: unknown) => {
      const args = Array.isArray(maybeArgs) ? maybeArgs as string[] : [];
      const cb =
        typeof maybeOptions === "function"
          ? maybeOptions as (error: Error | null, stdout?: string, stderr?: string) => void
          : typeof maybeCb === "function"
            ? maybeCb as (error: Error | null, stdout?: string, stderr?: string) => void
            : null;
      if (!cb) return;

      if (file === "which" && args[0] === "openclaw") {
        cb(null, "/usr/local/bin/openclaw\n", "");
        return;
      }

      if (file === "openclaw" && args[0] === "models" && args[1] === "set") {
        configuredModels.push(args[2] ?? "");
      }

      cb(null, "", "");
    });

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const response = await POST(localRequest({ action: "configure" }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.model).toBe("ollama/gemma4:latest");
      expect(configuredModels).toContain("ollama/gemma4:latest");
    } finally {
      if (prevOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prevOpenAiKey;
      }
      if (prevProvider === undefined) {
        delete process.env.LLM_PROVIDER;
      } else {
        process.env.LLM_PROVIDER = prevProvider;
      }
      if (prevOllamaModel === undefined) {
        delete process.env.OLLAMA_MODEL;
      } else {
        process.env.OLLAMA_MODEL = prevOllamaModel;
      }
      if (prevImpl) {
        readFileMock.mockImplementation(prevImpl);
      } else {
        readFileMock.mockResolvedValue(
          "OPENAI_API_KEY=sk-test-openai\nLLM_MODEL=gpt-5.4\n",
        );
      }
    }
  });

  it("starts OpenClaw in local mode without requiring an OpenAI key", async () => {
    vi.useFakeTimers();
    const fsPromises = await import("node:fs/promises");
    const readFileMock = fsPromises.readFile as unknown as ReturnType<typeof vi.fn>;
    const prevImpl = readFileMock.getMockImplementation();
    const prevOpenAiKey = process.env.OPENAI_API_KEY;
    const prevProvider = process.env.LLM_PROVIDER;
    const prevOllamaModel = process.env.OLLAMA_MODEL;

    delete process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = "local";
    process.env.OLLAMA_MODEL = "gemma4";
    readFileMock.mockResolvedValue(
      "LLM_PROVIDER=local\nOLLAMA_MODEL=gemma4\n",
    );
    mockGatewayStartsDisconnectedThenConnects();

    installExecFileMock();

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const responsePromise = POST(localRequest({ action: "start" }));
      // Drain setImmediate (fake ChildProcess exit) and one startup poll.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await responsePromise;

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        running: true,
      });
      // State-dir mode runs the gateway directly so OPENCLAW_STATE_DIR
      // and OPENCLAW_CONFIG_PATH stay attached to the long-lived process.
      expect(mockSpawn).toHaveBeenCalledWith(
        "openclaw",
        expect.arrayContaining(["gateway", "run", "--allow-unconfigured"]),
        expect.any(Object),
      );
      expect(readFileSync(join(tmpRoot, "openclaw", "gateway.pid"), "utf-8")).toBe("54321");
      // Regression guard: no unscoped `pkill -f openclaw.*gateway`
      // shotgun may be reintroduced by future edits. Covers both
      // exec and spawn surfaces.
      const allSpawnCalls = [
        ...mockExecFile.mock.calls.map((call) => call[0]),
        ...mockSpawn.mock.calls.map((call) => call[0]),
      ];
      expect(allSpawnCalls).not.toContain("pkill");
    } finally {
      vi.useRealTimers();
      if (prevOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prevOpenAiKey;
      }
      if (prevProvider === undefined) {
        delete process.env.LLM_PROVIDER;
      } else {
        process.env.LLM_PROVIDER = prevProvider;
      }
      if (prevOllamaModel === undefined) {
        delete process.env.OLLAMA_MODEL;
      } else {
        process.env.OLLAMA_MODEL = prevOllamaModel;
      }
      if (prevImpl) {
        readFileMock.mockImplementation(prevImpl);
      } else {
        readFileMock.mockResolvedValue(
          "OPENAI_API_KEY=sk-test-openai\nLLM_MODEL=gpt-5.4\n",
        );
      }
    }
  });

  it("passes cwd to spawnOpenClaw so the gateway subprocess discovers openclaw.plugin.json", async () => {
    vi.useFakeTimers();
    mockGatewayStartsDisconnectedThenConnects();
    installExecFileMock();

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const responsePromise = POST(localRequest({ action: "start" }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await responsePromise;

      expect(response.status).toBe(200);

      // Every spawnOpenClaw call (gateway start + possibly gateway run)
      // must pass `cwd` so the OpenClaw bundle loader can find
      // openclaw.plugin.json at the repo root and auto-register the
      // scienceswarm MCP server.
      for (const call of mockSpawn.mock.calls) {
        const opts = call[2] as { cwd?: string } | undefined;
        expect(opts?.cwd).toBe(process.cwd());
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes cwd to the gateway run fallback when gateway start exits non-zero", async () => {
    vi.useFakeTimers();
    const prevProfile = process.env.OPENCLAW_PROFILE;
    process.env.OPENCLAW_PROFILE = "fallback-test";
    mockGatewayStartsDisconnectedThenConnects();
    installExecFileMock();

    // Make gateway start fail so the route falls through to gateway run.
    mockSpawn.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("start")) {
        return makeFakeChild({ exitCode: 1, autoExit: true });
      }
      return makeFakeChild({ exitCode: 0, autoExit: true });
    });

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const responsePromise = POST(localRequest({ action: "start" }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await responsePromise;

      expect(response.status).toBe(200);

      // Should have been called twice: once for gateway start, once for
      // gateway run --allow-unconfigured.
      expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Both calls must include cwd.
      for (const call of mockSpawn.mock.calls) {
        const opts = call[2] as { cwd?: string } | undefined;
        expect(opts?.cwd).toBe(process.cwd());
      }
    } finally {
      vi.useRealTimers();
      if (prevProfile === undefined) {
        delete process.env.OPENCLAW_PROFILE;
      } else {
        process.env.OPENCLAW_PROFILE = prevProfile;
      }
    }
  });

  it("does not spawn the gateway run fallback while gateway start is still running", async () => {
    vi.useFakeTimers();
    const prevProfile = process.env.OPENCLAW_PROFILE;
    process.env.OPENCLAW_PROFILE = "start-still-running-test";
    mockGatewayStartsDisconnectedThenConnects();
    installExecFileMock();

    mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 0, autoExit: false }));

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const responsePromise = POST(localRequest({ action: "start" }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["gateway", "start"]));
      expect(mockSpawn.mock.calls.map((call) => call[1])).not.toContainEqual(
        expect.arrayContaining(["gateway", "run"]),
      );
    } finally {
      vi.useRealTimers();
      if (prevProfile === undefined) {
        delete process.env.OPENCLAW_PROFILE;
      } else {
        process.env.OPENCLAW_PROFILE = prevProfile;
      }
    }
  });

  it("starts state-dir gateways on the configured port and fails if they stay unreachable", async () => {
    vi.useFakeTimers();
    const prevPort = process.env.OPENCLAW_PORT;
    process.env.OPENCLAW_PORT = "23456";
    mockHealthCheck.mockResolvedValue(disconnectedOpenClawStatus());
    installExecFileMock();
    mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 0, autoExit: false }));

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const responsePromise = POST(localRequest({ action: "start" }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(11_000);
      const response = await responsePromise;

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        running: false,
        error: expect.stringContaining("gateway did not become reachable"),
      });
      expect(mockSpawn).toHaveBeenCalledWith(
        "openclaw",
        expect.arrayContaining(["gateway", "run", "--port", "23456", "--bind", "loopback"]),
        expect.objectContaining({
          cwd: process.cwd(),
          detached: true,
        }),
      );
    } finally {
      vi.useRealTimers();
      if (prevPort === undefined) {
        delete process.env.OPENCLAW_PORT;
      } else {
        process.env.OPENCLAW_PORT = prevPort;
      }
    }
  });

  it("returns 503 when the start command exits but OpenClaw never becomes reachable", async () => {
    vi.useFakeTimers();
    const prevProfile = process.env.OPENCLAW_PROFILE;
    process.env.OPENCLAW_PROFILE = "start-unreachable-test";
    mockHealthCheck.mockResolvedValue(disconnectedOpenClawStatus());
    installExecFileMock();

    try {
      const { POST } = await import("@/app/api/settings/openclaw/route");
      const responsePromise = POST(localRequest({ action: "start" }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(11_000);
      const response = await responsePromise;

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        running: false,
        error: expect.stringContaining("gateway did not become reachable"),
      });
    } finally {
      vi.useRealTimers();
      if (prevProfile === undefined) {
        delete process.env.OPENCLAW_PROFILE;
      } else {
        process.env.OPENCLAW_PROFILE = prevProfile;
      }
    }
  });

  it("sanitizes install failures instead of returning the raw exception", async () => {
    installExecFileMock({ openclawInstalled: false });
    mockHealthCheck.mockResolvedValue(disconnectedOpenClawStatus());
    mockExecFile.mockImplementation((file: string, maybeArgs: unknown, maybeOptions: unknown, maybeCb: unknown) => {
      const args = Array.isArray(maybeArgs) ? maybeArgs as string[] : [];
      const cb =
        typeof maybeOptions === "function"
          ? maybeOptions as (error: Error | null, stdout?: string, stderr?: string) => void
          : typeof maybeCb === "function"
            ? maybeCb as (error: Error | null, stdout?: string, stderr?: string) => void
            : null;

      if (!cb) return;

      if (file === "which" && args[0] === "npm") {
        cb(null, "/usr/local/bin/npm\n", "");
        return;
      }

      if (file === "which" && args[0] === "openclaw") {
        cb(new Error("openclaw missing"), "", "");
        return;
      }

      if (file === "npm" && args[0] === "install") {
        cb(new Error("npm registry timeout"), "", "npm ERR!");
        return;
      }

      cb(null, "", "");
    });

    const { POST } = await import("@/app/api/settings/openclaw/route");
    const response = await POST(localRequest({ action: "install" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Install failed",
    });
  });

  it("writes a pidfile on gateway start and reads/kills it on stop without pkill shotgun", async () => {
    // The start path must route through spawnOpenClaw, which writes the
    // captured child.pid into `$SCIENCESWARM_DIR/openclaw/gateway.pid`.
    // The stop path must target that PID rather than shelling out to
    // `pkill -f openclaw.*gateway`, which would kill unrelated user
    // profiles on the same machine.
    const fakePid = 987654;
    mockSpawn.mockImplementation(() =>
      makeFakeChild({ pid: fakePid, exitCode: 0, autoExit: true }),
    );
    mockGatewayStartsDisconnectedThenConnects();
    installExecFileMock();

    const { POST } = await import("@/app/api/settings/openclaw/route");

    // Start the gateway.
    const startResponse = await POST(localRequest({ action: "start" }));
    expect(startResponse.status).toBe(200);

    // Pidfile lives under the state-dir mode's state dir.
    const pidFile = join(tmpRoot, "openclaw", "gateway.pid");
    expect(existsSync(pidFile)).toBe(true);
    expect(readFileSync(pidFile, "utf8")).toBe(String(fakePid));

    // Spy on process.kill so the stop path doesn't actually signal
    // real PIDs — we just want to see that it targeted the tracked
    // PID from the pidfile (the fallback path, exercised by forcing
    // `gateway stop` to fail through a non-zero exit).
    const killSpy = vi.spyOn(process, "kill").mockImplementation((...args: unknown[]) => {
      const pid = args[0];
      const sig = args[1];
      if (sig === 0 && pid === fakePid) {
        // Signal 0 is a liveness probe. Report "not alive" so the
        // wrapper skips SIGKILL escalation.
        throw new Error("ESRCH");
      }
      return true;
    });

    // Force `gateway stop` (which the route runs through runOpenClaw →
    // execFile) to fail so we hit the killGatewayByPid fallback branch.
    const prevExecFileImpl = mockExecFile.getMockImplementation();
    mockExecFile.mockImplementation((file: string, maybeArgs: unknown, maybeOptions: unknown, maybeCb: unknown) => {
      const args = Array.isArray(maybeArgs) ? maybeArgs as string[] : [];
      const cb =
        typeof maybeOptions === "function"
          ? maybeOptions as (error: Error | null, stdout?: string, stderr?: string) => void
          : typeof maybeCb === "function"
            ? maybeCb as (error: Error | null, stdout?: string, stderr?: string) => void
            : null;
      if (!cb) return;

      if (file === "which" && args[0] === "openclaw") {
        cb(null, "/usr/local/bin/openclaw\n", "");
        return;
      }
      if (file === "openclaw" && args[0] === "gateway" && args[1] === "stop") {
        const err = new Error("gateway stop failed") as Error & { code: number };
        err.code = 1;
        cb(err, "", "stop failed");
        return;
      }
      cb(null, "", "");
    });

    mockHealthCheck
      .mockResolvedValueOnce(connectedOpenClawStatus())
      .mockResolvedValueOnce(disconnectedOpenClawStatus());

    try {
      const stopResponse = await POST(localRequest({ action: "stop" }));
      expect(stopResponse.status).toBe(200);

      // Assert the tracked PID was targeted (SIGTERM).
      const sigtermCalls = killSpy.mock.calls.filter(
        (call) => call[0] === fakePid && call[1] === "SIGTERM",
      );
      expect(sigtermCalls.length).toBeGreaterThanOrEqual(1);

      // Regression guard: no unscoped pkill anywhere in the call history.
      const allInvocations = [
        ...mockExecFile.mock.calls.map((call) => call[0]),
        ...mockSpawn.mock.calls.map((call) => call[0]),
      ];
      expect(allInvocations).not.toContain("pkill");

      // Pidfile cleared after kill.
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      killSpy.mockRestore();
      if (prevExecFileImpl) mockExecFile.mockImplementation(prevExecFileImpl);
    }
  });

  it("falls back to the tracked PID when gateway stop reports success but the gateway stays reachable", async () => {
    const fakePid = 765432;
    mockSpawn.mockImplementation(() =>
      makeFakeChild({ pid: fakePid, exitCode: 0, autoExit: true }),
    );
    mockGatewayStartsDisconnectedThenConnects();
    installExecFileMock();

    const { POST } = await import("@/app/api/settings/openclaw/route");
    const startResponse = await POST(localRequest({ action: "start" }));
    expect(startResponse.status).toBe(200);

    const killSpy = vi.spyOn(process, "kill").mockImplementation((...args: unknown[]) => {
      const pid = args[0];
      const sig = args[1];
      if (sig === 0 && pid === fakePid) {
        throw new Error("ESRCH");
      }
      return true;
    });

    mockHealthCheck
      .mockResolvedValueOnce(connectedOpenClawStatus())
      .mockResolvedValueOnce(disconnectedOpenClawStatus());

    try {
      const stopResponse = await POST(localRequest({ action: "stop" }));
      expect(stopResponse.status).toBe(200);
      await expect(stopResponse.json()).resolves.toEqual({
        ok: true,
        running: false,
      });

      const sigtermCalls = killSpy.mock.calls.filter(
        (call) => call[0] === fakePid && call[1] === "SIGTERM",
      );
      expect(sigtermCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      killSpy.mockRestore();
    }
  });

});
