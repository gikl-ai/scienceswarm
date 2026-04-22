import type { ConversationStartRequest } from "@/lib/openhands";

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
import { RuntimeHostCapabilityUnsupported, RuntimeHostError } from "../errors";
import { requireRuntimeHostProfile } from "../registry";
import {
  createRuntimeSessionStore,
  type RuntimeSessionStore,
} from "../sessions";
import { createRuntimePathMapper } from "../path-mapping";

export interface OpenHandsRuntimeClient {
  healthCheck?: () => Promise<Pick<RuntimeHostHealth, "status" | "detail">>;
  startConversation?: (
    request: ConversationStartRequest,
  ) => Promise<unknown>;
  queuePendingMessage?: (
    taskOrConversationId: string,
    message: string,
  ) => Promise<void>;
  getEvents?: (
    conversationId: string,
    limit?: number,
    sortOrder?: "TIMESTAMP" | "TIMESTAMP_DESC",
  ) => Promise<unknown[]>;
  extractAgentMessageText?: (event: unknown) => string | null;
  listFiles?: (conversationId: string, path?: string) => Promise<unknown>;
  cancelConversation?: (conversationId: string) => Promise<RuntimeCancelResult>;
  listConversations?: (projectId: string) => Promise<RuntimeSessionRecord[]>;
}

export interface OpenHandsRuntimeHostAdapterOptions {
  profile?: RuntimeHostProfile;
  client?: OpenHandsRuntimeClient;
  sessionStore?: RuntimeSessionStore;
  projectId?: string;
  projectRoot?: string;
  hostWorkspaceRoot?: string;
  now?: () => Date;
  idGenerator?: () => string;
}

async function defaultOpenHandsModule(): Promise<OpenHandsRuntimeClient> {
  const openhands = await import("@/lib/openhands");
  return {
    startConversation: openhands.startConversation,
    queuePendingMessage: openhands.queuePendingMessage,
    getEvents: openhands.getEvents,
    extractAgentMessageText: openhands.extractAgentMessageText,
    listFiles: openhands.listFiles,
  };
}

function extractConversationId(value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new RuntimeHostError({
      code: "RUNTIME_TRANSPORT_ERROR",
      status: 502,
      message: "OpenHands start response did not include a conversation id.",
      userMessage: "OpenHands did not return a task id.",
      recoverable: true,
      context: { hostId: "openhands" },
    });
  }
  const record = value as Record<string, unknown>;
  const id = record.id ?? record.conversation_id ?? record.task_id;
  if (typeof id === "string" && id.trim().length > 0) {
    return id.trim();
  }
  throw new RuntimeHostError({
    code: "RUNTIME_TRANSPORT_ERROR",
    status: 502,
    message: "OpenHands start response did not include a conversation id.",
    userMessage: "OpenHands did not return a task id.",
    recoverable: true,
    context: { hostId: "openhands" },
  });
}

function safeIdSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    || "session";
}

function eventRecord(event: unknown): Record<string, unknown> {
  return event && typeof event === "object" && !Array.isArray(event)
    ? event as Record<string, unknown>
    : {};
}

function eventIdFor(input: {
  sessionId: string;
  event: unknown;
  index: number;
}): string {
  const record = eventRecord(input.event);
  const rawId = record.id ?? record.event_id ?? record.timestamp ?? input.index;
  return `openhands-${input.sessionId}-${String(rawId)}`;
}

function artifactPathFromEvent(event: unknown): string | null {
  const record = eventRecord(event);
  for (const key of ["artifactPath", "path", "file_path", "filePath"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function normalizeOpenHandsEvent(input: {
  sessionId: string;
  hostId: string;
  event: unknown;
  index: number;
  extractAgentMessageText?: (event: unknown) => string | null;
  now: () => Date;
}): RuntimeEvent | null {
  const record = eventRecord(input.event);
  const text = input.extractAgentMessageText?.(input.event) ?? null;
  if (text) {
    return {
      id: eventIdFor(input),
      sessionId: input.sessionId,
      hostId: input.hostId,
      type: "message",
      createdAt: input.now().toISOString(),
      payload: { text },
    };
  }

  const artifactPath = artifactPathFromEvent(input.event);
  const kind = typeof record.kind === "string" ? record.kind : "";
  if (
    artifactPath
    && (
      kind.toLowerCase().includes("file")
      || kind.toLowerCase().includes("artifact")
    )
  ) {
    return {
      id: eventIdFor(input),
      sessionId: input.sessionId,
      hostId: input.hostId,
      type: "artifact",
      createdAt: input.now().toISOString(),
      payload: { path: artifactPath },
    };
  }

  if (kind.toLowerCase().includes("error")) {
    return {
      id: eventIdFor(input),
      sessionId: input.sessionId,
      hostId: input.hostId,
      type: "error",
      createdAt: input.now().toISOString(),
      payload: {
        code: "RUNTIME_TRANSPORT_ERROR",
        event: record,
      },
    };
  }

  return null;
}

function unwrapFileList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.files)) return record.files;
  if (Array.isArray(record.items)) return record.items;
  return [];
}

