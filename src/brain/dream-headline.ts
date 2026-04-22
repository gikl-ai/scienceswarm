import { ensureBrainStoreReady, getBrainStore, type BrainPage } from "./store";
import type { BrainConfig, BrainEvent } from "./types";
import type { LLMClient } from "./llm";
import {
  compileAffectedConceptsForSource,
  normalizeSlug,
  type CompileAffectedTopic,
} from "./compile-affected";
import type { GbrainEngineAdapter } from "./stores/gbrain-engine-adapter";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

export interface DreamSignal {
  slug: string;
  title: string;
  type: string;
  sourceKind: DreamSourceKind;
  observedAt: string;
}

export type DreamSourceKind =
  | "paper"
  | "zotero"
  | "lab_data"
  | "meeting"
  | "chat"
  | "note"
  | "task"
  | "other";

export interface DreamStaleExperiment {
  slug: string;
  title: string;
  kind?: "experiment" | "task";
  lastObservedAt: string | null;
  reason: string;
}

export interface DreamHeadlineSummary {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  headline: string;
  newSignals: number;
  newPapers: number;
  sourceBreakdown: Record<DreamSourceKind, number>;
  topicsRecompiled: number;
  contradictionsFound: number;
  staleExperiments: number;
  crossReferencesAdded: number;
  brokenBacklinksFixed: number;
  staleTimelinesConsolidated: number;
  compiledTopics: CompileAffectedTopic[];
  signals: DreamSignal[];
  staleExperimentDetails: DreamStaleExperiment[];
}

export interface BuildDreamHeadlineInput {
  config: BrainConfig;
  llm: LLMClient;
  events: BrainEvent[];
  lastRunAt?: string | null;
  now?: Date;
  maxSignals?: number;
  skipConceptSlugs?: string[];
}

const SOURCE_KINDS: DreamSourceKind[] = [
  "paper",
  "zotero",
  "lab_data",
  "meeting",
  "chat",
  "note",
  "task",
  "other",
];
const DEFAULT_MAX_SIGNALS = 20;
const STALE_EXPERIMENT_DAYS = 14;

export async function buildDreamHeadlineSummary(
  input: BuildDreamHeadlineInput,
): Promise<DreamHeadlineSummary> {
  const now = input.now ?? new Date();
  const windowStart = resolveWindowStart(input.lastRunAt, now);
  const windowEnd = now.toISOString();
  await ensureBrainStoreReady({ root: input.config.root });
  const store = getBrainStore({ root: input.config.root });
  const pages = await store.listPages({ limit: 5000 });
  const pageBySlug = new Map(pages.map((page) => [normalizeSlug(page.path), page]));
  const observedAtBySlug = collectSignalSlugs(input.events, windowStart, pages);
  const signals = Array.from(observedAtBySlug.entries())
    .map(([slug, observedAt]) => toDreamSignal(pageBySlug.get(slug), slug, observedAt, windowStart))
    .filter((signal): signal is DreamSignal => Boolean(signal))
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
    .slice(0, input.maxSignals ?? DEFAULT_MAX_SIGNALS);

  const sourceBreakdown = emptySourceBreakdown();
  for (const signal of signals) {
    sourceBreakdown[signal.sourceKind] += 1;
  }

  let topicsRecompiled = 0;
  let contradictionsFound = 0;
  let crossReferencesAdded = 0;
  const brokenBacklinksFixed = 0;
  let staleTimelinesConsolidated = 0;
  const compiledTopics: CompileAffectedTopic[] = [];

  for (const signal of signals) {
    const sourcePage = pageBySlug.get(signal.slug);
    if (!sourcePage) continue;
    const compileResult = await compileAffectedConceptsForSource({
      sourceSlug: signal.slug,
      sourceTitle: signal.title,
      sourceType: signal.sourceKind,
      content: sourcePage.content,
      config: input.config,
      llm: input.llm,
      maxConcepts: 3,
      skipConceptSlugs: input.skipConceptSlugs,
    });
    topicsRecompiled += compileResult.pagesCompiled;
    contradictionsFound += compileResult.contradictionsFound;
    crossReferencesAdded += compileResult.backlinksAdded;
    staleTimelinesConsolidated += compileResult.pagesCompiled;
    compiledTopics.push(...compileResult.compiledTopics);
  }

  const staleExperimentDetails = await flagStaleExperiments({
    pages,
    windowEnd,
  });

  const summary: DreamHeadlineSummary = {
    generatedAt: windowEnd,
    windowStart: windowStart.toISOString(),
    windowEnd,
    headline: "",
    newSignals: signals.length,
    newPapers: signals.filter((signal) => signal.sourceKind === "paper").length,
    sourceBreakdown,
    topicsRecompiled,
    contradictionsFound,
    staleExperiments: staleExperimentDetails.length,
    crossReferencesAdded,
    brokenBacklinksFixed,
    staleTimelinesConsolidated,
    compiledTopics: dedupeCompiledTopics(compiledTopics),
    signals,
    staleExperimentDetails,
  };
  summary.headline = buildHeadlineText(summary);
  return summary;
}

