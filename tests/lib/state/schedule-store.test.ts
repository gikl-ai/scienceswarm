import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  getScheduleStorePath,
  readScheduleStore,
  writeScheduleStore,
} from "@/lib/state/schedule-store";

const ROOT = join(tmpdir(), "scienceswarm-state-schedule-store");

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("schedule-store", () => {
  it("writes and reads the schedule store", async () => {
    const store = {
      version: 1 as const,
      jobs: { job1: { status: "pending" } },
      pipelines: { pipeline1: { status: "idle" } },
      updatedAt: "2026-04-08T00:00:00.000Z",
    };

    await writeScheduleStore(store, ROOT);
    const loaded = await readScheduleStore(ROOT);
    expect(loaded).toEqual(store);
    expect(readFileSync(getScheduleStorePath(ROOT), "utf-8")).toContain('"job1"');
  });
});
