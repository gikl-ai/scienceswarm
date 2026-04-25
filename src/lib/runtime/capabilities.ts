import {
  isOpenHandsContextLengthReady,
  OPENHANDS_MINIMUM_CONTEXT,
  ollamaModelMatches,
  resolveConfiguredLocalModel,
} from "@/lib/runtime/model-catalog";
import type {
  RuntimeCapability,
  RuntimeCapabilityContract,
  RuntimeCapabilityEvidence,
  RuntimeCapabilityStatus,
  RuntimeLegacyBooleans,
  RuntimeSummary,
} from "@/lib/runtime/types";

interface AgentSnapshot {
  type: string;
  status: "connected" | "disconnected";
}

interface OllamaSnapshot {
  running: boolean;
  models: string[];
  url?: string;
}

interface OpenHandsSnapshot {
  status: "connected" | "disconnected";
  url?: string;
  localModelConfigured?: boolean;
  localModelVerified?: boolean;
  gbrainWritebackVerified?: boolean;
  contextLength?: number;
  minimumContext?: number;
  evidenceObservedAt?: string;
  evidenceStale?: boolean;
}

interface GbrainSnapshot {
  read?: boolean;
  write?: boolean;
  capture?: boolean;
  maintenance?: boolean;
  uploadFiles?: boolean;
  localFolder?: boolean;
  /**
   * One-line cause string surfaced when any capability flag is `false`.
   * Sourced from `probeGbrainEngineHealth` so dashboards can render an
   * honest error instead of `unavailable` with no detail.
   */
  cause?: string;
}

interface StructuredCritiqueSnapshot {
  configured: boolean;
  ready: boolean;
  status: string;
  detail: string;
  endpoint?: string;
  observedAt?: string;
}

export interface RuntimeCapabilitySnapshot {
  generatedAt?: string;
  strictLocalOnly: boolean;
  llmProvider: "local" | "openai";
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv;
  localModel?: string;
  ollama: OllamaSnapshot;
  agent: AgentSnapshot;
  openhands: OpenHandsSnapshot;
  openaiKeyConfigured: boolean;
  structuredCritiqueConfigured: boolean;
  structuredCritiqueReady?: boolean;
  structuredCritiqueProbe?: StructuredCritiqueSnapshot;
  telegramConfigured?: boolean;
  gbrain?: GbrainSnapshot;
}

function evidence(
  label: string,
  value: string | undefined,
  source: RuntimeCapabilityEvidence["source"],
  status?: RuntimeCapabilityStatus,
): RuntimeCapabilityEvidence {
  return { label, value, source, status };
}

function localModelAvailable(ollama: OllamaSnapshot, model: string): boolean {
  return ollama.models.some((available) => ollamaModelMatches(model, available));
}

function gbrainCapability(
  capabilityId: RuntimeCapability["capabilityId"],
  label: string,
  value: boolean | undefined,
  nextAction: string,
  cause?: string,
): RuntimeCapability {
  const evidenceItems: RuntimeCapabilityEvidence[] = [
    evidence(
      "gbrain state",
      value === undefined ? "not probed" : value ? "available" : "unavailable",
      "probe",
      value ? "ready" : "unavailable",
    ),
  ];
  if (!value && cause) {
    evidenceItems.push(
      evidence("Cause", cause, "probe", "unavailable"),
    );
  }
  return {
    capabilityId,
    label,
    status: value ? "ready" : "unavailable",
    privacy: "local-only",
    requiredForLocalGuarantee: true,
    evidence: evidenceItems,
    // Prefer the live cause when we have one; the static next-action
    // hint applies when the brain has simply never been initialized.
    nextAction: value ? undefined : (cause ?? nextAction),
  };
}

function summarize(capabilities: RuntimeCapability[]): RuntimeSummary {
  const required = capabilities.filter((capability) =>
    capability.requiredForLocalGuarantee
  );
  const blockingRequired = required.find((capability) =>
    capability.status === "blocked" || capability.status === "misconfigured"
  );
  if (blockingRequired) {
    return {
      state: "blocked",
      title: `${blockingRequired.label} blocked`,
      detail: blockingRequired.nextAction
        ? `${blockingRequired.label}: ${blockingRequired.nextAction}`
        : `${blockingRequired.label} is ${blockingRequired.status}.`,
      nextAction: blockingRequired.nextAction,
    };
  }

  const unavailableRequired = required.find((capability) =>
    capability.status === "unavailable"
  );
  if (unavailableRequired) {
    return {
      state: "attention",
      title: `${unavailableRequired.label} unavailable`,
      detail: unavailableRequired.nextAction
        ? `${unavailableRequired.label}: ${unavailableRequired.nextAction}`
        : `${unavailableRequired.label} is unavailable.`,
      nextAction: unavailableRequired.nextAction,
    };
  }

  const optionalIssue = capabilities.find((capability) =>
    !capability.requiredForLocalGuarantee
    && capability.status === "misconfigured"
  );
  if (optionalIssue) {
    return {
      state: "attention",
      title: `${optionalIssue.label} needs attention`,
      detail: optionalIssue.nextAction
        ? `${optionalIssue.label}: ${optionalIssue.nextAction}`
        : `${optionalIssue.label} is ${optionalIssue.status}.`,
      nextAction: optionalIssue.nextAction,
    };
  }

  return {
    state: "ready",
    title: "Local runtime ready",
    detail: "Core local ScienceSwarm capabilities are ready.",
  };
}

