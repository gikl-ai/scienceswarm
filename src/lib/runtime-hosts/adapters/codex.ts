import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import type {
  ArtifactImportRequest,
  ResearchRuntimeHost,
  RuntimeCancelResult,
  RuntimeDataIncluded,
  RuntimeEvent,
  RuntimeHostAuthStatus,
  RuntimeHostHealth,
  RuntimeHostProfile,
  RuntimeHostPrivacyProof,
  RuntimePrivacyClass,
  RuntimeSessionRecord,
  RuntimeTurnRequest,
  RuntimeTurnResult,
} from "../contracts";
import { RuntimeHostCapabilityUnsupported } from "../errors";
import {
  assertHostSupportsTurnMode,
  assertTurnPreviewAllowsPromptConstruction,
} from "../policy";
import { requireRuntimeHostProfile } from "../registry";
import { resolveRuntimeMcpToolProfile } from "../mcp/tool-profiles";
import {
  mintRuntimeMcpAccessToken,
  type RuntimeMcpToolName,
} from "../mcp/tokens";
import {
  LocalCliTransport,
  detectCliAuthStatus,
  detectCliHealth,
  type CliTransport,
} from "../transport/cli";
import { buildSubscriptionNativeCliEnv } from "../transport/subscription-env";

const DEFAULT_RUNTIME_MCP_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface CodexRuntimeMcpContext {
  configArgs: string[];
  env: Record<string, string>;
  prompt: string;
  allowedTools: RuntimeMcpToolName[];
}

export interface CodexRuntimeHostAdapterOptions {
  profile?: RuntimeHostProfile;
  transport?: CliTransport;
  command?: string;
  timeoutMs?: number;
  sessionIdGenerator?: () => string;
  healthArgs?: string[];
  authArgs?: string[];
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  repoRoot?: string;
  enableRuntimeMcp?: boolean;
}

export class CodexRuntimeHostAdapter implements ResearchRuntimeHost {
  private readonly runtimeProfile: RuntimeHostProfile;
  private readonly transport: CliTransport;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly sessionIdGenerator: () => string;
  private readonly healthArgs: string[];
  private readonly authArgs?: string[];
  private readonly env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  private readonly repoRoot?: string;
  private readonly enableRuntimeMcp?: boolean;
  private messageEventSequence = 0;

  constructor(options: CodexRuntimeHostAdapterOptions = {}) {
    this.runtimeProfile = options.profile ?? requireRuntimeHostProfile("codex");
    this.transport = options.transport ?? new LocalCliTransport();
    this.command =
      options.command ?? this.runtimeProfile.transport.command ?? "codex";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.sessionIdGenerator =
      options.sessionIdGenerator ?? (() => randomUUID());
    this.healthArgs = options.healthArgs ?? ["--version"];
    this.authArgs = options.authArgs;
    this.env = options.env;
    this.repoRoot = options.repoRoot;
    this.enableRuntimeMcp = options.enableRuntimeMcp;
  }

  profile(): RuntimeHostProfile {
    return this.runtimeProfile;
  }

  runtimeContextDataIncluded(input: {
    projectId?: string | null;
  }): RuntimeDataIncluded[] {
    return codexRuntimeContextDataIncluded({
      projectId: input.projectId,
      includeRuntimeMcp: this.enableRuntimeMcp !== false,
    });
  }

  async health(): Promise<RuntimeHostHealth> {
    return await detectCliHealth({
      hostId: this.runtimeProfile.id,
      command: this.command,
      args: this.healthArgs,
      env: this.cliEnv(),
      transport: this.transport,
    });
  }

  async authStatus(): Promise<RuntimeHostAuthStatus> {
    return await detectCliAuthStatus({
      authMode: this.runtimeProfile.authMode,
      provider: this.runtimeProfile.authProvider,
      hostId: this.runtimeProfile.id,
      command: this.command,
      args: this.authArgs,
      env: this.cliEnv(),
      transport: this.transport,
    });
  }

  async privacyProfile(): Promise<
    RuntimePrivacyClass | RuntimeHostPrivacyProof
  > {
    return {
      privacyClass: this.runtimeProfile.privacyClass,
      adapterProof: "declared-hosted",
      reason: "Codex CLI execution is owned by the user's OpenAI account.",
      observedAt: new Date().toISOString(),
    };
  }

