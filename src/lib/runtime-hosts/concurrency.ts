import { randomUUID } from "node:crypto";

export type RuntimeConcurrencyLane =
  | "compare-child"
  | "task"
  | "mcp-read"
  | "mcp-write";

export type RuntimeConcurrencySlotState = "running" | "queued" | "blocked";

export interface RuntimeConcurrencyPolicy {
  compare: {
    maxChildren: number;
  };
  task: {
    maxRunning: number;
  };
  mcp: {
    maxRead: number;
    maxWrite: number;
  };
}

export interface RuntimeConcurrencyPolicyInput {
  compare?: {
    maxChildren?: number;
  };
  task?: {
    maxRunning?: number;
  };
  mcp?: {
    maxRead?: number;
    maxWrite?: number;
  };
}

export interface RuntimeConcurrencyRequest {
  id?: string;
  lane: RuntimeConcurrencyLane;
  sessionId?: string;
  queue?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RuntimeConcurrencySlot {
  id: string;
  lane: RuntimeConcurrencyLane;
  state: RuntimeConcurrencySlotState;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  queuePosition?: number;
  metadata?: Record<string, unknown>;
}

export interface RuntimeConcurrencyReleaseResult {
  released: RuntimeConcurrencySlot | null;
  promoted: RuntimeConcurrencySlot | null;
}

export interface RuntimeConcurrencySnapshot {
  policy: RuntimeConcurrencyPolicy;
  running: RuntimeConcurrencySlot[];
  queued: RuntimeConcurrencySlot[];
  blocked: RuntimeConcurrencySlot[];
}

export interface RuntimeConcurrencyManagerOptions {
  now?: () => Date;
  idGenerator?: () => string;
  policy?: RuntimeConcurrencyPolicyInput;
}

export const DEFAULT_RUNTIME_CONCURRENCY_POLICY: RuntimeConcurrencyPolicy = {
  compare: {
    maxChildren: 3,
  },
  task: {
    maxRunning: 1,
  },
  mcp: {
    maxRead: 8,
    maxWrite: 2,
  },
};

function positiveIntegerOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function cloneSlot(slot: RuntimeConcurrencySlot): RuntimeConcurrencySlot {
  return JSON.parse(JSON.stringify(slot)) as RuntimeConcurrencySlot;
}

function limitForLane(
  policy: RuntimeConcurrencyPolicy,
  lane: RuntimeConcurrencyLane,
): number {
  if (lane === "compare-child") return policy.compare.maxChildren;
  if (lane === "task") return policy.task.maxRunning;
  if (lane === "mcp-read") return policy.mcp.maxRead;
  return policy.mcp.maxWrite;
}

function findAndRemoveSlot(
  slotsByLane: Map<RuntimeConcurrencyLane, RuntimeConcurrencySlot[]>,
  id: string,
): RuntimeConcurrencySlot | null {
  for (const [lane, slots] of slotsByLane) {
    const index = slots.findIndex((slot) => slot.id === id);
    if (index >= 0) {
      const [slot] = slots.splice(index, 1);
      slotsByLane.set(lane, slots);
      return slot ? cloneSlot(slot) : null;
    }
  }
  return null;
}

function allSlots(
  slotsByLane: Map<RuntimeConcurrencyLane, RuntimeConcurrencySlot[]>,
): RuntimeConcurrencySlot[] {
  return Array.from(slotsByLane.values()).flat().map(cloneSlot);
}

export function normalizeRuntimeConcurrencyPolicy(
  input: RuntimeConcurrencyPolicyInput = {},
): RuntimeConcurrencyPolicy {
  return {
    compare: {
      maxChildren: positiveIntegerOrDefault(
        input.compare?.maxChildren,
        DEFAULT_RUNTIME_CONCURRENCY_POLICY.compare.maxChildren,
      ),
    },
    task: {
      maxRunning: positiveIntegerOrDefault(
        input.task?.maxRunning,
        DEFAULT_RUNTIME_CONCURRENCY_POLICY.task.maxRunning,
      ),
    },
    mcp: {
      maxRead: positiveIntegerOrDefault(
        input.mcp?.maxRead,
        DEFAULT_RUNTIME_CONCURRENCY_POLICY.mcp.maxRead,
      ),
      maxWrite: positiveIntegerOrDefault(
        input.mcp?.maxWrite,
        DEFAULT_RUNTIME_CONCURRENCY_POLICY.mcp.maxWrite,
      ),
    },
  };
}

export class RuntimeConcurrencyManager {
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly policy: RuntimeConcurrencyPolicy;
  private readonly running = new Map<RuntimeConcurrencyLane, RuntimeConcurrencySlot[]>();
  private readonly queued = new Map<RuntimeConcurrencyLane, RuntimeConcurrencySlot[]>();
  private readonly blocked = new Map<RuntimeConcurrencyLane, RuntimeConcurrencySlot[]>();

