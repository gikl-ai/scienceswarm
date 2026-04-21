import { describe, expect, test } from "vitest";
import { DEFAULT_SCHEDULE, DEFAULT_CHANNELS } from "@/lib/radar/types";

describe("radar defaults", () => {
  test("default schedule is 6 AM", () => {
    expect(DEFAULT_SCHEDULE.cron).toBe("0 6 * * *");
  });

  test("default channels: dashboard on, telegram off, email off", () => {
    expect(DEFAULT_CHANNELS).toEqual({
      telegram: false,
      dashboard: true,
      email: false,
    });
  });
});
