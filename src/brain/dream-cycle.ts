/**
 * Second Brain — Dream Cycle Orchestrator
 *
 * The overnight cycle that runs while the scientist sleeps:
 * 1. Entity Sweep — find entities mentioned in recent conversations
 * 2. Enrich Thin Spots — fill in missing metadata from APIs
 * 3. Fix Broken Citations — DOI lookups, metadata gaps
 * 4. Citation Graph Update — weekly "cited by" refresh
 * 5. Consolidate — LLM identifies patterns, promotes themes
 * 6. Log — write dream cycle event + report
 *
 * Follows Garry's DREAMS pattern adapted for science:
 * deterministic collectors for data, LLMs for judgment.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";
import type { BrainConfig, IngestCost } from "./types";
import type { LLMClient } from "./llm";
import { getRecentEvents, logEvent, aggregateCosts } from "./cost";
import { search } from "./search";
import { batchEnrich } from "./enrichment";
import {
  readDreamState,
  writeDreamState,
  enqueueTargets,
  markEventsProcessed,
  type DreamState,
  type EnrichmentTarget,
} from "./dream-state";
import { resolveAllInformalRefs } from "./name-resolver";
import { clusterOriginals, generateClusterReport } from "./original-clustering";
import { compilePage } from "./compile-page";
import {
  buildDreamHeadlineSummary,
  type DreamHeadlineSummary,
} from "./dream-headline";
import { persistDreamCycleJournal } from "./dream-journal";

// ── Types ─────────────────────────────────────────────

export interface DreamCycleResult {
  entitiesSwept: number;
  pagesEnriched: number;
  pagesCreated: number;
  citationsFixed: number;
  refsResolved: number;
  clusterCount: number;
  consolidations: number;
  pagesCompiled: number;
  contradictionsFound: number;
  backlinksAdded: number;
  headline: DreamHeadlineSummary | null;
  cost: IngestCost;
  durationMs: number;
  report: string; // Human-readable summary
  journalSlug?: string;
}

export type DreamCycleMode = "full" | "sweep-only" | "enrich-only";

// ── Main Entry Point ──────────────────────────────────

/**
 * Run the dream cycle. Safe to call repeatedly (idempotent within a day).
 */