function filePathFromListEntry(entry: unknown): string | null {
  const record = eventRecord(entry);
  const type = record.type;
  if (type !== undefined && type !== "file") return null;
  const candidate = record.path ?? record.file_path ?? record.name;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : null;
}

export class OpenHandsRuntimeHostAdapter implements ResearchRuntimeHost {
  private readonly runtimeProfile: RuntimeHostProfile;
  private readonly client: OpenHandsRuntimeClient;
  private readonly sessionStore: RuntimeSessionStore;
  private readonly projectId: string;
  private readonly projectRoot: string;
  private readonly hostWorkspaceRoot: string;
  private readonly now: () => Date;

  constructor(options: OpenHandsRuntimeHostAdapterOptions = {}) {
    this.runtimeProfile = options.profile ?? requireRuntimeHostProfile("openhands");
    this.client = options.client ?? {};
    this.sessionStore = options.sessionStore ?? createRuntimeSessionStore({
      now: options.now,
      idGenerator: options.idGenerator,
    });
    this.projectId = options.projectId ?? "runtime-project";
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.hostWorkspaceRoot = options.hostWorkspaceRoot ?? "/workspace";
    this.now = options.now ?? (() => new Date());
  }

  profile(): RuntimeHostProfile {
    return this.runtimeProfile;
  }

