import type { PrivacyMode } from "@/brain/types";
import type { RuntimePrivacyClass } from "@/lib/runtime/types";

export type { RuntimePrivacyClass };

export const RUNTIME_HOST_IDS = [
  "openclaw",
  "claude-code",
  "codex",
  "gemini-cli",
  "openhands",
] as const;

export type RuntimeHostId = (typeof RUNTIME_HOST_IDS)[number];

export type RuntimeProjectPolicy = PrivacyMode;

export type RuntimeAuthMode = "subscription-native" | "api-key" | "local";

export type RuntimeAuthProvider =
  | "openclaw"
  | "anthropic"
  | "openai"
  | "google-ai"
  | "vertex-ai"
  | "ollama"
  | "openhands";

export type RuntimeTransportKind =
  | "local-cli"
  | "http-api"
  | "managed-openhands"
  | "desktop-bridge";

export type RuntimeTransportProtocol =
  | "stdio"
  | "stdout-jsonl"
  | "pty"
  | "http"
  | "websocket"
  | "deep-link";

export type RuntimeCliTransportMode = "stdio" | "stdout-jsonl" | "pty";

export type RuntimeHostCapability =
  | "chat"
  | "task"
  | "stream"
  | "cancel"
  | "resume"
  | "list-sessions"
  | "mcp-tools"
  | "artifact-import";

export type RuntimeTurnMode =
  | "chat"
  | "task"
  | "compare"
  | "mcp-tool"
  | "artifact-import";

export type RuntimeDataIncludedKind =
  | "prompt"
  | "gbrain-excerpt"
  | "workspace-file"
  | "artifact"
  | "runtime-output"
  | "mcp-tool-call";

export type RuntimeHostLifecycleStatus =
  | "available"
  | "requires-auth"
  | "requires-install"
  | "disabled";

export interface RuntimeHostProfile {
  id: RuntimeHostId;
  label: string;
  authMode: RuntimeAuthMode;
  authProvider: RuntimeAuthProvider;
  privacyClass: RuntimePrivacyClass;
  transport: {
    kind: RuntimeTransportKind;
    protocol: RuntimeTransportProtocol;
    cliMode?: RuntimeCliTransportMode;
    command?: string;
    endpoint?: string;
  };
  controlSurface: {
    owner: "scienceSwarm-wrapper" | "native-host" | "remote-provider";
    sessionIdSource: "scienceSwarm" | "native-host" | "none";
    supportsCancel: boolean;
    supportsResume: boolean;
    supportsNativeSessionList: boolean;
  };
  mcpToolProfile: {
    alwaysExposeTools: string[];
    conditionalWorkspaceTools: string[];
    suppressWhenNativeToolsSafe: string[];
  };
  capabilities: RuntimeHostCapability[];
  requiresProjectPrivacy: RuntimeProjectPolicy;
  dataSent: RuntimeDataIncludedKind[];
  storesTokensInScienceSwarm: false | "api-key-only";
  lifecycle: {
    status: RuntimeHostLifecycleStatus;
    canStream: boolean;
    canCancel: boolean;
    canResumeNativeSession: boolean;
    canListNativeSessions: boolean;
    cancelSemantics: "none" | "kill-wrapper-process" | "host-api-cancel";
    resumeSemantics:
      | "none"
      | "open-native-session"
      | "scienceSwarm-wrapper-session";
  };
}

export interface RuntimeHostPrivacyProof {
  privacyClass: RuntimePrivacyClass;
  adapterProof: "declared-local" | "declared-hosted" | "unknown";
  reason?: string;
  observedAt?: string;
}

export interface RuntimeDataIncluded {
  kind: RuntimeDataIncludedKind;
  label: string;
  bytes?: number;
}