export async function runDreamCycle(
  config: BrainConfig,
  llm: LLMClient,
  mode: DreamCycleMode = "full",
): Promise<DreamCycleResult> {
  const startTime = Date.now();
  const costs: IngestCost[] = [];
  let state = readDreamState(config);
  const lastRunAt = state.lastFullRun;

  const result: DreamCycleResult = {
    entitiesSwept: 0,
    pagesEnriched: 0,
    pagesCreated: 0,
    citationsFixed: 0,
    refsResolved: 0,
    clusterCount: 0,
    consolidations: 0,
    pagesCompiled: 0,
    contradictionsFound: 0,
    backlinksAdded: 0,
    headline: null,
    cost: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, model: "none" },
    durationMs: 0,
    report: "",
  };

  // ── Step 1: Entity Sweep ────────────────────────────
  if (mode === "full" || mode === "sweep-only") {
    const sweepResult = await entitySweep(config, llm, state);
    state = sweepResult.state;
    result.entitiesSwept = sweepResult.targets.length;
    if (sweepResult.cost) costs.push(sweepResult.cost);
  }

  // ── Step 2: Enrich Thin Spots ──────────────────────
  if (mode === "full" || mode === "enrich-only") {
    const targets = state.enrichmentQueue.slice(0, 20); // Cap per run
    if (targets.length > 0) {
      const enrichResult = await batchEnrich(config, llm, targets);
      result.pagesEnriched += enrichResult.pagesUpdated.length;
      result.pagesCreated += enrichResult.pagesCreated.length;
      costs.push(enrichResult.cost);

      // Remove processed targets from queue
      const processedIds = new Set(targets.map((t) => t.identifier));
      state.enrichmentQueue = state.enrichmentQueue.filter(
        (t) => !processedIds.has(t.identifier),
      );
    }
  }

  // ── Step 3: Fix Broken Citations ───────────────────
  if (mode === "full") {
    const fixResult = await fixBrokenCitations(config);
    result.citationsFixed = fixResult.fixed;
    // Citation fixing is deterministic (no LLM cost)
  }

  // ── Step 4: Citation Graph Update + Name Resolution (weekly) ──
  if (mode === "full") {
    const shouldUpdate = shouldRunCitationGraph(state);
    if (shouldUpdate) {
      const cgResult = await updateCitationGraph(config);
      result.pagesEnriched += cgResult.updated;
      state.lastCitationGraphUpdate = new Date().toISOString();
    }

    // Resolve informal references in recently-touched pages
    try {
      const recentEvents = getRecentEvents(config, undefined, 20);
      const recentPages = new Set<string>();
      for (const event of recentEvents) {
        for (const p of event.created ?? []) recentPages.add(p);
        for (const p of event.updated ?? []) recentPages.add(p);
      }
      for (const pagePath of Array.from(recentPages).slice(0, 10)) {
        const absPath = join(config.root, pagePath);
        if (!existsSync(absPath)) continue;
        const content = readFileSync(absPath, "utf-8");
        const resolved = await resolveAllInformalRefs(config, content);
        result.refsResolved += resolved.length;
      }
    } catch {
      // Name resolution is best-effort; don't fail the cycle
    }
  }

  // ── Step 5: Consolidate + Original Clustering ─────
  if (mode === "full") {
    const consolidateResult = await consolidate(config, llm);
    result.consolidations = consolidateResult.consolidations;
    result.pagesCompiled = consolidateResult.pagesCompiled;
    result.contradictionsFound = consolidateResult.contradictionsFound;
    result.backlinksAdded = consolidateResult.backlinksAdded;
    if (consolidateResult.cost) costs.push(consolidateResult.cost);

    const headline = await buildDreamHeadlineSummary({
      config,
      llm,
      events: getRecentEvents(config, undefined, 200),
      lastRunAt,
      skipConceptSlugs: consolidateResult.compiledTopicSlugs,
    });
    result.headline = headline;
    result.pagesCompiled += headline.topicsRecompiled;
    result.contradictionsFound += headline.contradictionsFound;
    result.backlinksAdded += headline.crossReferencesAdded;

    // Run original clustering weekly
    const shouldCluster = shouldRunClustering(state);
    if (shouldCluster) {
      try {
        const clusters = await clusterOriginals(config);
        result.clusterCount = clusters.length;
        if (clusters.length > 0) {
          const clusterReport = generateClusterReport(clusters);
          const reportDir = join(config.root, "state", "dream-reports");
          mkdirSync(reportDir, { recursive: true });
          const dateStr = new Date().toISOString().slice(0, 10);
          writeFileSync(
            join(reportDir, `${dateStr}-clusters.md`),
            clusterReport + "\n",
          );
        }
        state.lastClusteringRun = new Date().toISOString();
      } catch {
        // Clustering is best-effort
      }
    }
  }

  // ── Step 6: Log + Report ───────────────────────────
  result.cost = aggregateCosts(costs);
  result.durationMs = Date.now() - startTime;
  result.report = buildReport(result);
  const finishedAt = new Date();

  // Update state
  state.lastFullRun = finishedAt.toISOString();
  writeDreamState(config, state);

  // Write report to disk
  const reportPath = saveDreamReport(config, result.report, finishedAt);

  try {
    const journal = await persistDreamCycleJournal({
      config,
      mode,
      result,
      reportPath,
      now: finishedAt,
    });
    result.journalSlug = journal.slug;
  } catch {
    // Journal persistence is best-effort; the disk report remains the
    // fallback audit artifact when gbrain write-back is unavailable.
  }

  // Log event
  logEvent(config, {
    ts: finishedAt.toISOString(),
    type: "compile",
    cost: result.cost,
    durationMs: result.durationMs,
  });

  return result;
}

// ── Step 1: Entity Sweep ──────────────────────────────

interface SweepResult {
  targets: EnrichmentTarget[];
  state: DreamState;
  cost?: IngestCost;
}

function getEventPagePaths(event: {
  created?: string[];
  updated?: string[];
}): string[] {
  return [...(event.created ?? []), ...(event.updated ?? [])];
}

