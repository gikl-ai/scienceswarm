// GET /api/health
// Returns status of all services and which features are available.
//
// Uses the universal agent-client for agent health checks so this endpoint
// agrees with /api/chat/unified?action=health on every probe.

import { getOpenHandsUrl } from "@/lib/config/ports";
import { isGbrainRootReady } from "@/lib/brain/readiness";
import {
  buildOpenHandsLocalEvidenceSnapshot,
  buildRuntimeCapabilityContract,
  readOpenHandsLocalEvidence,
} from "@/lib/runtime";
import type { RuntimeCapabilityContract } from "@/lib/runtime";
import {
  probeStructuredCritiqueReadiness,
  type StructuredCritiqueReadinessProbe,
} from "@/lib/structured-critique-client";
import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import { getStructuredCritiqueConfigStatus } from "@/lib/structured-critique-config";
import { getCurrentLlmRuntimeEnv } from "@/lib/runtime-saved-env";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

interface UserHandleStatus {
  configured: boolean;
  value?: string;
  message?: string;
}

interface DatabaseKeyStatus {
  configured: boolean;
  required: boolean;
  env: string;
}

interface ScientificDatabaseStatus {
  pubmed: DatabaseKeyStatus;
  materialsProject: DatabaseKeyStatus;
  semanticScholar: DatabaseKeyStatus;
  crossref: DatabaseKeyStatus;
  openalex: DatabaseKeyStatus;
}

// SCIENCESWARM_USER_HANDLE is required for every gbrain write. Warn loudly
// once at module load so the operator sees a hint before their first
// capture, but do not hard-fail: the dashboard still needs to come up so
// the user can fix the state.
if (!process.env.SCIENCESWARM_USER_HANDLE?.trim()) {
  console.warn(
    "[health] SCIENCESWARM_USER_HANDLE is not set; attributed gbrain writes will fail until you set it in .env or complete /setup.",
  );
}

interface ServiceStatus {
  agent: { type: string; status: "connected" | "disconnected" };
  // Legacy fields for backward compat
  openclaw: "connected" | "disconnected";
  nanoclaw: "connected" | "disconnected";
  ollama: "connected" | "disconnected";
  openhands: "connected" | "disconnected";
  openai: "configured" | "missing" | "disabled";
}

interface RuntimeStatus {
  state: "ready" | "attention" | "blocked";
  title: string;
  detail: string;
  nextAction?: string;
}

interface HealthResponse extends ServiceStatus {
  llmProvider: "openai" | "local";
  strictLocalOnly: boolean;
  configuredLocalModel: string;
  ollamaModels: string[];
  scienceswarm_user_handle: UserHandleStatus;
  scientific_databases: ScientificDatabaseStatus;
  runtime: RuntimeStatus;
  runtimeContract: RuntimeCapabilityContract;
  structuredCritique: StructuredCritiqueReadinessProbe;
  features: {
    chat: boolean;
    codeExecution: boolean;
    github: boolean;
    multiChannel: boolean;
    structuredCritique: boolean;
  };
}

function probeScientificDatabaseKeys(): ScientificDatabaseStatus {
  return {
    pubmed: keyStatus("NCBI_API_KEY", false),
    materialsProject: keyStatus("MATERIALS_PROJECT_API_KEY", true),
    semanticScholar: keyStatus("SEMANTIC_SCHOLAR_API_KEY", true),
    crossref: keyStatus("CROSSREF_MAILTO", false),
    openalex: keyStatus("OPENALEX_MAILTO", false),
  };
}

function keyStatus(env: string, required: boolean): DatabaseKeyStatus {
  return {
    configured: Boolean(process.env[env]?.trim()),
    required,
    env,
  };
}

// Short in-process TTL cache. The settings page and the global banner both
// call /api/health on mount; without this, each navigation pays the full
// probe cost (agent-client subprocess + two 3s HTTP timeouts). 2s is long
// enough to coalesce parallel callers but short enough that "start Ollama,
// reload" still feels immediate.
const CACHE_TTL_MS = 2_000;
let cached: { at: number; body: HealthResponse } | null = null;

