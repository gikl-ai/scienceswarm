/**
 * Second Brain — Research-Aware Briefing Engine
 *
 * Synthesizes across ALL brain content to produce briefings that actually
 * help scientists. The morning brief is the flagship: opinionated, tied to
 * the user's actual work, and laser-focused on what matters NOW.
 *
 * gbrain principle: Briefings are NOT news aggregation. They are highly
 * opinionated filtering tied to the user's actual work.
 */

import { getRecentEvents } from "./cost";
import { search, countPages } from "./search";
import { scanForContradictions } from "./contradiction-detector";
import { loadFrontierWatchItems } from "./frontier-loader";
import { loadCalendarEvents, buildMeetingPrepFromCalendar } from "./meeting-prep";
import type {
  BrainConfig,
  BrainEvent,
  Confidence,
  MorningBrief,
  ProgramBrief,
  ContradictionReport,
  SearchResult,
} from "./types";
import type { LLMClient } from "./llm";

// ── Morning Brief ─────────────────────────────────────

export interface MorningBriefOptions {
  project?: string;
  includeAllProjects?: boolean;
}

/**
 * Build the morning brief — the main daily briefing for a scientist.
 *
 * Steps:
 * 1. Gather signals (recent events, tasks, experiments, frontier)
 * 2. Detect contradictions
 * 3. Score frontier items
 * 4. Find stale threads
 * 5. Identify open questions
 * 6. Synthesize next move (LLM)
 */
export async function buildMorningBrief(
  config: BrainConfig,
  llm: LLMClient,
  options?: MorningBriefOptions,
): Promise<MorningBrief> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Step 1: Gather signals — parallel searches
  const projectFilter = options?.project ?? "";
  const [
    recentEvents,
    taskResults,
    experimentResults,
    frontierResults,
    hypothesisResults,
    observationResults,
  ] = await Promise.all([
    Promise.resolve(getRecentEvents(config, yesterday, 50)),
    search(config, {
      query: projectFilter ? `task ${projectFilter}` : "status: open task",
      mode: "grep",
      limit: 20,
      profile: "synthesis",
    }),
    search(config, {
      query: projectFilter
        ? `experiment ${projectFilter} running`
        : "status: running experiment",
      mode: "grep",
      limit: 15,
      profile: "synthesis",
    }),
    search(config, {
      query: projectFilter
        ? `frontier ${projectFilter}`
        : "frontier_item staged promoted",
      mode: "grep",
      limit: 20,
      profile: "synthesis",
    }),
    search(config, {
      query: projectFilter
        ? `hypothesis ${projectFilter}`
        : "hypothesis active",
      mode: "grep",
      limit: 15,
      profile: "synthesis",
    }),
    search(config, {
      query: projectFilter
        ? `observation ${projectFilter}`
        : "observation",
      mode: "grep",
      limit: 15,
      profile: "synthesis",
    }),
  ]);

  // Step 2: Detect contradictions — uses extraction model (cheaper)
  const contradictionReport = await scanForContradictions(config, llm, {
    project: options?.project,
    since: yesterday.toISOString().slice(0, 10),
  });

  // Step 3: Score frontier items — merge search results with watch store data
  const watchItems = await loadFrontierWatchItems(config, projectFilter);
  const mergedFrontierResults = mergeFrontierSources(frontierResults, watchItems);
  const frontier = scoreFrontierItems(mergedFrontierResults, projectFilter);

  // Step 4: Find stale threads
  const staleThreads = findStaleThreads(
    taskResults,
    experimentResults,
    recentEvents,
    now,
  );

  // Step 5: Identify open questions
  const openQuestions = identifyOpenQuestions(
    hypothesisResults,
    taskResults,
    now,
  );

  // Step 6: Synthesize with LLM — uses synthesis model (stronger)
  const synthesisContext = buildSynthesisContext({
    recentEvents,
    taskResults,
    experimentResults,
    frontierResults,
    hypothesisResults,
    observationResults,
    contradictionReport,
    staleThreads,
    openQuestions,
    frontier,
    projectFilter,
  });

  const synthesisResponse = await llm.complete({
    system: MORNING_BRIEF_SYNTHESIS_PROMPT,
    user: synthesisContext,
    model: config.synthesisModel,
  });

  const synthesized = parseSynthesisResponse(synthesisResponse.content);

  // Build stats
  const pageCount = await countPages(config);
  const newPagesYesterday = recentEvents.filter(
    (e) => e.type === "ingest" && e.created && e.created.length > 0,
  ).length;
  const capturesYesterday = recentEvents.filter(
    (e) => e.type === "observe",
  ).length;
  const enrichmentsYesterday = recentEvents.filter(
    (e) => e.type === "ripple",
  ).length;

  // Build top matters from synthesis
  const topMatters = synthesized.topMatters.slice(0, 3);
  if (topMatters.length === 0) {
    // Fallback: derive from recent events
    if (recentEvents.length > 0) {
      topMatters.push({
        summary: `${recentEvents.length} brain events in the last 24h`,
        whyItMatters:
          "Recent activity suggests active research. Review the latest changes.",
        evidence: recentEvents
          .slice(0, 3)
          .map(
            (e) =>
              e.created?.[0] ?? e.updated?.[0] ?? `event:${e.type}`,
          ),
        urgency: "awareness" as const,
      });
    }
    if (taskResults.length > 0) {
      topMatters.push({
        summary: `${taskResults.length} open tasks found`,
        whyItMatters: "Outstanding tasks may need attention today.",
        evidence: taskResults.slice(0, 3).map((t) => t.path),
        urgency: "this-week" as const,
      });
    }
  }

  // Build contradictions from report
  const contradictions = contradictionReport.contradictions
    .slice(0, 5)
    .map((c) => ({
      claim1: { summary: c.claim1.text, source: c.claim1.source, date: c.claim1.date },
      claim2: { summary: c.claim2.text, source: c.claim2.source, date: c.claim2.date },
      implication: c.implication,
    }));

  // Step 7: Meeting prep — load calendar if available
  let meetingPrep: MorningBrief["meetingPrep"];
  const calendarEvents = await loadCalendarEvents();
  if (calendarEvents && calendarEvents.length > 0) {
    try {
      meetingPrep = await buildMeetingPrepFromCalendar(config, calendarEvents);
    } catch {
      // Meeting prep is best-effort — do not fail the brief
    }
  }

  return {
    generatedAt: now.toISOString(),
    greeting: buildGreeting(now, options?.project),
    topMatters,
    contradictions,
    frontier,
    staleThreads,
    openQuestions,
    nextMove: synthesized.nextMove,
    meetingPrep,
    stats: {
      brainPages: pageCount,
      newPagesYesterday,
      capturesYesterday,
      enrichmentsYesterday,
    },
  };
}

