import type { BrainConfig, Confidence, SourceRef } from "./types";
import type { LLMClient } from "./llm";
import { ensureBrainStoreReady, getBrainStore, type BrainPage } from "./store";
import { filterProjectPages } from "./project-organizer";
import { buildProjectBrief } from "./briefing";
import { displayTitleForBrainPage } from "./page-title";
import { persistGeneratedProjectArtifact } from "@/lib/project-generated-artifact";
import {
  getProjectBrainRootForBrainRoot,
  getProjectStateRootForBrainRoot,
} from "@/lib/state/project-storage";

export interface RankedNextExperiment {
  rank: number;
  title: string;
  whyItMatters: string;
  controls: string[];
  readouts: string[];
  discriminates: string;
  confidence: Confidence;
  turnaround: string;
  dependsOn: string[];
}

export interface NextExperimentPlan {
  summary: string;
  uncertainty: string;
  whatChanged?: string;
  missingInputs: string[];
  evidence: string[];
  recommendations: RankedNextExperiment[];
}

export interface NextExperimentPlannerResult {
  plan: NextExperimentPlan;
  artifactPage: string;
  savePath: string;
  artifactTitle: string;
  responseMarkdown: string;
  provenance: {
    projectPath: string;
    artifactSlug?: string;
    sourceFiles: string[];
    prompt: string;
    tool: string;
    createdAt: string;
  };
}

export async function buildAndPersistNextExperimentPlan(input: {
  config: BrainConfig;
  llm: LLMClient;
  project: string;
  prompt: string;
  previousPlanSlug?: string | null;
  focusBrainSlug?: string | null;
}): Promise<NextExperimentPlannerResult> {
  await ensureBrainStoreReady();
  const store = getBrainStore();
  const [allPages, brief] = await Promise.all([
    store.listPages({ limit: 5000 }),
    buildProjectBrief({ config: input.config, project: input.project }).catch(() => null),
  ]);
  const projectPages = filterProjectPages(allPages, input.project);
  const previousPlan =
    (input.previousPlanSlug
      ? await store.getPage(input.previousPlanSlug).catch(() => null)
      : null) ?? findLatestSavedPlan(projectPages);
  const focusPage = input.focusBrainSlug
    ? await store.getPage(input.focusBrainSlug).catch(() => null)
    : null;

  const plan = await synthesizePlan({
    llm: input.llm,
    prompt: input.prompt,
    project: input.project,
    pages: projectPages,
    brief,
    previousPlan,
    focusPage,
  });
  const finalizedPlan = finalizePlan({
    plan,
    prompt: input.prompt,
    project: input.project,
    pages: projectPages,
    brief,
    previousPlan,
    focusPage,
  });

  const artifactTitle = `${humanizeProject(input.project)} next experiment plan`;
  const markdown = renderPlanMarkdown(finalizedPlan, {
    title: artifactTitle,
    project: input.project,
    briefRecommendation: brief?.nextMove?.recommendation,
  });
  const responseMarkdown = renderPlannerResponse(finalizedPlan, artifactTitle);
  const sourceRefs: SourceRef[] = buildSourceRefs({
    projectPages,
    previousPlan,
    focusPage,
  });

  const persisted = await persistGeneratedProjectArtifact({
    brainRoot: getProjectBrainRootForBrainRoot(input.project, input.config.root),
    stateRoot: getProjectStateRootForBrainRoot(input.project, input.config.root),
    projectSlug: input.project,
    projectTitle: humanizeProject(input.project),
    artifactType: "next-experiment-plan",
    title: artifactTitle,
    content: markdown,
    workspaceFileName: `${input.project}-next-experiment-plan.md`,
    sourceRefs,
    tags: ["next-experiment-plan", "reasoning-api", "lab-planning"],
    prompt: input.prompt,
    tool: "next-experiment-planner",
  });

  return {
    plan: finalizedPlan,
    artifactPage: persisted.artifactPage,
    savePath: persisted.savePath,
    artifactTitle,
    responseMarkdown: `${responseMarkdown}\n\nSaved to \`${persisted.savePath}\` and Brain Artifacts.`,
    provenance: persisted.provenance,
  };
}