  async sendTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnResult> {
    this.assertCanSend(request);
    const sessionId =
      request.conversationId ?? `codex-${this.sessionIdGenerator()}`;
    const wrapperSessionId = request.runtimeSessionId ?? sessionId;
    const env = this.cliEnv();
    const context = this.buildRuntimeMcpContext({
      request,
      runtimeSessionId: wrapperSessionId,
      env,
    });
    const result = await this.transport.run({
      hostId: this.runtimeProfile.id,
      sessionId: wrapperSessionId,
      command: this.command,
      args: [
        "exec",
        "--json",
        ...(context?.configArgs ?? []),
        context?.prompt ?? request.prompt,
      ],
      env: this.runtimeEnv(env, context),
      timeoutMs: this.timeoutMs,
    });

    return {
      hostId: this.runtimeProfile.id,
      sessionId,
      message: result.output.text,
      events: [
        this.messageEvent({
          sessionId,
          text: result.output.text,
        }),
      ],
    };
  }

  async executeTask(
    request: RuntimeTurnRequest,
  ): Promise<RuntimeSessionRecord> {
    this.assertCanSend(request);
    const sessionId = `codex-task-${this.sessionIdGenerator()}`;
    const wrapperSessionId = request.runtimeSessionId ?? sessionId;
    const now = new Date().toISOString();
    const env = this.cliEnv();
    const context = this.buildRuntimeMcpContext({
      request,
      runtimeSessionId: wrapperSessionId,
      env,
    });

    await this.transport.run({
      hostId: this.runtimeProfile.id,
      sessionId: wrapperSessionId,
      command: this.command,
      args: [
        "exec",
        "--json",
        ...(context?.configArgs ?? []),
        context?.prompt ?? request.prompt,
      ],
      env: this.runtimeEnv(env, context),
      timeoutMs: this.timeoutMs,
    });

    return {
      id: sessionId,
      hostId: this.runtimeProfile.id,
      projectId: request.projectId,
      conversationId: request.conversationId,
      mode: request.mode,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      preview: request.preview,
    };
  }

  async cancel(sessionId: string): Promise<RuntimeCancelResult> {
    const cancelled = (await this.transport.cancel?.(sessionId)) ?? false;
    return {
      sessionId,
      cancelled,
      detail: cancelled
        ? "Stopped the ScienceSwarm wrapper process."
        : "No active Codex wrapper process was found.",
    };
  }

  async listSessions(_projectId: string): Promise<RuntimeSessionRecord[]> {
    throw new RuntimeHostCapabilityUnsupported({
      hostId: this.runtimeProfile.id,
      capability: "list-sessions",
    });
  }

  async *streamEvents(_sessionId: string): AsyncIterable<RuntimeEvent> {
    return;
  }

  async artifactImportHints(
    _sessionId: string,
  ): Promise<ArtifactImportRequest[]> {
    return [];
  }

  private assertCanSend(request: RuntimeTurnRequest): void {
    assertHostSupportsTurnMode(this.runtimeProfile, request.mode);
    assertTurnPreviewAllowsPromptConstruction(
      request.preview,
      request.approvalState === "approved",
    );
  }

  private buildRuntimeMcpContext(input: {
    request: RuntimeTurnRequest;
    runtimeSessionId: string;
    env: NodeJS.ProcessEnv;
  }): CodexRuntimeMcpContext | null {
    return buildCodexRuntimeMcpContext({
      request: input.request,
      runtimeSessionId: input.runtimeSessionId,
      env: input.env,
      repoRoot: this.repoRoot,
      enableRuntimeMcp: this.enableRuntimeMcp,
    });
  }

  private runtimeEnv(
    env: NodeJS.ProcessEnv,
    context?: CodexRuntimeMcpContext | null,
  ): NodeJS.ProcessEnv {
    return context?.env ? { ...env, ...context.env } : env;
  }

  private cliEnv(): NodeJS.ProcessEnv {
    const baseEnv = typeof this.env === "function" ? this.env() : this.env;
    return buildSubscriptionNativeCliEnv(
      this.runtimeProfile.authProvider,
      baseEnv ?? process.env,
    );
  }

  private messageEvent(input: {
    sessionId: string;
    text: string;
  }): RuntimeEvent {
    this.messageEventSequence += 1;
    return {
      id: `${input.sessionId}:message-${this.messageEventSequence}`,
      sessionId: input.sessionId,
      hostId: this.runtimeProfile.id,
      type: "message",
      createdAt: new Date().toISOString(),
      payload: {
        text: input.text,
      },
    };
  }
}

