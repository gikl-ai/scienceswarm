import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the universal agent-client that the route dynamic-imports.
const resolveAgentConfig = vi.hoisted(() => vi.fn().mockReturnValue(null));
const agentHealthCheck = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: "disconnected" }),
);
const localHealth = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ running: false, models: [], url: "http://localhost:11434" }),
);
const getLocalModel = vi.hoisted(() =>
  vi.fn().mockReturnValue("gemma4"),
);
const isLocalProviderConfigured = vi.hoisted(() =>
  vi.fn(() => process.env.LLM_PROVIDER === "local"),
);

// Mock `@/brain/store` so the health route's dynamic import does not
// transitively pull in the gbrain runtime module. Each test controls
// the probe outcome by tweaking the hoisted refs below.
const ensureBrainStoreReady = vi.hoisted(() =>
  vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
);
const brainHealthFn = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; pageCount: number; error?: string }>>(
    () => Promise.resolve({ ok: true, pageCount: 7 }),
  ),
);
class MockBrainBackendUnavailableError extends Error {
  detail?: string;
  constructor(message: string, options?: { cause?: unknown; detail?: string }) {
    super(message);
    this.name = "BrainBackendUnavailableError";
    if (options?.detail !== undefined) this.detail = options.detail;
  }
}

vi.mock("@/brain/store", () => ({
  ensureBrainStoreReady,
  getBrainStore: () => ({ health: brainHealthFn }),
  resetBrainStore: vi.fn().mockResolvedValue(undefined),
  describeBrainBackendError: (error: unknown) => {
    if (error instanceof MockBrainBackendUnavailableError && error.detail) return error.detail;
    if (error instanceof Error && error.message) return error.message;
    return String(error);
  },
  BrainBackendUnavailableError: MockBrainBackendUnavailableError,
  isBrainBackendUnavailableError: (error: unknown) =>
    error instanceof MockBrainBackendUnavailableError,
}));

