import { randomUUID } from "node:crypto";

import type {
  ArtifactImportRequest,
  ResearchRuntimeHost,
  RuntimeCancelResult,
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
import {
  RuntimeHostCapabilityUnsupported,
  RuntimeHostError,
} from "../errors";
import {
  assertHostSupportsTurnMode,
  assertTurnPreviewAllowsPromptConstruction,
} from "../policy";
import { requireRuntimeHostProfile } from "../registry";
import {
  ClaudeCodeStreamAccumulator,
  parseClaudeCodeStreamOutput,
} from "../transport/claude-code-stream";
import {
  LocalCliTransport,
  detectCliAuthStatus,
  detectCliHealth,
  type CliTransport,
  type CliTransportRunResult,
} from "../transport/cli";
import { buildSubscriptionNativeCliEnv } from "../transport/subscription-env";
import {
  buildClaudeCodeRuntimeContext,
  claudeCodeRuntimeContextDataIncluded,
  type ClaudeCodeInvocationContext,
  type ClaudeCodeRuntimeContextBuilder,
} from "./claude-code-context";
import { runtimeRunIdFromSessionId } from "../workspace";

function isNativeClaudeCodeSessionId(
  conversationId: string | null,
): conversationId is string {
  return typeof conversationId === "string"
    && conversationId.trim().length > 0
    && conversationId.startsWith("claude-code-") === false;
}

// Scientific execution turns can legitimately spend many minutes inside
// domain tools before returning a final assistant message.
const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = 30 * 60_000;
const CLAUDE_CODE_STDOUT_IDLE_SETTLE_MS = 20_000;

function isMissingClaudeCodeConversationError(error: unknown): boolean {
  const text = error instanceof RuntimeHostError
    ? [
        error.message,
        error.userMessage,
        typeof error.context.stderr === "string" ? error.context.stderr : "",
      ].join("\n")
    : error instanceof Error
      ? error.message
      : String(error);
  return /No conversation found with session ID/i.test(text);
}

interface ClaudeCodeLaunchPlan {
  wrapperSessionId: string;
  nativeSessionId: string;
  resumeSessionId: string | null;
  runId: string;
}

export interface ClaudeCodeRuntimeHostAdapterOptions {
  profile?: RuntimeHostProfile;
  transport?: CliTransport;
  command?: string;
  timeoutMs?: number;
  sessionIdGenerator?: () => string;
  healthArgs?: string[];
  authArgs?: string[];
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  repoRoot?: string;
  dataRoot?: string;
  enableRuntimeMcp?: boolean;
  contextBuilder?: ClaudeCodeRuntimeContextBuilder;
}

export class ClaudeCodeRuntimeHostAdapter implements ResearchRuntimeHost {
  private readonly runtimeProfile: RuntimeHostProfile;
  private readonly transport: CliTransport;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly sessionIdGenerator: () => string;
  private readonly healthArgs: string[];
  private readonly authArgs?: string[];
  private readonly env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  private readonly repoRoot?: string;
  private readonly dataRoot?: string;
  private readonly enableRuntimeMcp?: boolean;
  private readonly contextBuilder: ClaudeCodeRuntimeContextBuilder;
  private messageEventSequence = 0;

  constructor(options: ClaudeCodeRuntimeHostAdapterOptions = {}) {
    this.runtimeProfile = options.profile ?? requireRuntimeHostProfile("claude-code");
    this.transport = options.transport ?? new LocalCliTransport();
    this.command = options.command ?? this.runtimeProfile.transport.command ?? "claude";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_CODE_TIMEOUT_MS;
    this.sessionIdGenerator = options.sessionIdGenerator ?? (() => randomUUID());
    this.healthArgs = options.healthArgs ?? ["--version"];
    this.authArgs = options.authArgs;
    this.env = options.env;
    this.repoRoot = options.repoRoot;
    this.dataRoot = options.dataRoot;
    this.enableRuntimeMcp = options.enableRuntimeMcp;
    this.contextBuilder = options.contextBuilder ?? buildClaudeCodeRuntimeContext;
  }

  profile(): RuntimeHostProfile {
    return this.runtimeProfile;
  }

  runtimeContextDataIncluded(input: {
    projectId?: string | null;
  }) {
    return claudeCodeRuntimeContextDataIncluded({
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

  async privacyProfile(): Promise<RuntimePrivacyClass | RuntimeHostPrivacyProof> {
    return {
      privacyClass: this.runtimeProfile.privacyClass,
      adapterProof: "declared-hosted",
      reason: "Claude Code subscription-native execution is owned by the Anthropic host account.",
      observedAt: new Date().toISOString(),
    };
  }

  async sendTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnResult> {
    this.assertCanSend(request);
    let launch = this.buildLaunchPlan(request);
    let invocation: Awaited<ReturnType<typeof this.invokeClaudeCode>>;
    try {
      invocation = await this.invokeClaudeCode(request, launch);
    } catch (error) {
      if (!launch.resumeSessionId || !isMissingClaudeCodeConversationError(error)) {
        throw error;
      }
      launch = this.buildLaunchPlan(request, { forceFresh: true });
      invocation = await this.invokeClaudeCode(request, launch);
    }

    const { wrapperSessionId, parsed, result } = invocation;
    const message = parsed.message || result.output.text;
    const nativeSessionId = parsed.nativeSessionId ?? launch.nativeSessionId;
    const events = parsed.events.some((event) =>
      event.type === "message" && typeof event.payload.text === "string"
    )
      ? parsed.events
      : [
          ...parsed.events,
          this.messageEvent({ sessionId: wrapperSessionId, text: message, nativeSessionId }),
        ];

    return {
      hostId: this.runtimeProfile.id,
      sessionId: nativeSessionId,
      message,
      events,
    };
  }

  async executeTask(request: RuntimeTurnRequest): Promise<RuntimeSessionRecord> {
    this.assertCanSend(request);
    const sessionId = `claude-code-task-${this.sessionIdGenerator()}`;
    const launch = this.buildLaunchPlan({
      ...request,
      runtimeSessionId: request.runtimeSessionId ?? sessionId,
    });
    const now = new Date().toISOString();
    const { wrapperSessionId, parsed, result } = await this.invokeClaudeCode(request, launch);
    const message = parsed.message || result.output.text;
    const nativeSessionId = parsed.nativeSessionId ?? launch.nativeSessionId;
    const events = parsed.events.some((event) =>
      event.type === "message" && typeof event.payload.text === "string"
    )
      ? parsed.events
      : [
          ...parsed.events,
          this.messageEvent({
            sessionId: wrapperSessionId,
            text: message,
            nativeSessionId: nativeSessionId ?? wrapperSessionId,
          }),
        ];

    return {
      id: nativeSessionId ?? wrapperSessionId,
      hostId: this.runtimeProfile.id,
      projectId: request.projectId,
      conversationId: nativeSessionId,
      mode: request.mode,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      preview: request.preview,
      events,
    };
  }

  async cancel(sessionId: string): Promise<RuntimeCancelResult> {
    const cancelled = await this.transport.cancel?.(sessionId) ?? false;
    return {
      sessionId,
      cancelled,
      detail: cancelled
        ? "Stopped the ScienceSwarm wrapper process."
        : "No active Claude Code wrapper process was found.",
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

  private cliEnv(): NodeJS.ProcessEnv {
    const baseEnv = typeof this.env === "function" ? this.env() : this.env;
    return buildSubscriptionNativeCliEnv(
      this.runtimeProfile.authProvider,
      baseEnv ?? process.env,
    );
  }

  private async buildRuntimeContext(input: {
    request: RuntimeTurnRequest;
    launch: ClaudeCodeLaunchPlan;
    env: NodeJS.ProcessEnv;
  }): Promise<ClaudeCodeInvocationContext | null> {
    return await this.contextBuilder({
      request: input.request,
      wrapperSessionId: input.launch.wrapperSessionId,
      nativeSessionId: input.launch.nativeSessionId,
      runId: input.launch.runId,
      env: input.env,
      repoRoot: this.repoRoot,
      dataRoot: this.dataRoot,
      enableRuntimeMcp: this.enableRuntimeMcp,
    });
  }

  private runtimeEnv(
    env: NodeJS.ProcessEnv,
    context?: ClaudeCodeInvocationContext | null,
  ): NodeJS.ProcessEnv {
    return context?.env ? { ...env, ...context.env } : env;
  }

  private async runWithContextCleanup<T>(
    context: ClaudeCodeInvocationContext | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } finally {
      await context?.cleanup?.().catch(() => undefined);
    }
  }

  private buildPromptArgs(
    request: RuntimeTurnRequest,
    launch: ClaudeCodeLaunchPlan,
    context?: ClaudeCodeInvocationContext | null,
  ): string[] {
    const args = [
      "-p",
      request.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (context?.appendSystemPrompt) {
      args.push("--append-system-prompt", context.appendSystemPrompt);
    }
    if (context?.addDirs?.length) {
      args.push("--add-dir", ...context.addDirs);
    }
    if (context?.mcpConfigPath) {
      args.push("--mcp-config", context.mcpConfigPath, "--strict-mcp-config");
    }
    if (context?.allowedTools?.length) {
      args.push("--allowedTools", context.allowedTools.join(","));
    }
    if (launch.resumeSessionId) {
      args.push("--resume", launch.resumeSessionId);
    } else {
      args.push("--session-id", launch.nativeSessionId);
    }
    return args;
  }

  private buildLaunchPlan(
    request: RuntimeTurnRequest,
    options: { forceFresh?: boolean } = {},
  ): ClaudeCodeLaunchPlan {
    const resumeSessionId = !options.forceFresh && isNativeClaudeCodeSessionId(request.conversationId)
      ? request.conversationId
      : null;
    const nativeSessionId = resumeSessionId ?? this.sessionIdGenerator();
    const wrapperSessionId =
      request.runtimeSessionId
      ?? (!options.forceFresh && request.conversationId
        ? request.conversationId
        : `claude-code-${nativeSessionId}`);
    return {
      wrapperSessionId,
      nativeSessionId,
      resumeSessionId,
      runId: runtimeRunIdFromSessionId(wrapperSessionId),
    };
  }

  private async invokeClaudeCode(
    request: RuntimeTurnRequest,
    launch: ClaudeCodeLaunchPlan,
  ): Promise<{
    wrapperSessionId: string;
    result: CliTransportRunResult;
    parsed: ReturnType<typeof parseClaudeCodeStreamOutput>;
  }> {
    const stream = new ClaudeCodeStreamAccumulator({
      hostId: this.runtimeProfile.id,
      sessionId: launch.wrapperSessionId,
    });
    const env = this.cliEnv();
    const context = await this.buildRuntimeContext({
      request,
      launch,
      env,
    });
    const result = await this.runWithContextCleanup(context, () =>
      this.transport.run({
        hostId: this.runtimeProfile.id,
        sessionId: launch.wrapperSessionId,
        command: this.command,
        args: this.buildPromptArgs(request, launch, context),
        cwd: context?.cwd,
        env: this.runtimeEnv(env, context),
        timeoutMs: this.timeoutMs,
        settleAfterStdoutIdleMs: CLAUDE_CODE_STDOUT_IDLE_SETTLE_MS,
        settleAfterStdoutIdleWhen: isClaudeCodeTerminalResultLine,
        onStdoutLine: (line) => {
          const event = stream.acceptLine(line);
          if (event) request.onEvent?.(event);
        },
      })
    );
    const parsed = stream.hasLines
      ? stream.result()
      : parseClaudeCodeStreamOutput({
          hostId: this.runtimeProfile.id,
          sessionId: launch.wrapperSessionId,
          lines: result.output.lines,
        });

    return {
      wrapperSessionId: launch.wrapperSessionId,
      result,
      parsed,
    };
  }

  private messageEvent(input: {
    sessionId: string;
    text: string;
    nativeSessionId?: string;
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
        nativeSessionId: input.nativeSessionId ?? input.sessionId,
      },
    };
  }
}

function isClaudeCodeTerminalResultLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line.trim()) as unknown;
    return Boolean(
      parsed
        && typeof parsed === "object"
        && !Array.isArray(parsed)
        && (parsed as { type?: unknown }).type === "result",
    );
  } catch {
    return false;
  }
}

export function createClaudeCodeRuntimeHostAdapter(
  options: ClaudeCodeRuntimeHostAdapterOptions = {},
): ClaudeCodeRuntimeHostAdapter {
  return new ClaudeCodeRuntimeHostAdapter(options);
}
