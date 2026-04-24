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
import { requireRuntimeHostProfile } from "../registry";

type OpenClawRuntimeHealthStatus =
  | RuntimeHostHealth["status"]
  | "connected"
  | "disconnected";

export interface OpenClawRuntimeHostAdapterOptions {
  profile?: RuntimeHostProfile;
  healthCheck?: () => Promise<{
    status: OpenClawRuntimeHealthStatus;
    detail?: string;
  }>;
  sendAgentMessage?: (
    message: string,
    options?: {
      session?: string;
      cwd?: string;
      timeoutMs?: number;
      onEvent?: (event: unknown) => void;
    },
  ) => Promise<string>;
  abortChat?: (
    sessionKey: string,
    options?: { timeoutMs?: number },
  ) => Promise<{ aborted: boolean; runIds?: string[] }>;
}

export class OpenClawRuntimeHostAdapter implements ResearchRuntimeHost {
  private readonly runtimeProfile: RuntimeHostProfile;
  private readonly healthCheckOverride?: OpenClawRuntimeHostAdapterOptions["healthCheck"];
  private readonly sendAgentMessageOverride?: OpenClawRuntimeHostAdapterOptions["sendAgentMessage"];
  private readonly abortChatOverride?: OpenClawRuntimeHostAdapterOptions["abortChat"];
  private readonly activeRuntimeSessions = new Map<string, string>();

  constructor(options: OpenClawRuntimeHostAdapterOptions = {}) {
    this.runtimeProfile = options.profile ?? requireRuntimeHostProfile("openclaw");
    this.healthCheckOverride = options.healthCheck;
    this.sendAgentMessageOverride = options.sendAgentMessage;
    this.abortChatOverride = options.abortChat;
  }

  profile(): RuntimeHostProfile {
    return this.runtimeProfile;
  }

  async health(): Promise<RuntimeHostHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const status = this.healthCheckOverride
        ? await this.healthCheckOverride()
        : await import("@/lib/openclaw").then((openclaw) => openclaw.healthCheck());

      return {
        status: status.status === "ready" || status.status === "connected"
          ? "ready"
          : status.status === "misconfigured"
            ? "misconfigured"
            : "unavailable",
        checkedAt,
        detail: "detail" in status ? status.detail : undefined,
      };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt,
        detail: error instanceof Error ? error.message : "OpenClaw health failed.",
      };
    }
  }

  async authStatus(): Promise<RuntimeHostAuthStatus> {
    return {
      status: "not-required",
      authMode: this.runtimeProfile.authMode,
      provider: this.runtimeProfile.authProvider,
      detail: "OpenClaw uses the local ScienceSwarm/OpenClaw installation.",
    };
  }

  async privacyProfile(): Promise<RuntimePrivacyClass | RuntimeHostPrivacyProof> {
    return {
      privacyClass: "local-network",
      adapterProof: "declared-local",
      reason: "OpenClaw is the local-first ScienceSwarm manager runtime.",
      observedAt: new Date().toISOString(),
    };
  }

  async sendTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnResult> {
    const sendAgentMessage = this.sendAgentMessageOverride
      ?? (await import("@/lib/openclaw")).sendAgentMessage;
    const sessionId = request.conversationId ?? `openclaw-${randomUUID()}`;
    if (request.runtimeSessionId) {
      this.activeRuntimeSessions.set(request.runtimeSessionId, sessionId);
    }

    let message: string;
    try {
      message = await sendAgentMessage(request.prompt, {
        session: sessionId,
      });
    } finally {
      if (request.runtimeSessionId) {
        this.activeRuntimeSessions.delete(request.runtimeSessionId);
      }
    }

    return {
      hostId: this.runtimeProfile.id,
      sessionId,
      message,
    };
  }

  async executeTask(request: RuntimeTurnRequest): Promise<RuntimeSessionRecord> {
    throw new RuntimeHostCapabilityUnsupported({
      hostId: this.runtimeProfile.id,
      capability: "task",
      mode: request.mode,
    });
  }

  async cancel(sessionId: string): Promise<RuntimeCancelResult> {
    const openClawSessionKey = this.activeRuntimeSessions.get(sessionId);
    if (!openClawSessionKey) {
      return {
        sessionId,
        cancelled: false,
        detail: "No active OpenClaw run was found for this ScienceSwarm session.",
      };
    }

    const abortChat = this.abortChatOverride
      ?? (await import("@/lib/openclaw/gateway-ws-client")).abortChatViaGateway;
    const result = await abortChat(openClawSessionKey, { timeoutMs: 10_000 });

    return {
      sessionId,
      cancelled: result.aborted,
      detail: result.aborted
        ? `Stopped OpenClaw run for session ${openClawSessionKey}.`
        : `No active OpenClaw run was found for session ${openClawSessionKey}.`,
    };
  }

  async listSessions(_projectId: string): Promise<RuntimeSessionRecord[]> {
    return [];
  }

  async *streamEvents(_sessionId: string): AsyncIterable<RuntimeEvent> {
    return;
  }

  async artifactImportHints(
    _sessionId: string,
  ): Promise<ArtifactImportRequest[]> {
    return [];
  }
}

export function createOpenClawRuntimeHostAdapter(
  options: OpenClawRuntimeHostAdapterOptions = {},
): OpenClawRuntimeHostAdapter {
  return new OpenClawRuntimeHostAdapter(options);
}
