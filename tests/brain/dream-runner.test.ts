import { describe, expect, it } from "vitest";

import {
  computeDreamRunnerSleepSeconds,
  fallbackDreamRunnerSleepSeconds,
} from "@/brain/dream-runner";
import type { DreamScheduleConfig } from "@/brain/dream-scheduler";

function makeSchedule(
  overrides?: Partial<DreamScheduleConfig>,
): DreamScheduleConfig {
  return {
    enabled: true,
    schedule: "0 3 * * *",
    mode: "full",
    quietHoursStart: 23,
    quietHoursEnd: 7,
    ...overrides,
  };
}

describe("dream runner sleep resolution", () => {
  it("falls back to the max idle poll window when scheduling is disabled", () => {
    expect(
      computeDreamRunnerSleepSeconds(makeSchedule({ enabled: false }), {
        now: new Date(2026, 3, 20, 10, 0, 0),
        maxIdlePollMinutes: 45,
      }),
    ).toBe(45 * 60);
  });

  it("sleeps until the next run when it is sooner than the idle poll cap", () => {
    expect(
      computeDreamRunnerSleepSeconds(makeSchedule(), {
        now: new Date(2026, 3, 20, 2, 50, 0),
        maxIdlePollMinutes: 60,
      }),
    ).toBe(10 * 60);
  });

  it("caps long waits to the configured max idle poll interval", () => {
    expect(
      computeDreamRunnerSleepSeconds(makeSchedule(), {
        now: new Date(2026, 3, 20, 10, 0, 0),
        maxIdlePollMinutes: 60,
      }),
    ).toBe(60 * 60);
  });

  it("normalizes invalid idle poll values to the default fallback", () => {
    expect(fallbackDreamRunnerSleepSeconds(0)).toBe(60 * 60);
    expect(fallbackDreamRunnerSleepSeconds(Number.NaN)).toBe(60 * 60);
  });
});
