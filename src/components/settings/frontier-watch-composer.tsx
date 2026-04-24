"use client";

import { useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import type { ProjectWatchConfig, ProjectWatchSource, WatchSourceType } from "@/lib/watch/types";
import {
  formatWatchScheduleSummary,
  getScheduleDays,
  WEEKDAY_OPTIONS,
} from "@/lib/watch/schedule-utils";
import {
  applyObjectiveToWatchConfig,
  buildCompiledPrompt,
  buildArxivQuery,
  createWatchSource,
  mergeKeywords,
  summarizeWatchConfig,
} from "./frontier-watch-helpers";

interface ProjectOption {
  id: string;
  name: string;
}

interface FrontierWatchComposerProps {
  projectOptions: ProjectOption[];
  watchProject: string;
  onWatchProjectChange: (project: string) => void;
  watchConfig: ProjectWatchConfig;
  setWatchConfig: Dispatch<SetStateAction<ProjectWatchConfig>>;
  watchLoading: boolean;
  watchSaving: boolean;
  watchError: string | null;
  onSave: () => void;
  inputClassName: string;
  primaryButtonClassName: string;
  secondaryButtonClassName: string;
}

interface WatchPreset {
  id: string;
  title: string;
  description: string;
  objective: string;
  apply: (config: ProjectWatchConfig, projectLabel?: string) => ProjectWatchConfig;
}

function toggleWeeklyDay(currentSchedule: NonNullable<ProjectWatchConfig["schedule"]>, day: number) {
  const currentDays = getScheduleDays(currentSchedule);
  const nextDays = currentDays.includes(day)
    ? currentDays.filter((value) => value !== day)
    : [...currentDays, day].sort((left, right) => left - right);
  const normalizedDays = nextDays.length > 0 ? nextDays : [day];

  return {
    ...currentSchedule,
    daysOfWeek: normalizedDays,
    dayOfWeek: normalizedDays.length === 1 ? normalizedDays[0] : undefined,
  };
}

function formatSourceSummary(source: ProjectWatchSource): string {
  if (source.type === "rss") {
    return source.url?.trim() || "Paste a feed URL";
  }
  if (source.type === "web_search") {
    return source.query?.trim() || "Uses the generated briefing prompt";
  }
  return source.query?.trim() || "Add an arXiv query";
}

function ProjectPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-accent bg-accent text-white"
          : "border-border bg-background text-muted hover:border-accent hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function KeywordChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove keyword ${label}`}
        className="text-muted transition-colors hover:text-foreground"
      >
        ×
      </button>
    </span>
  );
}

