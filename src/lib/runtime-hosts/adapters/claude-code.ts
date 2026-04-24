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
import { RuntimeHostCapabilityUnsupported } from "../errors";
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
} from "../transport/cli";
import { buildSubscriptionNativeCliEnv } from "../transport/subscription-env";
import {
  buildClaudeCodeRuntimeContext,
  claudeCodeRuntimeContextDataIncluded,
  type ClaudeCodeInvocationContext,
  type ClaudeCodeRuntimeContextBuilder,
} from "./claude-code-context";

function isNativeClaudeCodeSessionId(
  conversationId: string | null,
): conversationId is string {
  return typeof conversationId === "string"
    && conversationId.trim().length > 0
    && conversationId.startsWith("claude-code-") === false;
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
  sessionRoot?: string;
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
  private readonly sessionRoot?: string;
  private readonly enableRuntimeMcp?: boolean;
  private readonly contextBuilder: ClaudeCodeRuntimeContextBuilder;
  private messageEventSequence = 0;

  constructor(options: ClaudeCodeRuntimeHostAdapterOptions = {}) {
    this.runtimeProfile = options.profile ?? requireRuntimeHostProfile("claude-code");
    this.transport = options.transport ?? new LocalCliTransport();
    this.command = options.command ?? this.runtimeProfile.transport.command ?? "claude";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.sessionIdGenerator = options.sessionIdGenerator ?? (() => randomUUID());
    this.healthArgs = options.healthArgs ?? ["--version"];
    this.authArgs = options.authArgs;
    this.env = options.env;
    this.repoRoot = options.repoRoot;
    this.sessionRoot = options.sessionRoot;
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
    const wrapperSessionId =
      request.runtimeSessionId
      ?? request.conversationId
      ?? `claude-code-${this.sessionIdGenerator()}`;
    const stream = new ClaudeCodeStreamAccumulator({
      hostId: this.runtimeProfile.id,
      sessionId: wrapperSessionId,
    });
    const env = this.cliEnv();
    const context = await this.buildRuntimeContext({
      request,
      wrapperSessionId,
      env,
    });
    const result = await this.runWithContextCleanup(context, () =>
      this.transport.run({
        hostId: this.runtimeProfile.id,
        sessionId: wrapperSessionId,
        command: this.command,
        args: this.buildPromptArgs(request, context),
        cwd: context?.cwd,
        env: this.runtimeEnv(env, context),
        timeoutMs: this.timeoutMs,
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
          sessionId: wrapperSessionId,
          lines: result.output.lines,
        });
    const message = parsed.message || result.output.text;
    const nativeSessionId = parsed.nativeSessionId ?? wrapperSessionId;
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
    const wrapperSessionId = request.runtimeSessionId ?? sessionId;
    const now = new Date().toISOString();
    const stream = new ClaudeCodeStreamAccumulator({
      hostId: this.runtimeProfile.id,
      sessionId: wrapperSessionId,
    });
    const env = this.cliEnv();
    const context = await this.buildRuntimeContext({
      request,
      wrapperSessionId,
      env,
    });

    const result = await this.runWithContextCleanup(context, () =>
      this.transport.run({
        hostId: this.runtimeProfile.id,
        sessionId: wrapperSessionId,
        command: this.command,
        args: this.buildPromptArgs(request, context),
        cwd: context?.cwd,
        env: this.runtimeEnv(env, context),
        timeoutMs: this.timeoutMs,
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
          sessionId: wrapperSessionId,
          lines: result.output.lines,
        });
    const message = parsed.message || result.output.text;
    const nativeSessionId = parsed.nativeSessionId
      ?? (isNativeClaudeCodeSessionId(request.conversationId) ? request.conversationId : null);
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
    wrapperSessionId: string;
    env: NodeJS.ProcessEnv;
  }): Promise<ClaudeCodeInvocationContext | null> {
    return await this.contextBuilder({
      ...input,
      repoRoot: this.repoRoot,
      sessionRoot: this.sessionRoot,
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
    if (isNativeClaudeCodeSessionId(request.conversationId)) {
      args.push("--resume", request.conversationId);
    }
    return args;
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

export function createClaudeCodeRuntimeHostAdapter(
  options: ClaudeCodeRuntimeHostAdapterOptions = {},
): ClaudeCodeRuntimeHostAdapter {
  return new ClaudeCodeRuntimeHostAdapter(options);
}