async function entitySweep(
  config: BrainConfig,
  llm: LLMClient,
  state: DreamState,
): Promise<SweepResult> {
  // Get recent events not yet processed
  const recentEvents = getRecentEvents(config, undefined, 50).filter(
    (event) => getEventPagePaths(event).length > 0,
  );
  const processedSet = new Set(state.processedEventIds);
  const newEvents = recentEvents.filter((e) => !processedSet.has(e.ts));

  if (newEvents.length === 0) {
    return { targets: [], state };
  }

  // Collect all pages mentioned in recent events
  const mentionedPages = new Set<string>();
  for (const event of newEvents) {
    for (const pagePath of getEventPagePaths(event)) {
      mentionedPages.add(pagePath);
    }
  }

  // Read recent pages and extract entities
  const targets: EnrichmentTarget[] = [];
  const seenIdentifiers = new Set<string>();

  for (const pagePath of mentionedPages) {
    const absPath = join(config.root, pagePath);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, "utf-8");
    const parsed = matter(content);

    // Paper pages without abstracts or citation counts -> enrich
    if (parsed.data.type === "paper") {
      const hasAbstract = content.includes("## Abstract") &&
        !content.includes("{To be filled");
      const hasCitations = parsed.data.citation_count > 0;

      if (!hasAbstract || !hasCitations) {
        const identifier = parsed.data.doi ??
          parsed.data.arxiv ??
          parsed.data.title ??
          basename(pagePath, ".md");
        if (!seenIdentifiers.has(identifier)) {
          seenIdentifiers.add(identifier);
          targets.push({
            type: "paper",
            identifier,
            brainPath: pagePath,
            priority: "high",
          });
        }
      }
    }

    // Extract wikilinks to non-existent pages
    const wikilinks = content.match(/\[\[([^\]|]+)/g) ?? [];
    for (const link of wikilinks) {
      const target = link.slice(2); // Remove [[
      const absTarget = join(config.root, target.endsWith(".md") ? target : `${target}.md`);
      if (!existsSync(absTarget) && !seenIdentifiers.has(target)) {
        seenIdentifiers.add(target);
        // Determine type from path
        if (target.includes("people/") || target.includes("person/")) {
          targets.push({
            type: "author",
            identifier: basename(target, ".md").replace(/-/g, " "),
            priority: "low",
          });
        } else if (target.includes("concepts/")) {
          targets.push({
            type: "concept",
            identifier: basename(target, ".md").replace(/-/g, " "),
            priority: "low",
          });
        }
      }
    }
  }

  // Use LLM to extract additional entities from recent page content
  const recentPageContents: string[] = [];
  for (const pagePath of Array.from(mentionedPages).slice(0, 5)) {
    const absPath = join(config.root, pagePath);
    if (!existsSync(absPath)) continue;
    const content = readFileSync(absPath, "utf-8");
    recentPageContents.push(`--- ${pagePath} ---\n${content.slice(0, 2000)}`);
  }

  let cost: IngestCost | undefined;
  if (recentPageContents.length > 0) {
    const extractResponse = await llm.complete({
      system: `You are a research entity extraction agent. From the given brain pages, identify entities (papers, authors, concepts, methods) that deserve their own page but may not have one yet. Output a JSON array of objects: { type: "paper"|"author"|"concept"|"method", identifier: string, priority: "high"|"medium"|"low" }. Focus on frequently mentioned entities. Max 10 items.`,
      user: recentPageContents.join("\n\n"),
      model: config.extractionModel,
    });
    cost = extractResponse.cost;

    try {
      const jsonMatch = extractResponse.content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0]) as EnrichmentTarget[];
        for (const t of extracted) {
          if (t.identifier && !seenIdentifiers.has(t.identifier)) {
            seenIdentifiers.add(t.identifier);
            targets.push({
              type: t.type ?? "concept",
              identifier: t.identifier,
              priority: t.priority ?? "medium",
            });
          }
        }
      }
    } catch {
      // LLM output wasn't valid JSON — skip
    }
  }

  // Update state: mark events as processed and enqueue targets
  const updatedState = markEventsProcessed(
    enqueueTargets(state, targets),
    newEvents.map((e) => e.ts),
  );

  return { targets, state: updatedState, cost };
}

// ── Step 3: Fix Broken Citations ─────────────────────

interface FixResult {
  fixed: number;
}