  async health(): Promise<RuntimeHostHealth> {
    const checkedAt = this.now().toISOString();
    if (!this.client.healthCheck) {
      return {
        status: "unavailable",
        checkedAt,
        detail: "OpenHands health probing is not configured for this adapter.",
      };
    }

    try {
      const health = await this.client.healthCheck();
      return {
        status: health.status,
        checkedAt,
        detail: health.detail,
      };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt,
        detail: error instanceof Error ? error.message : "OpenHands health failed.",
      };
    }
  }

  async authStatus(): Promise<RuntimeHostAuthStatus> {
    return {
      status: "not-required",
      authMode: this.runtimeProfile.authMode,
      provider: this.runtimeProfile.authProvider,
      detail: "OpenHands uses the local OpenHands service configured for ScienceSwarm.",
    };
  }

  async privacyProfile(): Promise<RuntimePrivacyClass | RuntimeHostPrivacyProof> {
    return {
      privacyClass: "local-network",
      adapterProof: "declared-local",
      reason: "ScienceSwarm talks to the local OpenHands service over the configured local-network endpoint.",
      observedAt: this.now().toISOString(),
    };
  }

  async sendTurn(request: RuntimeTurnRequest): Promise<RuntimeTurnResult> {
    throw new RuntimeHostCapabilityUnsupported({
      hostId: this.runtimeProfile.id,
      capability: "chat",
      mode: request.mode,
    });
  }

  async executeTask(request: RuntimeTurnRequest): Promise<RuntimeSessionRecord> {
    if (request.mode !== "task") {
      throw new RuntimeHostCapabilityUnsupported({
        hostId: this.runtimeProfile.id,
        capability: "task",
        mode: request.mode,
      });
    }

    const defaults = await defaultOpenHandsModule();
    const startConversation = this.client.startConversation
      ?? defaults.startConversation;
    const queuePendingMessage = this.client.queuePendingMessage
      ?? defaults.queuePendingMessage;
    if (!startConversation || !queuePendingMessage) {
      throw new RuntimeHostError({
        code: "RUNTIME_HOST_UNAVAILABLE",
        status: 503,
        message: "OpenHands client boundary is unavailable.",
        userMessage: "OpenHands is not available.",
        recoverable: true,
        context: { hostId: this.runtimeProfile.id },
      });
    }

    // The OpenHands boundary starts the conversation with no initial message;
    // the prompt is delivered exactly once through the pending-message queue.
    const startResult = await startConversation({ message: "" });
    const conversationId = extractConversationId(startResult);
    await queuePendingMessage(conversationId, request.prompt);

    return this.sessionStore.createSession({
      id: `openhands-${safeIdSegment(conversationId)}`,
      hostId: this.runtimeProfile.id,
      projectId: request.projectId,
      conversationId,
      mode: "task",
      status: "running",
      preview: request.preview,
    });
  }

  async cancel(sessionId: string): Promise<RuntimeCancelResult> {
    if (!this.client.cancelConversation) {
      return {
        sessionId,
        cancelled: false,
        detail: "OpenHands cancellation is not exposed by the current client boundary.",
      };
    }
    const conversationId = this.conversationIdForRuntimeSession(sessionId);
    const result = await this.client.cancelConversation(conversationId);
    return {
      ...result,
      sessionId,
    };
  }

  async listSessions(projectId: string): Promise<RuntimeSessionRecord[]> {
    if (this.client.listConversations) {
      return this.client.listConversations(projectId);
    }
    return this.sessionStore.listSessions({
      hostId: this.runtimeProfile.id,
      projectId,
    });
  }

  async *streamEvents(sessionId: string): AsyncIterable<RuntimeEvent> {
    const defaults = await defaultOpenHandsModule();
    const getEvents = this.client.getEvents ?? defaults.getEvents;
    if (!getEvents) return;

    const conversationId = this.conversationIdForRuntimeSession(sessionId);
    const rawEvents = await getEvents(conversationId, 50, "TIMESTAMP");
    const extractAgentMessageText = this.client.extractAgentMessageText
      ?? defaults.extractAgentMessageText;
    for (const [index, event] of rawEvents.entries()) {
      const normalized = normalizeOpenHandsEvent({
        sessionId,
        hostId: this.runtimeProfile.id,
        event,
        index,
        extractAgentMessageText,
        now: this.now,
      });
      if (normalized) {
        yield normalized;
      }
    }
  }

  async artifactImportHints(
    sessionId: string,
  ): Promise<ArtifactImportRequest[]> {
    const defaults = await defaultOpenHandsModule();
    const listFiles = this.client.listFiles ?? defaults.listFiles;
    if (!listFiles) return [];

    const mapper = createRuntimePathMapper({
      projectId: this.projectId,
      hostId: this.runtimeProfile.id,
      projectRoot: this.projectRoot,
      hostWorkspaceRoot: this.hostWorkspaceRoot,
    });
    const conversationId = this.conversationIdForRuntimeSession(sessionId);
    const files = unwrapFileList(await listFiles(conversationId, this.hostWorkspaceRoot));
    const hints: ArtifactImportRequest[] = [];

    for (const entry of files) {
      const sourcePath = filePathFromListEntry(entry);
      if (!sourcePath) continue;
      try {
        const mapping = mapper.fromHostNative(sourcePath);
        hints.push({
          sessionId,
          hostId: this.runtimeProfile.id,
          sourcePath,
          sourceNamespace: "host-native",
          targetPath: mapping.projectRelativePath,
          provenance: {
            generatedByHostId: this.runtimeProfile.id,
            runtimeSessionId: sessionId,
            privacyClass: "local-network",
          },
        });
      } catch {
        // Ignore paths outside the declared OpenHands workspace. Validation
        // happens again before import, so hints stay conservative.
      }
    }

    return hints;
  }

  private conversationIdForRuntimeSession(sessionId: string): string {
    const session = this.sessionStore.getSession(sessionId);
    if (
      session?.conversationId
      && session.conversationId.trim().length > 0
    ) {
      return session.conversationId;
    }
    return sessionId;
  }
}

export function createOpenHandsRuntimeHostAdapter(
  options: OpenHandsRuntimeHostAdapterOptions = {},
): OpenHandsRuntimeHostAdapter {
  return new OpenHandsRuntimeHostAdapter(options);
}
