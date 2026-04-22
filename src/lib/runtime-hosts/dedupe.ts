import { createHash, randomUUID } from "node:crypto";

import type { RuntimeHostId, RuntimeTurnMode } from "./contracts";

export type RuntimeDedupeOperation =
  | RuntimeTurnMode
  | "artifact-writeback";

export type RuntimeDedupeRecordStatus =
  | "in-flight"
  | "completed"
  | "failed";

export interface RuntimeDedupeRecord {
  key: string;
  operation: RuntimeDedupeOperation;
  sessionId: string;
  status: RuntimeDedupeRecordStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  expiresAt?: string;
}

export interface RuntimeDedupePolicy {
  completedWindowMsByOperation: Record<RuntimeDedupeOperation, number>;
}

export interface RuntimeDedupePolicyInput {
  completedWindowMsByOperation?: Partial<Record<RuntimeDedupeOperation, number>>;
}

export interface RuntimeIdempotencyKeyInput {
  operation: RuntimeDedupeOperation;
  projectId?: string | null;
  conversationId?: string | null;
  hostIds: Array<RuntimeHostId | string>;
  prompt?: string;
  inputHash?: string;
  clientSubmitId?: string | null;
  extra?: Record<string, unknown>;
}

export interface RuntimeDedupeClaimInput {
  key: string;
  operation: RuntimeDedupeOperation;
  sessionId?: string;
  bypassCompletedDedupe?: boolean;
}

export type RuntimeDedupeClaimResult =
  | {
      decision: "claimed";
      record: RuntimeDedupeRecord;
    }
  | {
      decision: "deduped-in-flight" | "deduped-completed";
      record: RuntimeDedupeRecord;
    };

export interface RuntimeDedupeStoreOptions {
  now?: () => Date;
  idGenerator?: () => string;
  policy?: RuntimeDedupePolicyInput;
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RUNTIME_DEDUPE_WINDOWS_MS: Record<
  RuntimeDedupeOperation,
  number
> = {
  chat: 2 * MINUTE_MS,
  task: 10 * MINUTE_MS,
  compare: 10 * MINUTE_MS,
  "mcp-tool": 10 * MINUTE_MS,
  "artifact-import": DAY_MS,
  "artifact-writeback": DAY_MS,
};

function positiveWindowOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  ).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePrompt(prompt: string | undefined): string | null {
  if (prompt === undefined) return null;
  return prompt.trim().replace(/\s+/g, " ");
}

function cloneRecord(record: RuntimeDedupeRecord): RuntimeDedupeRecord {
  return { ...record };
}

function expiresAtFor(
  operation: RuntimeDedupeOperation,
  completedAt: Date,
  policy: RuntimeDedupePolicy,
): string {
  return new Date(
    completedAt.getTime() + policy.completedWindowMsByOperation[operation],
  ).toISOString();
}

function isCompletedRecordFresh(
  record: RuntimeDedupeRecord,
  now: Date,
): boolean {
  if (record.status !== "completed" || !record.expiresAt) return false;
  return Date.parse(record.expiresAt) >= now.getTime();
}

export function normalizeRuntimeDedupePolicy(
  input: RuntimeDedupePolicyInput = {},
): RuntimeDedupePolicy {
  return {
    completedWindowMsByOperation: {
      chat: positiveWindowOrDefault(
        input.completedWindowMsByOperation?.chat,
        DEFAULT_RUNTIME_DEDUPE_WINDOWS_MS.chat,
      ),
      task: positiveWindowOrDefault(
        input.completedWindowMsByOperation?.task,
        DEFAULT_RUNTIME_DEDUPE_WINDOWS_MS.task,
      ),
      compare: positiveWindowOrDefault(
        input.completedWindowMsByOperation?.compare,
        DEFAULT_RUNTIME_DEDUPE_WINDOWS_MS.compare,
      ),
      "mcp-tool": positiveWindowOrDefault(
        input.completedWindowMsByOperation?.["mcp-tool"],
        DEFAULT_RUNTIME_DEDUPE_WINDOWS_MS["mcp-tool"],
      ),
      "artifact-import": positiveWindowOrDefault(
        input.completedWindowMsByOperation?.["artifact-import"],
        DEFAULT_RUNTIME_DEDUPE_WINDOWS_MS["artifact-import"],
      ),
      "artifact-writeback": positiveWindowOrDefault(
        input.completedWindowMsByOperation?.["artifact-writeback"],
        DEFAULT_RUNTIME_DEDUPE_WINDOWS_MS["artifact-writeback"],
      ),
    },
  };
}