export interface TurnPreview {
  allowed: boolean;
  projectPolicy: RuntimeProjectPolicy;
  hostId: RuntimeHostId;
  mode: RuntimeTurnMode;
  effectivePrivacyClass: RuntimePrivacyClass;
  destinations: Array<{
    hostId: RuntimeHostId;
    label: string;
    privacyClass: RuntimePrivacyClass;
  }>;
  dataIncluded: RuntimeDataIncluded[];
  proof: {
    projectGatePassed: boolean;
    operationPrivacyClass: RuntimePrivacyClass;
    adapterProof: RuntimeHostPrivacyProof["adapterProof"];
  };
  blockReason: string | null;
  requiresUserApproval: boolean;
  accountDisclosure: {
    authMode: RuntimeAuthMode;
    provider: RuntimeAuthProvider;
    billingClass: "local-compute" | "subscription-native" | "api-key";
    accountSource: ".env" | "host-cli-login" | "local-service" | "openhands";
    estimatedRequestBytes?: number;
    compareFanOutCount?: number;
    costCopyRequired: boolean;
  };
}

export type RuntimeApprovalState =
  | "not-required"
  | "required"
  | "approved"
  | "rejected";

export interface RuntimeTurnRequest {
  hostId: RuntimeHostId;
  runtimeSessionId?: string;
  projectId: string | null;
  conversationId: string | null;
  mode: RuntimeTurnMode;
  prompt: string;
  promptHash?: string;
  inputFileRefs: string[];
  dataIncluded: RuntimeDataIncluded[];
  approvalState: RuntimeApprovalState;
  preview: TurnPreview;
  appOrigin?: string | null;
  onEvent?: (event: RuntimeEvent) => void;
}

export interface RuntimeTurnResult {
  hostId: RuntimeHostId;
  sessionId: string;
  message: string;
  events?: RuntimeEvent[];
  artifacts?: ArtifactImportRequest[];
}

export interface RuntimeSessionRecord {
  id: string;
  hostId: RuntimeHostId | string;
  projectId: string | null;
  conversationId: string | null;
  mode: RuntimeTurnMode;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  readOnly?: boolean;
  preview?: TurnPreview;
  errorCode?: string;
  events?: RuntimeEvent[];
}

export interface RuntimeEvent {
  id: string;
  sessionId: string;
  hostId: RuntimeHostId | string;
  type:
    | "message"
    | "status"
    | "tool-call"
    | "artifact"
    | "error"
    | "done";
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface RuntimeHostHealth {
  status: "ready" | "unavailable" | "misconfigured";
  checkedAt: string;
  detail?: string;
  evidence?: Array<{
    label: string;
    value?: string;
  }>;
}

export interface RuntimeHostAuthStatus {
  status: "not-required" | "authenticated" | "missing" | "invalid" | "unknown";
  authMode: RuntimeAuthMode;
  provider: RuntimeAuthProvider;
  accountLabel?: string;
  detail?: string;
}

export interface RuntimeCancelResult {
  sessionId: string;
  cancelled: boolean;
  detail?: string;
}

export interface ArtifactImportRequest {
  sessionId: string;
  hostId: RuntimeHostId | string;
  sourcePath: string;
  sourceNamespace: "project-relative" | "local-absolute" | "host-native";
  targetPath?: string;
  provenance: {
    generatedByHostId: RuntimeHostId | string;
    runtimeSessionId: string;
    privacyClass: RuntimePrivacyClass;
  };
}

export interface ResearchRuntimeHost {
  profile(): RuntimeHostProfile;
  runtimeContextDataIncluded?(input: {
    projectId?: string | null;
  }): RuntimeDataIncluded[];
  health(): Promise<RuntimeHostHealth>;
  authStatus(): Promise<RuntimeHostAuthStatus>;
  privacyProfile(): Promise<RuntimePrivacyClass | RuntimeHostPrivacyProof>;
  sendTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnResult>;
  executeTask(request: RuntimeTurnRequest): Promise<RuntimeSessionRecord>;
  cancel(sessionId: string): Promise<RuntimeCancelResult>;
  listSessions(projectId: string): Promise<RuntimeSessionRecord[]>;
  streamEvents(sessionId: string): AsyncIterable<RuntimeEvent>;
  artifactImportHints(sessionId: string): Promise<ArtifactImportRequest[]>;
}
