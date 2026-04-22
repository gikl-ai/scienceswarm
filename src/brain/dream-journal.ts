import { relative } from "node:path";

import type { PersistTransactionLinkInput } from "@/brain/in-process-gbrain-client";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { ensureBrainStoreReady } from "@/brain/store";
import type { BrainConfig } from "@/brain/types";
import type { PersistedResearchArtifact } from "@/lib/research-packets/contract";
import { persistResearchArtifactPage } from "@/lib/research-packets/writeback";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

import type { DreamCycleMode, DreamCycleResult } from "./dream-cycle";

export async function persistDreamCycleJournal(input: {
  config: BrainConfig;
  mode: DreamCycleMode;
  result: DreamCycleResult;
  reportPath?: string;
  now?: Date;
}): Promise<PersistedResearchArtifact> {
  const now = input.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const slug = buildDreamJournalSlug(date, input.mode);
  const client = createInProcessGbrainClient();

  await ensureBrainStoreReady();

  return persistResearchArtifactPage({
    slug,
    title:
      input.mode === "full"
        ? `Dream Cycle Journal: ${date}`
        : `Dream Cycle Journal (${input.mode}): ${date}`,
    type: "overnight_journal",
    brainRoot: input.config.root,
    client,
    userHandle: getCurrentUserHandle(),
    now,
    compiledTruth: renderDreamJournalBody(input.config.root, input.mode, input.result, date, input.reportPath),
    timelineEntry: renderDreamJournalTimeline(input.mode, input.result, date),
    frontmatter: buildDreamJournalFrontmatter(input.config.root, input.mode, input.result, now, input.reportPath),
    links: buildDreamJournalLinks(slug, input.result),
  });
}

function buildDreamJournalSlug(date: string, mode: DreamCycleMode): string {
  return mode === "full"
    ? `journals/${date}-dream-cycle`
    : `journals/${date}-dream-cycle-${mode}`;
}

function renderDreamJournalBody(
  brainRoot: string,
  mode: DreamCycleMode,
  result: DreamCycleResult,
  date: string,
  reportPath?: string,
): string {
  const lines = [
    `# Dream Cycle Journal — ${date}`,
    "",
    `Mode: ${mode}`,
    result.headline ? `Headline: ${result.headline.headline}` : null,
    reportPath ? `Report mirror: ${toRelativeBrainPath(brainRoot, reportPath)}` : null,
    "",
    "## Metrics",
    `- Entities swept: ${result.entitiesSwept}`,
    `- Pages enriched: ${result.pagesEnriched}`,
    `- Pages created: ${result.pagesCreated}`,
    `- Citations fixed: ${result.citationsFixed}`,
    `- Informal refs resolved: ${result.refsResolved}`,
    `- Clusters generated: ${result.clusterCount}`,
    `- Consolidations promoted: ${result.consolidations}`,
    `- Pages compiled: ${result.pagesCompiled}`,
    `- Contradictions found: ${result.contradictionsFound}`,
    `- Backlinks added: ${result.backlinksAdded}`,
    `- Duration (ms): ${result.durationMs}`,
    "",
    result.headline ? "## Compiled Topics" : null,
    result.headline && result.headline.compiledTopics.length > 0
      ? result.headline.compiledTopics.map((topic) => `- ${topic.title} (${topic.slug})`).join("\n")
      : result.headline
        ? "- None"
        : null,
    "",
    result.headline ? "## Signals" : null,
    result.headline && result.headline.signals.length > 0
      ? result.headline.signals.map((signal) => `- ${signal.title} (${signal.slug})`).join("\n")
      : result.headline
        ? "- None"
        : null,
    "",
    "## Report",
    result.report.trim(),
  ];

  return lines.filter((line): line is string => typeof line === "string" && line.length > 0).join("\n");
}

function renderDreamJournalTimeline(
  mode: DreamCycleMode,
  result: DreamCycleResult,
  date: string,
): string {
  return [
    `- ${date} Dream Cycle (${mode}) completed.`,
    `  Compiled ${result.pagesCompiled} pages, surfaced ${result.contradictionsFound} contradictions, and added ${result.backlinksAdded} backlinks.`,
  ].join("\n");
}

function buildDreamJournalFrontmatter(
  brainRoot: string,
  mode: DreamCycleMode,
  result: DreamCycleResult,
  now: Date,
  reportPath?: string,
): Record<string, unknown> {
  return {
    source: "dream-cycle",
    mode,
    generated_at: now.toISOString(),
    report_path: reportPath ? toRelativeBrainPath(brainRoot, reportPath) : undefined,
    entities_swept: result.entitiesSwept,
    pages_enriched: result.pagesEnriched,
    pages_created: result.pagesCreated,
    citations_fixed: result.citationsFixed,
    refs_resolved: result.refsResolved,
    cluster_count: result.clusterCount,
    consolidations: result.consolidations,
    pages_compiled: result.pagesCompiled,
    contradictions_found: result.contradictionsFound,
    backlinks_added: result.backlinksAdded,
    duration_ms: result.durationMs,
    headline: result.headline?.headline,
  };
}

function buildDreamJournalLinks(
  journalSlug: string,
  result: DreamCycleResult,
): PersistTransactionLinkInput[] {
  const links: PersistTransactionLinkInput[] = [];

  for (const topic of result.headline?.compiledTopics ?? []) {
    links.push({
      from: journalSlug,
      to: topic.slug,
      context: "compiled_topic",
      linkType: "supports",
    });
  }

  for (const signal of result.headline?.signals ?? []) {
    links.push({
      from: journalSlug,
      to: signal.slug,
      context: "dream_signal",
      linkType: "supports",
    });
  }

  for (const staleItem of result.headline?.staleExperimentDetails ?? []) {
    links.push({
      from: journalSlug,
      to: staleItem.slug,
      context: "stale_experiment",
      linkType: "supports",
    });
  }

  return dedupeLinks(links);
}

function dedupeLinks(
  links: PersistTransactionLinkInput[],
): PersistTransactionLinkInput[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.from}:${link.to}:${link.context ?? ""}:${link.linkType ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toRelativeBrainPath(brainRoot: string, absolutePath: string): string {
  const value = relative(brainRoot, absolutePath).replaceAll("\\", "/");
  return value || absolutePath;
}
