import { describe, expect, it } from "vitest";

import {
  createRuntimeConcurrencyManager,
  normalizeRuntimeConcurrencyPolicy,
} from "@/lib/runtime-hosts";

describe("runtime concurrency policy", () => {
  it("defaults compare child concurrency to three and exposes queued state", () => {
    const manager = createRuntimeConcurrencyManager();

    const slots = [1, 2, 3, 4].map((index) =>
      manager.requestSlot({
        id: `compare-${index}`,
        lane: "compare-child",
        sessionId: `session-${index}`,
      })
    );

    expect(slots.map((slot) => slot.state)).toEqual([
      "running",
      "running",
      "running",
      "queued",
    ]);
    expect(slots[3]).toMatchObject({
      queuePosition: 1,
    });
    expect(manager.snapshot()).toMatchObject({
      policy: {
        compare: {
          maxChildren: 3,
        },
      },
      running: expect.arrayContaining([
        expect.objectContaining({ id: "compare-1" }),
        expect.objectContaining({ id: "compare-2" }),
        expect.objectContaining({ id: "compare-3" }),
      ]),
      queued: [expect.objectContaining({ id: "compare-4" })],
    });
  });

  it("promotes queued work when a running slot is released", () => {
    const manager = createRuntimeConcurrencyManager({
      policy: {
        compare: {
          maxChildren: 1,
        },
      },
    });
    manager.requestSlot({ id: "compare-1", lane: "compare-child" });
    manager.requestSlot({ id: "compare-2", lane: "compare-child" });

    const release = manager.releaseSlot("compare-1");

    expect(release).toMatchObject({
      released: { id: "compare-1", state: "running" },
      promoted: { id: "compare-2", state: "running" },
    });
    expect(manager.snapshot()).toMatchObject({
      running: [expect.objectContaining({ id: "compare-2" })],
      queued: [],
    });
  });

  it("respects user/project concurrency configuration", () => {
    const policy = normalizeRuntimeConcurrencyPolicy({
      compare: {
        maxChildren: 2,
      },
      task: {
        maxRunning: 2,
      },
      mcp: {
        maxRead: 4,
        maxWrite: 1,
      },
    });

    expect(policy).toEqual({
      compare: {
        maxChildren: 2,
      },
      task: {
        maxRunning: 2,
      },
      mcp: {
        maxRead: 4,
        maxWrite: 1,
      },
    });

    const manager = createRuntimeConcurrencyManager({ policy });
    expect(
      [1, 2, 3].map((index) =>
        manager.requestSlot({
          id: `task-${index}`,
          lane: "task",
        }).state
      ),
    ).toEqual(["running", "running", "queued"]);
  });

  it("exposes blocked state when queueing is disabled", () => {
    const manager = createRuntimeConcurrencyManager({
      policy: {
        mcp: {
          maxWrite: 1,
        },
      },
    });

    manager.requestSlot({ id: "write-1", lane: "mcp-write" });
    const blocked = manager.requestSlot({
      id: "write-2",
      lane: "mcp-write",
      queue: false,
    });

    expect(blocked).toMatchObject({
      id: "write-2",
      state: "blocked",
    });
    expect(manager.snapshot().blocked).toEqual([
      expect.objectContaining({ id: "write-2", state: "blocked" }),
    ]);
  });
});