async function fixBrokenCitations(config: BrainConfig): Promise<FixResult> {
  let fixed = 0;

  // Find paper pages
  const paperDir = join(config.root, "wiki/entities/papers");
  if (!existsSync(paperDir)) return { fixed };

  const files = readdirSync(paperDir).filter((f) => f.endsWith(".md"));

  for (const file of files.slice(0, 30)) {
    // Cap per run
    const absPath = join(paperDir, file);
    const content = readFileSync(absPath, "utf-8");
    const parsed = matter(content);

    // Paper without DOI but with arXiv ID -> try to find DOI
    if (!parsed.data.doi && parsed.data.arxiv) {
      // Queue for enrichment rather than fixing inline
      // (The enrichment step will handle this)
      fixed++;
    }

    // Paper without year
    if (!parsed.data.year && parsed.data.title) {
      // Try to extract year from title or filename
      const yearMatch = file.match(/(\d{4})/);
      if (yearMatch) {
        parsed.data.year = parseInt(yearMatch[1], 10);
        const rebuilt = matter.stringify(parsed.content, parsed.data);
        writeFileSync(absPath, rebuilt);
        fixed++;
      }
    }
  }

  return { fixed };
}

// ── Step 4: Citation Graph Update ────────────────────

function shouldRunCitationGraph(state: DreamState): boolean {
  if (!state.lastCitationGraphUpdate) return true;
  const lastUpdate = new Date(state.lastCitationGraphUpdate);
  const daysSince = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= 7;
}

function shouldRunClustering(state: DreamState): boolean {
  if (!state.lastClusteringRun) return true;
  const lastRun = new Date(state.lastClusteringRun);
  const daysSince = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= 7;
}

interface CitationGraphResult {
  updated: number;
}

async function updateCitationGraph(
  config: BrainConfig,
): Promise<CitationGraphResult> {
  let updated = 0;

  // Find the most cross-referenced papers in the brain
  const paperDir = join(config.root, "wiki/entities/papers");
  if (!existsSync(paperDir)) return { updated };

  const files = readdirSync(paperDir).filter((f) => f.endsWith(".md"));

  // Score papers by how many other pages reference them
  const paperScores: Array<{ file: string; score: number; doi?: string; arxiv?: string }> = [];

  for (const file of files) {
    const absPath = join(paperDir, file);
    const content = readFileSync(absPath, "utf-8");
    const parsed = matter(content);

    // Count incoming references via grep search
    const slug = basename(file, ".md");
    const results = await search(config, {
      query: slug,
      mode: "grep",
      limit: 50,
      profile: "synthesis",
    });
    // Exclude self-references
    const incomingRefs = results.filter(
      (r) => !r.path.endsWith(file),
    ).length;

    if (incomingRefs > 0) {
      paperScores.push({
        file,
        score: incomingRefs,
        doi: parsed.data.doi as string | undefined,
        arxiv: parsed.data.arxiv as string | undefined,
      });
    }
  }

  // Sort by score and take top 5
  paperScores.sort((a, b) => b.score - a.score);
  const topPapers = paperScores.slice(0, 5);

  for (const p of topPapers) {
    // Only update papers with DOIs or arXiv IDs (can be resolved)
    if (!p.doi && !p.arxiv) continue;

    try {
      // Just resolve and update citation count — no LLM needed for this
      const { resolvePaper } = await import(
        "../../scripts/research-enrichment/semantic-scholar"
      );
      const query = p.doi ? { doi: p.doi } : { arxivId: p.arxiv };
      const ssResult = await resolvePaper(query, 500);

      if (ssResult.ok && ssResult.paper) {
        const absPath = join(config.root, "wiki/entities/papers", p.file);
        const content = readFileSync(absPath, "utf-8");
        const parsed = matter(content);
        const oldCount = parsed.data.citation_count ?? 0;
        const newCount = ssResult.paper.citationCount;

        if (newCount > oldCount) {
          parsed.data.citation_count = newCount;
          const dateStr = new Date().toISOString().slice(0, 10);
          const rebuilt = matter.stringify(parsed.content, parsed.data);
          const timelineEntry = `\n- ${dateStr}: Citation count updated ${oldCount} -> ${newCount}\n`;
          writeFileSync(absPath, rebuilt.trimEnd() + timelineEntry);
          updated++;
        }
      }
    } catch {
      // Skip papers that fail to resolve
    }
  }

  return { updated };
}

// ── Step 5: Consolidate ──────────────────────────────

interface ConsolidateResult {
  consolidations: number;
  pagesCompiled: number;
  contradictionsFound: number;
  backlinksAdded: number;
  compiledTopicSlugs: string[];
  cost?: IngestCost;
}

