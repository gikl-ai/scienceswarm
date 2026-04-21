import { describe, expect, it } from "vitest";

import {
  configureGbrainWriteQueue,
  enqueueGbrainWrite,
  GbrainWriteQueueFullError,
} from "@/lib/gbrain/write-queue";

describe("gbrain write queue", () => {
  it("serializes writes in enqueue order and isolates failures", async () => {
    configureGbrainWriteQueue({ maxQueued: 10 });
    const events: string[] = [];
    const first = enqueueGbrainWrite(async () => {
      events.push("first");
      return 1;
    });
    const second = enqueueGbrainWrite(async () => {
      events.push("second");
      throw new Error("boom");
    });
    const third = enqueueGbrainWrite(async () => {
      events.push("third");
      return 3;
    });

    await expect(first).resolves.toBe(1);
    await expect(second).rejects.toThrow("boom");
    await expect(third).resolves.toBe(3);
    expect(events).toEqual(["first", "second", "third"]);
  });

  it("rejects when queue is over capacity", async () => {
    configureGbrainWriteQueue({ maxQueued: 1 });
    let release!: () => void;
    const blocker = enqueueGbrainWrite(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await expect(enqueueGbrainWrite(async () => undefined)).rejects.toBeInstanceOf(
      GbrainWriteQueueFullError,
    );
    release();
    await blocker;
    configureGbrainWriteQueue({ maxQueued: 64 });
  });
});