type OpenHandsStatus = ServiceStatus["openhands"];
type AgentStatus = ServiceStatus["agent"];
interface LocalProbe {
  ollama: ServiceStatus["ollama"];
  ollamaModels: string[];
  configuredLocalModel: string;
  localProviderConfigured: boolean;
}

function structuredCritiqueBlockedByStrictLocal(): StructuredCritiqueReadinessProbe {
  const configStatus = getStructuredCritiqueConfigStatus();
  return {
    configured: configStatus.available,
    ready: false,
    status: configStatus.available ? "unavailable" : "not_configured",
    detail: configStatus.available
      ? "Cloud Descartes critique is configured but blocked in strict local-only mode."
      : "Cloud Descartes critique is blocked in strict local-only mode.",
    observedAt: new Date().toISOString(),
  };
}

function isLocalRuntimeUrl(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl);
    return (
      hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "0.0.0.0"
      || hostname === "::1"
      || hostname === "[::1]"
      || hostname === "host.docker.internal"
    );
  } catch {
    return false;
  }
}

async function probeOpenHands(strictLocalOnly: boolean, openhandsUrl: string): Promise<OpenHandsStatus> {
  if (strictLocalOnly && !isLocalRuntimeUrl(openhandsUrl)) {
    return "disconnected";
  }
  try {
    const res = await fetch(openhandsUrl, { signal: AbortSignal.timeout(3000) });
    return res.ok ? "connected" : "disconnected";
  } catch {
    return "disconnected";
  }
}

async function probeAgent(strictLocalOnly: boolean): Promise<AgentStatus> {
  try {
    const { resolveAgentConfig, agentHealthCheck } = await import("@/lib/agent-client");
    const cfg = resolveAgentConfig();
    if (!cfg) return { type: "none", status: "disconnected" };
    if (strictLocalOnly && !isLocalRuntimeUrl(cfg.url)) {
      return { type: cfg.type, status: "disconnected" };
    }
    const result = await agentHealthCheck(cfg);
    return { type: cfg.type, status: result.status };
  } catch {
    return { type: "none", status: "disconnected" };
  }
}

async function probeLocal(): Promise<LocalProbe> {
  const runtimeEnv = getCurrentLlmRuntimeEnv(process.env);
  let ollama: ServiceStatus["ollama"] = "disconnected";
  let ollamaModels: string[] = [];
  let configuredLocalModel = runtimeEnv.ollamaModel ?? "gemma4";
  let localProviderConfigured = runtimeEnv.llmProvider === "local";
  try {
    const {
      healthCheck: localHealth,
      getLocalModel,
      isLocalProviderConfigured,
    } = await import("@/lib/local-llm");
    configuredLocalModel = getLocalModel();
    localProviderConfigured = isLocalProviderConfigured();
    const status = await localHealth();
    ollama = status.running ? "connected" : "disconnected";
    ollamaModels = status.models ?? [];
  } catch {
    // local-llm import or healthCheck failed
  }
  return { ollama, ollamaModels, configuredLocalModel, localProviderConfigured };
}

function probeGbrain(): {
  read: boolean;
  write: boolean;
  capture: boolean;
  maintenance: boolean;
  uploadFiles: boolean;
  localFolder: boolean;
} {
  const root = getScienceSwarmBrainRoot();
  const ready = isGbrainRootReady(root);
  return {
    read: ready,
    write: ready,
    capture: ready,
    maintenance: ready,
    uploadFiles: ready,
    localFolder: ready,
  };
}