export function createCodexRuntimeHostAdapter(
  options: CodexRuntimeHostAdapterOptions = {},
): CodexRuntimeHostAdapter {
  return new CodexRuntimeHostAdapter(options);
}

export function codexRuntimeContextDataIncluded(input: {
  projectId?: string | null;
  includeRuntimeMcp?: boolean;
}): RuntimeDataIncluded[] {
  if (!input.projectId || input.includeRuntimeMcp === false) return [];
  return [
    {
      kind: "mcp-tool-call",
      label: "Scoped gbrain MCP tools",
    },
  ];
}

export function buildCodexRuntimeMcpContext(input: {
  request: RuntimeTurnRequest;
  runtimeSessionId: string;
  env: NodeJS.ProcessEnv;
  repoRoot?: string;
  enableRuntimeMcp?: boolean;
  tokenTtlMs?: number;
}): CodexRuntimeMcpContext | null {
  if (input.enableRuntimeMcp === false || !input.request.projectId) {
    return null;
  }

  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const projectId = input.request.projectId;
  const allowedTools = resolveRuntimeMcpToolProfile("codex").allowedTools;
  const token = mintRuntimeMcpAccessToken({
    projectId,
    runtimeSessionId: input.runtimeSessionId,
    hostId: "codex",
    allowedTools,
    ttlMs: input.tokenTtlMs ?? DEFAULT_RUNTIME_MCP_TOKEN_TTL_MS,
    secret: randomBytes(32).toString("base64url"),
  });
  const shell = input.env.SCIENCESWARM_RUNTIME_MCP_SHELL ?? "/bin/sh";
  const command = [
    "cd",
    shellQuote(repoRoot),
    "&&",
    "NODE_OPTIONS=--preserve-symlinks",
    "npx",
    "tsx",
    "src/lib/runtime-hosts/mcp/runtime-stdio-server.ts",
  ].join(" ");
  const instructions = buildCodexRuntimeMcpInstructions({
    projectId,
    runtimeSessionId: input.runtimeSessionId,
    projectPolicy: input.request.preview.projectPolicy,
    approvalStateApproved:
      input.request.approvalState === "approved" ||
      input.request.approvalState === "not-required",
    allowedTools,
  });

  return {
    configArgs: [
      "-c",
      `mcp_servers.scienceswarm.command=${tomlString(shell)}`,
      "-c",
      `mcp_servers.scienceswarm.args=${tomlStringArray(["-c", command])}`,
      "-c",
      `mcp_servers.scienceswarm.env_vars=${tomlStringArray([
        "SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN",
        "BRAIN_ROOT",
        "SCIENCESWARM_DIR",
        "NODE_ENV",
        "PATH",
      ])}`,
      "-c",
      `mcp_servers.scienceswarm.enabled_tools=${tomlStringArray(allowedTools)}`,
      "-c",
      "mcp_servers.scienceswarm.enabled=true",
    ],
    env: {
      SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN: token,
    },
    prompt: [instructions, "", "User prompt:", input.request.prompt].join("\n"),
    allowedTools,
  };
}

function buildCodexRuntimeMcpInstructions(input: {
  projectId: string;
  runtimeSessionId: string;
  projectPolicy: RuntimeTurnRequest["preview"]["projectPolicy"];
  approvalStateApproved: boolean;
  allowedTools: readonly RuntimeMcpToolName[];
}): string {
  return [
    "A runtime-scoped MCP server named `scienceswarm` is available for selective gbrain access.",
    "Use search before read. Prefer narrow queries tied to the user's project or named artifact.",
    "Do not enumerate the whole brain or read broad directories.",
    "ScienceSwarm injects runtime MCP authorization through the Codex subprocess environment.",
    "Do not ask the user for bearer tokens, and do not write token values into prompts, files, or captured notes.",
    "",
    "For each `scienceswarm` MCP call, include these non-secret auth fields exactly:",
    `- projectId: ${input.projectId}`,
    `- runtimeSessionId: ${input.runtimeSessionId}`,
    "- hostId: codex",
    `- projectPolicy: ${input.projectPolicy}`,
    `- approved: ${input.approvalStateApproved ? "true" : "false"}`,
    "",
    `Allowed tools: ${input.allowedTools.join(", ")}.`,
    "For runtime-originated gbrain writes, include RuntimeGbrainProvenance matching this session.",
  ].join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
