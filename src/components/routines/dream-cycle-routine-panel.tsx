"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  Check,
  Flask,
  LinkSimple,
  MoonStars,
  WarningDiamond,
} from "@phosphor-icons/react";
import { Spinner } from "@/components/spinner";

type DreamCycleMode = "full" | "sweep-only" | "enrich-only";

interface DreamCompiledTopic {
  slug: string;
  title: string;
  contradictions?: unknown[];
  backlinksAdded?: number;
  compiledTruthPreview?: string;
}

interface DreamSignal {
  slug: string;
  title: string;
  sourceKind: string;
  observedAt: string;
}

interface DreamStaleExperiment {
  slug: string;
  title: string;
  kind?: "experiment" | "task";
  lastObservedAt: string | null;
  reason: string;
}

interface DreamHeadlineSummary {
  generatedAt: string;
  headline: string;
  newSignals: number;
  newPapers: number;
  topicsRecompiled: number;
  contradictionsFound: number;
  staleExperiments: number;
  crossReferencesAdded: number;
  compiledTopics: DreamCompiledTopic[];
  signals: DreamSignal[];
  staleExperimentDetails: DreamStaleExperiment[];
}

interface DreamLastRun {
  timestamp: string;
  mode: string;
  journal_slug?: string;
  pages_compiled: number;
  contradictions_found: number;
  backlinks_added: number;
  duration_ms: number;
  partial: boolean;
  skipped?: boolean;
  reason?: string;
  errors?: string[];
  headline?: DreamHeadlineSummary;
}

interface DreamScheduleState {
  enabled: boolean;
  schedule: string;
  mode: DreamCycleMode;
  quietHoursStart: number;
  quietHoursEnd: number;
  nextRun: string | null;
}

const DEFAULT_SCHEDULE: DreamScheduleState = {
  enabled: false,
  schedule: "0 3 * * *",
  mode: "full",
  quietHoursStart: 0,
  quietHoursEnd: 6,
  nextRun: null,
};

const CRON_PRESETS = [
  { label: "Nightly", value: "0 3 * * *" },
  { label: "Weekdays", value: "0 6 * * 1-5" },
  { label: "Weekly", value: "0 7 * * 1" },
];

const inputClassName =
  "h-10 w-full rounded-lg border-2 border-border bg-background px-3 text-sm text-foreground transition-colors focus:border-accent focus:outline-none";