// ── Program Brief ─────────────────────────────────────

/**
 * Build a program-level brief for team projects (FinalDose-style).
 */
export async function buildProgramBrief(
  config: BrainConfig,
  llm: LLMClient,
  teamProjects: string[],
): Promise<ProgramBrief> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentEvents = getRecentEvents(config, yesterday, 100);

  // Gather per-project signals in parallel
  const projectSignals = await Promise.all(
    teamProjects.map(async (project) => {
      const [tasks, experiments, hypotheses] = await Promise.all([
        search(config, {
          query: `task ${project}`,
          mode: "grep",
          limit: 10,
          profile: "synthesis",
        }),
        search(config, {
          query: `experiment ${project} running`,
          mode: "grep",
          limit: 10,
          profile: "synthesis",
        }),
        search(config, {
          query: `hypothesis ${project}`,
          mode: "grep",
          limit: 10,
          profile: "synthesis",
        }),
      ]);
      return { project, tasks, experiments, hypotheses };
    }),
  );

  // Detect contradictions across all projects
  const contradictionReport = await scanForContradictions(config, llm);

  // Build context for synthesis
  const contextParts: string[] = [
    `Program brief for projects: ${teamProjects.join(", ")}`,
    `Recent events (last 24h): ${recentEvents.length}`,
    "",
  ];

  for (const signal of projectSignals) {
    contextParts.push(
      `## Project: ${signal.project}`,
      `  Tasks: ${signal.tasks.length} (${signal.tasks.map((t) => t.title).join("; ")})`,
      `  Experiments: ${signal.experiments.length} (${signal.experiments.map((e) => e.title).join("; ")})`,
      `  Hypotheses: ${signal.hypotheses.length} (${signal.hypotheses.map((h) => h.title).join("; ")})`,
    );
  }

  if (contradictionReport.contradictions.length > 0) {
    contextParts.push(
      "",
      "## Contradictions Found",
      ...contradictionReport.contradictions.map(
        (c) =>
          `- [${c.severity}] ${c.claim1.text} vs ${c.claim2.text}: ${c.implication}`,
      ),
    );
  }

  const response = await llm.complete({
    system: PROGRAM_BRIEF_SYNTHESIS_PROMPT,
    user: contextParts.join("\n"),
    model: config.synthesisModel,
  });

  return parseProgramBriefResponse(response.content, now, teamProjects);
}