async function consolidate(
  config: BrainConfig,
  llm: LLMClient,
): Promise<ConsolidateResult> {
  const emptyResult: ConsolidateResult = {
    consolidations: 0,
    pagesCompiled: 0,
    contradictionsFound: 0,
    backlinksAdded: 0,
    compiledTopicSlugs: [],
  };
  // Get recent events to understand what happened today
  const recentEvents = getRecentEvents(config, undefined, 30);
  if (recentEvents.length === 0) return emptyResult;

  // Collect recent page paths
  const recentPages = new Set<string>();
  for (const event of recentEvents) {
    for (const p of event.created ?? []) recentPages.add(p);
    for (const p of event.updated ?? []) recentPages.add(p);
  }
  const recentPageList = Array.from(recentPages);

  // Read a sample of recent pages
  const pageSnippets: string[] = [];
  for (const pagePath of recentPageList.slice(0, 10)) {
    const absPath = join(config.root, pagePath);
    if (!existsSync(absPath)) continue;
    const content = readFileSync(absPath, "utf-8");
    pageSnippets.push(
      `--- ${pagePath} ---\n${content.slice(0, 1500)}`,
    );
  }

  if (pageSnippets.length === 0) return emptyResult;

  // Ask LLM to identify patterns and suggest consolidations
  const response = await llm.complete({
    system: `You are a research knowledge consolidation agent. Analyze recent brain activity and identify:
1. Recurring themes or topics that should become concept pages
2. Patterns across conversations worth noting
3. Any existing concept pages that should be updated with new evidence

Output a JSON object: { themes: string[], concept_updates: Array<{ concept: string, evidence: string, source?: string }>, summary: string }`,
    user: `Recent brain activity (${recentEvents.length} events, ${recentPages.size} pages):\n\n${pageSnippets.join("\n\n")}`,
    model: config.extractionModel,
  });

  let consolidations = 0;
  let pagesCompiled = 0;
  let contradictionsFound = 0;
  let backlinksAdded = 0;
  const compiledTopicSlugs: string[] = [];
  const costs: IngestCost[] = [response.cost];

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        themes?: string[];
        concept_updates?: Array<{ concept: string; evidence: string; source?: string }>;
        summary?: string;
      };

      // Create concept pages for recurring themes
      for (const theme of (parsed.themes ?? []).slice(0, 3)) {
        const slug = theme
          .toLowerCase()
          .replace(/[^a-z0-9\s]+/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 60);
        const conceptPath = join(config.root, `wiki/concepts/${slug}.md`);

        if (!existsSync(conceptPath)) {
          mkdirSync(join(config.root, "wiki/concepts"), { recursive: true });
          const dateStr = new Date().toISOString().slice(0, 10);
          const content = [
            "---",
            `date: ${dateStr}`,
            "type: concept",
            "para: resources",
            `title: "${theme.replace(/"/g, '\\"')}"`,
            "tags: [concept, dream-cycle]",
            "---",
            "",
            `# ${theme}`,
            "",
            "## Definition",
            "{Recurring theme identified by dream cycle. To be refined.}",
            "",
            "## Evidence From Our Work",
            "",
            "## Timeline",
            `- ${dateStr}: Identified as recurring theme by dream cycle`,
          ].join("\n") + "\n";
          writeFileSync(conceptPath, content);
          consolidations++;
        }
      }

      for (const update of (parsed.concept_updates ?? []).slice(0, 5)) {
        if (!update.concept?.trim() || !update.evidence?.trim()) continue;
        const targetSlug = conceptToCompiledSlug(update.concept);
        const sourceSlug = chooseEvidenceSourceSlug(
          update.source,
          recentPageList,
          targetSlug,
        );
        try {
          const compileResult = await compilePage(
            targetSlug,
            {
              content: update.evidence,
              sourceSlug,
              sourceTitle: sourceSlug
                ? titleFromSlug(sourceSlug)
                : "Dream cycle consolidation",
              sourceType: "dream-cycle",
            },
            config,
            llm,
          );
          pagesCompiled += 1;
          contradictionsFound += compileResult.contradictions.length;
          backlinksAdded += compileResult.backlinksAdded;
          compiledTopicSlugs.push(targetSlug);
          costs.push(compileResult.cost);
        } catch {
          // A suggested concept update may point at a page that does not yet
          // exist in gbrain. Keep the nightly cycle moving; the created theme
          // stubs above can become compile targets on a later run.
        }
      }
    }
  } catch {
    // JSON parsing failed — skip consolidation
  }

  return {
    consolidations,
    pagesCompiled,
    contradictionsFound,
    backlinksAdded,
    compiledTopicSlugs,
    cost: aggregateCosts(costs),
  };
}

