import { readFile } from "node:fs/promises";

import {
  getScienceSwarmProjectRoot,
} from "@/lib/scienceswarm-paths";
import {
  startConversation,
  type ConversationStartRequest,
} from "@/lib/openhands";

import type {
  RuntimeDataIncluded,
  RuntimeHostId,
  RuntimeHostProfile,
  RuntimeProjectPolicy,
  TurnPreview,
} from "../contracts";
import {
  createRuntimeConcurrencyManager,
  type RuntimeConcurrencyLane,
  type RuntimeConcurrencyManager,
} from "../concurrency";
import {
  assertTurnPreviewAllowsPromptConstruction,
  computeTurnPreview,
} from "../policy";
import { requireRuntimeHostProfile } from "../registry";
import {
  createRuntimeArtifactRecord,
  validateRuntimeArtifactImport,
  type RuntimeArtifactImportReason,
  type RuntimeArtifactImportValidation,
  type RuntimeArtifactRecord,
} from "../artifacts";
import {
  createRuntimePathMapper,
  type RuntimePathMapper,
  type RuntimePathNamespace,
} from "../path-mapping";
import type { RuntimeApprovalState } from "../contracts";
import {
  validateRuntimeGbrainProvenance,
  type RuntimeGbrainProvenance,
} from "../gbrain-writeback";
import { runtimeMcpToolAllowedForHost } from "./tool-profiles";
import {
  verifyRuntimeMcpAccessToken,
  type RuntimeMcpAccessTokenClaims,
  type RuntimeMcpToolName,
} from "./tokens";

export type RuntimeMcpToolErrorCode =
  | "RUNTIME_MCP_UNAUTHORIZED"
  | "RUNTIME_MCP_TOOL_NOT_ALLOWED"
  | "RUNTIME_MCP_RATE_LIMITED"
  | "RUNTIME_MCP_TOOL_UNAVAILABLE";

export class RuntimeMcpToolError extends Error {
  readonly code: RuntimeMcpToolErrorCode;
  readonly status: number;
  readonly recoverable: boolean;
  readonly context: Record<string, unknown>;

