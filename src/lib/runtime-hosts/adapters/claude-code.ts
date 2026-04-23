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
  LocalCliTransport,
  detectCliAuthStatus,
  detectCliHealth,
  type CliTransport,
} from "../transport/cli";

export interface ClaudeCodeRuntimeHostAdapterOptions {
  profile?: RuntimeHostProfile;
  transport?: CliTransport;
  command?: string;
  timeoutMs?: number;
  sessionIdGenerator?: () => string;
  healthArgs?: string[];
  authArgs?: string[];
}

export class ClaudeCodeRuntimeHostAdapter implements ResearchRuntimeHost {
  private readonly runtimeProfile: RuntimeHostProfile;
  private readonly transport: CliTransport;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly sessionIdGenerator: () => string;
  private readonly healthArgs: string[];
  private readonly authArgs?: string[];
  private messageEventSequence = 0;

  constructor(options: ClaudeCodeRuntimeHostAdapterOptions = {}) {
    this.runtimeProfile = options.profile ?? requireRuntimeHostProfile("claude-code");
    this.transport = options.transport ?? new LocalCliTransport();
    this.command = options.command ?? this.runtimeProfile.transport.command ?? "claude";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.sessionIdGenerator = options.sessionIdGenerator ?? (() => randomUUID());
    this.healthArgs = options.healthArgs ?? ["--version"];
    this.authArgs = options.authArgs;
  }

  profile(): RuntimeHostProfile {
    return this.runtimeProfile;
  }

  async health(): Promise<RuntimeHostHealth> {
    return await detectCliHealth({
      hostId: this.runtimeProfile.id,
      command: this.command,
      args: this.healthArgs,
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
    const result = await this.transport.run({
      hostId: this.runtimeProfile.id,
      command: this.command,
      args: ["-p", request.prompt, "--output-format", "stream-json"],
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

  async executeTask(request: RuntimeTurnRequest): Promise<RuntimeSessionRecord> {
    this.assertCanSend(request);
    const sessionId = `claude-code-task-${this.sessionIdGenerator()}`;
    const now = new Date().toISOString();

    await this.transport.run({
      hostId: this.runtimeProfile.id,
      command: this.command,
      args: ["-p", request.prompt, "--output-format", "stream-json"],
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

  private messageEvent(input: { sessionId: string; text: string }): RuntimeEvent {
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

export function createClaudeCodeRuntimeHostAdapter(
  options: ClaudeCodeRuntimeHostAdapterOptions = {},
): ClaudeCodeRuntimeHostAdapter {
  return new ClaudeCodeRuntimeHostAdapter(options);
}
