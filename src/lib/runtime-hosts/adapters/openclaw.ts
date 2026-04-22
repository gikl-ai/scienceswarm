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
}

export class OpenClawRuntimeHostAdapter implements ResearchRuntimeHost {
  private readonly runtimeProfile: RuntimeHostProfile;
  private readonly healthCheckOverride?: OpenClawRuntimeHostAdapterOptions["healthCheck"];
  private readonly sendAgentMessageOverride?: OpenClawRuntimeHostAdapterOptions["sendAgentMessage"];

  constructor(options: OpenClawRuntimeHostAdapterOptions = {}) {
    this.runtimeProfile = options.profile ?? requireRuntimeHostProfile("openclaw");
    this.healthCheckOverride = options.healthCheck;
    this.sendAgentMessageOverride = options.sendAgentMessage;
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
    const message = await sendAgentMessage(request.prompt, {
      session: request.conversationId ?? request.preview.hostId,
    });

    return {
      hostId: "openclaw",
      sessionId: request.conversationId ?? request.preview.hostId,
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
    return {
      sessionId,
      cancelled: false,
      detail: "OpenClaw cancellation remains owned by the existing chat facade.",
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