// ── Telegram Format ───────────────────────────────────

/**
 * Format a morning brief for Telegram delivery — concise, information-dense.
 * Scientists checking on their phone need the key takeaway in 10 seconds.
 */
export function formatTelegramBrief(brief: MorningBrief): string {
  const date = new Date(brief.generatedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  const lines: string[] = [`Morning Brief -- ${date}`, ""];

  // Top 3
  lines.push("Top 3:");
  if (brief.topMatters.length === 0) {
    lines.push("  No major changes in the last 24h.");
  } else {
    for (let i = 0; i < brief.topMatters.length; i++) {
      const matter = brief.topMatters[i];
      lines.push(
        `${i + 1}. ${matter.summary} -- ${matter.whyItMatters}`,
      );
    }
  }
  lines.push("");

  // Contradictions
  if (brief.contradictions.length > 0) {
    lines.push(`Contradictions: ${brief.contradictions.length}`);
    lines.push(brief.contradictions[0].implication);
    lines.push("");
  }

  // Frontier
  if (brief.frontier.length > 0) {
    lines.push(`Frontier: ${brief.frontier.length} new`);
    lines.push(
      `${brief.frontier[0].title} -- ${brief.frontier[0].whyItMatters}`,
    );
    lines.push("");
  }

  // Next move
  lines.push(`Next move: ${brief.nextMove.recommendation}`);

  return lines.join("\n");
}

// ── Internal Helpers ──────────────────────────────────

function buildGreeting(now: Date, project?: string): string {
  const hour = now.getHours();
  const timeOfDay =
    hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const projectNote = project ? ` for ${project}` : "";
  return `Good ${timeOfDay}. Here is your research briefing${projectNote}.`;
}

/**
 * Merge frontier items from brain search with items loaded from the watch store.
 * Deduplicates by title (case-insensitive).
 */
function mergeFrontierSources(
  searchResults: SearchResult[],
  watchItems: SearchResult[],
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  // Watch items take priority — they have real scored data
  for (const item of watchItems) {
    const key = item.title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  // Then add search results that aren't already represented
  for (const item of searchResults) {
    const key = item.title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

function scoreFrontierItems(
  frontierResults: SearchResult[],
  projectFilter: string,
): MorningBrief["frontier"] {
  return frontierResults
    .map((item) => {
      const relevanceScore = item.relevance;
      const titleLower = item.title.toLowerCase();

      let threatOrOpportunity: "supports" | "challenges" | "adjacent" | "noise";
      if (
        titleLower.includes("support") ||
        titleLower.includes("confirm") ||
        titleLower.includes("validate")
      ) {
        threatOrOpportunity = "supports";
      } else if (
        titleLower.includes("challenge") ||
        titleLower.includes("contradict") ||
        titleLower.includes("refute")
      ) {
        threatOrOpportunity = "challenges";
      } else if (relevanceScore >= 0.6) {
        threatOrOpportunity = "adjacent";
      } else {
        threatOrOpportunity = "noise";
      }

      return {
        title: item.title,
        source: item.path,
        relevanceScore,
        whyItMatters:
          item.snippet ||
          `Frontier item relevant to ${projectFilter || "your research"}`,
        threatOrOpportunity,
      };
    })
    .filter((item) => item.relevanceScore >= 0.3) // Precision over recall
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 10);
}

function findStaleThreads(
  taskResults: SearchResult[],
  experimentResults: SearchResult[],
  recentEvents: BrainEvent[],
  now: Date,
): MorningBrief["staleThreads"] {
  const staleThresholdMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const recentPaths = new Set<string>();
  for (const event of recentEvents) {
    for (const p of event.created ?? []) recentPaths.add(p);
    for (const p of event.updated ?? []) recentPaths.add(p);
  }

  const stale: MorningBrief["staleThreads"] = [];

  // Check experiments first (higher priority)
  for (const exp of experimentResults) {
    if (recentPaths.has(exp.path)) continue;
    // Assume stale if no recent event touches it
    const daysSince = Math.floor(staleThresholdMs / (24 * 60 * 60 * 1000));
    stale.push({
      name: exp.title,
      lastActivity: new Date(now.getTime() - staleThresholdMs).toISOString().slice(0, 10),
      daysSinceActivity: daysSince,
      suggestedAction: `Review running experiment "${exp.title}" — no recent observations logged.`,
    });
  }

  // Then tasks
  for (const task of taskResults) {
    if (recentPaths.has(task.path)) continue;
    const daysSince = Math.floor(staleThresholdMs / (24 * 60 * 60 * 1000));
    stale.push({
      name: task.title,
      lastActivity: new Date(now.getTime() - staleThresholdMs).toISOString().slice(0, 10),
      daysSinceActivity: daysSince,
      suggestedAction: `Open task "${task.title}" has had no activity — update status or close.`,
    });
  }

  return stale.slice(0, 10);
}

function identifyOpenQuestions(
  hypothesisResults: SearchResult[],
  taskResults: SearchResult[],
  now: Date,
): MorningBrief["openQuestions"] {
  const questions: MorningBrief["openQuestions"] = [];

  for (const h of hypothesisResults) {
    if (
      h.snippet.toLowerCase().includes("active") ||
      h.snippet.toLowerCase().includes("unresolved")
    ) {
      questions.push({
        question: h.title,
        project: extractProjectFromPath(h.path),
        firstAsked: now.toISOString().slice(0, 10),
        daysPending: 0,
      });
    }
  }

  for (const t of taskResults) {
    const title = t.title.toLowerCase();
    if (
      title.includes("?") ||
      title.includes("investigate") ||
      title.includes("evaluate")
    ) {
      questions.push({
        question: t.title,
        project: extractProjectFromPath(t.path),
        firstAsked: now.toISOString().slice(0, 10),
        daysPending: 0,
      });
    }
  }

  return questions.slice(0, 10);
}

function extractProjectFromPath(path: string): string {
  const match = path.match(/wiki\/projects\/([^/]+)/);
  if (match) return match[1].replace(/\.md$/, "");
  return "general";
}

interface SynthesisResult {
  topMatters: MorningBrief["topMatters"];
  nextMove: MorningBrief["nextMove"];
}

function buildSynthesisContext(input: {
  recentEvents: BrainEvent[];
  taskResults: SearchResult[];
  experimentResults: SearchResult[];
  frontierResults: SearchResult[];
  hypothesisResults: SearchResult[];
  observationResults: SearchResult[];
  contradictionReport: ContradictionReport;
  staleThreads: MorningBrief["staleThreads"];
  openQuestions: MorningBrief["openQuestions"];
  frontier: MorningBrief["frontier"];
  projectFilter: string;
}): string {
  const parts: string[] = [];

  if (input.projectFilter) {
    parts.push(`Project focus: ${input.projectFilter}`);
  }

  parts.push(`Recent events (last 24h): ${input.recentEvents.length}`);

  if (input.taskResults.length > 0) {
    parts.push(
      `\nOpen tasks (${input.taskResults.length}):`,
      ...input.taskResults
        .slice(0, 5)
        .map((t) => `- ${t.title} [${t.path}]`),
    );
  }

  if (input.experimentResults.length > 0) {
    parts.push(
      `\nRunning experiments (${input.experimentResults.length}):`,
      ...input.experimentResults
        .slice(0, 5)
        .map((e) => `- ${e.title}: ${e.snippet}`),
    );
  }

  if (input.frontier.length > 0) {
    parts.push(
      `\nFrontier items (${input.frontier.length}):`,
      ...input.frontier
        .slice(0, 5)
        .map(
          (f) =>
            `- ${f.title} [${f.threatOrOpportunity}, relevance=${f.relevanceScore.toFixed(2)}]`,
        ),
    );
  }

  if (input.hypothesisResults.length > 0) {
    parts.push(
      `\nActive hypotheses (${input.hypothesisResults.length}):`,
      ...input.hypothesisResults
        .slice(0, 5)
        .map((h) => `- ${h.title}: ${h.snippet}`),
    );
  }

  if (input.observationResults.length > 0) {
    parts.push(
      `\nRecent observations (${input.observationResults.length}):`,
      ...input.observationResults
        .slice(0, 5)
        .map((o) => `- ${o.title}: ${o.snippet}`),
    );
  }

  if (input.contradictionReport.contradictions.length > 0) {
    parts.push(
      `\nContradictions detected (${input.contradictionReport.contradictions.length}):`,
      ...input.contradictionReport.contradictions.map(
        (c) => `- [${c.severity}] ${c.claim1.text} vs ${c.claim2.text}`,
      ),
    );
  }

  if (input.staleThreads.length > 0) {
    parts.push(
      `\nStale threads (${input.staleThreads.length}):`,
      ...input.staleThreads
        .slice(0, 5)
        .map((s) => `- ${s.name} (${s.daysSinceActivity}d stale)`),
    );
  }

  if (input.openQuestions.length > 0) {
    parts.push(
      `\nOpen questions (${input.openQuestions.length}):`,
      ...input.openQuestions
        .slice(0, 5)
        .map((q) => `- ${q.question} [${q.project}]`),
    );
  }

  return parts.join("\n");
}

function parseSynthesisResponse(content: string): SynthesisResult {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        topMatters: (parsed.topMatters ?? []).map(
          (m: Record<string, unknown>) => ({
            summary: String(m.summary ?? ""),
            whyItMatters: String(m.whyItMatters ?? ""),
            evidence: Array.isArray(m.evidence)
              ? (m.evidence as string[])
              : [],
            urgency: validateUrgency(String(m.urgency ?? "awareness")),
          }),
        ),
        nextMove: {
          recommendation: String(
            parsed.nextMove?.recommendation ?? "Review your current priorities.",
          ),
          reasoning: String(parsed.nextMove?.reasoning ?? ""),
          assumptions: Array.isArray(parsed.nextMove?.assumptions)
            ? parsed.nextMove.assumptions
            : [],
          missingEvidence: Array.isArray(parsed.nextMove?.missingEvidence)
            ? parsed.nextMove.missingEvidence
            : [],
          experiment: parsed.nextMove?.experiment
            ? {
                hypothesis: String(
                  parsed.nextMove.experiment.hypothesis ?? "",
                ),
                method: String(parsed.nextMove.experiment.method ?? ""),
                expectedOutcome: String(
                  parsed.nextMove.experiment.expectedOutcome ?? "",
                ),
              }
            : undefined,
        },
      };
    }
  } catch {
    // Fall through
  }

  return {
    topMatters: [],
    nextMove: {
      recommendation: "Review your current priorities and active experiments.",
      reasoning:
        "Unable to synthesize a specific recommendation from available data.",
      assumptions: ["Brain content is current."],
      missingEvidence: [
        "More structured data would improve recommendation quality.",
      ],
    },
  };
}