export async function GET(): Promise<Response> {
  const now = Date.now();
  // Bypass cache under vitest so mocked probes per test aren't shadowed
  // by an earlier test's result.
  const cacheEnabled = process.env.NODE_ENV !== "test";
  if (cacheEnabled && cached && now - cached.at < CACHE_TTL_MS) {
    return Response.json(cached.body);
  }

  const runtimeEnv = getCurrentLlmRuntimeEnv(process.env);
  const openaiKey = runtimeEnv.openaiApiKey;
  const strictLocalOnly = runtimeEnv.strictLocalOnly;
  const openhandsUrl = getOpenHandsUrl();
  const llmProvider: HealthResponse["llmProvider"] = runtimeEnv.llmProvider;

  const openai: ServiceStatus["openai"] = strictLocalOnly
    ? "disabled"
    : openaiKey
      ? "configured"
      : "missing";

  // Run every probe in parallel. Previously these were serial awaits, so a
  // cold machine paid 3s (OpenHands) + ~1–2s (agent-client subprocess) + 3s
  // (Ollama) ≈ 7s per request. Promise.all collapses that to the slowest
  // single probe.
  const [
    openhands,
    agent,
    localProbe,
    openHandsEvidence,
    structuredCritique,
  ] = await Promise.all([
    probeOpenHands(strictLocalOnly, openhandsUrl),
    probeAgent(strictLocalOnly),
    probeLocal(),
    readOpenHandsLocalEvidence(),
    strictLocalOnly
      ? Promise.resolve(structuredCritiqueBlockedByStrictLocal())
      : probeStructuredCritiqueReadiness(),
  ]);

  const agentAvailable = agent.status === "connected";
  const { ollama, ollamaModels, configuredLocalModel, localProviderConfigured } = localProbe;
  const configuredLlmProvider = localProviderConfigured ? "local" : "openai";

  const configuredLocalModelAvailable = ollamaModels.some(
    (availableModel) =>
      availableModel === configuredLocalModel ||
      availableModel.startsWith(`${configuredLocalModel}:`),
  );
  const localChatReady = ollama === "connected" && configuredLocalModelAvailable;
  const strictLocalChatReady = localProviderConfigured && localChatReady;
  const directChatReady = llmProvider === "local"
    ? localChatReady
    : openai === "configured";
  const openHandsLocalEvidence = buildOpenHandsLocalEvidenceSnapshot({
    evidence: openHandsEvidence,
  });
  const runtimeContract = buildRuntimeCapabilityContract({
    strictLocalOnly,
    llmProvider: configuredLlmProvider,
    localModel: configuredLocalModel,
    ollama: {
      running: ollama === "connected",
      models: ollamaModels,
    },
    agent,
    openhands: {
      status: openhands,
      url: openhandsUrl,
      ...openHandsLocalEvidence,
    },
    openaiKeyConfigured: openai === "configured",
    structuredCritiqueConfigured: structuredCritique.configured,
    structuredCritiqueReady: structuredCritique.ready,
    structuredCritiqueProbe: structuredCritique,
    telegramConfigured: Boolean(
      process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_USER_ID,
    ),
    gbrain: probeGbrain(),
  });
  const localOpenHandsReady =
    runtimeContract.capabilities.find((capability) =>
      capability.capabilityId === "execution.openhands.local"
    )?.status === "ready";

  const runtime: RuntimeStatus = (() => {
    if (strictLocalOnly) {
      if (!localProviderConfigured) {
        return {
          state: "blocked",
          title: "Strict local-only mode is misconfigured",
          detail: "Strict local-only mode is enabled, but LLM_PROVIDER is not set to local. Set LLM_PROVIDER=local or re-save strict local-only mode in Settings.",
          nextAction: "Open Settings",
        };
      }

      if (ollama === "disconnected") {
        return {
          state: "blocked",
          title: "Start Ollama",
          detail: `Strict local-only mode is enabled, but Ollama is not running. Start Ollama, then pull ${configuredLocalModel} in Settings.`,
          nextAction: "Open Settings",
        };
      }

      if (!configuredLocalModelAvailable) {
        return {
          state: "blocked",
          title: `Pull ${configuredLocalModel}`,
          detail: `Strict local-only mode is enabled and ${configuredLocalModel} is not downloaded yet. Open Settings -> Local Model via Ollama and pull it first.`,
          nextAction: "Open Settings",
        };
      }

      return {
        state: "ready",
        title: "Strict local-only chat ready",
        detail: `Strict local-only mode is enabled. Project chat uses Ollama with ${configuredLocalModel}, and non-local backends are blocked.`,
      };
    }

    if (llmProvider === "local") {
      if (ollama === "disconnected") {
        return {
          state: "blocked",
          title: "Start Ollama",
          detail: `Local chat is configured, but Ollama is not running. Start Ollama, then pull ${configuredLocalModel} in Settings.`,
          nextAction: "Open Settings",
        };
      }

      if (!configuredLocalModelAvailable) {
        return {
          state: "blocked",
          title: `Pull ${configuredLocalModel}`,
          detail: `Local chat is configured to use ${configuredLocalModel}, but that model is not downloaded yet. Open Settings -> Local Model via Ollama and pull it first.`,
          nextAction: "Open Settings",
        };
      }

      return {
        state: "ready",
        title: "Local chat ready",
        detail: `Ollama is running with ${configuredLocalModel}, so project chat can use the local model path.`,
      };
    }

    if (!agentAvailable) {
      if (directChatReady) {
        return {
          state: "attention",
          title: "No agent backend attached",
          detail: "Direct chat is available, but OpenClaw or NanoClaw is not attached yet. Connect one in Settings to unlock the shared agent path.",
          nextAction: "Open Settings",
        };
      }

      return {
        state: "blocked",
        title: "Start OpenClaw or NanoClaw",
        detail: "No agent backend is reachable yet. Open Settings to attach to an existing install or install a managed copy.",
        nextAction: "Open Settings",
      };
    }

    if (openhands === "disconnected") {
      return {
        state: "attention",
        title: "OpenHands is offline",
        detail: "Chat is available through OpenClaw or NanoClaw, but code execution and GitHub workflows are not connected yet.",
        nextAction: "Open Settings",
      };
    }

    if (openai === "missing") {
      return {
        state: "attention",
        title: "OpenAI key is missing",
        detail: "The agent path is connected, but direct chat is not configured yet. Add the OpenAI API key in Settings if you want that route.",
        nextAction: "Open Settings",
      };
    }

    return {
      state: "ready",
      title:
        agent.type === "openclaw"
          ? "OpenClaw active"
          : agent.type === "nanoclaw"
            ? "NanoClaw active"
            : `${agent.type} active`,
      detail: "The project loop is connected and ready for chat, import follow-up, and brief generation.",
    };
  })();

  let scienceswarmUserHandle: UserHandleStatus;
  try {
    scienceswarmUserHandle = {
      configured: true,
      value: getCurrentUserHandle(),
    };
  } catch {
    scienceswarmUserHandle = {
      configured: false,
      message:
        "SCIENCESWARM_USER_HANDLE is not set. Every gbrain write needs an author handle; export it in your shell or .env (e.g. @scienceswarm-demo) before running an audit-revise session.",
    };
  }

  const body: HealthResponse = {
    agent,
    // Legacy fields for backward compat
    openclaw: agent.type === "openclaw" ? agent.status : "disconnected",
    nanoclaw: agent.type === "nanoclaw" ? agent.status : "disconnected",
    ollama,
    openhands,
    openai,
    llmProvider,
    strictLocalOnly,
    configuredLocalModel,
    ollamaModels,
    scienceswarm_user_handle: scienceswarmUserHandle,
    scientific_databases: probeScientificDatabaseKeys(),
    runtime,
    runtimeContract,
    structuredCritique,
    features: {
      chat: strictLocalOnly
        ? strictLocalChatReady
        : llmProvider === "local"
          ? localChatReady
          : agentAvailable || directChatReady,
      codeExecution: strictLocalOnly ? localOpenHandsReady : openhands === "connected",
      github: strictLocalOnly ? false : openhands === "connected",
      multiChannel: strictLocalOnly
        ? localProviderConfigured
          && agent.status === "connected"
          && (agent.type === "openclaw" || agent.type === "nanoclaw")
        : agent.status === "connected" &&
          (agent.type === "openclaw" || agent.type === "nanoclaw"),
      structuredCritique:
        !strictLocalOnly &&
        (structuredCritique.ready ||
          structuredCritique.status === "sign_in_required"),
    },
  };

  cached = { at: now, body };
  return Response.json(body);
}