  constructor(options: RuntimeConcurrencyManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
    this.policy = normalizeRuntimeConcurrencyPolicy(options.policy);
  }

  requestSlot(input: RuntimeConcurrencyRequest): RuntimeConcurrencySlot {
    const nowIso = this.now().toISOString();
    const id = input.id ?? `rt-concurrency-${this.idGenerator()}`;
    const laneRunning = this.running.get(input.lane) ?? [];
    const limit = limitForLane(this.policy, input.lane);
    const baseSlot: RuntimeConcurrencySlot = {
      id,
      lane: input.lane,
      state: "running",
      sessionId: input.sessionId,
      createdAt: nowIso,
      updatedAt: nowIso,
      metadata: input.metadata,
    };

    if (laneRunning.length < limit) {
      const slot = {
        ...baseSlot,
        startedAt: nowIso,
      };
      this.running.set(input.lane, [...laneRunning, cloneSlot(slot)]);
      return cloneSlot(slot);
    }

    if (input.queue === false) {
      const slot: RuntimeConcurrencySlot = {
        ...baseSlot,
        state: "blocked",
      };
      this.blocked.set(input.lane, [
        ...(this.blocked.get(input.lane) ?? []),
        cloneSlot(slot),
      ]);
      return cloneSlot(slot);
    }

    const laneQueued = this.queued.get(input.lane) ?? [];
    const slot: RuntimeConcurrencySlot = {
      ...baseSlot,
      state: "queued",
      queuePosition: laneQueued.length + 1,
    };
    this.queued.set(input.lane, [...laneQueued, cloneSlot(slot)]);
    return cloneSlot(slot);
  }

  releaseSlot(id: string): RuntimeConcurrencyReleaseResult {
    const releasedRunning = findAndRemoveSlot(this.running, id);
    if (!releasedRunning) {
      const releasedQueued = findAndRemoveSlot(this.queued, id);
      if (releasedQueued) {
        this.reindexQueued(releasedQueued.lane);
        return { released: releasedQueued, promoted: null };
      }

      const releasedBlocked = findAndRemoveSlot(this.blocked, id);
      return { released: releasedBlocked, promoted: null };
    }

    const promoted = this.promoteNext(releasedRunning.lane);
    return {
      released: releasedRunning,
      promoted,
    };
  }

  snapshot(): RuntimeConcurrencySnapshot {
    return {
      policy: JSON.parse(JSON.stringify(this.policy)) as RuntimeConcurrencyPolicy,
      running: allSlots(this.running),
      queued: allSlots(this.queued),
      blocked: allSlots(this.blocked),
    };
  }

  clear(): void {
    this.running.clear();
    this.queued.clear();
    this.blocked.clear();
  }

  private promoteNext(lane: RuntimeConcurrencyLane): RuntimeConcurrencySlot | null {
    const laneQueued = this.queued.get(lane) ?? [];
    const [next, ...rest] = laneQueued;
    if (!next) return null;

    const nowIso = this.now().toISOString();
    const promoted: RuntimeConcurrencySlot = {
      ...next,
      state: "running",
      updatedAt: nowIso,
      startedAt: nowIso,
      queuePosition: undefined,
    };
    this.queued.set(lane, rest);
    this.reindexQueued(lane);
    this.running.set(lane, [
      ...(this.running.get(lane) ?? []),
      cloneSlot(promoted),
    ]);
    return cloneSlot(promoted);
  }

  private reindexQueued(lane: RuntimeConcurrencyLane): void {
    const queued = (this.queued.get(lane) ?? []).map((slot, index) => ({
      ...slot,
      queuePosition: index + 1,
    }));
    this.queued.set(lane, queued);
  }
}

export function createRuntimeConcurrencyManager(
  options: RuntimeConcurrencyManagerOptions = {},
): RuntimeConcurrencyManager {
  return new RuntimeConcurrencyManager(options);
}