function validateUrgency(
  value: string,
): "act-now" | "this-week" | "awareness" {
  if (value === "act-now" || value === "this-week") return value;
  return "awareness";
}

function parseProgramBriefResponse(
  content: string,
  now: Date,
  teamProjects: string[],
): ProgramBrief {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        generatedAt: now.toISOString(),
        programStatus: validateProgramStatus(
          String(parsed.programStatus ?? "on-track"),
        ),
        whatChanged: (parsed.whatChanged ?? []).map(
          (c: Record<string, unknown>) => ({
            project: String(c.project ?? ""),
            change: String(c.change ?? ""),
            impact: validateImpact(String(c.impact ?? "low")),
          }),
        ),
        scientificRisks: (parsed.scientificRisks ?? []).map(
          (r: Record<string, unknown>) => ({
            risk: String(r.risk ?? ""),
            project: String(r.project ?? ""),
            severity: validateSeverity(String(r.severity ?? "medium")),
            competingExplanations: Array.isArray(r.competingExplanations)
              ? (
                  r.competingExplanations as Array<Record<string, unknown>>
                ).map((ce) => ({
                  explanation: String(ce.explanation ?? ""),
                  evidence: Array.isArray(ce.evidence)
                    ? (ce.evidence as string[])
                    : [],
                  confidence: validateConfidence(
                    String(ce.confidence ?? "medium"),
                  ),
                }))
              : undefined,
          }),
        ),
        bestNextExperiment: {
          hypothesis: String(
            parsed.bestNextExperiment?.hypothesis ?? "",
          ),
          method: String(parsed.bestNextExperiment?.method ?? ""),
          expectedOutcome: String(
            parsed.bestNextExperiment?.expectedOutcome ?? "",
          ),
          whyThisOne: String(
            parsed.bestNextExperiment?.whyThisOne ?? "",
          ),
          assumptions: Array.isArray(
            parsed.bestNextExperiment?.assumptions,
          )
            ? parsed.bestNextExperiment.assumptions
            : [],
          discriminates: String(
            parsed.bestNextExperiment?.discriminates ?? "",
          ),
        },
        standupSummary: String(
          parsed.standupSummary ??
            `Program brief for ${teamProjects.join(", ")}`,
        ),
      };
    }
  } catch {
    // Fall through
  }

  return {
    generatedAt: now.toISOString(),
    programStatus: "on-track",
    whatChanged: [],
    scientificRisks: [],
    bestNextExperiment: {
      hypothesis: "",
      method: "",
      expectedOutcome: "",
      whyThisOne: "Insufficient data to recommend an experiment.",
      assumptions: [],
      discriminates: "",
    },
    standupSummary: `Program brief for ${teamProjects.join(", ")} — no significant changes detected.`,
  };
}

