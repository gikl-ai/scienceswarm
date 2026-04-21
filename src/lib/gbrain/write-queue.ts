export class GbrainWriteQueueFullError extends Error {
  readonly code = "gbrain_write_queue_full";
  constructor(limit: number) {
    super(`gbrain writer busy; queue capacity ${limit} is full`);
    this.name = "GbrainWriteQueueFullError";
  }
}

export interface GbrainWriteQueueOptions {
  maxQueued?: number;
}

const DEFAULT_MAX_QUEUED = 64;

interface QueueState {
  tail: Promise<unknown>;
  queued: number;
  maxQueued: number;
}

const state: QueueState = {
  tail: Promise.resolve(),
  queued: 0,
  maxQueued: DEFAULT_MAX_QUEUED,
};

export function configureGbrainWriteQueue(
  options: GbrainWriteQueueOptions,
): void {
  state.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
}

export function getGbrainWriteQueueDepth(): number {
  return state.queued;
}

export function enqueueGbrainWrite<T>(operation: () => Promise<T>): Promise<T> {
  if (state.queued >= state.maxQueued) {
    return Promise.reject(new GbrainWriteQueueFullError(state.maxQueued));
  }
  state.queued += 1;

  const run = state.tail.then(() => operation(), () => operation());
  state.tail = run.catch(() => undefined).finally(() => {
    state.queued -= 1;
  });
  return run;
}

export function runGbrainWriteBatch<T>(
  operations: Array<() => Promise<T>>,
): Promise<T[]> {
  return enqueueGbrainWrite(async () => {
    const results: T[] = [];
    for (const operation of operations) {
      results.push(await operation());
    }
    return results;
  });
}