export function DreamCycleRoutinePanel({
  onNavigateBrainPage,
}: {
  onNavigateBrainPage?: (slug: string) => void;
}) {
  const [lastRun, setLastRun] = useState<DreamLastRun | null>(null);
  const [schedule, setSchedule] = useState<DreamScheduleState>(DEFAULT_SCHEDULE);
  const [draft, setDraft] = useState<DreamScheduleState>(DEFAULT_SCHEDULE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDreamCycle = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [dreamResponse, scheduleResponse] = await Promise.all([
        fetch("/api/brain/dream", { signal }),
        fetch("/api/brain/dream-schedule", { signal }),
      ]);

      const dreamBody = (await dreamResponse.json().catch(() => ({}))) as {
        lastRun?: DreamLastRun | null;
        error?: string;
      };
      const scheduleBody = (await scheduleResponse.json().catch(() => ({}))) as
        Partial<DreamScheduleState> & { error?: string };

      if (!dreamResponse.ok) {
        throw new Error(dreamBody.error || "Dream Cycle status failed");
      }
      if (!scheduleResponse.ok) {
        throw new Error(scheduleBody.error || "Dream Cycle schedule failed");
      }

      const nextSchedule = normalizeSchedule(scheduleBody);
      setLastRun(dreamBody.lastRun ?? null);
      setSchedule(nextSchedule);
      setDraft(nextSchedule);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Dream Cycle status failed");
      setLastRun(null);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadDreamCycle(controller.signal);
    return () => controller.abort();
  }, [loadDreamCycle]);

  const hasDraftChanges = useMemo(
    () =>
      draft.enabled !== schedule.enabled ||
      draft.schedule !== schedule.schedule ||
      draft.mode !== schedule.mode ||
      draft.quietHoursStart !== schedule.quietHoursStart ||
      draft.quietHoursEnd !== schedule.quietHoursEnd,
    [draft, schedule],
  );

  const summary = useMemo(() => lastRun?.headline ?? fallbackHeadline(lastRun), [lastRun]);

  async function saveSchedule() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/brain/dream-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: draft.enabled,
          schedule: draft.schedule,
          mode: draft.mode,
          quietHoursStart: draft.quietHoursStart,
          quietHoursEnd: draft.quietHoursEnd,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as
        Partial<DreamScheduleState> & { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Could not save Dream Cycle schedule");
      }
      const nextSchedule = normalizeSchedule(body);
      setSchedule(nextSchedule);
      setDraft(nextSchedule);
      setMessage("Dream Cycle schedule saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save Dream Cycle schedule");
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/brain/dream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: draft.mode }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Dream Cycle run failed");
      }
      await loadDreamCycle();
      setMessage("Dream Cycle run completed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dream Cycle run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-5">
        <Metric label="New papers" value={summary?.newPapers ?? 0} />
        <Metric label="Topics rewritten" value={summary?.topicsRecompiled ?? lastRun?.pages_compiled ?? 0} />
        <Metric
          icon={<WarningDiamond size={14} />}
          label="Contradictions"
          value={summary?.contradictionsFound ?? lastRun?.contradictions_found ?? 0}
        />
        <Metric
          icon={<Flask size={14} />}
          label="Stale work"
          value={summary?.staleExperiments ?? 0}
        />
        <Metric
          icon={<LinkSimple size={14} />}
          label="Cross-links"
          value={summary?.crossReferencesAdded ?? lastRun?.backlinks_added ?? 0}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
                <MoonStars size={14} />
                Dream Cycle
              </div>
              <p className="mt-2 text-sm font-semibold text-foreground">
                {summary?.headline ?? "No overnight run yet."}
              </p>
              <p className="mt-1 text-xs text-muted">
                {lastRun
                  ? `${lastRun.partial ? "Partial run" : lastRun.skipped ? "Skipped run" : "Last run"} ${formatRelativeTime(lastRun.timestamp)}`
                  : loading
                    ? "Loading last run..."
                    : "No run recorded."}
                {schedule.nextRun ? ` Next ${formatRelativeTime(schedule.nextRun)}.` : ""}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {lastRun?.journal_slug && onNavigateBrainPage ? (
                <button
                  type="button"
                  onClick={() => onNavigateBrainPage(lastRun.journal_slug as string)}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                >
                  <LinkSimple size={14} />
                  Open journal
                </button>
              ) : null}
              <button
                type="button"
                onClick={runNow}
                disabled={running || loading}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {running ? <Spinner size="h-3.5 w-3.5" /> : <ArrowClockwise size={14} />}
                {running ? "Running" : "Run now"}
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-background p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm font-semibold text-foreground sm:col-span-2">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, enabled: event.target.checked }));
                }}
                className="h-4 w-4 accent-accent"
              />
              Scheduled run enabled
            </label>
            <div className="space-y-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted sm:col-span-2">
              <span>Schedule</span>
              <div className="flex flex-wrap gap-2">
                {CRON_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => {
                      setDraft((current) => ({ ...current, schedule: preset.value }));
                    }}
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold normal-case tracking-normal transition-colors ${
                      draft.schedule === preset.value
                        ? "border-accent bg-accent-faint text-accent"
                        : "border-border bg-white text-muted hover:border-accent hover:text-foreground"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <input
                aria-label="Dream Cycle cron schedule"
                value={draft.schedule}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, schedule: event.target.value }));
                }}
                className={`${inputClassName} font-mono normal-case tracking-normal`}
                placeholder="0 3 * * *"
              />
            </div>
            <label className="space-y-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
              Mode
              <select
                value={draft.mode}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    mode: event.target.value as DreamCycleMode,
                  }));
                }}
                className={inputClassName}
              >
                <option value="full">Full</option>
                <option value="sweep-only">Sweep only</option>
                <option value="enrich-only">Enrich only</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                label="Quiet start"
                value={draft.quietHoursStart}
                onChange={(value) => {
                  setDraft((current) => ({ ...current, quietHoursStart: value }));
                }}
              />
              <NumberField
                label="Quiet end"
                value={draft.quietHoursEnd}
                onChange={(value) => {
                  setDraft((current) => ({ ...current, quietHoursEnd: value }));
                }}
              />
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted">
              {draft.enabled
                ? schedule.nextRun
                  ? `Next run ${formatRelativeTime(schedule.nextRun)}.`
                  : "Schedule will run when the runner is due."
                : "Scheduled Dream Cycle is disabled."}
            </p>
            <button
              type="button"
              onClick={() => void saveSchedule()}
              disabled={saving || !hasDraftChanges}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Spinner size="h-3.5 w-3.5" /> : <Check size={14} />}
              {saving ? "Saving" : "Save schedule"}
            </button>
          </div>
        </div>
      </div>

      {message ? (
        <p className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
      {label}
      <input
        type="number"
        min={0}
        max={23}
        value={value}
        onChange={(event) => {
          const nextValue = Number.parseInt(event.target.value, 10);
          onChange(Number.isFinite(nextValue) ? Math.min(23, Math.max(0, nextValue)) : 0);
        }}
        className={inputClassName}
      />
    </label>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon?: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="min-h-16 rounded-lg border border-border bg-background px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-muted">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

function normalizeSchedule(value: Partial<DreamScheduleState>): DreamScheduleState {
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_SCHEDULE.enabled,
    schedule: typeof value.schedule === "string" && value.schedule.trim()
      ? value.schedule
      : DEFAULT_SCHEDULE.schedule,
    mode: isDreamCycleMode(value.mode) ? value.mode : DEFAULT_SCHEDULE.mode,
    quietHoursStart: normalizeHour(value.quietHoursStart, DEFAULT_SCHEDULE.quietHoursStart),
    quietHoursEnd: normalizeHour(value.quietHoursEnd, DEFAULT_SCHEDULE.quietHoursEnd),
    nextRun: typeof value.nextRun === "string" ? value.nextRun : null,
  };
}

function isDreamCycleMode(value: unknown): value is DreamCycleMode {
  return value === "full" || value === "sweep-only" || value === "enrich-only";
}

function normalizeHour(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(23, Math.max(0, Math.round(value)))
    : fallback;
}

function fallbackHeadline(lastRun: DreamLastRun | null): DreamHeadlineSummary | null {
  if (!lastRun) return null;
  return {
    generatedAt: lastRun.timestamp,
    headline: [
      "Last Dream Cycle:",
      `${lastRun.pages_compiled} topics rewritten,`,
      `${lastRun.contradictions_found} contradictions,`,
      `${lastRun.backlinks_added} cross-links.`,
    ].join(" "),
    newSignals: 0,
    newPapers: 0,
    topicsRecompiled: lastRun.pages_compiled,
    contradictionsFound: lastRun.contradictions_found,
    staleExperiments: 0,
    crossReferencesAdded: lastRun.backlinks_added,
    compiledTopics: [],
    signals: [],
    staleExperimentDetails: [],
  };
}

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const deltaMs = date.getTime() - Date.now();
  const absMinutes = Math.round(Math.abs(deltaMs) / 60_000);
  const suffix = deltaMs < 0 ? "ago" : "from now";
  if (absMinutes < 1) return deltaMs < 0 ? "just now" : "in less than a minute";
  if (absMinutes < 60) return `${absMinutes}m ${suffix}`;
  const absHours = Math.round(absMinutes / 60);
  if (absHours < 48) return `${absHours}h ${suffix}`;
  const absDays = Math.round(absHours / 24);
  return `${absDays}d ${suffix}`;
}