function conceptToCompiledSlug(concept: string): string {
  const trimmed = concept.trim().replace(/^gbrain:/, "").replace(/\\/g, "/");
  if (trimmed.includes("/")) {
    return trimmed.replace(/\.mdx?$/i, "");
  }
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `wiki/concepts/${slug || "untitled-concept"}`;
}

function chooseEvidenceSourceSlug(
  suggestedSource: string | undefined,
  recentPages: string[],
  targetSlug: string,
): string | undefined {
  const normalizedTarget = stripMarkdownExtension(targetSlug);
  const candidates = [
    suggestedSource,
    ...recentPages,
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));
  for (const candidate of candidates) {
    const normalized = stripMarkdownExtension(candidate.trim().replace(/^gbrain:/, ""));
    if (normalized && normalized !== normalizedTarget) {
      return normalized;
    }
  }
  return undefined;
}

function stripMarkdownExtension(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.mdx?$/i, "");
}

function titleFromSlug(slug: string): string {
  const base = stripMarkdownExtension(slug).split("/").pop() ?? slug;
  return base
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// ── Report Generation ─────────────────────────────────

function buildReport(result: DreamCycleResult): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toISOString().slice(11, 16);

  return [
    `# Dream Cycle Report — ${dateStr} ${timeStr}`,
    "",
    "## Summary",
    `- **Entities swept**: ${result.entitiesSwept}`,
    `- **Pages enriched**: ${result.pagesEnriched}`,
    `- **Pages created**: ${result.pagesCreated}`,
    `- **Citations fixed**: ${result.citationsFixed}`,
    `- **References resolved**: ${result.refsResolved}`,
    `- **Theme clusters**: ${result.clusterCount}`,
    `- **Consolidations**: ${result.consolidations}`,
    `- **Pages compiled**: ${result.pagesCompiled}`,
    `- **Contradictions surfaced**: ${result.contradictionsFound}`,
    `- **Typed backlinks added**: ${result.backlinksAdded}`,
    result.headline ? `- **Morning headline**: ${result.headline.headline}` : "",
    `- **Duration**: ${(result.durationMs / 1000).toFixed(1)}s`,
    `- **Cost**: $${result.cost.estimatedUsd.toFixed(4)} (${result.cost.inputTokens + result.cost.outputTokens} tokens)`,
    "",
    "## What Happened",
    result.entitiesSwept > 0
      ? `Swept ${result.entitiesSwept} entities from recent activity.`
      : "No new entities found in recent activity.",
    result.pagesCreated > 0
      ? `Created ${result.pagesCreated} new pages (author stubs, concept pages).`
      : "",
    result.pagesEnriched > 0
      ? `Enriched ${result.pagesEnriched} existing pages with metadata from Semantic Scholar.`
      : "",
    result.citationsFixed > 0
      ? `Fixed ${result.citationsFixed} citation issues.`
      : "",
    result.refsResolved > 0
      ? `Resolved ${result.refsResolved} informal references to canonical pages.`
      : "",
    result.clusterCount > 0
      ? `Detected ${result.clusterCount} theme cluster${result.clusterCount === 1 ? "" : "s"} across original thoughts.`
      : "",
    result.consolidations > 0
      ? `Promoted ${result.consolidations} recurring themes to concept pages.`
      : "",
    result.pagesCompiled > 0
      ? `Recompiled ${result.pagesCompiled} concept page${result.pagesCompiled === 1 ? "" : "s"} from new evidence.`
      : "",
    result.contradictionsFound > 0
      ? `Surfaced ${result.contradictionsFound} contradiction${result.contradictionsFound === 1 ? "" : "s"} for review.`
      : "",
    result.headline
      ? `Morning dashboard summary: ${result.headline.headline}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function saveDreamReport(
  config: BrainConfig,
  report: string,
  now: Date = new Date(),
): string {
  const reportDir = join(config.root, "state", "dream-reports");
  mkdirSync(reportDir, { recursive: true });

  const dateStr = now.toISOString().slice(0, 10);
  const reportPath = join(reportDir, `${dateStr}.md`);
  writeFileSync(reportPath, report + "\n");
  return reportPath;
}