async function synthesizePlan(input: {
  llm: LLMClient;
  prompt: string;
  project: string;
  pages: BrainPage[];
  brief: Awaited<ReturnType<typeof buildProjectBrief>> | null;
  previousPlan: BrainPage | null;
  focusPage: BrainPage | null;
}): Promise<NextExperimentPlan> {
  if (input.pages.length === 0) {
    return emptyPlan(input.project);
  }

  const context = buildPlannerContext(input);

  try {
    const response = await input.llm.complete({
      system: NEXT_EXPERIMENT_PLANNER_PROMPT,
      user: context,
    });
    const parsed = parsePlannerResponse(response.content);
    if (parsed.recommendations.length > 0) {
      return parsed;
    }
  } catch {
    // Fall through to the deterministic fallback below.
  }

  return fallbackPlan(input);
}

function buildPlannerContext(input: {
  prompt: string;
  project: string;
  pages: BrainPage[];
  brief: Awaited<ReturnType<typeof buildProjectBrief>> | null;
  previousPlan: BrainPage | null;
  focusPage: BrainPage | null;
}): string {
  const latestEvidencePage = findLatestEvidencePage(
    input.pages,
    input.previousPlan?.path ?? null,
  );
  const pages = rankPages(input.pages, input.prompt, input.focusPage?.path)
    .slice(0, 8)
    .map((page, index) => [
      `Page ${index + 1}: ${pageLabel(page)}`,
      truncate(page.content, 1200),
    ].join("\n"));

  return [
    `Scientist request: ${input.prompt}`,
    `Project: ${input.project}`,
    input.brief
      ? [
          `Current next move: ${input.brief.nextMove.recommendation}`,
          `Top matters: ${input.brief.topMatters.map((item) => item.summary).join("; ") || "none"}`,
          `Unresolved risks: ${input.brief.unresolvedRisks.map((item) => item.risk).join("; ") || "none"}`,
        ].join("\n")
      : "Project brief: unavailable",
    latestEvidencePage
      ? `Latest linked evidence to account for:\n${pageLabel(latestEvidencePage)}\n${truncate(latestEvidencePage.content, 1200)}`
      : "",
    input.focusPage ? `Current focus page: ${pageLabel(input.focusPage)}` : "",
    input.previousPlan
      ? `Previous plan artifact:\n${truncate(input.previousPlan.content, 1200)}`
      : "",
    "Project evidence:",
    ...pages,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function pageLabel(page: BrainPage): string {
  return `${displayTitleForBrainPage({
    title: page.title,
    path: page.path,
    frontmatter: page.frontmatter ?? {},
  })} (${page.type}; ${page.path})`;
}

function rankPages(
  pages: BrainPage[],
  prompt: string,
  focusPath?: string | null,
): BrainPage[] {
  const promptTerms = tokenize(prompt);
  return [...pages].sort((left, right) => {
    const rightScore = scorePage(right, promptTerms, focusPath);
    const leftScore = scorePage(left, promptTerms, focusPath);
    if (rightScore !== leftScore) return rightScore - leftScore;
    const recencyDelta = pageRecencyValue(right) - pageRecencyValue(left);
    if (recencyDelta !== 0) return recencyDelta;
    return left.path.localeCompare(right.path);
  });
}

function scorePage(
  page: BrainPage,
  promptTerms: Set<string>,
  focusPath?: string | null,
): number {
  let score = 0;
  if (focusPath && page.path === focusPath) score += 100;
  const haystack = `${page.title}\n${page.content}`.toLowerCase();
  for (const term of promptTerms) {
    if (haystack.includes(term)) score += 2;
  }
  if (page.type === "experiment" || page.type === "data") score += 3;
  if (page.type === "observation" || page.type === "note") score += 2;
  if (page.type === "paper") score += 1;
  return score;
}

function findLatestEvidencePage(
  pages: BrainPage[],
  previousPlanPath: string | null,
): BrainPage | null {
  return [...pages]
    .filter((page) => page.path !== previousPlanPath && page.type !== "artifact")
    .sort((left, right) => {
      const recencyDelta = pageRecencyValue(right) - pageRecencyValue(left);
      if (recencyDelta !== 0) return recencyDelta;
      return right.path.localeCompare(left.path);
    })[0] ?? null;
}

function pageRecencyValue(page: BrainPage): number {
  const frontmatter = page.frontmatter ?? {};
  const candidates = [
    typeof frontmatter.compiled_truth_updated_at === "string"
      ? frontmatter.compiled_truth_updated_at
      : null,
    typeof frontmatter.uploaded_at === "string" ? frontmatter.uploaded_at : null,
    typeof frontmatter.date === "string" ? frontmatter.date : null,
  ].filter((value): value is string => Boolean(value));

  for (const value of candidates) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  const fromPath = Date.parse(page.path);
  return Number.isFinite(fromPath) ? fromPath : 0;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((part) => part.length >= 4 && !GENERIC_TERMS.has(part)),
  );
}

function parsePlannerResponse(content: string): NextExperimentPlan {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const recommendations = Array.isArray(parsed.recommendations)
        ? parsed.recommendations.map(
            (
              item: Record<string, unknown>,
              index: number,
            ): RankedNextExperiment => ({
              rank: Number(item.rank ?? index + 1) || index + 1,
              title: String(item.title ?? `Recommendation ${index + 1}`),
              whyItMatters: String(item.whyItMatters ?? ""),
              controls: stringArray(item.controls),
              readouts: stringArray(item.readouts),
              discriminates: String(item.discriminates ?? ""),
              confidence: normalizeConfidence(String(item.confidence ?? "medium")),
              turnaround: String(item.turnaround ?? "Not specified"),
              dependsOn: stringArray(item.dependsOn),
            }),
          )
        : [];

      return {
        summary: String(parsed.summary ?? "Generated next-experiment plan."),
        uncertainty: String(
          parsed.uncertainty ?? "Confidence is limited by the currently linked project evidence.",
        ),
        whatChanged:
          typeof parsed.whatChanged === "string" && parsed.whatChanged.trim().length > 0
            ? parsed.whatChanged.trim()
            : undefined,
        missingInputs: stringArray(parsed.missingInputs),
        evidence: stringArray(parsed.evidence),
        recommendations,
      };
    }
  } catch {
    // Fall through to empty fallback.
  }

  return {
    summary: "Generated next-experiment plan.",
    uncertainty: "Confidence is limited by the currently linked project evidence.",
    missingInputs: [],
    evidence: [],
    recommendations: [],
  };
}

