export const RUNTIME_CAPABILITY_IDS = [
  "setup.local",
  "chat.local",
  "chat.openclaw",
  "brain.read",
  "brain.write",
  "brain.capture",
  "brain.maintenance",
  "imports.uploadFiles",
  "imports.localFolder",
  "execution.openhands.local",
  "execution.openhands.cloud",
  "structuredCritique.hosted",
  "telegram",
] as const;

export type RuntimeCapabilityId = (typeof RUNTIME_CAPABILITY_IDS)[number];

export type RuntimeCapabilityStatus =
  | "ready"
  | "unavailable"
  | "misconfigured"
  | "blocked";

export type RuntimePrivacyClass =
  | "local-only"
  | "local-network"
  | "hosted"
  | "external-network";

export type RuntimeSummaryState = "ready" | "attention" | "blocked";

export interface RuntimeCapabilityEvidence {
  label: string;
  value?: string;
  source?: "env" | "config" | "probe" | "policy" | "smoke" | "user";
  status?: RuntimeCapabilityStatus;
  observedAt?: string;
  stale?: boolean;
}

export interface RuntimeCapability {
  capabilityId: RuntimeCapabilityId;
  label: string;
  status: RuntimeCapabilityStatus;
  privacy: RuntimePrivacyClass;
  requiredForLocalGuarantee: boolean;
  provider?: string;
  model?: string;
  endpoint?: string;
  evidence: RuntimeCapabilityEvidence[];
  nextAction?: string;
}

export interface RuntimeSummary {
  state: RuntimeSummaryState;
  title: string;
  detail: string;
  nextAction?: string;
}

export interface RuntimeLegacyBooleans {
  chat: boolean;
  codeExecution: boolean;
  github: boolean;
  multiChannel: boolean;
  structuredCritique: boolean;
}

export interface RuntimeCapabilityContract {
  generatedAt: string;
  strictLocalOnly: boolean;
  llmProvider: "local" | "openai";
  configuredLocalModel: string;
  capabilities: RuntimeCapability[];
  summary: RuntimeSummary;
  legacy: RuntimeLegacyBooleans;
}