export function buildHeadlineText(summary: Pick<
  DreamHeadlineSummary,
  "newPapers" | "newSignals" | "contradictionsFound" | "staleExperiments" | "crossReferencesAdded"
>): string {
  return [
    "While you slept:",
    `${summary.newPapers} new paper${summary.newPapers === 1 ? "" : "s"}`,
    `${summary.contradictionsFound} contradiction${summary.contradictionsFound === 1 ? "" : "s"} with your current beliefs`,
    summary.staleExperiments === 1
      ? "1 stale work item"
      : `${summary.staleExperiments} stale work items`,
    `${summary.crossReferencesAdded} new cross-reference${summary.crossReferencesAdded === 1 ? "" : "s"}.`,
  ].join(" ");
}

function resolveWindowStart(lastRunAt: string | null | undefined, now: Date): Date {
  const parsed = lastRunAt ? new Date(lastRunAt) : null;
  if (parsed && Number.isFinite(parsed.getTime())) {
    return parsed;
  }
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

function collectSignalSlugs(
  events: BrainEvent[],
  windowStart: Date,
  pages: BrainPage[],
): Map<string, string> {
  const observedAtBySlug = new Map<string, string>();
  const rememberSignal = (slug: string, observedAt: string): void => {
    const normalized = normalizeSlug(slug);
    const parsed = parseDate(observedAt);
    if (!parsed || parsed < windowStart) return;
    const existing = parseDate(observedAtBySlug.get(normalized));
    if (!existing || parsed > existing) {
      observedAtBySlug.set(normalized, parsed.toISOString());
    }
  };

  for (const event of events) {
    const eventDate = new Date(event.ts);
    if (!Number.isFinite(eventDate.getTime()) || eventDate < windowStart) continue;
    for (const page of [...(event.created ?? []), ...(event.updated ?? [])]) {
      rememberSignal(page, eventDate.toISOString());
    }
  }
  for (const page of pages) {
    const observedAt = observedAtForPage(page);
    if (observedAt) rememberSignal(page.path, observedAt);
  }
  return observedAtBySlug;
}

function toDreamSignal(
  page: BrainPage | undefined,
  slug: string,
  observedAtHint: string,
  windowStart: Date,
): DreamSignal | null {
  if (!page) return null;
  const observedAt = latestDate([observedAtHint, observedAtForPage(page)]);
  if (!observedAt || new Date(observedAt) < windowStart) return null;
  const sourceKind = classifySource(page);
  if (page.type === "concept") return null;
  return {
    slug: normalizeSlug(slug),
    title: page.title,
    type: String(page.frontmatter.type ?? page.type),
    sourceKind,
    observedAt,
  };
}

function observedAtForPage(page: BrainPage): string | null {
  const frontmatter = page.frontmatter ?? {};
  for (const key of [
    "uploaded_at",
    "captured_at",
    "created_at",
    "updated_at",
    "timestamp",
    "date",
  ]) {
    const value = frontmatter[key];
    if (typeof value === "string" && parseDate(value)) {
      return parseDate(value)!.toISOString();
    }
  }
  return null;
}

function classifySource(page: BrainPage): DreamSourceKind {
  const frontmatter = page.frontmatter ?? {};
  const slug = normalizeSlug(page.path);
  const type = String(frontmatter.type ?? page.type).toLowerCase();
  if (frontmatter.zotero_key || frontmatter.zotero_item_key || frontmatter.zotero_library_id) {
    return "zotero";
  }
  if (type === "paper" || slug.includes("/papers/") || frontmatter.arxiv || frontmatter.doi) {
    return "paper";
  }
  if (type === "dataset" || type === "data" || type === "observation" || slug.includes("/data/")) {
    return "lab_data";
  }
  if (slug.includes("meeting") || type === "meeting") {
    return "meeting";
  }
  if (frontmatter.channel === "telegram" || frontmatter.channel === "web" || frontmatter.channel === "openclaw") {
    return "chat";
  }
  if (type === "task" || slug.includes("/tasks/")) {
    return "task";
  }
  if (type === "note") return "note";
  return "other";
}

function emptySourceBreakdown(): Record<DreamSourceKind, number> {
  return Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 0])) as Record<DreamSourceKind, number>;
}