function fallbackPlan(input: {
  prompt: string;
  project: string;
  pages: BrainPage[];
  brief: Awaited<ReturnType<typeof buildProjectBrief>> | null;
  previousPlan: BrainPage | null;
  focusPage: BrainPage | null;
}): NextExperimentPlan {
  const corpus = input.pages.map((page) => `${page.title}\n${page.content}`).join("\n\n").toLowerCase();
  const latestEvidencePage = findLatestEvidencePage(
    input.pages,
    input.previousPlan?.path ?? null,
  );
  const recommendations: RankedNextExperiment[] = [];

  if (/(erk|rebound|signaling|pathway)/i.test(corpus)) {
    recommendations.push({
      rank: recommendations.length + 1,
      title: "Run a short signaling rebound time course with orthogonal pathway controls",
      whyItMatters:
        "This directly tests whether the surviving cells regain the pathway activity that the current theory depends on, instead of inferring escape from survival alone.",
      controls: [
        "Untreated cells across the same time points",
        "Single-agent controls for each drug arm",
        "A positive control condition with known pathway reactivation if available",
      ],
      readouts: [
        "Primary pathway phospho-readout over time",
        "Parallel viability or cell-count readout in the same window",
      ],
      discriminates:
        "A clear late rebound supports pathway escape; persistently suppressed signaling weakens that explanation and shifts weight toward a state-change model.",
      confidence: "high",
      turnaround: "Fast, usually within days if the assay already exists",
      dependsOn: ["A validated pathway readout in the current model system"],
    });
  }

  if (/(persister|quies|ki-67|washout|reversible|stress)/i.test(corpus)) {
    recommendations.push({
      rank: recommendations.length + 1,
      title: "Test reversibility after drug washout with low-proliferation state controls",
      whyItMatters:
        "This asks whether the survivors behave like a reversible tolerant state rather than a durable signaling-escape population.",
      controls: [
        "Vehicle control throughout the same interval",
        "Matched survivors kept continuously on drug",
        "A proliferation marker or cell-state control collected alongside the washout readout",
      ],
      readouts: [
        "Outgrowth after washout",
        "Proliferation-state markers in the survivor population",
      ],
      discriminates:
        "Reversible outgrowth with a low-proliferation state favors a persister explanation; failure to recover after washout weakens that interpretation.",
      confidence: "high",
      turnaround: "Fast to medium, usually within one to two experimental cycles",
      dependsOn: ["Enough survivors to follow after washout"],
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      rank: 1,
      title: "Measure the most contested mechanism with a direct time-resolved assay",
      whyItMatters:
        "The current context is too thin for a highly specific recommendation, so the safest next step is the experiment that most directly measures the key disputed mechanism.",
      controls: [
        "Untreated baseline",
        "The strongest available positive or negative control for the disputed mechanism",
      ],
      readouts: ["Primary mechanistic readout", "Functional outcome readout"],
      discriminates:
        "It separates a true mechanistic effect from a downstream correlation or survivor artifact.",
      confidence: "medium",
      turnaround: "Choose the shortest assay already validated in this project",
      dependsOn: ["A directly measurable disputed mechanism"],
    });
  }

  return {
    summary:
      input.brief?.nextMove?.recommendation
      ?? `Generated a ranked next-experiment plan for ${humanizeProject(input.project)} from linked project evidence.`,
    uncertainty:
      "This plan is grounded in the current linked pages, but confidence would improve with a fresh result, explicit controls already run, and any negative findings not yet captured in the project.",
    whatChanged: input.previousPlan
      ? latestEvidencePage
        ? `This update re-ranked the plan against the newly linked evidence in ${pageLabel(latestEvidencePage)} and the prior saved plan.`
        : "This update re-ranked the plan against the latest visible project evidence and the prior saved plan."
      : undefined,
    missingInputs: [
      "Any negative or null follow-up results not yet linked into the project",
      "Which assays are already validated and fastest in the current model system",
    ],
    evidence: rankPages(input.pages, input.prompt, input.focusPage?.path)
      .slice(0, 4)
      .map((page) => pageLabel(page)),
    recommendations,
  };
}