export function createRuntimeIdempotencyKey(
  input: RuntimeIdempotencyKeyInput,
): string {
  const promptHash = input.inputHash
    ?? (input.prompt === undefined ? null : sha256(normalizePrompt(input.prompt) ?? ""));
  const payload = {
    operation: input.operation,
    projectId: input.projectId ?? null,
    conversationId: input.conversationId ?? null,
    hostIds: [...input.hostIds].sort(),
    promptHash,
    clientSubmitId: input.clientSubmitId ?? null,
    extra: input.extra ?? null,
  };
  return `runtime:${input.operation}:${sha256(stableJson(payload))}`;
}

export class RuntimeDedupeStore {
  private readonly records = new Map<string, RuntimeDedupeRecord>();
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly policy: RuntimeDedupePolicy;

  constructor(options: RuntimeDedupeStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
    this.policy = normalizeRuntimeDedupePolicy(options.policy);
  }

  claimOperation(input: RuntimeDedupeClaimInput): RuntimeDedupeClaimResult {
    const now = this.now();
    const nowIso = now.toISOString();
    const existing = this.records.get(input.key);

    if (existing?.status === "in-flight") {
      return {
        decision: "deduped-in-flight",
        record: cloneRecord(existing),
      };
    }

    if (
      existing
      && isCompletedRecordFresh(existing, now)
      && !input.bypassCompletedDedupe
    ) {
      return {
        decision: "deduped-completed",
        record: cloneRecord(existing),
      };
    }

    const record: RuntimeDedupeRecord = {
      key: input.key,
      operation: input.operation,
      sessionId: input.sessionId ?? `rt-session-${this.idGenerator()}`,
      status: "in-flight",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.records.set(input.key, cloneRecord(record));
    return {
      decision: "claimed",
      record: cloneRecord(record),
    };
  }

  completeOperation(key: string, sessionId?: string): RuntimeDedupeRecord | null {
    const record = this.records.get(key);
    if (!record) return null;
    if (record.status === "completed") return cloneRecord(record);

    const now = this.now();
    const completed: RuntimeDedupeRecord = {
      ...record,
      sessionId: sessionId ?? record.sessionId,
      status: "completed",
      updatedAt: now.toISOString(),
      completedAt: now.toISOString(),
      expiresAt: expiresAtFor(record.operation, now, this.policy),
    };
    this.records.set(key, cloneRecord(completed));
    return cloneRecord(completed);
  }

  failOperation(key: string): RuntimeDedupeRecord | null {
    const record = this.records.get(key);
    if (!record) return null;
    if (record.status === "completed") return cloneRecord(record);

    const failed: RuntimeDedupeRecord = {
      ...record,
      status: "failed",
      updatedAt: this.now().toISOString(),
      completedAt: undefined,
      expiresAt: undefined,
    };
    this.records.set(key, cloneRecord(failed));
    return cloneRecord(failed);
  }

  getRecord(key: string): RuntimeDedupeRecord | null {
    const record = this.records.get(key);
    return record ? cloneRecord(record) : null;
  }

  pruneExpiredCompleted(): number {
    const now = this.now();
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (record.status === "completed" && !isCompletedRecordFresh(record, now)) {
        this.records.delete(key);
        deleted += 1;
      }
      if (record.status === "failed") {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  clear(): void {
    this.records.clear();
  }
}

export function createRuntimeDedupeStore(
  options: RuntimeDedupeStoreOptions = {},
): RuntimeDedupeStore {
  return new RuntimeDedupeStore(options);
}
