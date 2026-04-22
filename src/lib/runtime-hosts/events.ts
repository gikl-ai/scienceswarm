import { randomUUID } from "node:crypto";

import type { RuntimeEvent } from "./contracts";
import {
  applyRuntimeEventRetention,
  type RuntimeRetentionPolicyInput,
} from "./retention";
import type { RuntimeSessionStatus, RuntimeSessionStore } from "./sessions";

export type RuntimeEventInputType = RuntimeEvent["type"] | "text" | "tool";

export interface RuntimeEventInput {
  id?: string;
  sessionId: string;
  hostId: RuntimeEvent["hostId"];
  type: RuntimeEventInputType;
  createdAt?: string;
  payload?: Record<string, unknown>;
}

export interface RuntimeEventStoreOptions {
  now?: () => Date;
  idGenerator?: () => string;
  sessions?: RuntimeSessionStore;
  retention?: RuntimeRetentionPolicyInput;
}

export interface AppendRuntimeEventResult {
  event: RuntimeEvent;
  appended: boolean;
  duplicate: boolean;
  stale: boolean;
  truncated: boolean;
}

function cloneEvent(event: RuntimeEvent): RuntimeEvent {
  return JSON.parse(JSON.stringify(event)) as RuntimeEvent;
}

function normalizeEventType(type: RuntimeEventInputType): RuntimeEvent["type"] {
  if (type === "text") return "message";
  if (type === "tool") return "tool-call";
  return type;
}

function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

function payloadStatus(payload: Record<string, unknown>): RuntimeSessionStatus | null {
  const status = payload.status;
  if (
    status === "queued"
    || status === "running"
    || status === "completed"
    || status === "failed"
    || status === "cancelled"
  ) {
    return status;
  }
  return null;
}

function statusFromEvent(event: RuntimeEvent): RuntimeSessionStatus | null {
  if (event.type === "done") return "completed";
  if (event.type === "error") return "failed";
  if (event.type === "status") return payloadStatus(event.payload);
  if (
    event.type === "message"
    || event.type === "tool-call"
    || event.type === "artifact"
  ) {
    return "running";
  }
  return null;
}

export function normalizeRuntimeEvent(
  input: RuntimeEventInput,
  options: Pick<RuntimeEventStoreOptions, "now" | "idGenerator"> = {},
): RuntimeEvent {
  const now = options.now ?? (() => new Date());
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const nowIso = now().toISOString();
  return {
    id: input.id ?? `rt-event-${idGenerator()}`,
    sessionId: input.sessionId,
    hostId: input.hostId,
    type: normalizeEventType(input.type),
    createdAt: normalizeTimestamp(input.createdAt, nowIso),
    payload: input.payload ? { ...input.payload } : {},
  };
}

export class RuntimeEventStore {
  private readonly eventsBySession = new Map<string, RuntimeEvent[]>();
  private readonly seenEventIdsBySession = new Map<string, Set<string>>();
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly sessions?: RuntimeSessionStore;
  private readonly retention: RuntimeRetentionPolicyInput;

  constructor(options: RuntimeEventStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
    this.sessions = options.sessions;
    this.retention = options.retention ?? {};
  }

  appendEvent(input: RuntimeEventInput): AppendRuntimeEventResult {
    let event = normalizeRuntimeEvent(input, {
      now: this.now,
      idGenerator: this.idGenerator,
    });
    const seenEventIds = this.seenEventIds(event.sessionId);
    if (seenEventIds.has(event.id)) {
      const existing = this.listEvents(event.sessionId).find(
        (candidate) => candidate.id === event.id,
      );
      return {
        event: existing ?? event,
        appended: false,
        duplicate: true,
        stale: false,
        truncated: false,
      };
    }

    const sessionStatus = statusFromEvent(event);
    const statusResult = sessionStatus
      ? this.sessions?.trySetSessionStatus({
          sessionId: event.sessionId,
          status: sessionStatus,
          updatedAt: event.createdAt,
          errorCode: event.type === "error"
            ? String(event.payload.code ?? "RUNTIME_TRANSPORT_ERROR")
            : undefined,
        })
      : undefined;
    const stale = statusResult?.stale ?? false;
    if (stale) {
      event = {
        ...event,
        payload: {
          ...event.payload,
          runtimeEventStale: true,
        },
      };
    }

    seenEventIds.add(event.id);
    const events = [...(this.eventsBySession.get(event.sessionId) ?? []), event];
    const retention = applyRuntimeEventRetention({
      sessionId: event.sessionId,
      events,
      policy: this.retention,
      now: this.now(),
    });
    this.eventsBySession.set(event.sessionId, retention.events.map(cloneEvent));

    return {
      event: cloneEvent(event),
      appended: true,
      duplicate: false,
      stale,
      truncated: retention.truncated,
    };
  }

  listEvents(sessionId: string): RuntimeEvent[] {
    return (this.eventsBySession.get(sessionId) ?? []).map(cloneEvent);
  }

  clearSessionEvents(sessionId: string): void {
    this.eventsBySession.delete(sessionId);
    this.seenEventIdsBySession.delete(sessionId);
  }

  clear(): void {
    this.eventsBySession.clear();
    this.seenEventIdsBySession.clear();
  }

  private seenEventIds(sessionId: string): Set<string> {
    const existing = this.seenEventIdsBySession.get(sessionId);
    if (existing) return existing;

    const seen = new Set<string>();
    this.seenEventIdsBySession.set(sessionId, seen);
    return seen;
  }
}

export function createRuntimeEventStore(
  options: RuntimeEventStoreOptions = {},
): RuntimeEventStore {
  return new RuntimeEventStore(options);
}
