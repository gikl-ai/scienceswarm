import { randomUUID } from "node:crypto";

import type {
  RuntimeHostId,
  RuntimeSessionRecord,
  RuntimeTurnMode,
  TurnPreview,
} from "./contracts";
import { RuntimeHostError } from "./errors";
import { resolveRuntimeHostRecord } from "./registry";

export type RuntimeSessionStatus = RuntimeSessionRecord["status"];

export interface CreateRuntimeSessionInput {
  id?: string;
  hostId: RuntimeHostId | string;
  projectId?: string | null;
  conversationId?: string | null;
  mode: RuntimeTurnMode;
  status?: RuntimeSessionStatus;
  createdAt?: string;
  updatedAt?: string;
  preview?: TurnPreview;
  errorCode?: string;
}

export interface UpdateRuntimeSessionInput {
  projectId?: string | null;
  conversationId?: string | null;
  mode?: RuntimeTurnMode;
  status?: RuntimeSessionStatus;
  updatedAt?: string;
  preview?: TurnPreview;
  errorCode?: string | null;
}

export interface ListRuntimeSessionsFilter {
  hostId?: RuntimeHostId | string;
  projectId?: string | null;
  conversationId?: string | null;
  status?: RuntimeSessionStatus;
}

export interface RuntimeSessionStoreOptions {
  now?: () => Date;
  idGenerator?: () => string;
}

const STATUS_RANK: Record<RuntimeSessionStatus, number> = {
  queued: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
};

const TERMINAL_STATUSES = new Set<RuntimeSessionStatus>([
  "completed",
  "failed",
  "cancelled",
]);

function cloneSession(record: RuntimeSessionRecord): RuntimeSessionRecord {
  return {
    ...record,
    preview: record.preview ? JSON.parse(JSON.stringify(record.preview)) : undefined,
  };
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RuntimeHostError({
      code: "RUNTIME_INVALID_REQUEST",
      status: 400,
      message: `Invalid runtime session timestamp: ${value}`,
      userMessage: "Runtime session state included an invalid timestamp.",
      recoverable: false,
      context: { timestamp: value },
    });
  }
  return parsed.toISOString();
}

export function canRuntimeSessionStatusTransition(
  current: RuntimeSessionStatus,
  next: RuntimeSessionStatus,
): boolean {
  if (current === next) return true;
  if (TERMINAL_STATUSES.has(current)) return false;
  return STATUS_RANK[next] >= STATUS_RANK[current];
}

export class RuntimeSessionStore {
  private readonly sessions = new Map<string, RuntimeSessionRecord>();
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: RuntimeSessionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
  }

  createSession(input: CreateRuntimeSessionInput): RuntimeSessionRecord {
    const nowIso = this.now().toISOString();
    const id = input.id ?? `rt-session-${this.idGenerator()}`;
    if (this.sessions.has(id)) {
      throw new RuntimeHostError({
        code: "RUNTIME_INVALID_REQUEST",
        status: 409,
        message: `Runtime session already exists: ${id}`,
        userMessage: "That runtime session already exists.",
        recoverable: true,
        context: { sessionId: id },
      });
    }

    const historicalHost = resolveRuntimeHostRecord(input.hostId);
    const createdAt = normalizeTimestamp(input.createdAt, nowIso);
    const updatedAt = normalizeTimestamp(input.updatedAt, createdAt);
    const record: RuntimeSessionRecord = {
      id,
      hostId: input.hostId,
      projectId: input.projectId ?? null,
      conversationId: input.conversationId ?? null,
      mode: input.mode,
      status: input.status ?? "queued",
      createdAt,
      updatedAt,
      readOnly: historicalHost.readOnly || undefined,
      preview: input.preview,
      errorCode: input.errorCode,
    };

    this.sessions.set(id, cloneSession(record));
    return cloneSession(record);
  }

  getSession(id: string): RuntimeSessionRecord | null {
    const record = this.sessions.get(id);
    return record ? cloneSession(record) : null;
  }

  requireSession(id: string): RuntimeSessionRecord {
    const record = this.getSession(id);
    if (record) return record;

    throw new RuntimeHostError({
      code: "RUNTIME_INVALID_REQUEST",
      status: 404,
      message: `Runtime session not found: ${id}`,
      userMessage: "That runtime session was not found.",
      recoverable: true,
      context: { sessionId: id },
    });
  }

  listSessions(filter: ListRuntimeSessionsFilter = {}): RuntimeSessionRecord[] {
    return Array.from(this.sessions.values())
      .filter((record) =>
        (filter.hostId === undefined || record.hostId === filter.hostId)
        && (filter.projectId === undefined || record.projectId === filter.projectId)
        && (
          filter.conversationId === undefined
          || record.conversationId === filter.conversationId
        )
        && (filter.status === undefined || record.status === filter.status)
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(cloneSession);
  }

  updateSession(
    id: string,
    input: UpdateRuntimeSessionInput,
  ): RuntimeSessionRecord {
    const current = this.requireSession(id);
    const nextUpdatedAt = normalizeTimestamp(
      input.updatedAt,
      this.now().toISOString(),
    );
    const nextStatus = input.status ?? current.status;

    if (!canRuntimeSessionStatusTransition(current.status, nextStatus)) {
      throw new RuntimeHostError({
        code: "RUNTIME_INVALID_REQUEST",
        status: 409,
        message: `Cannot move runtime session ${id} from ${current.status} to ${nextStatus}.`,
        userMessage: "Runtime session status cannot move backward.",
        recoverable: true,
        context: {
          sessionId: id,
          currentStatus: current.status,
          nextStatus,
        },
      });
    }

    const record: RuntimeSessionRecord = {
      ...current,
      projectId: input.projectId === undefined
        ? current.projectId
        : input.projectId,
      conversationId: input.conversationId === undefined
        ? current.conversationId
        : input.conversationId,
      mode: input.mode ?? current.mode,
      status: nextStatus,
      updatedAt: nextUpdatedAt,
      preview: input.preview ?? current.preview,
      errorCode: input.errorCode === null
        ? undefined
        : input.errorCode ?? current.errorCode,
    };

    this.sessions.set(id, cloneSession(record));
    return cloneSession(record);
  }

  trySetSessionStatus(input: {
    sessionId: string;
    status: RuntimeSessionStatus;
    updatedAt?: string;
    errorCode?: string;
  }): { updated: boolean; stale: boolean; session: RuntimeSessionRecord | null } {
    const current = this.getSession(input.sessionId);
    if (!current) {
      return { updated: false, stale: false, session: null };
    }

    const nextUpdatedAt = normalizeTimestamp(
      input.updatedAt,
      this.now().toISOString(),
    );
    const eventTime = Date.parse(nextUpdatedAt);
    const currentTime = Date.parse(current.updatedAt);
    const stale =
      eventTime < currentTime
      || !canRuntimeSessionStatusTransition(current.status, input.status);

    if (stale) {
      return { updated: false, stale: true, session: current };
    }

    const session = this.updateSession(input.sessionId, {
      status: input.status,
      updatedAt: nextUpdatedAt,
      errorCode: input.errorCode,
    });
    return { updated: true, stale: false, session };
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
  }
}

export function createRuntimeSessionStore(
  options: RuntimeSessionStoreOptions = {},
): RuntimeSessionStore {
  return new RuntimeSessionStore(options);
}

const defaultRuntimeSessionStore = createRuntimeSessionStore();

export function getDefaultRuntimeSessionStore(): RuntimeSessionStore {
  return defaultRuntimeSessionStore;
}