export function FrontierWatchComposer({
  projectOptions,
  watchProject,
  onWatchProjectChange,
  watchConfig,
  setWatchConfig,
  watchLoading,
  watchSaving,
  watchError,
  onSave,
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
}: FrontierWatchComposerProps) {
  const [watchObjectiveDraft, setWatchObjectiveDraft] = useState<string | null>(null);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const projectLabel = projectOptions.find((project) => project.id === watchProject)?.name ?? watchProject;
  const watchObjective = watchObjectiveDraft ?? watchConfig.objective ?? summarizeWatchConfig(watchConfig, projectLabel);
  const schedule = watchConfig.schedule ?? {
    enabled: false,
    cadence: "daily" as const,
    time: "08:00",
    timezone: "local",
  };

  const presets: WatchPreset[] = [
    {
      id: "papers",
      title: "Track papers daily",
      description: "Start with a project-shaped arXiv query and keep the frontier tight.",
      objective: `Track new papers, methods, and datasets relevant to ${projectLabel || "this project"}.`,
      apply: (config, label) =>
        applyObjectiveToWatchConfig(
          {
            ...config,
            promotionThreshold: 5,
            stagingThreshold: 2,
          },
          `Track new papers, methods, and datasets relevant to ${label || "this project"}.`,
          label,
        ),
    },
    {
      id: "feeds",
      title: "Follow feeds",
      description: "Add a ready-to-edit RSS slot for labs, blogs, or journals you already trust.",
      objective: `Follow blog, journal, and lab feeds that matter for ${projectLabel || "this project"}.`,
      apply: (config) => ({
        ...config,
        sources: config.sources.some((source) => source.type === "rss")
          ? config.sources
          : [
              ...config.sources,
              {
                ...createWatchSource("rss"),
                label: "Primary external feed",
              },
            ],
      }),
    },
    {
      id: "mixed",
      title: "Mixed frontier brief",
      description: "Combine papers with external feeds so the brief catches both research and outside movement.",
      objective: `Watch ${projectLabel || "this project"} across arXiv plus a few external feeds, then surface only the items that change the plan.`,
      apply: (config, label) => {
        const next = applyObjectiveToWatchConfig(
          {
            ...config,
            promotionThreshold: 6,
            stagingThreshold: 3,
          },
          `Watch ${label || "this project"} across arXiv plus a few external feeds.`,
          label,
        );

        if (next.sources.some((source) => source.type === "rss")) {
          return next;
        }

        return {
          ...next,
          sources: [
            ...next.sources,
            {
              ...createWatchSource("rss"),
              label: "Primary external feed",
            },
          ],
        };
      },
    },
  ];

  function setWatchSource(sourceId: string, updater: (source: ProjectWatchSource) => ProjectWatchSource) {
    setWatchConfig((current) => ({
      ...current,
      sources: current.sources.map((source) => (source.id === sourceId ? updater(source) : source)),
    }));
  }

  function addWatchSource(type: WatchSourceType) {
    setWatchConfig((current) => ({
      ...current,
      sources: [...current.sources, createWatchSource(type)],
    }));
  }

  function removeWatchSource(sourceId: string) {
    setWatchConfig((current) => ({
      ...current,
      sources: current.sources.filter((source) => source.id !== sourceId),
    }));
  }

  function addKeywords(rawValue: string) {
    const keywords = mergeKeywords(
      watchConfig.keywords,
      rawValue
        .split(/[\n,]/)
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    );
    setWatchConfig((current) => ({
      ...current,
      keywords,
    }));
    setKeywordDraft("");
  }

  function handleKeywordKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (keywordDraft.trim()) {
        addKeywords(keywordDraft);
      }
    }
  }

  function applyCompiledPlan(plan: {
    objective: string;
    compiledPrompt: string;
    keywords: string[];
    searchQueries: string[];
  }) {
    setWatchConfig((current) => {
      const webSearchSource = current.sources.find((source) => source.type === "web_search");
      return {
        ...current,
        objective: plan.objective,
        compiledPrompt: plan.compiledPrompt,
        searchQueries: plan.searchQueries,
        executionMode: "openclaw",
        keywords: mergeKeywords(current.keywords, plan.keywords),
        sources: webSearchSource
          ? current.sources.map((source) =>
              source.id === webSearchSource.id
                ? {
                    ...source,
                    label: source.label || "Current web search",
                    query: plan.compiledPrompt,
                    limit: source.limit ?? 8,
                  }
                : source,
            )
          : [
              ...current.sources,
              {
                ...createWatchSource("web_search"),
                label: "Current web search",
                query: plan.compiledPrompt,
                limit: 8,
              },
            ],
      };
    });
  }

  async function handleObjectiveApply() {
    if (!watchObjective.trim()) return;
    setComposing(true);
    setComposeError(null);
    try {
      const response = await fetch("/api/brain/watch-config/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: watchProject.trim() || undefined,
          objective: watchObjective,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        plan?: {
          objective: string;
          compiledPrompt: string;
          keywords: string[];
          searchQueries: string[];
        };
      };
      if (!response.ok) {
        setComposeError(data.error || "Failed to generate a search prompt.");
        return;
      }
      if (!data.plan) {
        setComposeError("Generated response did not include a search plan.");
        return;
      }
      applyCompiledPlan(data.plan);
      return;
    } catch {
      // Fall back to deterministic local prompt shaping below.
    } finally {
      setComposing(false);
    }

    const next = applyObjectiveToWatchConfig(watchConfig, watchObjective, projectLabel);
    applyCompiledPlan({
      objective: next.objective ?? watchObjective,
      compiledPrompt: next.compiledPrompt ?? buildCompiledPrompt({
        objective: watchObjective,
        keywords: next.keywords,
        searchQueries: next.searchQueries ?? [],
        projectLabel,
      }),
      keywords: next.keywords,
      searchQueries: next.searchQueries ?? [],
    });
  }

  function applyPreset(preset: WatchPreset) {
    setWatchObjectiveDraft(preset.objective);
    setWatchConfig((current) => preset.apply(current, projectLabel));
  }

  const liveSummary = summarizeWatchConfig(watchConfig, projectLabel);
  const activeSearchLabel = watchConfig.sources.some((source) => source.type === "web_search")
    ? "Live web search"
    : watchConfig.sources.some((source) => source.type === "arxiv" || source.type === "rss")
      ? "arXiv/RSS only"
      : "Not configured";
  const scheduleLabel = schedule.enabled
    ? formatWatchScheduleSummary(schedule)
    : "Runs when you open the brief";

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border-2 border-border bg-gradient-to-br from-background via-background to-surface p-5">
        <div className="flex flex-col gap-4">
          <div className="space-y-2">
            <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-muted">
              Daily Frontier Setup
            </p>
            <h3 className="text-xl font-semibold leading-tight">
              What should ScienceSwarm watch for this project?
            </h3>
            <p className="text-sm text-muted">
                Describe the recurring news/research brief you want. ScienceSwarm will turn it into a specific web-search prompt and query plan.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
            <div className="space-y-3">
              <label className="sr-only" htmlFor="watch-objective">
                Watch objective
              </label>
              <textarea
                id="watch-objective"
                value={watchObjective}
                onChange={(event) => setWatchObjectiveDraft(event.target.value)}
                rows={4}
                placeholder="Search for breaking AI news every weekday morning. Focus on OpenAI, Anthropic, Google DeepMind, xAI, DeepSeek, Mistral, Meta, new model releases, research breakthroughs, startup funding, and major lab announcements. Deliver a Markdown briefing with top stories and source links."
                className={`${inputClassName} min-h-[132px] resize-y font-sans leading-relaxed`}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleObjectiveApply}
                  disabled={!watchObjective.trim() || watchLoading || composing}
                  className={primaryButtonClassName}
                >
                  {composing ? "Generating..." : "Generate Specific Search Prompt"}
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-background/80 p-4">
              <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-muted">
                How This Runs
              </p>
              <div className="mt-3 space-y-3">
                <div>
                  <p className="text-sm font-semibold">
                    {watchConfig.compiledPrompt ? "Search prompt ready" : "Describe the brief first"}
                  </p>
                  <p className="text-xs text-muted">ScienceSwarm turns your request into a concrete research brief prompt.</p>
                </div>
                <div>
                  <p className="text-sm font-semibold">{activeSearchLabel}</p>
                  <p className="text-xs text-muted">Default mode asks OpenClaw to handle the live web research and analysis.</p>
                </div>
                <div>
                  <p className="text-sm font-semibold">{scheduleLabel}</p>
                  <p className="text-xs text-muted leading-relaxed">{liveSummary}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Project</p>
            <p className="text-xs text-muted">
              Choose the project whose brief should pick up this watch.
            </p>
          </div>
          <div className="w-full max-w-sm">
            <label className="sr-only" htmlFor="watch-project">
              Project slug
            </label>
            <input
              id="watch-project"
              list="watch-project-options"
              value={watchProject}
              onChange={(event) => onWatchProjectChange(event.target.value)}
              placeholder="alpha-project"
              className={inputClassName}
            />
            <datalist id="watch-project-options">
              {projectOptions.map((project, idx) => (
                <option key={`${project.id}-${idx}`} value={project.id}>
                  {project.name}
                </option>
              ))}
            </datalist>
          </div>
        </div>

        {projectOptions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {projectOptions.slice(0, 6).map((project) => (
              <ProjectPill
                key={project.id}
                active={watchProject === project.id}
                label={project.name}
                onClick={() => onWatchProjectChange(project.id)}
              />
            ))}
          </div>
        )}

        {projectOptions.length === 0 && (
          <p className="text-xs text-muted">
            No brain project pages found yet. Import or create a project before saving watch config.
          </p>
        )}
      </div>

      {(watchError || composeError) && (
        <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {watchError || composeError}
        </p>
      )}

      <div className="rounded-xl border border-border bg-background p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium">Run schedule</p>
            <p className="text-xs text-muted">
              Let ScienceSwarm refresh the watch automatically instead of only when you open the brief.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={schedule.enabled}
              onChange={(event) =>
                setWatchConfig((current) => ({
                  ...current,
                  schedule: {
                    ...schedule,
                    enabled: event.target.checked,
                  },
                }))
              }
            />
            Scheduled
          </label>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="space-y-2 text-sm font-medium">
            Cadence
            <select
              value={schedule.cadence}
              onChange={(event) =>
                setWatchConfig((current) => ({
                  ...current,
                  schedule: {
                    ...schedule,
                    cadence: event.target.value as "daily" | "weekdays" | "weekly",
                    daysOfWeek: event.target.value === "weekly"
                      ? (getScheduleDays(schedule).length > 0 ? getScheduleDays(schedule) : [1])
                      : undefined,
                    dayOfWeek: event.target.value === "weekly"
                      ? getScheduleDays(schedule)[0] ?? 1
                      : undefined,
                  },
                }))
              }
              className={inputClassName}
            >
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium">
            Time
            <input
              type="time"
              value={schedule.time}
              onChange={(event) =>
                setWatchConfig((current) => ({
                  ...current,
                  schedule: {
                    ...schedule,
                    time: event.target.value,
                  },
                }))
              }
              className={inputClassName}
            />
          </label>
          <label className="space-y-2 text-sm font-medium">
            Timezone
            <input
              type="text"
              value={schedule.timezone === "local" ? Intl.DateTimeFormat().resolvedOptions().timeZone : schedule.timezone}
              onChange={(event) =>
                setWatchConfig((current) => ({
                  ...current,
                  schedule: {
                    ...schedule,
                    timezone: event.target.value,
                  },
                }))
              }
              className={inputClassName}
            />
          </label>
        </div>

        {schedule.cadence === "weekly" && (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-medium">Weekly days</p>
            <p className="text-xs text-muted">
              Choose one or more days for recurring research-first or briefing runs.
            </p>
            <div className="flex flex-wrap gap-2">
              {WEEKDAY_OPTIONS.map((day) => {
                const selected = getScheduleDays(schedule).includes(day.value);
                return (
                  <label
                    key={day.value}
                    className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      selected
                        ? "border-accent bg-accent text-white"
                        : "border-border bg-background text-muted hover:border-accent hover:text-foreground"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() =>
                        setWatchConfig((current) => ({
                          ...current,
                          schedule: toggleWeeklyDay(schedule, day.value),
                        }))
                      }
                      className="sr-only"
                    />
                    {day.shortLabel}
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {watchConfig.compiledPrompt && (
        <div className="rounded-xl border-2 border-accent/30 bg-accent/5 p-4">
          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold">Generated search prompt</p>
              <p className="text-xs text-muted">
                This is what OpenClaw will use for the live web research task. Edit it if you want a narrower or broader briefing.
              </p>
            </div>
            <span className="rounded-full bg-background px-2.5 py-1 text-[11px] font-mono uppercase tracking-[0.16em] text-muted">
              OpenClaw
            </span>
          </div>
            <textarea
              value={watchConfig.compiledPrompt}
              onChange={(event) =>
                setWatchConfig((current) => ({
                  ...current,
                  compiledPrompt: event.target.value,
                  sources: current.sources.map((source) =>
                    source.type === "web_search" ? { ...source, query: event.target.value } : source,
                  ),
                }))
              }
              rows={10}
              className={`${inputClassName} font-sans leading-relaxed`}
            />
            {watchConfig.searchQueries && watchConfig.searchQueries.length > 0 && (
              <div className="mt-3 space-y-1">
                <p className="text-xs font-medium text-muted">Example searches the prompt asks the model to try</p>
                {watchConfig.searchQueries.map((query) => (
                  <p key={query} className="rounded-lg bg-surface px-3 py-2 text-xs font-mono">
                    {query}
                  </p>
                ))}
              </div>
            )}
        </div>
      )}

      <details className="rounded-xl border border-border bg-background">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium">
          Examples and quick starts
        </summary>
        <div className="space-y-3 border-t border-border px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Quick Starts</p>
            <p className="text-xs text-muted">
              Start from the shape you want, then edit the exact feeds and keywords.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              disabled={watchLoading}
              className="rounded-xl border border-border bg-background p-4 text-left transition-colors hover:border-accent hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
            >
              <p className="text-sm font-medium">{preset.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{preset.description}</p>
            </button>
          ))}
        </div>
        </div>
      </details>

      <details className="rounded-xl border border-border bg-background">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium">
          Optional filters
        </summary>
        <div className="space-y-3 border-t border-border px-4 py-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Ranking filters</p>
            <p className="text-xs text-muted">
              These are internal relevance hints used after search results come back. Most users can ignore them; the generated prompt is the main control.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-background p-4">
          <div className="flex flex-wrap gap-2">
            {watchConfig.keywords.length > 0 ? (
              watchConfig.keywords.map((keyword) => (
                <KeywordChip
                  key={keyword}
                  label={keyword}
                  onRemove={() =>
                    setWatchConfig((current) => ({
                      ...current,
                      keywords: current.keywords.filter((entry) => entry !== keyword),
                    }))
                  }
                />
              ))
            ) : (
              <p className="text-xs text-muted">
                No keywords yet. Start with the objective above or add them directly here.
              </p>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="watch-keyword-draft">
              Add keyword
            </label>
            <input
              id="watch-keyword-draft"
              type="text"
              value={keywordDraft}
              onChange={(event) => setKeywordDraft(event.target.value)}
              onKeyDown={handleKeywordKeyDown}
              placeholder="Add keyword or paste comma-separated terms"
              className={inputClassName}
            />
            <button
              type="button"
              onClick={() => addKeywords(keywordDraft)}
              disabled={!keywordDraft.trim()}
              className={secondaryButtonClassName}
            >
              Add Keywords
            </button>
          </div>
        </div>
        </div>
      </details>

      <details className="rounded-xl border border-border bg-background">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium">
          Optional sources
        </summary>
        <div className="space-y-3 border-t border-border px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Sources</p>
            <p className="text-xs text-muted">
              By default, OpenClaw handles flexible web research from the generated prompt. Add RSS or arXiv only when you want to force a deterministic source.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => addWatchSource("rss")}
              className={secondaryButtonClassName}
            >
              Add RSS
            </button>
            <button
              type="button"
              onClick={() => {
                const fallbackQuery = buildArxivQuery(watchConfig.keywords);
                setWatchConfig((current) => ({
                  ...current,
                  sources: [
                    ...current.sources,
                    {
                      ...createWatchSource("arxiv"),
                      label: "Research papers",
                      query: fallbackQuery,
                    },
                  ],
                }));
              }}
              className={secondaryButtonClassName}
            >
              Add arXiv
            </button>
            <button
              type="button"
              onClick={() => addWatchSource("web_search")}
              className={secondaryButtonClassName}
            >
              Add Web Search
            </button>
          </div>
        </div>

        {watchConfig.sources.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-background px-4 py-5 text-sm text-muted">
            No sources configured yet. Use a quick start or add an RSS feed / arXiv query.
          </div>
        ) : (
          <div className="space-y-3">
            {watchConfig.sources.map((source) => (
              <div
                key={source.id}
                className="rounded-xl border border-border bg-background p-4"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-surface px-2.5 py-1 text-[11px] font-mono uppercase tracking-[0.16em] text-muted">
                        {source.type}
                      </span>
                      <input
                        type="text"
                        value={source.label ?? ""}
                        onChange={(event) =>
                          setWatchSource(source.id, (current) => ({
                            ...current,
                            label: event.target.value,
                          }))
                        }
                        placeholder={
                          source.type === "rss"
                            ? "Lab feed"
                            : source.type === "web_search"
                              ? "Current web search"
                              : "Research papers"
                        }
                        className={`${inputClassName} min-w-[180px] max-w-xs`}
                      />
                      <label className="inline-flex items-center gap-2 text-xs font-medium text-muted">
                        <input
                          type="checkbox"
                          checked={source.enabled !== false}
                          onChange={(event) =>
                            setWatchSource(source.id, (current) => ({
                              ...current,
                              enabled: event.target.checked,
                            }))
                          }
                        />
                        Enabled
                      </label>
                    </div>

                    {source.type === "rss" ? (
                      <input
                        type="url"
                        value={source.url ?? ""}
                        onChange={(event) =>
                          setWatchSource(source.id, (current) => ({
                            ...current,
                            url: event.target.value,
                          }))
                        }
                        placeholder="https://example.com/feed.xml"
                        className={inputClassName}
                      />
                    ) : (
                      <input
                        type="text"
                        value={source.query ?? ""}
                        onChange={(event) =>
                          setWatchSource(source.id, (current) => ({
                            ...current,
                            query: event.target.value,
                          }))
                        }
                        placeholder={source.type === "web_search" ? "Generated briefing prompt" : "all:crispr sequencing"}
                        className={inputClassName}
                      />
                    )}

                    <p className="text-xs text-muted">
                      {formatSourceSummary(source)}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-muted">
                      Limit
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={source.limit ?? 10}
                        onChange={(event) =>
                          setWatchSource(source.id, (current) => ({
                            ...current,
                            limit: Number(event.target.value) || 10,
                          }))
                        }
                        className="w-20 rounded-lg border-2 border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => removeWatchSource(source.id)}
                      className={secondaryButtonClassName}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
      </details>

      <details className="rounded-xl border border-border bg-background">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium">
          Developer tuning
        </summary>
        <div className="grid gap-3 border-t border-border px-4 py-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="watch-staging-threshold">
              Staging threshold
            </label>
            <p className="text-xs text-muted">
              Minimum relevance score before an item is saved as a candidate. Leave at 2 unless you are debugging ranking.
            </p>
            <input
              id="watch-staging-threshold"
              type="number"
              min={0}
              value={watchConfig.stagingThreshold}
              onChange={(event) =>
                setWatchConfig((current) => ({
                  ...current,
                  stagingThreshold: Number(event.target.value) || 0,
                }))
              }
              className={inputClassName}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="watch-promotion-threshold">
              Promotion threshold
            </label>
            <p className="text-xs text-muted">
              Score required before an item appears directly in the project brief. Leave at 5 for normal use.
            </p>
            <input
              id="watch-promotion-threshold"
              type="number"
              min={1}
              value={watchConfig.promotionThreshold}
              onChange={(event) =>
                setWatchConfig((current) => ({
                  ...current,
                  promotionThreshold: Number(event.target.value) || 1,
                }))
              }
              className={inputClassName}
            />
          </div>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={!watchProject.trim() || watchSaving || watchLoading}
          className={primaryButtonClassName}
        >
          {watchSaving ? "Saving..." : watchLoading ? "Loading..." : "Save Frontier Watch"}
        </button>
        <span className="text-xs text-muted">
          The next project brief will refresh this watch and pull promoted frontier items into the brief.
        </span>
      </div>
    </div>
  );
}