function validateProgramStatus(
  value: string,
): ProgramBrief["programStatus"] {
  if (value === "at-risk" || value === "blocked") return value;
  return "on-track";
}

function validateImpact(
  value: string,
): "high" | "medium" | "low" {
  if (value === "high" || value === "medium") return value;
  return "low";
}

function validateSeverity(
  value: string,
): "critical" | "high" | "medium" {
  if (value === "critical" || value === "high") return value;
  return "medium";
}

function validateConfidence(value: string): Confidence {
  if (value === "low" || value === "high") return value;
  return "medium";
}

// ── LLM Prompts ───────────────────────────────────────

const MORNING_BRIEF_SYNTHESIS_PROMPT = `You are a research advisor synthesizing a morning briefing for a scientist.

Given the brain's current state (recent events, tasks, experiments, frontier items, hypotheses, observations, contradictions, stale threads, open questions), produce a structured JSON response.

The scientist should feel:
- "This saved me an hour of doom-scrolling."
- "It understands my current bets."
- "It tells me WHY something matters, not just that it exists."

Output valid JSON with this exact structure:
{
  "topMatters": [
    {
      "summary": "One-line summary of what changed",
      "whyItMatters": "Explain relevance in the scientist's project language — be specific",
      "evidence": ["wiki/path/to/evidence.md"],
      "urgency": "act-now" | "this-week" | "awareness"
    }
  ],
  "nextMove": {
    "recommendation": "The single highest-value next action",
    "reasoning": "Why this is the best use of the scientist's time",
    "assumptions": ["What this recommendation depends on"],
    "missingEvidence": ["What evidence would make this recommendation stronger"],
    "experiment": {
      "hypothesis": "If we do X, then Y",
      "method": "How to test it",
      "expectedOutcome": "What we expect to see"
    }
  }
}

Rules:
- Top matters: max 3, ordered by urgency. Be opinionated — if nothing important happened, say so.
- Next move: ONE recommendation. Be specific. Include the reasoning chain. State assumptions explicitly.
- If an experiment would help, include it. Otherwise omit the experiment field.
- Never be hand-wavy. Every recommendation must state what it depends on and what evidence is missing.
- Use plain language. Avoid jargon unless the input uses it.`;

