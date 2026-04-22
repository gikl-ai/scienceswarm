import type {
  ResearchRuntimeHost,
  RuntimeApprovalState,
  RuntimeDataIncluded,
  RuntimeHostId,
  RuntimeProjectPolicy,
  RuntimeSessionRecord,
  RuntimeTurnMode,
  RuntimeTurnRequest,
  RuntimeTurnResult,
  TurnPreview,
} from "./contracts";
import { RuntimeHostError } from "./errors";
import {
  assertHostSupportsTurnMode,
  assertTurnPreviewAllowsPromptConstruction,
  computeTurnPreview,
} from "./policy";
import {
  RuntimeHostRegistry,
  requireRuntimeHostProfile,
} from "./registry";
import {
  RuntimeSessionStore,
  createRuntimeSessionStore,
  getDefaultRuntimeSessionStore,
  type RuntimeSessionStatus,
} from "./sessions";
import {
  RuntimeEventStore,
  createRuntimeEventStore,
} from "./events";
import { createOpenClawRuntimeHostAdapter } from "./adapters/openclaw";

export interface RuntimeRouterTurnInput {
  hostId?: RuntimeHostId | string;
  projectPolicy?: RuntimeProjectPolicy;
  projectId: string | null;
  conversationId: string | null;
  mode: RuntimeTurnMode;
  prompt: string;
  promptHash?: string;
  inputFileRefs?: string[];
  dataIncluded?: RuntimeDataIncluded[];
  approvalState?: RuntimeApprovalState;
}

export interface PreparedRuntimeTurn {
  preview: TurnPreview;
  request: RuntimeTurnRequest;
  session: RuntimeSessionRecord;
}

export interface RuntimeRouterDispatchResult extends PreparedRuntimeTurn {
  result: RuntimeTurnResult;
}

export interface FinishRuntimeTurnInput {
  status: RuntimeSessionStatus;
  errorCode?: string;
}

export interface RuntimeHostRouterOptions {
  registry?: RuntimeHostRegistry;
  sessionStore?: RuntimeSessionStore;
  eventStore?: RuntimeEventStore;
  adapters?: ResearchRuntimeHost[];
}

function defaultDataIncluded(prompt: string): RuntimeDataIncluded[] {
  return [
    {
      kind: "prompt",
      label: "User prompt",
      bytes: Buffer.byteLength(prompt, "utf8"),
    },
  ];
}

function adapterMapFrom(
  adapters: readonly ResearchRuntimeHost[],
): Map<string, ResearchRuntimeHost> {
  return new Map(adapters.map((adapter) => [adapter.profile().id, adapter]));
}

export class RuntimeHostRouter {
  private readonly registry: RuntimeHostRegistry | null;
  private readonly sessionStore: RuntimeSessionStore;
  private readonly eventStore: RuntimeEventStore;
  private readonly adapters: Map<string, ResearchRuntimeHost>;

  constructor(options: RuntimeHostRouterOptions = {}) {
    this.registry = options.registry ?? null;
    this.sessionStore = options.sessionStore ?? createRuntimeSessionStore();
    this.eventStore = options.eventStore ?? createRuntimeEventStore({
      sessions: this.sessionStore,
    });
    this.adapters = adapterMapFrom(options.adapters ?? []);
  }

  prepareTurn(input: RuntimeRouterTurnInput): PreparedRuntimeTurn {
    const hostId = input.hostId ?? "openclaw";
    const host = this.registry?.require(hostId) ?? requireRuntimeHostProfile(hostId);
    assertHostSupportsTurnMode(host, input.mode);

    const preview = computeTurnPreview({
      projectPolicy: input.projectPolicy ?? "local-only",
      host,
      mode: input.mode,
      dataIncluded: input.dataIncluded ?? defaultDataIncluded(input.prompt),
    });
    assertTurnPreviewAllowsPromptConstruction(
      preview,
      input.approvalState === "approved",
    );

    const session = this.sessionStore.createSession({
      hostId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      mode: input.mode,
      status: "running",
      preview,
    });
    const request: RuntimeTurnRequest = {
      hostId: host.id,
      projectId: input.projectId,
      conversationId: input.conversationId,
      mode: input.mode,
      prompt: input.prompt,
      promptHash: input.promptHash,
      inputFileRefs: input.inputFileRefs ?? [],
      dataIncluded: preview.dataIncluded,
      approvalState: input.approvalState ?? "not-required",
      preview,
    };

    this.eventStore.appendEvent({
      id: `${session.id}:runtime-started`,
      sessionId: session.id,
      hostId,
      type: "status",
      payload: {
        status: "running",
        conversationId: input.conversationId,
      },
    });

    return {
      preview,
      request,
      session,
    };
  }

  async dispatchTurn(
    input: RuntimeRouterTurnInput,
  ): Promise<RuntimeRouterDispatchResult> {
    const prepared = this.prepareTurn(input);
    const adapter = this.adapters.get(prepared.request.hostId);
    if (!adapter) {
      throw new RuntimeHostError({
        code: "RUNTIME_HOST_UNKNOWN",
        status: 404,
        message: `No runtime adapter registered for ${prepared.request.hostId}.`,
        userMessage: "That runtime host is not available.",
        recoverable: true,
        context: { hostId: prepared.request.hostId },
      });
    }

    try {
      const result = await adapter.sendTurn(prepared.request);
      this.finishTurn(prepared.session.id, { status: "completed" });
      for (const event of result.events ?? []) {
        this.eventStore.appendEvent(event);
      }
      return {
        ...prepared,
        result,
      };
    } catch (error) {
      this.finishTurn(prepared.session.id, {
        status: "failed",
        errorCode: error instanceof RuntimeHostError
          ? error.code
          : "RUNTIME_TRANSPORT_ERROR",
      });
      throw error;
    }
  }

  finishTurn(sessionId: string, input: FinishRuntimeTurnInput): void {
    this.sessionStore.trySetSessionStatus({
      sessionId,
      status: input.status,
      errorCode: input.errorCode,
    });
    this.eventStore.appendEvent({
      id: `${sessionId}:runtime-${input.status}`,
      sessionId,
      hostId: this.sessionStore.getSession(sessionId)?.hostId ?? "unknown",
      type: input.status === "completed" ? "done" : "error",
      payload: {
        status: input.status,
        code: input.errorCode,
      },
    });
  }

  listSessions(filter?: Parameters<RuntimeSessionStore["listSessions"]>[0]) {
    return this.sessionStore.listSessions(filter);
  }

  getSessionStore(): RuntimeSessionStore {
    return this.sessionStore;
  }
}

export function createRuntimeHostRouter(
  options: RuntimeHostRouterOptions = {},
): RuntimeHostRouter {
  return new RuntimeHostRouter(options);
}

const defaultRuntimeHostRouter = createRuntimeHostRouter({
  sessionStore: getDefaultRuntimeSessionStore(),
  adapters: [createOpenClawRuntimeHostAdapter()],
});

export function getDefaultRuntimeHostRouter(): RuntimeHostRouter {
  return defaultRuntimeHostRouter;
}
