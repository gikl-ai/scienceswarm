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

export interface ClaudeCodeRuntimeHostAdapterOptions {
  profile?: RuntimeHostProfile;
  transport?: CliTransport;
  command?: string;
  timeoutMs?: number;
  sessionIdGenerator?: () => string;
  healthArgs?: string[];
  authArgs?: string[];
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
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
  }

  profile(): RuntimeHostProfile {
    return this.runtimeProfile;
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
    const sessionId = request.conversationId ?? `claude-code-${this.sessionIdGenerator()}`;
    const stream = new ClaudeCodeStreamAccumulator({
      hostId: this.runtimeProfile.id,
      sessionId,
    });
    const result = await this.transport.run({
      hostId: this.runtimeProfile.id,
      command: this.command,
      args: this.buildPromptArgs(request),
      env: this.cliEnv(),
      timeoutMs: this.timeoutMs,
      onStdoutLine: (line) => {
        const event = stream.acceptLine(line);
        if (event) request.onEvent?.(event);
      },
    });
    const parsed = stream.hasLines
      ? stream.result()
      : parseClaudeCodeStreamOutput({
          hostId: this.runtimeProfile.id,
          sessionId,
          lines: result.output.lines,
        });
    const message = parsed.message || result.output.text;
    const nativeSessionId = parsed.nativeSessionId ?? sessionId;
    const events = parsed.events.some((event) =>
      event.type === "message" && typeof event.payload.text === "string"
    )
      ? parsed.events
      : [
          ...parsed.events,
          this.messageEvent({ sessionId, text: message, nativeSessionId }),
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
    const now = new Date().toISOString();

    await this.transport.run({
      hostId: this.runtimeProfile.id,
      command: this.command,
      args: this.buildPromptArgs(request),
      env: this.cliEnv(),
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

  private buildPromptArgs(request: RuntimeTurnRequest): string[] {
    const args = [
      "-p",
      request.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (request.conversationId) {
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
