import type { RuntimeEvent } from "./contracts";

export interface RuntimeRetentionPolicy {
  eventTtlMs: number | null;
  transcriptTtlMs: number | null;
  maxEventsPerSession: number;
  maxEventLogBytesPerSession: number;
}

export interface RuntimeRetentionPolicyInput {
  eventTtlMs?: number | null;
  transcriptTtlMs?: number | null;
  maxEventsPerSession?: number;
  maxEventLogBytesPerSession?: number;
}

export interface RuntimeRetentionResult {
  events: RuntimeEvent[];
  truncated: boolean;
  droppedEventCount: number;
  droppedApproximateBytes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RUNTIME_RETENTION_POLICY: RuntimeRetentionPolicy = {
  eventTtlMs: 7 * DAY_MS,
  transcriptTtlMs: 30 * DAY_MS,
  maxEventsPerSession: 1_000,
  maxEventLogBytesPerSession: 256 * 1024,
};

export const RUNTIME_EVENT_TRUNCATION_MARKER_ID = "runtime-event-log-truncated";

function positiveIntegerOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function ttlOrDefault(
  value: number | null | undefined,
  fallback: number | null,
): number | null {
  if (value === null) return null;
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function approximateEventBytes(event: RuntimeEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function totalEventBytes(events: readonly RuntimeEvent[]): number {
  return events.reduce((total, event) => total + approximateEventBytes(event), 0);
}

function isTruncationMarker(event: RuntimeEvent): boolean {
  return event.id.startsWith(RUNTIME_EVENT_TRUNCATION_MARKER_ID)
    || event.payload.runtimeEventLogTruncated === true;
}

function createTruncationMarker(input: {
  sessionId: string;
  hostId: RuntimeEvent["hostId"];
  createdAt: string;
  droppedEventCount: number;
  droppedApproximateBytes: number;
}): RuntimeEvent {
  return {
    id: `${RUNTIME_EVENT_TRUNCATION_MARKER_ID}:${input.sessionId}`,
    sessionId: input.sessionId,
    hostId: input.hostId,
    type: "status",
    createdAt: input.createdAt,
    payload: {
      runtimeEventLogTruncated: true,
      reason: "retention-policy",
      droppedEventCount: input.droppedEventCount,
      droppedApproximateBytes: input.droppedApproximateBytes,
    },
  };
}

export function normalizeRuntimeRetentionPolicy(
  input: RuntimeRetentionPolicyInput = {},
): RuntimeRetentionPolicy {
  return {
    eventTtlMs: ttlOrDefault(
      input.eventTtlMs,
      DEFAULT_RUNTIME_RETENTION_POLICY.eventTtlMs,
    ),
    transcriptTtlMs: ttlOrDefault(
      input.transcriptTtlMs,
      DEFAULT_RUNTIME_RETENTION_POLICY.transcriptTtlMs,
    ),
    maxEventsPerSession: positiveIntegerOrDefault(
      input.maxEventsPerSession,
      DEFAULT_RUNTIME_RETENTION_POLICY.maxEventsPerSession,
    ),
    maxEventLogBytesPerSession: positiveIntegerOrDefault(
      input.maxEventLogBytesPerSession,
      DEFAULT_RUNTIME_RETENTION_POLICY.maxEventLogBytesPerSession,
    ),
  };
}

export function applyRuntimeEventRetention(input: {
  sessionId: string;
  events: readonly RuntimeEvent[];
  policy?: RuntimeRetentionPolicyInput;
  now?: Date;
}): RuntimeRetentionResult {
  const policy = normalizeRuntimeRetentionPolicy(input.policy);
  const now = input.now ?? new Date();
  let droppedEventCount = 0;
  let droppedApproximateBytes = 0;
  let events = input.events.filter((event) => !isTruncationMarker(event));

  if (policy.eventTtlMs !== null) {
    const cutoff = now.getTime() - policy.eventTtlMs;
    const retained = events.filter((event) => {
      const eventTime = Date.parse(event.createdAt);
      return Number.isFinite(eventTime) && eventTime >= cutoff;
    });
    for (const dropped of events.slice(0, events.length - retained.length)) {
      droppedApproximateBytes += approximateEventBytes(dropped);
    }
    droppedEventCount += events.length - retained.length;
    events = retained;
  }

  if (events.length > policy.maxEventsPerSession) {
    const dropped = events.slice(0, events.length - policy.maxEventsPerSession);
    droppedApproximateBytes += totalEventBytes(dropped);
    droppedEventCount += dropped.length;
    events = events.slice(-policy.maxEventsPerSession);
  }

  while (
    events.length > 1
    && totalEventBytes(events) > policy.maxEventLogBytesPerSession
  ) {
    const [dropped, ...rest] = events;
    droppedApproximateBytes += approximateEventBytes(dropped);
    droppedEventCount += 1;
    events = rest;
  }

  if (droppedEventCount === 0) {
    return {
      events: [...events],
      truncated: false,
      droppedEventCount: 0,
      droppedApproximateBytes: 0,
    };
  }

  const hostId = events[0]?.hostId ?? "unknown";
  const marker = createTruncationMarker({
    sessionId: input.sessionId,
    hostId,
    createdAt: now.toISOString(),
    droppedEventCount,
    droppedApproximateBytes,
  });
  let retained = [marker, ...events];

  while (
    retained.length > 1
    && totalEventBytes(retained) > policy.maxEventLogBytesPerSession
  ) {
    const dropped = retained[1];
    retained = [retained[0], ...retained.slice(2)];
    if (dropped) {
      droppedApproximateBytes += approximateEventBytes(dropped);
      droppedEventCount += 1;
      retained[0] = createTruncationMarker({
        sessionId: input.sessionId,
        hostId,
        createdAt: now.toISOString(),
        droppedEventCount,
        droppedApproximateBytes,
      });
    }
  }

  return {
    events: retained,
    truncated: true,
    droppedEventCount,
    droppedApproximateBytes,
  };
}
