/**
 * Second Brain — Dream Cycle Scheduling
 *
 * Cron-compatible scheduling for automatic nightly dream cycles.
 * Simple cron parser (no external deps): "M H * * *" format.
 *
 * Persisted at {brain.root}/state/dream-schedule.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { BrainConfig } from "./types";
import type { DreamCycleMode } from "./dream-cycle";

// ── Types ─────────────────────────────────────────────

export interface DreamScheduleConfig {
  /** Whether scheduled dream cycles are enabled */
  enabled: boolean;
  /** Cron expression: "M H * * *" (minute hour day-of-month month day-of-week) */
  schedule: string;
  /** Dream cycle mode to run */
  mode: DreamCycleMode;
  /** Hour (0-23) when quiet hours start (dream cycle allowed) */
  quietHoursStart: number;
  /** Hour (0-23) when quiet hours end */
  quietHoursEnd: number;
}

// ── Defaults ─────────────────────────────────────────

function defaultSchedule(): DreamScheduleConfig {
  return {
    enabled: true,
    schedule: "0 3 * * *", // 3 AM daily
    mode: "full",
    quietHoursStart: 23, // 11 PM
    quietHoursEnd: 7, // 7 AM
  };
}

// ── Persistence ──────────────────────────────────────

function schedulePath(config: BrainConfig): string {
  return join(config.root, "state", "dream-schedule.json");
}

/**
 * Read the dream schedule config from disk.
 * Returns defaults if not found.
 */
export function readScheduleConfig(config: BrainConfig): DreamScheduleConfig {
  const path = schedulePath(config);
  if (!existsSync(path)) return defaultSchedule();

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DreamScheduleConfig>;
    const defaults = defaultSchedule();
    return {
      enabled: parsed.enabled ?? defaults.enabled,
      schedule: parsed.schedule ?? defaults.schedule,
      mode: parsed.mode ?? defaults.mode,
      quietHoursStart: parsed.quietHoursStart ?? defaults.quietHoursStart,
      quietHoursEnd: parsed.quietHoursEnd ?? defaults.quietHoursEnd,
    };
  } catch {
    return defaultSchedule();
  }
}

/**
 * Write the dream schedule config to disk.
 */
export function writeScheduleConfig(
  config: BrainConfig,
  schedule: DreamScheduleConfig,
): void {
  const path = schedulePath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(schedule, null, 2) + "\n");
}

// ── Cron Parsing ─────────────────────────────────────

interface CronFields {
  minute: number | null; // null = wildcard
  hour: number | null;
  dayOfMonth: number | null;
  month: number | null;
  dayOfWeek: number | null;
  minuteValues: number[] | null;
  hourValues: number[] | null;
  dayOfMonthValues: number[] | null;
  monthValues: number[] | null;
  dayOfWeekValues: number[] | null;
}

/**
 * Parse a simple cron expression: "M H DOM MON DOW"
 * Supports numeric values, comma-separated lists, ranges, and "*" wildcards.
 * Returns null if the expression is invalid.
 */
export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  function parseField(
    field: string,
    min: number,
    max: number,
  ): { display: number | null; values: number[] | null } | null {
    if (field === "*") return { display: null, values: null };

    const values = new Set<number>();
    for (const part of field.split(",")) {
      if (/^\d+$/.test(part)) {
        const value = Number.parseInt(part, 10);
        if (value < min || value > max) return null;
        values.add(value);
        continue;
      }

      const range = part.match(/^(\d+)-(\d+)$/);
      if (range) {
        const start = Number.parseInt(range[1] as string, 10);
        const end = Number.parseInt(range[2] as string, 10);
        if (start < min || end > max || start > end) return null;
        for (let value = start; value <= end; value += 1) {
          values.add(value);
        }
        continue;
      }

      return null;
    }

    const sortedValues = [...values].sort((left, right) => left - right);
    if (sortedValues.length === 0) return null;
    return {
      display: sortedValues.length === 1 ? sortedValues[0] as number : null,
      values: sortedValues,
    };
  }

  const minute = parseField(parts[0] as string, 0, 59);
  const hour = parseField(parts[1] as string, 0, 23);
  const dayOfMonth = parseField(parts[2] as string, 1, 31);
  const month = parseField(parts[3] as string, 1, 12);
  const dayOfWeek = parseField(parts[4] as string, 0, 6);

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;

  return {
    minute: minute.display,
    hour: hour.display,
    dayOfMonth: dayOfMonth.display,
    month: month.display,
    dayOfWeek: dayOfWeek.display,
    minuteValues: minute.values,
    hourValues: hour.values,
    dayOfMonthValues: dayOfMonth.values,
    monthValues: month.values,
    dayOfWeekValues: dayOfWeek.values,
  };
}

/**
 * Check whether a Date matches a cron expression.
 */
export function matchesCron(cron: CronFields, date: Date): boolean {
  if (!fieldMatches(cron.minuteValues, date.getMinutes())) return false;
  if (!fieldMatches(cron.hourValues, date.getHours())) return false;
  if (!fieldMatches(cron.dayOfMonthValues, date.getDate())) return false;
  if (!fieldMatches(cron.monthValues, date.getMonth() + 1)) return false;
  if (!fieldMatches(cron.dayOfWeekValues, date.getDay())) return false;
  return true;
}

function fieldMatches(values: number[] | null, value: number): boolean {
  return values === null || values.includes(value);
}

// ── Quiet Hours ──────────────────────────────────────

/**
 * Check whether the current hour falls within quiet hours.
 * Quiet hours are the window when the dream cycle is allowed to run.
 *
 * Handles wrap-around: if start=23 and end=7, hours 23,0,1,...,6 are quiet.
 */
export function isQuietHour(
  currentHour: number,
  quietStart: number,
  quietEnd: number,
): boolean {
  if (quietStart <= quietEnd) {
    // Simple range: e.g. 1-5
    return currentHour >= quietStart && currentHour < quietEnd;
  }
  // Wrap-around: e.g. 23-7 means 23,0,1,2,3,4,5,6
  return currentHour >= quietStart || currentHour < quietEnd;
}

// ── Public API ───────────────────────────────────────

/**
 * Check whether the dream cycle should run now based on the schedule.
 * Returns true if:
 * - Schedule is enabled
 * - Current time matches the cron expression
 * - Current hour is within quiet hours
 */
export function shouldRunNow(
  schedule: DreamScheduleConfig,
  now?: Date,
): boolean {
  if (!schedule.enabled) return false;

  const date = now ?? new Date();

  // Check quiet hours first
  if (!isQuietHour(date.getHours(), schedule.quietHoursStart, schedule.quietHoursEnd)) {
    return false;
  }

  // Parse and match cron
  const cron = parseCron(schedule.schedule);
  if (!cron) return false;

  return matchesCron(cron, date);
}

/**
 * Calculate when the dream cycle will next run.
 * Scans forward minute-by-minute up to 48 hours.
 */
export function getNextRunTime(
  schedule: DreamScheduleConfig,
  from?: Date,
): Date | null {
  if (!schedule.enabled) return null;

  const cron = parseCron(schedule.schedule);
  if (!cron) return null;

  // Start from next minute
  const start = from ? new Date(from) : new Date();
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Scan up to 48 hours (2880 minutes)
  const maxMinutes = 48 * 60;
  const candidate = new Date(start);

  for (let i = 0; i < maxMinutes; i++) {
    if (
      matchesCron(cron, candidate) &&
      isQuietHour(candidate.getHours(), schedule.quietHoursStart, schedule.quietHoursEnd)
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null; // No match in 48h window
}