function finalizePlan(input: {
  plan: NextExperimentPlan;
  prompt: string;
  project: string;
  pages: BrainPage[];
  brief: Awaited<ReturnType<typeof buildProjectBrief>> | null;
  previousPlan: BrainPage | null;
  focusPage: BrainPage | null;
}): NextExperimentPlan {
  const latestEvidencePage = findLatestEvidencePage(
    input.pages,
    input.previousPlan?.path ?? null,
  );
  const normalizedRecommendations = rerankRecommendationsAgainstLatestEvidence(
    input.plan.recommendations,
    latestEvidencePage,
    Boolean(input.previousPlan),
  );
  const evidence = buildEvidenceList({
    plan: input.plan,
    pages: input.pages,
    prompt: input.prompt,
    focusPage: input.focusPage,
    latestEvidencePage,
    previousPlan: input.previousPlan,
  });
  const missingInputs =
    input.plan.missingInputs.length > 0
      ? input.plan.missingInputs
      : [
          "Any negative or null follow-up results not yet linked into the project",
          "Which assays are already validated and fastest in the current model system",
        ];
  const whatChanged =
    input.plan.whatChanged?.trim() ||
    buildWhatChangedSummary({
      previousPlan: input.previousPlan,
      latestEvidencePage,
      recommendations: normalizedRecommendations,
    });
  const summary = buildPlanSummary({
    summary: input.plan.summary,
    project: input.project,
    latestEvidencePage,
    topRecommendation: normalizedRecommendations[0],
    previousPlan: input.previousPlan,
    briefRecommendation: input.brief?.nextMove?.recommendation,
  });

  return {
    ...input.plan,
    summary,
    whatChanged,
    evidence,
    missingInputs,
    recommendations: normalizedRecommendations,
  };
}