async function flagStaleExperiments(input: {
  pages: BrainPage[];
  windowEnd: string;
}): Promise<DreamStaleExperiment[]> {
  const store = getBrainStore();
  const adapter = store as Partial<GbrainEngineAdapter>;
  const now = new Date(input.windowEnd);
  const stale: DreamStaleExperiment[] = [];
  const experiments = input.pages.filter(isStaleWorkCandidate);
  for (const page of experiments.slice(0, 50)) {
    const kind = page.type === "task" ? "task" : "experiment";
    const status = String(page.frontmatter.status ?? "running").toLowerCase();
    if (isTerminalStaleWorkStatus(status)) continue;
    const timeline = await store.getTimeline(page.path, { limit: 50 }).catch(() => []);
    const lastObservedAt = lastObservedAtForStaleWork(page, timeline);
    if (!lastObservedAt) continue;
    const ageDays = Math.floor((now.getTime() - new Date(lastObservedAt).getTime()) / 86_400_000);
    if (ageDays < STALE_EXPERIMENT_DAYS) continue;
    const detail: DreamStaleExperiment = {
      slug: normalizeSlug(page.path),
      title: page.title,
      kind,
      lastObservedAt,
      reason:
        kind === "task"
          ? `No research task update for ${ageDays} days.`
          : `No experiment timeline update for ${ageDays} days.`,
    };
    stale.push(detail);
    const staleSummary = staleTimelineSummary(kind);
    const alreadyFlaggedToday = timeline.some(
      (entry) =>
        isDreamStaleTimelineEntry(entry) &&
        normalizeTimelineDate(entry.date) === input.windowEnd.slice(0, 10),
    );
    if (adapter.engine && !alreadyFlaggedToday) {
      const userHandle = getCurrentUserHandle();
      await adapter.engine.addTimelineEntry(normalizeSlug(page.path), {
        date: input.windowEnd.slice(0, 10),
        source: "dream-cycle",
        summary: staleSummary,
        detail: `${detail.reason} Flagged by ${userHandle}.`,
      }).catch(() => {});
    }
  }
  return stale;
}

function isStaleWorkCandidate(page: BrainPage): boolean {
  return page.type === "experiment" || page.type === "task";
}

function isTerminalStaleWorkStatus(status: string): boolean {
  return [
    "archived",
    "canceled",
    "cancelled",
    "closed",
    "complete",
    "completed",
    "done",
    "failed",
  ].includes(status);
}

function lastObservedAtForStaleWork(
  page: BrainPage,
  timeline: Array<{ date: string; source?: string | null; summary: string }>,
): string | null {
  const explicitLastUpdate = explicitLastUpdateForPage(page);
  if (explicitLastUpdate) return explicitLastUpdate;
  return latestDate([
    ...timeline
      .filter((entry) => !isDreamStaleTimelineEntry(entry))
      .map((entry) => entry.date),
    observedAtForPage(page),
  ]);
}

function explicitLastUpdateForPage(page: BrainPage): string | null {
  const frontmatter = page.frontmatter ?? {};
  for (const key of [
    "last_update",
    "last_updated",
    "lastUpdate",
    "lastUpdated",
    "last_observed_at",
    "lastObservedAt",
    "last_activity_at",
    "lastActivityAt",
    "last_run_at",
    "lastRunAt",
  ]) {
    const value = frontmatter[key];
    if (typeof value === "string" && parseDate(value)) {
      return parseDate(value)!.toISOString();
    }
  }

  const content = page.content ?? "";
  const patterns = [
    /\blast\s+(?:update|updated|observed|activity|run|analysis update)\s*[:=]\s*([A-Z][a-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/i,
    /\bnot\s+(?:had\s+)?(?:a\s+)?(?:recorded\s+)?(?:analysis\s+)?update\s+since\s+([A-Z][a-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/i,
    /\bnot\s+been\s+updated\s+since\s+([A-Z][a-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/i,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    const parsed = parseDate(match?.[1]);
    if (parsed) return parsed.toISOString();
  }
  return null;
}

function staleTimelineSummary(kind: "experiment" | "task"): string {
  return kind === "task" ? "Research task flagged as stale" : "Experiment flagged as stale";
}

function isDreamStaleTimelineEntry(entry: {
  date: string;
  source?: string | null;
  summary: string;
}): boolean {
  return (
    entry.source === "dream-cycle" &&
    (entry.summary === "Experiment flagged as stale" ||
      entry.summary === "Research task flagged as stale")
  );
}

function normalizeTimelineDate(date: string): string {
  return date.slice(0, 10);
}

function latestDate(values: Array<string | null | undefined>): string | null {
  const dates = values
    .map((value) => parseDate(value))
    .filter((date): date is Date => Boolean(date))
    .sort((left, right) => right.getTime() - left.getTime());
  return dates[0]?.toISOString() ?? null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dedupeCompiledTopics(topics: CompileAffectedTopic[]): CompileAffectedTopic[] {
  const bySlug = new Map<string, CompileAffectedTopic>();
  for (const topic of topics) {
    const existing = bySlug.get(topic.slug);
    if (!existing) {
      bySlug.set(topic.slug, topic);
      continue;
    }
    bySlug.set(topic.slug, {
      ...existing,
      score: Math.max(existing.score, topic.score),
      backlinksAdded: existing.backlinksAdded + topic.backlinksAdded,
      contradictions: [...existing.contradictions, ...topic.contradictions],
      compiledTruthPreview: topic.compiledTruthPreview || existing.compiledTruthPreview,
    });
  }
  return Array.from(bySlug.values()).sort((left, right) => right.score - left.score);
}
