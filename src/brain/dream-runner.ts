import type { BrainConfig } from "./types";
import {
  getNextRunTime,
  readScheduleConfig,
  type DreamScheduleConfig,
} from "./dream-scheduler";

const DEFAULT_MAX_IDLE_POLL_MINUTES = 60;
const MIN_SLEEP_SECONDS = 60;

function normalizeMaxIdlePollMinutes(value?: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 1) {
    return DEFAULT_MAX_IDLE_POLL_MINUTES;
  }
  return Math.floor(value);
}

export function fallbackDreamRunnerSleepSeconds(maxIdlePollMinutes?: number): number {
  return normalizeMaxIdlePollMinutes(maxIdlePollMinutes) * 60;
}

export function computeDreamRunnerSleepSeconds(
  schedule: DreamScheduleConfig,
  options?: {
    now?: Date;
    maxIdlePollMinutes?: number;
  },
): number {
  const now = options?.now ?? new Date();
  const fallbackSeconds = fallbackDreamRunnerSleepSeconds(
    options?.maxIdlePollMinutes,
  );
  const nextRun = getNextRunTime(schedule, now);

  if (!nextRun) {
    return fallbackSeconds;
  }

  const deltaSeconds = Math.ceil((nextRun.getTime() - now.getTime()) / 1000);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
    return MIN_SLEEP_SECONDS;
  }

  return Math.max(MIN_SLEEP_SECONDS, Math.min(fallbackSeconds, deltaSeconds));
}

export function resolveDreamRunnerSleepSeconds(
  config: BrainConfig,
  options?: {
    now?: Date;
    maxIdlePollMinutes?: number;
  },
): number {
  return computeDreamRunnerSleepSeconds(readScheduleConfig(config), options);
}