function findLatestSavedPlan(pages: BrainPage[]): BrainPage | null {
  return [...pages]
    .filter(
      (page) =>
        page.type === "artifact" &&
        String(page.frontmatter?.artifact_type ?? "") === "next-experiment-plan",
    )
    .sort((left, right) => {
      const recencyDelta = pageRecencyValue(right) - pageRecencyValue(left);
      if (recencyDelta !== 0) return recencyDelta;
      return right.path.localeCompare(left.path);
    })[0] ?? null;
}

function rerankRecommendationsAgainstLatestEvidence(
  recommendations: RankedNextExperiment[],
  latestEvidencePage: BrainPage | null,
  isUpdate: boolean,
): RankedNextExperiment[] {
  if (!isUpdate || !latestEvidencePage || recommendations.length < 2) {
    return normalizeRanks(recommendations);
  }

  const evidenceTerms = tokenize(
    `${latestEvidencePage.title}\n${latestEvidencePage.content}`,
  );
  const rescored = recommendations
    .map((recommendation, index) => {
      const recommendationTerms = tokenize(
        [
          recommendation.title,
          recommendation.whyItMatters,
          recommendation.discriminates,
          recommendation.controls.join(" "),
          recommendation.readouts.join(" "),
          recommendation.dependsOn.join(" "),
        ].join("\n"),
      );
      let overlap = 0;
      for (const term of recommendationTerms) {
        if (evidenceTerms.has(term)) overlap += 1;
      }
      return {
        recommendation,
        score: overlap * 6 + Math.max(0, recommendations.length - index),
      };
    })
    .sort((left, right) => right.score - left.score);

  return normalizeRanks(rescored.map((item) => item.recommendation));
}

function normalizeRanks(
  recommendations: RankedNextExperiment[],
): RankedNextExperiment[] {
  return recommendations.map((recommendation, index) => ({
    ...recommendation,
    rank: index + 1,
  }));
}

function buildEvidenceList(input: {
  plan: NextExperimentPlan;
  pages: BrainPage[];
  prompt: string;
  focusPage: BrainPage | null;
  latestEvidencePage: BrainPage | null;
  previousPlan: BrainPage | null;
}): string[] {
  const entries = new Set<string>();
  for (const evidence of input.plan.evidence) {
    if (evidence.trim()) entries.add(evidence.trim());
  }
  if (input.latestEvidencePage) {
    entries.add(pageLabel(input.latestEvidencePage));
  }
  if (input.previousPlan) {
    entries.add(pageLabel(input.previousPlan));
  }
  for (const page of rankPages(
    input.pages,
    input.prompt,
    input.focusPage?.path,
  ).slice(0, 3)) {
    entries.add(pageLabel(page));
  }
  return [...entries].slice(0, 6);
}

function buildWhatChangedSummary(input: {
  previousPlan: BrainPage | null;
  latestEvidencePage: BrainPage | null;
  recommendations: RankedNextExperiment[];
}): string | undefined {
  if (!input.previousPlan) return undefined;

  const previousTitles = extractRankedExperimentTitles(input.previousPlan.content);
  const currentTop = input.recommendations[0]?.title;
  const previousTop = previousTitles[0];
  const evidenceLabel = input.latestEvidencePage
    ? displayTitleForBrainPage({
        title: input.latestEvidencePage.title,
        path: input.latestEvidencePage.path,
        frontmatter: input.latestEvidencePage.frontmatter ?? {},
      })
    : "the latest linked evidence";

  if (currentTop && previousTop && currentTop !== previousTop) {
    return `The newest linked result in ${evidenceLabel} changed the top-ranked experiment from "${previousTop}" to "${currentTop}" because it better matches the latest observed behavior.`;
  }

  return `This update re-checked the prior saved plan against ${evidenceLabel} and refreshed the ranking, controls, and decision value using the newest visible evidence.`;
}