function legacyFromCapabilities(
  capabilities: RuntimeCapability[],
): RuntimeLegacyBooleans {
  const byId = new Map(capabilities.map((capability) => [
    capability.capabilityId,
    capability,
  ]));
  return {
    chat: byId.get("chat.local")?.status === "ready"
      || byId.get("chat.openclaw")?.status === "ready",
    codeExecution: byId.get("execution.openhands.local")?.status === "ready"
      || byId.get("execution.openhands.cloud")?.status === "ready",
    github: byId.get("execution.openhands.local")?.status === "ready"
      || byId.get("execution.openhands.cloud")?.status === "ready",
    multiChannel: byId.get("chat.openclaw")?.status === "ready",
    structuredCritique:
      byId.get("structuredCritique.hosted")?.status === "ready",
  };
}

export function buildRuntimeCapabilityContract(
  snapshot: RuntimeCapabilitySnapshot,
): RuntimeCapabilityContract {
  const generatedAt = snapshot.generatedAt ?? new Date().toISOString();
  const configuredLocalModel =
    snapshot.localModel?.trim() || resolveConfiguredLocalModel(snapshot.env);
  const localProviderConfigured = snapshot.llmProvider === "local";
  const openHandsContextLength = snapshot.openhands.contextLength;
  const openHandsMinimumContext =
    snapshot.openhands.minimumContext ?? OPENHANDS_MINIMUM_CONTEXT;
  const openHandsContextReady =
    typeof openHandsContextLength !== "number"
    || isOpenHandsContextLengthReady(openHandsContextLength);
  const configuredModelAvailable = localModelAvailable(
    snapshot.ollama,
    configuredLocalModel,
  );
  const localChatReady =
    localProviderConfigured && snapshot.ollama.running && configuredModelAvailable;

  const chatLocalStatus: RuntimeCapabilityStatus = localChatReady
    ? "ready"
    : !localProviderConfigured
      ? snapshot.strictLocalOnly ? "misconfigured" : "unavailable"
      : !snapshot.ollama.running || !configuredModelAvailable
        ? "blocked"
        : "unavailable";

  const agentChatReady =
    snapshot.agent.type === "openclaw"
    && snapshot.agent.status === "connected";
  const openHandsLocalReady =
    snapshot.openhands.status === "connected"
    && snapshot.openhands.localModelConfigured === true
    && snapshot.openhands.localModelVerified === true
    && snapshot.openhands.gbrainWritebackVerified === true
    && openHandsContextReady
    && snapshot.openhands.evidenceStale !== true;
  const openHandsLocalStatus: RuntimeCapabilityStatus = openHandsLocalReady
    ? "ready"
    : snapshot.openhands.status === "connected"
      ? "misconfigured"
      : "unavailable";
  const openHandsLocalNextAction = (() => {
    if (openHandsLocalReady) return undefined;
    if (
      typeof openHandsContextLength === "number"
      && !openHandsContextReady
    ) {
      return `Set OLLAMA_CONTEXT_LENGTH to at least ${openHandsMinimumContext} for local OpenHands execution.`;
    }
    if (snapshot.openhands.localModelConfigured !== true) {
      return "Set LLM_PROVIDER=local and configure the local OpenHands runtime.";
    }
    if (snapshot.openhands.evidenceStale === true) {
      return "Run `npm run smoke:local -- --verify-openhands-local --verify-gbrain-writeback`; existing evidence is stale or for a different model.";
    }
    if (snapshot.openhands.localModelVerified !== true) {
      return "Run `npm run smoke:local -- --verify-openhands-local --verify-gbrain-writeback`.";
    }
    if (snapshot.openhands.gbrainWritebackVerified !== true) {
      return "Run `npm run smoke:local -- --verify-gbrain-writeback`.";
    }
    return "Run `npm run smoke:local -- --verify-openhands-local --verify-gbrain-writeback`.";
  })();
  const capabilities: RuntimeCapability[] = [
    {
      capabilityId: "setup.local",
      label: "Local setup",
      status: localProviderConfigured ? "ready" : "misconfigured",
      privacy: "local-only",
      requiredForLocalGuarantee: true,
      provider: snapshot.llmProvider,
      model: configuredLocalModel,
      evidence: [
        evidence("LLM_PROVIDER", snapshot.llmProvider, "env"),
        evidence("OLLAMA_MODEL", configuredLocalModel, "env"),
      ],
      nextAction: localProviderConfigured
        ? undefined
        : "Set LLM_PROVIDER=local for the default no-key setup.",
    },
    {
      capabilityId: "chat.local",
      label: "Local chat",
      status: chatLocalStatus,
      privacy: "local-network",
      requiredForLocalGuarantee: true,
      provider: "ollama",
      model: configuredLocalModel,
      endpoint: snapshot.ollama.url,
      evidence: [
        evidence(
          "Ollama daemon",
          snapshot.ollama.running ? "running" : "not running",
          "probe",
          snapshot.ollama.running ? "ready" : "unavailable",
        ),
        evidence(
          "Selected model",
          configuredModelAvailable ? configuredLocalModel : "missing",
          "probe",
          configuredModelAvailable ? "ready" : "blocked",
        ),
      ],
      nextAction: localChatReady
        ? undefined
        : !localProviderConfigured
          ? "Set LLM_PROVIDER=local."
          : !snapshot.ollama.running
            ? "Start Ollama."
            : `Pull ${configuredLocalModel}.`,
    },
    {
      capabilityId: "chat.openclaw",
      label: "OpenClaw chat",
      status: agentChatReady ? "ready" : "unavailable",
      privacy: "local-network",
      requiredForLocalGuarantee: true,
      provider: snapshot.agent.type,
      evidence: [
        evidence(
          "Agent backend",
          `${snapshot.agent.type}:${snapshot.agent.status}`,
          "probe",
          agentChatReady ? "ready" : "unavailable",
        ),
      ],
      nextAction: agentChatReady
        ? undefined
        : "Start OpenClaw from Settings.",
    },
    gbrainCapability(
      "brain.read",
      "gbrain read",
      snapshot.gbrain?.read,
      "Run setup to initialize gbrain read/search.",
      snapshot.gbrain?.cause,
    ),
    gbrainCapability(
      "brain.write",
      "gbrain write",
      snapshot.gbrain?.write,
      "Run setup to initialize gbrain writes.",
      snapshot.gbrain?.cause,
    ),
    gbrainCapability(
      "brain.capture",
      "gbrain capture",
      snapshot.gbrain?.capture,
      "Run setup to initialize gbrain capture.",
      snapshot.gbrain?.cause,
    ),
    gbrainCapability(
      "brain.maintenance",
      "gbrain maintenance",
      snapshot.gbrain?.maintenance,
      "Run setup to initialize local maintenance.",
      snapshot.gbrain?.cause,
    ),
    gbrainCapability(
      "imports.uploadFiles",
      "Upload files import",
      snapshot.gbrain?.uploadFiles,
      "Run setup to initialize gbrain ingest.",
      snapshot.gbrain?.cause,
    ),
    gbrainCapability(
      "imports.localFolder",
      "Local folder import",
      snapshot.gbrain?.localFolder,
      "Run setup to initialize gbrain ingest.",
      snapshot.gbrain?.cause,
    ),
    {
      capabilityId: "execution.openhands.local",
      label: "OpenHands local execution",
      status: openHandsLocalStatus,
      privacy: "local-network",
      requiredForLocalGuarantee: true,
      provider: "openhands",
      model: configuredLocalModel,
      endpoint: snapshot.openhands.url,
      evidence: [
        evidence(
          "Container",
          snapshot.openhands.status,
          "probe",
          snapshot.openhands.status === "connected" ? "ready" : "unavailable",
        ),
        evidence(
          "Local runtime config",
          snapshot.openhands.localModelConfigured
            ? "configured"
            : "not configured",
          "config",
          snapshot.openhands.localModelConfigured
            ? "ready"
            : "misconfigured",
        ),
        evidence(
          "Context length",
          typeof openHandsContextLength === "number"
            ? `${openHandsContextLength}`
            : "not reported",
          "config",
          openHandsContextReady ? "ready" : "misconfigured",
        ),
        evidence(
          "Local model preflight",
          snapshot.openhands.localModelVerified ? "passed" : "not verified",
          "smoke",
          snapshot.openhands.localModelVerified ? "ready" : "unavailable",
        ),
        evidence(
          "gbrain writeback smoke",
          snapshot.openhands.gbrainWritebackVerified ? "passed" : "not verified",
          "smoke",
          snapshot.openhands.gbrainWritebackVerified ? "ready" : "unavailable",
        ),
        evidence(
          "Smoke evidence",
          snapshot.openhands.evidenceObservedAt
            ? snapshot.openhands.evidenceObservedAt
            : "not recorded",
          "smoke",
          snapshot.openhands.evidenceStale === true
            ? "unavailable"
            : snapshot.openhands.evidenceObservedAt
              ? "ready"
              : "unavailable",
        ),
      ],
      nextAction: openHandsLocalNextAction,
    },
  ];

  return {
    generatedAt,
    strictLocalOnly: snapshot.strictLocalOnly,
    llmProvider: snapshot.llmProvider,
    configuredLocalModel,
    capabilities,
    summary: summarize(capabilities),
    legacy: legacyFromCapabilities(capabilities),
  };
}