  constructor(input: {
    code: RuntimeMcpToolErrorCode;
    status: number;
    message: string;
    recoverable?: boolean;
    context?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "RuntimeMcpToolError";
    this.code = input.code;
    this.status = input.status;
    this.recoverable = input.recoverable ?? false;
    this.context = input.context ?? {};
  }
}

export interface RuntimeMcpAuthParams {
  token?: string | null;
  projectId: string;
  runtimeSessionId: string;
  hostId: RuntimeHostId | string;
  projectPolicy: RuntimeProjectPolicy;
  approved?: boolean;
}

export interface RuntimeMcpAuthorizationInput extends RuntimeMcpAuthParams {
  toolName: RuntimeMcpToolName;
  dataIncluded?: RuntimeDataIncluded[];
  tokenSecret?: string;
  now?: () => Date;
}

export interface RuntimeMcpAuthorizationResult {
  claims: RuntimeMcpAccessTokenClaims;
  host: RuntimeHostProfile;
  preview: TurnPreview;
}

export interface RuntimeMcpGbrainSearchParams extends RuntimeMcpAuthParams {
  query: string;
  mode?: string;
  limit?: number;
  detail?: string;
}

export interface RuntimeMcpGbrainReadParams extends RuntimeMcpAuthParams {
  path: string;
}

export interface RuntimeMcpGbrainCaptureParams extends RuntimeMcpAuthParams {
  content: string;
  kind?: string;
  title?: string;
  project?: string;
  tags?: string[];
  channel?: string;
  userId?: string;
  runtimeProvenance?: RuntimeGbrainProvenance;
}

export interface RuntimeMcpProjectWorkspaceReadParams extends RuntimeMcpAuthParams {
  workspacePath: string;
  projectRoot?: string;
  maxBytes?: number;
}

export interface RuntimeMcpArtifactImportParams extends RuntimeMcpAuthParams {
  sourcePath: string;
  sourcePathKind: RuntimePathNamespace;
  hostNativePath?: string;
  allowedRoots: string[];
  approvalState: RuntimeApprovalState;
  importReason: RuntimeArtifactImportReason;
  targetPath?: string;
  projectRoot?: string;
  hostWorkspaceRoot?: string;
  requireFile?: boolean;
  promptHash?: string;
  inputFileRefs?: string[];
  importedBy?: string;
  generatedAt?: string;
  gbrainSlug?: string | null;
}

export interface RuntimeMcpOpenHandsDelegateParams extends RuntimeMcpAuthParams {
  task: string;
  repository?: string;
  branch?: string;
  model?: string;
}

export interface RuntimeMcpProvenanceLogParams extends RuntimeMcpAuthParams {
  event: string;
  metadata?: Record<string, unknown>;
  runtimeProvenance?: RuntimeGbrainProvenance;
}

export interface RuntimeMcpProjectWorkspaceReadResult {
  projectId: string;
  workspacePath: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface RuntimeMcpArtifactImportResult {
  validation: RuntimeArtifactImportValidation;
  artifact: RuntimeArtifactRecord | null;
}

export interface RuntimeMcpToolsetDeps {
  tokenSecret?: string;
  now?: () => Date;
  concurrencyManager?: RuntimeConcurrencyManager;
  brainSearch?: (
    params: Omit<RuntimeMcpGbrainSearchParams, keyof RuntimeMcpAuthParams>,
  ) => Promise<unknown>;
  brainRead?: (
    params: Omit<RuntimeMcpGbrainReadParams, keyof RuntimeMcpAuthParams>,
  ) => Promise<unknown>;
  brainCapture?: (
    params: Omit<RuntimeMcpGbrainCaptureParams, keyof RuntimeMcpAuthParams>
      & {
        runtimeOriginated: true;
        runtimeSessionId: string;
        runtimeHostId: RuntimeHostId | string;
      },
  ) => Promise<unknown>;
  projectWorkspaceRead?: (
    params: RuntimeMcpProjectWorkspaceReadParams,
  ) => Promise<RuntimeMcpProjectWorkspaceReadResult>;
  artifactImport?: (
    params: RuntimeMcpArtifactImportParams,
    mapper: RuntimePathMapper,
  ) => Promise<RuntimeMcpArtifactImportResult>;
  openhandsDelegate?: (
    params: Omit<RuntimeMcpOpenHandsDelegateParams, keyof RuntimeMcpAuthParams>,
  ) => Promise<unknown>;
  provenanceLog?: (
    params: Omit<RuntimeMcpProvenanceLogParams, keyof RuntimeMcpAuthParams>,
  ) => Promise<unknown>;
}

function runtimeMcpDataIncluded(input: {
  toolName: RuntimeMcpToolName;
  label: string;
  kind?: RuntimeDataIncluded["kind"];
  bytes?: number;
}): RuntimeDataIncluded[] {
  return [
    {
      kind: input.kind ?? "mcp-tool-call",
      label: `${input.toolName}:${input.label}`,
      bytes: input.bytes,
    },
  ];
}

function authError(message: string, context: Record<string, unknown> = {}): never {
  throw new RuntimeMcpToolError({
    code: "RUNTIME_MCP_UNAUTHORIZED",
    status: 401,
    message,
    recoverable: true,
    context,
  });
}

export function authorizeRuntimeMcpToolCall(
  input: RuntimeMcpAuthorizationInput,
): RuntimeMcpAuthorizationResult {
  const tokenVerification = verifyRuntimeMcpAccessToken({
    token: input.token,
    projectId: input.projectId,
    runtimeSessionId: input.runtimeSessionId,
    hostId: input.hostId,
    toolName: input.toolName,
    now: input.now,
    secret: input.tokenSecret,
  });

  if (!tokenVerification.ok) {
    authError(tokenVerification.message, {
      reason: tokenVerification.reason,
      toolName: input.toolName,
      projectId: input.projectId,
      runtimeSessionId: input.runtimeSessionId,
      hostId: input.hostId,
    });
  }

  const host = requireRuntimeHostProfile(input.hostId);
  if (!runtimeMcpToolAllowedForHost({ host, toolName: input.toolName })) {
    throw new RuntimeMcpToolError({
      code: "RUNTIME_MCP_TOOL_NOT_ALLOWED",
      status: 403,
      message: `Runtime MCP tool ${input.toolName} is not allowed for host ${input.hostId}.`,
      recoverable: true,
      context: {
        toolName: input.toolName,
        hostId: input.hostId,
      },
    });
  }

  const preview = computeTurnPreview({
    projectPolicy: input.projectPolicy,
    host,
    mode: "mcp-tool",
    dataIncluded: input.dataIncluded,
  });
  assertTurnPreviewAllowsPromptConstruction(preview, input.approved ?? false);

  return {
    claims: tokenVerification.claims,
    host,
    preview,
  };
}

function laneForTool(toolName: RuntimeMcpToolName): RuntimeConcurrencyLane {
  return toolName === "gbrain_capture"
    || toolName === "artifact_import"
    || toolName === "openhands_delegate"
    || toolName === "provenance_log"
    ? "mcp-write"
    : "mcp-read";
}

async function withRuntimeMcpToolAuthorization<T>(
  deps: RuntimeMcpToolsetDeps & { concurrencyManager: RuntimeConcurrencyManager },
  input: RuntimeMcpAuthorizationInput,
  operation: (auth: RuntimeMcpAuthorizationResult) => Promise<T>,
): Promise<T> {
  const auth = authorizeRuntimeMcpToolCall(input);
  const concurrencyManager = deps.concurrencyManager;
  const slot = concurrencyManager.requestSlot({
    lane: laneForTool(input.toolName),
    sessionId: input.runtimeSessionId,
    queue: false,
    metadata: {
      toolName: input.toolName,
      hostId: input.hostId,
      projectId: input.projectId,
    },
  });

  if (slot.state !== "running") {
    throw new RuntimeMcpToolError({
      code: "RUNTIME_MCP_RATE_LIMITED",
      status: 429,
      message: `Runtime MCP ${slot.lane} concurrency limit reached.`,
      recoverable: true,
      context: {
        lane: slot.lane,
        toolName: input.toolName,
        projectId: input.projectId,
        runtimeSessionId: input.runtimeSessionId,
      },
    });
  }

  try {
    return await operation(auth);
  } finally {
    concurrencyManager.releaseSlot(slot.id);
  }
}

function toolUnavailable(name: RuntimeMcpToolName): never {
  throw new RuntimeMcpToolError({
    code: "RUNTIME_MCP_TOOL_UNAVAILABLE",
    status: 501,
    message: `Runtime MCP tool ${name} is not configured.`,
    recoverable: true,
    context: { toolName: name },
  });
}

function assertRuntimeGbrainCaptureProvenance(
  input: RuntimeMcpGbrainCaptureParams,
): void {
  if (!input.runtimeProvenance) {
    throw new RuntimeMcpToolError({
      code: "RUNTIME_MCP_UNAUTHORIZED",
      status: 403,
      message: "Runtime-originated gbrain_capture requires RuntimeGbrainProvenance.",
      recoverable: true,
      context: {
        toolName: "gbrain_capture",
        projectId: input.projectId,
        runtimeSessionId: input.runtimeSessionId,
        hostId: input.hostId,
      },
    });
  }

  const error = validateRuntimeGbrainProvenance({
    provenance: input.runtimeProvenance,
    runtimeSessionId: input.runtimeSessionId,
    hostId: input.hostId,
  });
  if (error) {
    throw new RuntimeMcpToolError({
      code: "RUNTIME_MCP_UNAUTHORIZED",
      status: 403,
      message: error.message,
      recoverable: true,
      context: {
        toolName: "gbrain_capture",
        projectId: input.projectId,
        runtimeSessionId: input.runtimeSessionId,
        hostId: input.hostId,
      },
    });
  }
}

async function defaultProjectWorkspaceRead(
  input: RuntimeMcpProjectWorkspaceReadParams,
): Promise<RuntimeMcpProjectWorkspaceReadResult> {
  const projectRoot = input.projectRoot ?? getScienceSwarmProjectRoot(input.projectId);
  const mapper = createRuntimePathMapper({
    projectId: input.projectId,
    hostId: input.hostId,
    projectRoot,
  });
  const mapping = mapper.fromProjectRelative(input.workspacePath);
  const maxBytes = input.maxBytes ?? 64_000;
  const bytes = await readFile(mapping.localAbsolutePath);
  const visibleBytes = bytes.subarray(0, maxBytes);

  return {
    projectId: input.projectId,
    workspacePath: mapping.projectRelativePath,
    content: visibleBytes.toString("utf-8"),
    bytes: bytes.length,
    truncated: bytes.length > visibleBytes.length,
  };
}

function pathMapperForArtifactImport(
  input: RuntimeMcpArtifactImportParams,
): RuntimePathMapper {
  return createRuntimePathMapper({
    projectId: input.projectId,
    hostId: input.hostId,
    projectRoot: input.projectRoot ?? getScienceSwarmProjectRoot(input.projectId),
    hostWorkspaceRoot: input.hostWorkspaceRoot,
  });
}

async function defaultArtifactImport(
  input: RuntimeMcpArtifactImportParams,
  mapper: RuntimePathMapper,
): Promise<RuntimeMcpArtifactImportResult> {
  const validation = await validateRuntimeArtifactImport({
    projectId: input.projectId,
    sourceHostId: input.hostId,
    sourceSessionId: input.runtimeSessionId,
    sourcePath: input.sourcePath,
    sourcePathKind: input.sourcePathKind,
    hostNativePath: input.hostNativePath,
    allowedRoots: input.allowedRoots,
    approvalState: input.approvalState,
    importReason: input.importReason,
    targetPath: input.targetPath,
    requireFile: input.requireFile,
    pathMapper: mapper,
  });

  if (!validation.ok) {
    return { validation, artifact: null };
  }

  return {
    validation,
    artifact: createRuntimeArtifactRecord({
      projectId: input.projectId,
      sourceHostId: input.hostId,
      sourceSessionId: input.runtimeSessionId,
      sourcePath: input.sourcePath,
      workspacePath: validation.mapping.projectRelativePath,
      promptHash: input.promptHash ?? "runtime-mcp",
      inputFileRefs: input.inputFileRefs ?? [],
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      importedBy: input.importedBy ?? "runtime-mcp",
      approvalState: input.approvalState,
      gbrainSlug: input.gbrainSlug,
    }),
  };
}

async function defaultOpenHandsDelegate(
  input: Omit<RuntimeMcpOpenHandsDelegateParams, keyof RuntimeMcpAuthParams>,
): Promise<unknown> {
  const request: ConversationStartRequest = {
    message: input.task,
    repository: input.repository,
    branch: input.branch,
    model: input.model,
  };
  return startConversation(request);
}

async function defaultProvenanceLog(
  input: Omit<RuntimeMcpProvenanceLogParams, keyof RuntimeMcpAuthParams>,
): Promise<unknown> {
  return {
    status: "accepted",
    event: input.event,
    metadata: input.metadata ?? {},
    runtimeProvenance: input.runtimeProvenance ?? null,
  };
}

export function createRuntimeMcpToolset(deps: RuntimeMcpToolsetDeps = {}) {
  const toolsetDeps = {
    ...deps,
    concurrencyManager: deps.concurrencyManager
      ?? createRuntimeConcurrencyManager(),
  };

  return {
    gbrainSearch(input: RuntimeMcpGbrainSearchParams): Promise<unknown> {
      return withRuntimeMcpToolAuthorization(
        toolsetDeps,
        {
          ...input,
          toolName: "gbrain_search",
          tokenSecret: toolsetDeps.tokenSecret,
          now: toolsetDeps.now,
          dataIncluded: runtimeMcpDataIncluded({
            toolName: "gbrain_search",
            label: input.query,
            kind: "gbrain-excerpt",
          }),
        },
        () => {
          if (!toolsetDeps.brainSearch) toolUnavailable("gbrain_search");
          const { query, mode, limit, detail } = input;
          return toolsetDeps.brainSearch({ query, mode, limit, detail });
        },
      );
    },

    gbrainRead(input: RuntimeMcpGbrainReadParams): Promise<unknown> {
      return withRuntimeMcpToolAuthorization(
        toolsetDeps,
        {
          ...input,
          toolName: "gbrain_read",
          tokenSecret: toolsetDeps.tokenSecret,
          now: toolsetDeps.now,
          dataIncluded: runtimeMcpDataIncluded({
            toolName: "gbrain_read",
            label: input.path,
            kind: "gbrain-excerpt",
          }),
        },
        () => {
          if (!toolsetDeps.brainRead) toolUnavailable("gbrain_read");
          return toolsetDeps.brainRead({ path: input.path });
        },
      );
    },

    gbrainCapture(input: RuntimeMcpGbrainCaptureParams): Promise<unknown> {
      return withRuntimeMcpToolAuthorization(
        toolsetDeps,
        {
          ...input,
          toolName: "gbrain_capture",
          tokenSecret: toolsetDeps.tokenSecret,
          now: toolsetDeps.now,
          dataIncluded: runtimeMcpDataIncluded({
            toolName: "gbrain_capture",
            label: input.title ?? input.project ?? input.runtimeSessionId,
            kind: "runtime-output",
          }),
        },
        () => {
          if (!toolsetDeps.brainCapture) toolUnavailable("gbrain_capture");
          assertRuntimeGbrainCaptureProvenance(input);
          const {
            content,
            kind,
            title,
            project,
            tags,
            channel,
            userId,
            runtimeProvenance,
          } = input;
          return toolsetDeps.brainCapture({
            content,
            kind,
            title,
            project,
            tags,
            channel,
            userId,
            runtimeProvenance,
            runtimeOriginated: true,
            runtimeSessionId: input.runtimeSessionId,
            runtimeHostId: input.hostId,
          });
        },
      );
    },

    projectWorkspaceRead(
      input: RuntimeMcpProjectWorkspaceReadParams,
    ): Promise<RuntimeMcpProjectWorkspaceReadResult> {
      return withRuntimeMcpToolAuthorization(
        toolsetDeps,
        {
          ...input,
          toolName: "project_workspace_read",
          tokenSecret: toolsetDeps.tokenSecret,
          now: toolsetDeps.now,
          dataIncluded: runtimeMcpDataIncluded({
            toolName: "project_workspace_read",
            label: input.workspacePath,
            kind: "workspace-file",
            bytes: input.maxBytes,
          }),
        },
        () => (toolsetDeps.projectWorkspaceRead ?? defaultProjectWorkspaceRead)(input),
      );
    },

    artifactImport(
      input: RuntimeMcpArtifactImportParams,
    ): Promise<RuntimeMcpArtifactImportResult> {
      return withRuntimeMcpToolAuthorization(
        toolsetDeps,
        {
          ...input,
          toolName: "artifact_import",
          tokenSecret: toolsetDeps.tokenSecret,
          now: toolsetDeps.now,
          dataIncluded: runtimeMcpDataIncluded({
            toolName: "artifact_import",
            label: input.sourcePath,
            kind: "artifact",
          }),
        },
        () => {
          const mapper = pathMapperForArtifactImport(input);
          return (toolsetDeps.artifactImport ?? defaultArtifactImport)(input, mapper);
        },
      );
    },

    openhandsDelegate(input: RuntimeMcpOpenHandsDelegateParams): Promise<unknown> {
      return withRuntimeMcpToolAuthorization(
        toolsetDeps,
        {
          ...input,
          toolName: "openhands_delegate",
          tokenSecret: toolsetDeps.tokenSecret,
          now: toolsetDeps.now,
          dataIncluded: runtimeMcpDataIncluded({
            toolName: "openhands_delegate",
            label: input.task,
            kind: "mcp-tool-call",
          }),
        },
        () => {
          const { task, repository, branch, model } = input;
          return (toolsetDeps.openhandsDelegate ?? defaultOpenHandsDelegate)({
            task,
            repository,
            branch,
            model,
          });
        },
      );
    },

    provenanceLog(input: RuntimeMcpProvenanceLogParams): Promise<unknown> {
      return withRuntimeMcpToolAuthorization(
        toolsetDeps,
        {
          ...input,
          toolName: "provenance_log",
          tokenSecret: toolsetDeps.tokenSecret,
          now: toolsetDeps.now,
          dataIncluded: runtimeMcpDataIncluded({
            toolName: "provenance_log",
            label: input.event,
            kind: "mcp-tool-call",
          }),
        },
        () => {
          const { event, metadata, runtimeProvenance } = input;
          return (toolsetDeps.provenanceLog ?? defaultProvenanceLog)({
            event,
            metadata,
            runtimeProvenance,
          });
        },
      );
    },
  };
}
