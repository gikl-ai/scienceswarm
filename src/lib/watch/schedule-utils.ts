import type { ProjectWatchSchedule } from "./types";

export const WEEKDAY_OPTIONS = [
  { value: 0, label: "Sunday", shortLabel: "Sun" },
  { value: 1, label: "Monday", shortLabel: "Mon" },
  { value: 2, label: "Tuesday", shortLabel: "Tue" },
  { value: 3, label: "Wednesday", shortLabel: "Wed" },
  { value: 4, label: "Thursday", shortLabel: "Thu" },
  { value: 5, label: "Friday", shortLabel: "Fri" },
  { value: 6, label: "Saturday", shortLabel: "Sat" },
] as const;

function normalizeDayValue(day: number): number | null {
  if (!Number.isFinite(day)) return null;
  return ((Math.round(day) % 7) + 7) % 7;
}

export function normalizeWeeklyDays(daysOfWeek?: number[], legacyDayOfWeek?: number): number[] {
  const rawDays = Array.isArray(daysOfWeek) && daysOfWeek.length > 0
    ? daysOfWeek
    : legacyDayOfWeek === undefined
      ? []
      : [legacyDayOfWeek];

  return Array.from(
    new Set(
      rawDays
        .map(normalizeDayValue)
        .filter((day): day is number => day !== null),
    ),
  ).sort((left, right) => left - right);
}

export function getScheduleDays(schedule: ProjectWatchSchedule | undefined): number[] {
  if (!schedule || schedule.cadence !== "weekly") {
    return [];
  }

  const days = normalizeWeeklyDays(schedule.daysOfWeek, schedule.dayOfWeek);
  return days.length > 0 ? days : [1];
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function formatWatchScheduleSummary(schedule: ProjectWatchSchedule | undefined): string {
  if (!schedule?.enabled) return "not scheduled";

  if (schedule.cadence === "weekdays") {
    return `weekdays at ${schedule.time} (${schedule.timezone})`;
  }

  if (schedule.cadence === "weekly") {
    const dayLabels = getScheduleDays(schedule).map(
      (day) => WEEKDAY_OPTIONS.find((option) => option.value === day)?.label ?? `Day ${day}`,
    );
    return `weekly on ${joinLabels(dayLabels)} at ${schedule.time} (${schedule.timezone})`;
  }

  return `daily at ${schedule.time} (${schedule.timezone})`;
}
