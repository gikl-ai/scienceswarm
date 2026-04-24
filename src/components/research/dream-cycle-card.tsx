"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  Flask,
  LinkSimple,
  MoonStars,
  WarningDiamond,
} from "@phosphor-icons/react";
import { Spinner } from "@/components/spinner";

interface DreamSignal {
  slug: string;
  title: string;
  sourceKind: string;
  observedAt: string;
}

interface DreamCompiledTopic {
  slug: string;
  title: string;
  contradictions?: unknown[];
  backlinksAdded?: number;
  compiledTruthPreview?: string;
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

interface DreamScheduleResponse {
  schedule?: {
    enabled?: boolean;
    cron?: string;
    mode?: string;
  };
  nextRun?: string | null;
}

interface DreamCycleError {
  message: string;
  cause?: string;
  nextAction?: string;
  code?: string;
}

interface ProjectBrief {
  nextMove?: {
    recommendation?: string;
  };
  dueTasks?: Array<{
    path: string;
    title: string;
    status: string;
  }>;
  frontier?: Array<{
    path: string;
    title: string;
    status: string;
    whyItMatters: string;
  }>;
}

interface DreamCycleCardProps {
  enabled: boolean;
  projectBrief: ProjectBrief | null;
  onCycleComplete?: () => void;
  onNavigateBrainPage?: (slug: string) => void;
}

export function DreamCycleCard({
  enabled,
  projectBrief,
  onCycleComplete,
  onNavigateBrainPage,
}: DreamCycleCardProps) {
  const [lastRun, setLastRun] = useState<DreamLastRun | null>(null);
  const [schedule, setSchedule] = useState<DreamScheduleResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<DreamCycleError | null>(null);

  const loadDreamStatus = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const [dreamRes, scheduleRes] = await Promise.all([
        fetch("/api/brain/dream", { signal }),
        fetch("/api/brain/dream-schedule", { signal }),
      ]);
      if (!dreamRes.ok) {
        setError(await parseDreamCycleError(dreamRes, "Dream cycle status failed."));
        setLastRun(null);
        return;
      }
      const dreamBody = (await dreamRes.json()) as { lastRun: DreamLastRun | null };
      const dreamLastRun = dreamBody.lastRun ?? null;
      setLastRun(dreamLastRun);
      if (dreamLastRun?.partial && dreamLastRun.errors?.length) {
        setError({
          message: "Dream Cycle could not complete.",
          cause: dreamLastRun.errors[0],
          nextAction: dreamLastRun.reason,
        });
      }

      if (scheduleRes.ok) {
        setSchedule((await scheduleRes.json()) as DreamScheduleResponse);
      } else {
        setSchedule(null);
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        setError({
          message: err instanceof Error ? err.message : "Dream cycle status failed.",
        });
        setLastRun(null);
      }
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void loadDreamStatus(controller.signal);
    return () => controller.abort();
  }, [enabled, loadDreamStatus]);

  const summary = useMemo(() => lastRun?.headline ?? fallbackHeadline(lastRun), [lastRun]);
  const nextMove = projectBrief?.nextMove?.recommendation;
  const topTask = projectBrief?.dueTasks?.[0];
  const topFrontier = projectBrief?.frontier?.[0];

  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/brain/dream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      });
      if (!response.ok) {
        setError(await parseDreamCycleError(response, "Dream cycle run failed."));
        return;
      }
      await loadDreamStatus();
      onCycleComplete?.();
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : "Dream cycle run failed.",
      });
    } finally {
      setRunning(false);
    }
  }

  if (!enabled) return null;

  return (
    <section className="min-w-0 shrink-0 border-b border-border bg-white px-4 py-3">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted">
              <MoonStars size={14} />
              Dream Cycle
            </div>
            <p className="mt-1 text-sm font-semibold leading-6 text-foreground">
              {summary?.headline ?? "No overnight run yet."}
            </p>
            <p className="mt-1 text-xs text-muted">
              {lastRun
                ? `${lastRun.partial ? "Partial run" : lastRun.skipped ? "Skipped run" : "Last run"} ${formatRelativeTime(lastRun.timestamp)}${schedule?.nextRun ? ` · next ${formatRelativeTime(schedule.nextRun)}` : ""}`
                : schedule?.nextRun
                  ? `Next run ${formatRelativeTime(schedule.nextRun)}`
                  : "Scheduled runner is ready."}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {lastRun?.journal_slug && onNavigateBrainPage ? (
              <button
                type="button"
                onClick={() => onNavigateBrainPage(lastRun.journal_slug as string)}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                <LinkSimple size={14} />
                Open journal
              </button>
            ) : null}
            <button
              type="button"
              onClick={runNow}
              disabled={running || loading}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? <Spinner size="h-3.5 w-3.5" /> : <ArrowClockwise size={14} />}
              {running ? "Running" : "Run now"}
            </button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            <p className="font-semibold">{error.message}</p>
            {error.cause && (
              <p className="mt-1 leading-5 text-danger">{error.cause}</p>
            )}
            {error.nextAction && (
              <p className="mt-1 leading-5 text-danger">
                <span className="font-semibold">Next:</span> {error.nextAction}
              </p>
            )}
            <button
              type="button"
              onClick={runNow}
              disabled={running || loading}
              className="mt-2 inline-flex h-8 items-center justify-center gap-2 rounded-md border border-danger/40 bg-raised px-3 text-xs font-semibold text-danger transition-colors hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? <Spinner size="h-3.5 w-3.5" /> : <ArrowClockwise size={14} />}
              {running ? "Running" : "Retry Dream Cycle"}
            </button>
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
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
            label="Cross-references"
            value={summary?.crossReferencesAdded ?? lastRun?.backlinks_added ?? 0}
          />
        </div>

        {(summary?.compiledTopics?.length || summary?.signals?.length || topTask || topFrontier || nextMove) && (
          <div className="grid gap-3 lg:grid-cols-3">
            <InsightColumn
              title="Compiled Truth"
              empty="No topics rewritten yet."
              items={(summary?.compiledTopics ?? []).slice(0, 4).map((topic) => ({
                key: topic.slug,
                slug: topic.slug,
                title: topic.title,
                detail: topic.compiledTruthPreview
                  || formatPlural(topic.contradictions?.length ?? 0, "contradiction"),
              }))}
              onNavigate={onNavigateBrainPage}
            />
            <InsightColumn
              title="Current Focus"
              empty="No active focus item."
              items={[
                ...(nextMove ? [{ key: "next", title: "Next move", detail: nextMove }] : []),
                ...(topTask
                  ? [{
                    key: topTask.path,
                    slug: navigationSlugFromBriefPath(topTask.path),
                    title: topTask.title,
                    detail: topTask.status,
                  }]
                  : []),
              ].slice(0, 2)}
              onNavigate={onNavigateBrainPage}
            />
            <InsightColumn
              title="Stale or New"
              empty="No stale work or frontier items."
              items={[
                ...(summary?.signals ?? []).slice(0, 1).map((signal) => ({
                  key: signal.slug,
                  slug: signal.slug,
                  title: signal.title,
                  detail: `${formatSourceKind(signal.sourceKind)} · observed ${formatRelativeTime(signal.observedAt)}`,
                })),
                ...(summary?.staleExperimentDetails ?? []).slice(0, 1).map((experiment) => ({
                  key: experiment.slug,
                  slug: experiment.slug,
                  title: experiment.title,
                  detail: experiment.reason,
                })),
                ...(topFrontier
                  ? [{
                    key: topFrontier.path,
                    slug: navigationSlugFromBriefPath(topFrontier.path),
                    title: topFrontier.title,
                    detail: topFrontier.whyItMatters,
                  }]
                  : []),
              ].slice(0, 2)}
              onNavigate={onNavigateBrainPage}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function navigationSlugFromBriefPath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  if (/^gbrain:\/wiki\//i.test(trimmed)) {
    return trimmed.replace(/^gbrain:\//i, "").replace(/\.mdx?$/i, "");
  }
  return undefined;
}

async function parseDreamCycleError(
  response: Response,
  fallback: string,
): Promise<DreamCycleError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    cause?: unknown;
    nextAction?: unknown;
    code?: unknown;
  };
  return {
    message: typeof body.error === "string" && body.error.trim()
      ? body.error
      : fallback,
    cause: typeof body.cause === "string" && body.cause.trim()
      ? body.cause
      : undefined,
    nextAction: typeof body.nextAction === "string" && body.nextAction.trim()
      ? body.nextAction
      : undefined,
    code: typeof body.code === "string" && body.code.trim()
      ? body.code
      : undefined,
  };
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
    <div className="min-h-16 rounded-lg border border-border bg-surface/50 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-muted">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

function InsightColumn({
  title,
  empty,
  items,
  onNavigate,
}: {
  title: string;
  empty: string;
  items: Array<{ key: string; slug?: string; title: string; detail: string }>;
  onNavigate?: (slug: string) => void;
}) {
  return (
    <div className="min-h-24 min-w-0 rounded-lg border border-border bg-background px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">
        {title}
      </p>
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-muted">{empty}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {items.map((item) => (
            <div key={item.key} className="min-w-0">
              {item.slug && onNavigate ? (
                <button
                  type="button"
                  onClick={() => onNavigate(item.slug!)}
                  className="block min-w-0 w-full text-left"
                >
                  <span className="block truncate text-xs font-semibold text-foreground underline-offset-2 hover:text-accent hover:underline">
                    {item.title}
                  </span>
                  <span className="line-clamp-2 text-[11px] leading-4 text-muted">
                    {item.detail}
                  </span>
                </button>
              ) : (
                <>
                  <p className="truncate text-xs font-semibold text-foreground">{item.title}</p>
                  <p className="line-clamp-2 text-[11px] leading-4 text-muted">{item.detail}</p>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fallbackHeadline(lastRun: DreamLastRun | null): DreamHeadlineSummary | null {
  if (!lastRun) return null;
  return {
    generatedAt: lastRun.timestamp,
    headline: [
      "While you slept:",
      "0 new papers",
      `${lastRun.contradictions_found} ${formatPlural(lastRun.contradictions_found, "contradiction")} with your current beliefs`,
      "0 stale work items",
      `${lastRun.backlinks_added} new ${formatPlural(lastRun.backlinks_added, "cross-reference")}.`,
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

function formatPlural(count: number, singular: string): string {
  return `${singular}${count === 1 ? "" : "s"}`;
}

function formatSourceKind(kind: string): string {
  const normalized = kind.replace(/[_-]+/g, " ").trim();
  if (!normalized) return "Source";
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
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