function extractRankedExperimentTitles(content: string): string[] {
  const matches = content.matchAll(/^###\s+\d+\.\s+(.+)$/gm);
  const titles: string[] = [];
  for (const match of matches) {
    const title = match[1]?.trim();
    if (title) titles.push(title);
  }
  return titles;
}

function buildPlanSummary(input: {
  summary: string;
  project: string;
  latestEvidencePage: BrainPage | null;
  topRecommendation?: RankedNextExperiment;
  previousPlan: BrainPage | null;
  briefRecommendation?: string;
}): string {
  const trimmed = input.summary.trim();
  if (
    trimmed &&
    !/^review the latest import summary/i.test(trimmed) &&
    trimmed.length >= 80
  ) {
    return trimmed;
  }

  const evidenceLead = input.latestEvidencePage
    ? summarizeEvidenceLead(input.latestEvidencePage)
    : `ScienceSwarm is using the currently linked evidence for ${humanizeProject(input.project)}.`;
  const recommendationLead = input.topRecommendation
    ? `The highest-value next step is ${input.topRecommendation.title.toLowerCase()} because it most directly reduces the current decision uncertainty.`
    : "";
  const updateLead = input.previousPlan
    ? "This is an updated plan rather than a fresh first pass."
    : "";

  return [evidenceLead, recommendationLead, updateLead, input.briefRecommendation]
    .filter(Boolean)
    .join(" ");
}

function summarizeEvidenceLead(page: BrainPage): string {
  const raw = page.content
    .replace(/^#.*$/gm, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence =
    raw.match(/[^.!?]+[.!?]/)?.[0]?.trim() || raw.slice(0, 220).trim();
  const label = displayTitleForBrainPage({
    title: page.title,
    path: page.path,
    frontmatter: page.frontmatter ?? {},
  });
  return `${label} is the latest linked evidence: ${sentence}`;
}

function emptyPlan(project: string): NextExperimentPlan {
  return {
    summary: `ScienceSwarm does not have enough linked evidence yet to rank next experiments for ${humanizeProject(project)}.`,
    uncertainty:
      "Any recommendation would be mostly guesswork until the workspace has a project description plus at least one result or literature note.",
    missingInputs: [
      "A short project summary with the leading competing explanations",
      "At least one recent result or notebook summary",
    ],
    evidence: [],
    recommendations: [
      {
        rank: 1,
        title: "Capture the current working theory and most recent result first",
        whyItMatters:
          "That creates the minimum context needed for a trustworthy ranked plan instead of a generic experiment list.",
        controls: ["State which comparison or control is currently missing"],
        readouts: ["The key readout that would change the team’s decision"],
        discriminates:
          "It turns an underspecified project into one where competing explanations can be ranked honestly.",
        confidence: "low",
        turnaround: "Immediate",
        dependsOn: ["A visible project summary and recent evidence"],
      },
    ],
  };
}

function renderPlanMarkdown(
  plan: NextExperimentPlan,
  input: {
    title: string;
    project: string;
    briefRecommendation?: string;
  },
): string {
  const lines = [
    `# ${input.title}`,
    "",
    "## Summary",
    plan.summary,
    "",
    "## Ranked Experiments",
  ];

  for (const recommendation of plan.recommendations) {
    lines.push(
      "",
      `### ${recommendation.rank}. ${recommendation.title}`,
      `- Why it matters: ${recommendation.whyItMatters}`,
      `- Controls: ${recommendation.controls.join("; ") || "Not specified"}`,
      `- Readouts: ${recommendation.readouts.join("; ") || "Not specified"}`,
      `- Discriminates: ${recommendation.discriminates}`,
      `- Confidence: ${recommendation.confidence}`,
      `- Turnaround: ${recommendation.turnaround}`,
    );
    if (recommendation.dependsOn.length > 0) {
      lines.push(`- Depends on: ${recommendation.dependsOn.join("; ")}`);
    }
  }

  lines.push("", "## Uncertainty", plan.uncertainty);

  if (plan.whatChanged) {
    lines.push("", "## What Changed", plan.whatChanged);
  }

  if (plan.missingInputs.length > 0) {
    lines.push("", "## Missing Inputs", ...plan.missingInputs.map((item) => `- ${item}`));
  }

  if (plan.evidence.length > 0) {
    lines.push("", "## Evidence Used", ...plan.evidence.map((item) => `- ${item}`));
  }

  if (input.briefRecommendation) {
    lines.push("", "## Prior Project Brief Next Move", input.briefRecommendation);
  }

  return `${lines.join("\n")}\n`;
}

function renderPlannerResponse(plan: NextExperimentPlan, title: string): string {
  const lines = [`**${title}**`, "", plan.summary, ""];
  for (const recommendation of plan.recommendations.slice(0, 3)) {
    lines.push(
      `${recommendation.rank}. ${recommendation.title}`,
      `Why it matters: ${recommendation.whyItMatters}`,
      `Controls: ${recommendation.controls.join("; ") || "Not specified"}`,
      `Readouts: ${recommendation.readouts.join("; ") || "Not specified"}`,
      `Decision value: ${recommendation.discriminates}`,
      "",
    );
  }
  lines.push(`Uncertainty: ${plan.uncertainty}`);
  if (plan.whatChanged) {
    lines.push(`What changed: ${plan.whatChanged}`);
  }
  if (plan.missingInputs.length > 0) {
    lines.push(`Most valuable missing input: ${plan.missingInputs[0]}`);
  }
  return lines.join("\n");
}

function buildSourceRefs(input: {
  projectPages: BrainPage[];
  previousPlan: BrainPage | null;
  focusPage: BrainPage | null;
}): SourceRef[] {
  const latestEvidencePage = findLatestEvidencePage(
    input.projectPages,
    input.previousPlan?.path ?? null,
  );
  const refs = new Map<string, SourceRef>();
  const pushRef = (ref: SourceRef) => {
    refs.set(`${ref.kind}:${ref.ref}`, ref);
  };

  for (const page of rankPages(
    input.projectPages,
    "",
    input.focusPage?.path,
  ).slice(0, 5)) {
    pushRef({ kind: "artifact", ref: page.path });
  }
  if (input.previousPlan) {
    pushRef({ kind: "artifact", ref: input.previousPlan.path });
  }
  if (input.focusPage) {
    pushRef({ kind: "artifact", ref: input.focusPage.path });
  }
  if (latestEvidencePage) {
    pushRef({ kind: "artifact", ref: latestEvidencePage.path });
  }

  return [...refs.values()];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeConfidence(value: string): Confidence {
  if (value === "low" || value === "high") return value;
  return "medium";
}

function humanizeProject(project: string): string {
  return project
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\n{3,}/g, "\n\n");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}\n...`;
}

const NEXT_EXPERIMENT_PLANNER_PROMPT = `You are ScienceSwarm's next-experiment planner for laboratory scientists.

Given project evidence, rank up to 4 follow-up experiments that most reduce uncertainty.

Return valid JSON with this exact shape:
{
  "summary": "One-paragraph summary of the current decision point",
  "uncertainty": "What remains uncertain and why",
  "whatChanged": "How the ranking changed relative to the previous plan, or omit if no previous plan exists",
  "missingInputs": ["Most valuable missing context"],
  "evidence": ["Short plain-language clues that drove the ranking"],
  "recommendations": [
    {
      "rank": 1,
      "title": "Short experiment name",
      "whyItMatters": "Why this ranks here",
      "controls": ["Controls the scientist would need"],
      "readouts": ["Expected readouts"],
      "discriminates": "Which competing explanations this separates",
      "confidence": "low|medium|high",
      "turnaround": "Expected speed or effort",
      "dependsOn": ["Critical assumptions or prerequisites"]
    }
  ]
}

Rules:
- Recommendations must be ranked, not unordered.
- Every recommendation must say what it discriminates, not just what to do.
- Include honest uncertainty and missing inputs instead of pretending the context is complete.
- Do not suggest an expensive omnibus assay as rank 1 if a faster discriminating experiment would answer the decision sooner.
- Prefer direct, concrete laboratory language over abstract review prose.`;

const GENERIC_TERMS = new Set([
  "about",
  "across",
  "after",
  "because",
  "before",
  "between",
  "could",
  "current",
  "decision",
  "evidence",
  "experiment",
  "experiments",
  "input",
  "latest",
  "linked",
  "matters",
  "might",
  "project",
  "result",
  "results",
  "should",
  "their",
  "these",
  "using",
  "visible",
  "which",
]);