const PROGRAM_BRIEF_SYNTHESIS_PROMPT = `You are a research program manager synthesizing a team briefing.

Given the state of multiple team projects (tasks, experiments, hypotheses, contradictions), produce a structured JSON response.

Output valid JSON:
{
  "programStatus": "on-track" | "at-risk" | "blocked",
  "whatChanged": [
    { "project": "slug", "change": "what happened", "impact": "high" | "medium" | "low" }
  ],
  "scientificRisks": [
    {
      "risk": "description",
      "project": "slug",
      "severity": "critical" | "high" | "medium",
      "competingExplanations": [
        { "explanation": "...", "evidence": ["..."], "confidence": "low" | "medium" | "high" }
      ]
    }
  ],
  "bestNextExperiment": {
    "hypothesis": "If we do X, then Y",
    "method": "How to test",
    "expectedOutcome": "What to expect",
    "whyThisOne": "Why this over other options",
    "assumptions": ["..."],
    "discriminates": "What competing explanations this resolves"
  },
  "standupSummary": "2-3 sentence summary suitable for a standup meeting"
}

Rules:
- Program status: "blocked" if any critical risk, "at-risk" if high risks, "on-track" otherwise.
- Be honest about what's working and what isn't.
- The bestNextExperiment should discriminate between competing explanations when possible.
- The standup summary should be concise enough to read aloud in 30 seconds.`;