vi.mock("@/lib/agent-client", () => ({
  resolveAgentConfig,
  agentHealthCheck,
}));
vi.mock("@/lib/local-llm", () => ({
  healthCheck: localHealth,
  getLocalModel,
  isLocalProviderConfigured,
}));

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  const originalCwd = process.cwd();
  let tempRepoRoot: string | null = null;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unreachable")));
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENHANDS_URL", "http://localhost:3000");
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_URL", "");
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN", "");
    resolveAgentConfig.mockReturnValue(null);
    agentHealthCheck.mockResolvedValue({ status: "disconnected" });
    localHealth.mockResolvedValue({ running: false, models: [], url: "http://localhost:11434" });
    getLocalModel.mockReturnValue("gemma4");
    isLocalProviderConfigured.mockImplementation(() => process.env.LLM_PROVIDER === "local");
    // Default: brain is healthy. Override per-test for unhealthy paths.
    ensureBrainStoreReady.mockReset().mockResolvedValue(undefined);
    brainHealthFn.mockReset().mockResolvedValue({ ok: true, pageCount: 7 });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempRepoRoot) {
      await rm(tempRepoRoot, { recursive: true, force: true });
      tempRepoRoot = null;
    }
  });

  it("returns status for all services", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("agent");
    expect(body).toHaveProperty("openclaw");
    expect(body).toHaveProperty("openhands");
    expect(body).toHaveProperty("openai");
    expect(body).toHaveProperty("runtime");
    expect(body).toHaveProperty("runtimeContract");
    expect(body).toHaveProperty("scientific_databases");
    expect(body).toHaveProperty("features");
    expect(body.runtimeContract.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityId: "chat.local" }),
        expect.objectContaining({ capabilityId: "execution.openhands.local" }),
      ]),
    );
  });

  it("reports gbrain capabilities as ready only when the engine health probe says ok", async () => {
    // The probe now opens the configured PGLite engine and calls
    // health() rather than only checking on-disk file existence. With
    // the mocked store happy-path, every gbrain capability flips to
    // ready and the runtime contract no longer lies about the brain.
    brainHealthFn.mockResolvedValue({ ok: true, pageCount: 12 });

    const response = await GET();
    const body = await response.json();

    expect(body.runtimeContract.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "brain.read",
          status: "ready",
        }),
        expect.objectContaining({
          capabilityId: "brain.write",
          status: "ready",
        }),
        expect.objectContaining({
          capabilityId: "brain.capture",
          status: "ready",
        }),
        expect.objectContaining({
          capabilityId: "brain.maintenance",
          status: "ready",
        }),
      ]),
    );
  });

  it("reports gbrain capabilities as unavailable with a non-empty cause when the engine init fails", async () => {
    // Force the store init to reject so the probe surfaces the
    // underlying cause instead of painting the dashboard green. This
    // is the regression guard for the "lying probe" bug — the earlier
    // file-existence stub would return read/write/capture/maintenance:
    // ready even when PGLite could not initialize.
    const failure = new MockBrainBackendUnavailableError(
      "Brain backend unavailable",
      {
        detail: "stale .gbrain-lock at brain.pglite/0001 — engine init refused",
      },
    );
    ensureBrainStoreReady.mockRejectedValue(failure);

    const response = await GET();
    const body = await response.json();

    const capabilityIds = [
      "brain.read",
      "brain.write",
      "brain.capture",
      "brain.maintenance",
      "imports.uploadFiles",
      "imports.localFolder",
    ];
    for (const id of capabilityIds) {
      const capability = body.runtimeContract.capabilities.find(
        (cap: { capabilityId: string }) => cap.capabilityId === id,
      );
      expect(capability).toBeDefined();
      expect(capability.status).toBe("unavailable");
      // The cause is surfaced as both an evidence row and the
      // capability's nextAction so operators see the underlying init
      // failure on the dashboard instead of the static "Run setup"
      // hint that hid the real problem.
      expect(capability.nextAction).toContain(".gbrain-lock");
      const causeEvidence = capability.evidence.find(
        (ev: { label: string }) => ev.label === "Cause",
      );
      expect(causeEvidence).toBeDefined();
      expect(causeEvidence.value).toContain(".gbrain-lock");
      expect(causeEvidence.value).not.toBe("");
    }
  });

  it("reports gbrain capabilities as unavailable when health() returns ok:false", async () => {
    // Equivalent guard for the "engine connects but reports degraded"
    // path — health() returns ok:false with a one-line error string.
    brainHealthFn.mockResolvedValue({
      ok: false,
      pageCount: 0,
      error: "PGLite schema migration failed",
    });

    const response = await GET();
    const body = await response.json();

    const capability = body.runtimeContract.capabilities.find(
      (cap: { capabilityId: string }) => cap.capabilityId === "brain.read",
    );
    expect(capability.status).toBe("unavailable");
    expect(capability.nextAction).toContain("schema migration failed");
  });

  it("reports openai as missing when no key", async () => {
    const response = await GET();
    const body = await response.json();
    expect(body.openai).toBe("missing");
    expect(body.features.chat).toBe(false);
  });

  it("reports openai as configured when key is set", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key");
    const response = await GET();
    const body = await response.json();
    expect(body.openai).toBe("configured");
    expect(body.features.chat).toBe(true);
  });

  it("disables remote backends when strict local-only mode is enabled", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key");
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_URL", "https://critique.example/v1");
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN", "test-token");
    const cfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(cfg);
    agentHealthCheck.mockResolvedValue({ status: "connected" });

    const response = await GET();
    const body = await response.json();

    expect(body.strictLocalOnly).toBe(true);
    expect(body.llmProvider).toBe("local");
    expect(body.openai).toBe("disabled");
    expect(
      body.runtimeContract.capabilities.find(
        (capability: { capabilityId: string }) =>
          capability.capabilityId === "setup.local",
      ),
    ).toMatchObject({
      status: "misconfigured",
    });
    // structuredCritique.hosted capability was removed from the capability matrix
    expect(
      body.runtimeContract.capabilities.find(
        (capability: { capabilityId: string }) =>
          capability.capabilityId === "structuredCritique.hosted",
      ),
    ).toBeUndefined();
    expect(body.structuredCritique).toMatchObject({
      configured: true,
      ready: false,
      status: "unavailable",
      detail:
        "Cloud Descartes critique is configured but blocked in strict local-only mode.",
    });
    expect(body.agent).toEqual({ type: "openclaw", status: "connected" });
    expect(body.features.chat).toBe(false);
    expect(body.features.codeExecution).toBe(false);
    expect(body.features.github).toBe(false);
    expect(body.features.multiChannel).toBe(false);
    expect(body.features.structuredCritique).toBe(false);
  });

  it("reports attention when direct OpenAI chat is available but no agent is attached", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key");

    const response = await GET();
    const body = await response.json();

    expect(body.features.chat).toBe(true);
    expect(body.runtime).toMatchObject({
      state: "attention",
      title: "No agent backend attached",
      nextAction: "Open Settings",
    });
    expect(body.runtime.detail).toContain("Direct chat is available");
  });

  it("reports openhands as disconnected when unreachable", async () => {
    const response = await GET();
    const body = await response.json();
    expect(body.openhands).toBe("disconnected");
    expect(body.features.codeExecution).toBe(false);
  });

  it("reports openhands as connected when reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    );

    const response = await GET();
    const body = await response.json();
    expect(body.openhands).toBe("connected");
    expect(body.features.codeExecution).toBe(true);
    expect(body.features.github).toBe(true);
  });

  it("features list is based on service availability", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-key");
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_URL", "https://critique.example/v1");
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://critique.example/v1/ready") {
          return Response.json({ ok: true });
        }
        throw new Error("unreachable");
      }),
    );

    const response = await GET();
    const body = await response.json();
    expect(body.features.structuredCritique).toBe(true);
    expect(body.structuredCritique).toMatchObject({
      configured: true,
      ready: true,
      status: "ready",
      endpoint: "https://critique.example/v1/ready",
    });
  });

  it("structuredCritique stays available when the hosted backend only requires user sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://scienceswarm.ai/api/v1/ready") {
          return Response.json(
            { detail: "Authentication required" },
            { status: 401 },
          );
        }
        throw new Error("unreachable");
      }),
    );

    const response = await GET();
    const body = await response.json();
    expect(body.features.structuredCritique).toBe(true);
    expect(body.structuredCritique).toMatchObject({
      configured: true,
      ready: true,
      status: "sign_in_required",
      detail: "ScienceSwarm reasoning is available. Sign in to run a live audit.",
      endpoint: "https://scienceswarm.ai/api/v1/ready",
    });
  });

  it("structuredCritique is false when Descartes rejects configured credentials", async () => {
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_URL", "https://critique.example/v1");
    vi.stubEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://critique.example/v1/ready") {
          return Response.json({ detail: "bad bearer test-token" }, { status: 401 });
        }
        throw new Error("unreachable");
      }),
    );

    const response = await GET();
    const body = await response.json();

    expect(body.features.structuredCritique).toBe(false);
    expect(body.structuredCritique).toMatchObject({
      configured: true,
      ready: false,
      status: "auth_failed",
      detail: "Cloud Descartes rejected the configured credentials.",
    });
    // structuredCritique.hosted capability was removed from the capability matrix
    const capability = body.runtimeContract.capabilities.find(
      (cap: { capabilityId: string }) => cap.capabilityId === "structuredCritique.hosted",
    );
    expect(capability).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("test-token");
  });

  it("surfaces scienceswarm_user_handle as configured when set", async () => {
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@scienceswarm-demo");

    const response = await GET();
    const body = await response.json();

    expect(body.scienceswarm_user_handle).toEqual({
      configured: true,
      value: "@scienceswarm-demo",
    });
  });

  it("surfaces scienceswarm_user_handle with a message when missing", async () => {
    tempRepoRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-health-"));
    process.chdir(tempRepoRoot);
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "");

    const response = await GET();
    const body = await response.json();

    expect(body.scienceswarm_user_handle.configured).toBe(false);
    expect(body.scienceswarm_user_handle.value).toBeUndefined();
    expect(body.scienceswarm_user_handle.message).toContain(
      "SCIENCESWARM_USER_HANDLE is not set",
    );
  });

  it("treats whitespace-only SCIENCESWARM_USER_HANDLE as missing", async () => {
    tempRepoRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-health-"));
    process.chdir(tempRepoRoot);
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "   ");

    const response = await GET();
    const body = await response.json();

    expect(body.scienceswarm_user_handle.configured).toBe(false);
    expect(body.scienceswarm_user_handle.message).toContain(
      "SCIENCESWARM_USER_HANDLE is not set",
    );
  });

  it("reads scienceswarm_user_handle from the saved .env when setup updated it after boot", async () => {
    tempRepoRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-health-"));
    await writeFile(
      path.join(tempRepoRoot, ".env"),
      "SCIENCESWARM_USER_HANDLE=@saved-health-handle\n",
    );
    process.chdir(tempRepoRoot);
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "");

    const response = await GET();
    const body = await response.json();

    expect(body.scienceswarm_user_handle).toEqual({
      configured: true,
      value: "@saved-health-handle",
    });
  });

  it("reports scientific database key presence without leaking values", async () => {
    vi.stubEnv("NCBI_API_KEY", "ncbi-secret");
    vi.stubEnv("MATERIALS_PROJECT_API_KEY", "");
    vi.stubEnv("SEMANTIC_SCHOLAR_API_KEY", "semantic-secret");
    vi.stubEnv("CROSSREF_MAILTO", "researcher@example.com");
    vi.stubEnv("OPENALEX_MAILTO", "");

    const response = await GET();
    const body = await response.json();

    expect(body.scientific_databases).toMatchObject({
      pubmed: { configured: true, required: false, env: "NCBI_API_KEY" },
      materialsProject: {
        configured: false,
        required: true,
        env: "MATERIALS_PROJECT_API_KEY",
      },
      semanticScholar: {
        configured: true,
        required: true,
        env: "SEMANTIC_SCHOLAR_API_KEY",
      },
      crossref: { configured: true, required: false, env: "CROSSREF_MAILTO" },
      openalex: { configured: false, required: false, env: "OPENALEX_MAILTO" },
    });
    expect(JSON.stringify(body)).not.toContain("semantic-secret");
    expect(JSON.stringify(body)).not.toContain("researcher@example.com");
  });

  it("reports agent connected via agent-client", async () => {
    const cfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(cfg);
    agentHealthCheck.mockResolvedValue({ status: "connected" });

    const response = await GET();
    const body = await response.json();
    expect(body.agent).toEqual({ type: "openclaw", status: "connected" });
    // Legacy field
    expect(body.openclaw).toBe("connected");
    expect(agentHealthCheck).toHaveBeenCalledWith(cfg);
  });

  it("reports nanoclaw connected via agent-client legacy field", async () => {
    const cfg = { type: "nanoclaw", url: "http://localhost:3002" };
    resolveAgentConfig.mockReturnValue(cfg);
    agentHealthCheck.mockResolvedValue({ status: "connected" });

    const response = await GET();
    const body = await response.json();
    expect(body.agent).toEqual({ type: "nanoclaw", status: "connected" });
    expect(body.nanoclaw).toBe("connected");
    // openclaw legacy field should be disconnected when nanoclaw is active
    expect(body.openclaw).toBe("disconnected");
  });

  it("explains when local chat is selected but the Ollama model is missing", async () => {
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.stubEnv("OLLAMA_MODEL", "gemma4");
    localHealth.mockResolvedValue({
      running: true,
      models: [],
      url: "http://localhost:11434",
    });

    const response = await GET();
    const body = await response.json();

    expect(body.ollama).toBe("connected");
    expect(body.configuredLocalModel).toBe("gemma4");
    expect(body.features.chat).toBe(false);
    expect(body.runtime).toMatchObject({
      state: "blocked",
      title: "Pull gemma4",
    });
    expect(body.runtime.detail).toContain("Open Settings -> Local Model via Ollama");
  });

  it("reports chat as available when the selected local model is already installed", async () => {
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.stubEnv("OLLAMA_MODEL", "gemma4");
    localHealth.mockResolvedValue({
      running: true,
      models: ["gemma4:e4b"],
      url: "http://localhost:11434",
    });

    const response = await GET();
    const body = await response.json();

    expect(body.features.chat).toBe(true);
    expect(body.runtime).toMatchObject({
      state: "ready",
      title: "Local chat ready",
    });
  });

  it("treats installed Gemma aliases as available for the e4b default", async () => {
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.stubEnv("OLLAMA_MODEL", "gemma4:e4b");
    getLocalModel.mockReturnValue("gemma4:e4b");
    localHealth.mockResolvedValue({
      running: true,
      models: ["gemma4"],
      url: "http://localhost:11434",
    });

    const response = await GET();
    const body = await response.json();

    expect(body.configuredLocalModel).toBe("gemma4:e4b");
    expect(body.ollamaModels).toEqual(["gemma4"]);
    expect(body.features.chat).toBe(true);
    expect(body.runtime).toMatchObject({
      state: "ready",
      title: "Local chat ready",
    });
  });

  it("does not claim chat is available when strict local-only mode is enabled from system env without the local provider configured", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    vi.stubEnv("LLM_PROVIDER", "openai");
    localHealth.mockResolvedValue({
      running: true,
      models: ["gemma4:e4b"],
      url: "http://localhost:11434",
    });

    const response = await GET();
    const body = await response.json();

    expect(body.strictLocalOnly).toBe(true);
    expect(body.features.chat).toBe(false);
    expect(body.runtime).toMatchObject({
      state: "blocked",
      title: "Strict local-only mode is misconfigured",
    });
  });

  it("does not claim chat is available from the agent path when local provider is selected but the local model is missing", async () => {
    vi.stubEnv("LLM_PROVIDER", "local");
    const cfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(cfg);
    agentHealthCheck.mockResolvedValue({ status: "connected" });
    localHealth.mockResolvedValue({
      running: true,
      models: [],
      url: "http://localhost:11434",
    });

    const response = await GET();
    const body = await response.json();

    expect(body.agent).toEqual({ type: "openclaw", status: "connected" });
    expect(body.features.chat).toBe(false);
    expect(body.runtime).toMatchObject({
      state: "blocked",
      title: "Pull gemma4",
    });
  });

  it("reports strict local-only readiness only from Ollama and the selected local model", async () => {
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key");
    vi.stubEnv("OLLAMA_MODEL", "gemma4");
    localHealth.mockResolvedValue({
      running: true,
      models: ["gemma4:e4b"],
      url: "http://localhost:11434",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    );

    const response = await GET();
    const body = await response.json();

    expect(body.features.chat).toBe(true);
    expect(body.openhands).toBe("connected");
    expect(body.features.codeExecution).toBe(false);
    expect(body.runtime).toMatchObject({
      state: "ready",
      title: "Strict local-only chat ready",
    });
    expect(body.runtime.detail).toContain("non-local backends are blocked");
  });

  it("runs probes in parallel, not serially", async () => {
    // Regression guard: previously the route awaited each probe in sequence,
    // so a cold machine paid ~7s per request (3s OpenHands timeout +
    // ~1–2s agent-client subprocess + 3s Ollama timeout). Parallelizing
    // collapses that to the slowest single probe. Use fake timers so the
    // assertion stays deterministic under CI load.
    vi.useFakeTimers();

    const DELAY = 120;
    const slow = <T,>(value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), DELAY));

    const cfg = { type: "openclaw", url: "http://localhost:19002" };
    resolveAgentConfig.mockReturnValue(cfg);
    agentHealthCheck.mockImplementation(() => slow({ status: "disconnected" }));
    localHealth.mockImplementation(() =>
      slow({ running: false, models: [], url: "http://localhost:11434" }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => slow(new Response("offline", { status: 503 }))),
    );

    const responsePromise = GET();
    const settled = vi.fn();
    void responsePromise.then(settled);

    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(1);

    const response = await responsePromise;
    expect(response.status).toBe(200);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
