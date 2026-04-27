import { existsSync, readFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import matter from "gray-matter";
import { getMonthCost, getRecentEvents } from "./cost";
import { countPages, isStructuralWikiPage, search } from "./search";
import type {
  BrainConfig,
  BrainEvent,
  GuideBriefing,
  ProjectBrief,
  ProjectManifest,
  RecentChange,
  SearchResult,
} from "./types";
import { readProjectManifest } from "@/lib/state/project-manifests";
import {
  readProjectImportSummary,
  type ProjectImportSummary,
} from "@/lib/state/project-import-summary";
import { isDefaultScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import { refreshProjectWatchFrontier } from "@/lib/watch";
import {
  getProjectBrainRootForBrainRoot,
  getProjectStateRootForBrainRoot,
} from "@/lib/state/project-storage";
import { resolvePgliteDatabasePath } from "@/lib/capture/materialize-memory";
import { createRuntimeEngine } from "./stores/gbrain-runtime.mjs";
import { ensureBrainStoreReady, getActiveBrainRoot, getBrainStore } from "./store";
import { filterProjectPages } from "./project-organizer";

// Re-export research briefing functions for convenience
export {
  buildMorningBrief,
  buildProgramBrief,
  formatTelegramBrief,
} from "./research-briefing";
export type { MorningBriefOptions } from "./research-briefing";
export { scanForContradictions } from "./contradiction-detector";
export type { ContradictionScanScope } from "./contradiction-detector";

interface BriefingPage {
  path: string;
  title: string;
  summary: string;
  content: string;
  status?: string;
}

interface ProjectBriefingInput {
  config: BrainConfig;
  project: string;
}

export interface GuideBriefingResult extends GuideBriefing {
  focus?: string;
  suggestions?: string[];
  readingSuggestions?: SearchResult[];
}

export async function buildProjectBrief(
  input: ProjectBriefingInput,
): Promise<ProjectBrief> {
  const { config, project } = input;
  const generatedAt = new Date().toISOString();
  const manifest = await loadProjectManifest(config, project);
  const importSummary = await loadProjectImportSummary(config, project);

  // Track C.3: connect a per-brief gbrain engine so page reads prefer
  // `engine.getPage(slug)` over the filesystem mirror. Failure returns
  // `null` and the disk fallback in `loadPage` keeps briefs working.
  const engine = await connectBriefingEngine(config.root);

  try {
    const refreshedManifest = await safeRefreshProjectWatchFrontier(config, manifest);

    // Pre-fetch every slug the manifest references so the synchronous
    // assembly below can call `loadPage` without awaiting per-page.
    const manifestSlugs: string[] = [];
    if (refreshedManifest.projectPagePath) {
      manifestSlugs.push(slugFromPagePath(refreshedManifest.projectPagePath));
    }
    for (const p of refreshedManifest.taskPaths) manifestSlugs.push(slugFromPagePath(p));
    for (const p of refreshedManifest.frontierPaths) manifestSlugs.push(slugFromPagePath(p));
    for (const p of refreshedManifest.decisionPaths) manifestSlugs.push(slugFromPagePath(p));
    for (const p of refreshedManifest.artifactPaths) manifestSlugs.push(slugFromPagePath(p));
    const gbrainPages = await prefetchGbrainPages(engine, manifestSlugs);

    const projectPage = refreshedManifest.projectPagePath
      ? loadPage(config, refreshedManifest.projectPagePath, project, gbrainPages)
      : null;
    const taskPages = loadPages(config, refreshedManifest.taskPaths, project, gbrainPages);
    const frontierPages = loadPages(config, refreshedManifest.frontierPaths, project, gbrainPages);
    const decisionPages = loadPages(config, refreshedManifest.decisionPaths, project, gbrainPages);
    const artifactPages = loadPages(config, refreshedManifest.artifactPaths, project, gbrainPages);
    const recentEvents = safeRecentEvents(config);
    const recentProjectPages = await loadRecentProjectPages(
      refreshedManifest.slug,
      refreshedManifest.projectPagePath,
    );
    const evidence = collectEvidence([
      projectPage,
      ...taskPages,
      ...frontierPages,
      ...decisionPages,
      ...artifactPages,
      ...recentProjectPages,
    ]);

    const topMatters = buildTopMatters({
      manifest: refreshedManifest,
      projectPage,
      taskPages,
      decisionPages,
      artifactPages,
      recentProjectPages,
      recentEvents,
      importSummary,
    });
    const unresolvedRisks = buildUnresolvedRisks({
      manifest: refreshedManifest,
      taskPages,
      frontierPages,
      recentProjectPages,
      recentEvents,
      importSummary,
    });
    const dueTasks = taskPages.map((page) => ({
      path: page.path,
      title: page.title,
      status: normalizeTaskStatus(page.status),
    }));
    const frontier = frontierPages.map((page) => ({
      path: page.path,
      title: page.title,
      status: normalizeFrontierStatus(page.status),
      whyItMatters: page.summary || `Linked frontier item for ${refreshedManifest.title}`,
    }));

    const nextMove = buildNextMove({
      manifest: refreshedManifest,
      topMatters,
      dueTasks,
      unresolvedRisks,
      evidence,
      importSummary,
    });

    return {
      project: refreshedManifest.slug,
      generatedAt,
      topMatters,
      unresolvedRisks,
      nextMove,
      dueTasks,
      frontier,
    };
  } catch {
    return buildFallbackProjectBrief({
      manifest,
      importSummary,
      generatedAt,
    });
  } finally {
    if (engine) {
      try {
        await engine.disconnect();
      } catch {
        // Non-fatal — brief already generated.
      }
    }
  }
}

export async function buildGuideBriefing(
  config: BrainConfig,
  focus?: string,
): Promise<GuideBriefingResult> {
  const recentEvents = getRecentEvents(config, undefined, 20);
  const monthCost = getMonthCost(config);
  const experiments = await search(config, {
    query: "status: running",
    mode: "grep",
    limit: 10,
    profile: "synthesis",
  });
  const suggestionsRaw = focus
    ? await search(config, {
        query: focus,
        mode: "grep",
        limit: 5,
        profile: "synthesis",
      })
    : [];
  const suggestions = suggestionsRaw.filter(
    (result) => !isStructuralWikiPage(result.path),
  );
  const pageCount = await countPages(config);
  const [sourceCount, crossReferences] = await Promise.all([
    countSourcePages(config),
    countCrossReferences(config),
  ]);

  return {
    stats: {
      sourceCount,
      pageCount,
      crossReferences,
      monthCostUsd: monthCost,
      monthBudgetUsd: config.paperWatchBudget,
    },
    alerts: buildAlerts(recentEvents, suggestions),
    activeExperiments: experiments.map((e) => ({
      name: e.title,
      status: "running",
      lastObservation: null,
      nextAction: e.snippet || "Review the linked page",
      linkedHypotheses: [],
    })),
    recentChanges: buildRecentChanges(recentEvents),
    readingQueue: suggestions.map((s) => ({
      title: s.title,
      reason: s.snippet,
      reference: s.path,
    })),
    focus,
    suggestions: suggestions.map((s) => s.title),
    readingSuggestions: suggestions.map((s) => ({
      path: s.path,
      title: s.title,
      snippet: s.snippet,
      relevance: s.relevance,
      type: s.type,
    })),
  };
}

async function loadProjectManifest(
  config: BrainConfig,
  project: string,
): Promise<ProjectManifest> {
  if (isDefaultScienceSwarmBrainRoot(config.root)) {
    const canonical = await readProjectManifest(project);
    if (canonical) return canonical;
  }

  const existing = await readProjectManifest(
    project,
    getProjectStateRootForBrainRoot(project, config.root),
  );
  if (existing) return existing;
  const legacyExisting = await readProjectManifest(project, join(config.root, "state"));
  if (legacyExisting) return legacyExisting;

  const inferredTitle = inferProjectTitle(project);
  return {
    version: 1,
    projectId: project,
    slug: project,
    title: inferredTitle,
    privacy: "cloud-ok",
    status: "active",
    projectPagePath: `wiki/projects/${project}.md`,
    sourceRefs: [],
    decisionPaths: [],
    taskPaths: [],
    artifactPaths: [],
    frontierPaths: [],
    activeThreads: [],
    dedupeKeys: [],
    updatedAt: new Date().toISOString(),
  };
}

// ── gbrain engine bridge for briefing reads ─────────────
//
// Track C.3: briefing.ts prefers `engine.getPage(slug)` over the
// filesystem mirror. We keep the disk fallback intact because (a) the
// legacy briefing test suite writes pages directly to disk without
// seeding gbrain, and (b) not every upstream writer (legacy
// scripts/import paths) routes through gbrain yet. When the gbrain row
// is present it wins; when it's missing we fall back to disk so briefs
// still generate during partial migrations.
//
// We keep the shape narrow (only the fields the briefing uses) and
// inline — `tests/integration/gbrain-contract.test.ts` is the canonical
// pin for the runtime contract.

interface BriefingEngineLike {
  disconnect(): Promise<void>;
  getPage(slug: string): Promise<unknown | null>;
}

/**
 * Connect a per-brief gbrain engine. Returns `null` on any failure so
 * `buildProjectBrief` can fall through to the disk-only path — briefs
 * must never fail because gbrain couldn't start.
 */
async function connectBriefingEngine(
  brainRoot: string,
): Promise<BriefingEngineLike | null> {
  const databasePath = resolvePgliteDatabasePath(brainRoot);
  if (!existsSync(databasePath)) {
    return null;
  }

  let processStoreReady = false;
  try {
    await ensureBrainStoreReady();
    processStoreReady = true;
  } catch {
    // Fall through to a per-brief engine below. Briefs should still be able
    // to read from their requested database when the process-level store is
    // temporarily unavailable.
  }

  const activeBrainRoot = getActiveBrainRoot();
  if (processStoreReady && activeBrainRoot && resolve(activeBrainRoot) === resolve(brainRoot)) {
    return {
      async disconnect() {
        // The process-level BrainStore owns this connection.
      },
      async getPage(slug: string) {
        const page = await getBrainStore().getPage(slug);
        if (!page) return null;
        return {
          title: page.title,
          compiled_truth: page.content,
          frontmatter: page.frontmatter,
        };
      },
    };
  }

  try {
    const engine = (await createRuntimeEngine({
      engine: "pglite",
      database_path: databasePath,
    })) as BriefingEngineLike;
    const connectedEngine = engine as BriefingEngineLike & {
      connect(config: { engine: "pglite"; database_path: string }): Promise<void>;
      initSchema(): Promise<void>;
    };
    const startup = (async () => {
      let connected = false;
      try {
        await connectedEngine.connect({ engine: "pglite", database_path: databasePath });
        connected = true;
        await connectedEngine.initSchema();
        return engine;
      } catch (error) {
        if (connected) {
          await engine.disconnect().catch(() => {});
        }
        throw error;
      }
    })();
    try {
      await withBriefingEngineDeadline(startup, 1_000);
      return engine;
    } catch {
      void startup.then(
        (lateEngine) => lateEngine.disconnect().catch(() => {}),
        () => {},
      );
      return null;
    }
  } catch {
    return null;
  }
}

function withBriefingEngineDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("BRIEFING_ENGINE_DEADLINE")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Derive the gbrain slug for a manifest pagePath. All production
 * writers (materializeMemory, task-extractor, importCorpus) use
 * `<basename-without-.md>` as the slug, so briefing reads the same.
 */
function slugFromPagePath(pagePath: string): string {
  return basename(pagePath, ".md");
}

function loadPages(
  config: BrainConfig,
  paths: string[],
  project: string | undefined,
  gbrainPages: Map<string, BriefingPage>,
): BriefingPage[] {
  return paths
    .map((pagePath) => loadPage(config, pagePath, project, gbrainPages))
    .filter((page): page is BriefingPage => page !== null);
}

function loadPage(
  config: BrainConfig,
  pagePath: string,
  project: string | undefined,
  gbrainPages: Map<string, BriefingPage>,
): BriefingPage | null {
  // Prefer gbrain (pre-fetched by the caller). We pre-fetch in
  // `buildProjectBrief` so `loadPage` stays synchronous and the
  // existing ProjectBrief synchronous assembly flow is untouched.
  const slug = slugFromPagePath(pagePath);
  const fromGbrain = gbrainPages.get(slug);
  if (fromGbrain) {
    // Preserve the manifest pagePath on the returned BriefingPage so
    // evidence lists and `dueTasks[].path` keep stable identifiers.
    return { ...fromGbrain, path: pagePath };
  }

  // Disk fallback — legacy writers, scaffolded study pages, and
  // filesystem-seeded tests land here.
  const absPath = project
    ? join(getProjectBrainRootForBrainRoot(project, config.root), pagePath)
    : join(config.root, pagePath);
  const fallbackPath = join(config.root, pagePath);
  const resolvedPath = existsSync(absPath) ? absPath : fallbackPath;
  if (!existsSync(resolvedPath)) return null;

  const content = readFileSync(resolvedPath, "utf-8");
  const parsed = matter(content);
  const title =
    (parsed.data.title as string | undefined) ??
    extractTitle(content) ??
    basename(pagePath, ".md");
  const status = typeof parsed.data.status === "string" ? parsed.data.status : undefined;

  return {
    path: pagePath,
    title,
    summary: buildSummary(parsed.content || content),
    content,
    status,
  };
}

/**
 * Pre-fetch every manifest-referenced page from gbrain in one pass so
 * `loadPage` can stay synchronous. Returns a slug-keyed map; any slug
 * missing from gbrain falls through to the disk path in `loadPage`.
 */
async function prefetchGbrainPages(
  engine: BriefingEngineLike | null,
  slugs: Iterable<string>,
): Promise<Map<string, BriefingPage>> {
  const result = new Map<string, BriefingPage>();
  if (!engine) return result;

  const unique = Array.from(new Set(Array.from(slugs).filter(Boolean)));
  await Promise.all(
    unique.map(async (slug) => {
      try {
        const page = await engine.getPage(slug);
        const converted = convertGbrainPage(page, slug);
        if (converted) result.set(slug, converted);
      } catch {
        // Individual page fetch failures degrade to disk; never fatal.
      }
    }),
  );
  return result;
}

function convertGbrainPage(
  raw: unknown,
  slug: string,
): BriefingPage | null {
  if (!raw || typeof raw !== "object") return null;
  const page = raw as {
    title?: unknown;
    compiled_truth?: unknown;
    frontmatter?: unknown;
  };
  const compiledTruth =
    typeof page.compiled_truth === "string" ? page.compiled_truth : "";
  if (!compiledTruth) return null;

  const frontmatter =
    page.frontmatter && typeof page.frontmatter === "object"
      ? (page.frontmatter as Record<string, unknown>)
      : {};

  const title =
    (typeof page.title === "string" && page.title) ||
    (typeof frontmatter.title === "string" ? (frontmatter.title as string) : "") ||
    extractTitle(compiledTruth) ||
    slug;
  const status =
    typeof frontmatter.status === "string"
      ? (frontmatter.status as string)
      : undefined;

  return {
    // Caller overwrites `path` with the manifest pagePath so evidence
    // keeps its stable identifier — this default is just a fallback.
    path: slug,
    title,
    summary: buildSummary(compiledTruth),
    content: compiledTruth,
    status,
  };
}

function buildTopMatters(input: {
  manifest: ProjectManifest;
  projectPage: BriefingPage | null;
  taskPages: BriefingPage[];
  decisionPages: BriefingPage[];
  artifactPages: BriefingPage[];
  recentProjectPages: BriefingPage[];
  recentEvents: BrainEvent[];
  importSummary: ProjectImportSummary | null;
}): ProjectBrief["topMatters"] {
  const matters: ProjectBrief["topMatters"] = [];
  const pushMatter = (summary: string, evidence: string[]) => {
    const normalizedSummary = summary.trim();
    if (!normalizedSummary) return;
    if (matters.some((item) => item.summary === normalizedSummary)) return;
    matters.push({
      summary: normalizedSummary,
      evidence,
    });
  };
  const latestDecision = [...input.decisionPages].sort((left, right) =>
    right.path.localeCompare(left.path),
  )[0];
  const latestTask = [...input.taskPages].sort((left, right) =>
    right.path.localeCompare(left.path),
  )[0];
  const latestArtifact = [...input.artifactPages].sort((left, right) =>
    right.path.localeCompare(left.path),
  )[0];
  const latestEvent = input.recentEvents[0];
  const latestEventPage = resolveLatestEventPage(input, latestEvent);

  if (latestEventPage) {
    pushMatter(latestEventPage.summary || latestEventPage.title, [latestEventPage.path]);
  }

  if (latestDecision) {
    pushMatter(latestDecision.summary || latestDecision.title, [latestDecision.path]);
  }

  if (latestTask) {
    pushMatter(latestTask.summary || latestTask.title, [latestTask.path]);
  }

  if (latestArtifact) {
    pushMatter(latestArtifact.summary || latestArtifact.title, [latestArtifact.path]);
  }

  if (input.recentProjectPages[0]) {
    pushMatter(
      input.recentProjectPages[0].summary || input.recentProjectPages[0].title,
      [input.recentProjectPages[0].path],
    );
  }

  if (input.importSummary) {
    pushMatter(formatImportSummary(input.importSummary), [
      makeImportSummaryEvidencePath(input.manifest.slug),
    ]);
  }

  if (input.projectPage) {
    pushMatter(
      input.projectPage.summary || `${input.manifest.title} study page`,
      [input.projectPage.path],
    );
  }

  if (latestEvent && !latestEventPage) {
    pushMatter(`Latest event: ${latestEvent.type}`, [
        latestEvent.created?.[0] ?? latestEvent.updated?.[0] ?? input.manifest.projectPagePath,
      ].filter(Boolean) as string[]);
  }

  if (matters.length === 0) {
    pushMatter(
      `Study ${input.manifest.title} is initialized and awaiting linked pages.`,
      [input.manifest.projectPagePath],
    );
  }

  return matters.slice(0, 3);
}

function resolveLatestEventPage(
  input: {
    projectPage: BriefingPage | null;
    taskPages: BriefingPage[];
    decisionPages: BriefingPage[];
    artifactPages: BriefingPage[];
    recentProjectPages: BriefingPage[];
  },
  latestEvent: BrainEvent | undefined,
): BriefingPage | null {
  const eventPath = latestEvent?.created?.[0] ?? latestEvent?.updated?.[0];
  if (!eventPath) return null;

  const pages = [
    input.projectPage,
    ...input.taskPages,
    ...input.decisionPages,
    ...input.artifactPages,
    ...input.recentProjectPages,
  ].filter((page): page is BriefingPage => page !== null);
  const normalizedEventPath = normalizeBriefingPath(eventPath);
  return pages.find((page) => normalizeBriefingPath(page.path) === normalizedEventPath) ?? null;
}

function buildUnresolvedRisks(input: {
  manifest: ProjectManifest;
  taskPages: BriefingPage[];
  frontierPages: BriefingPage[];
  recentProjectPages: BriefingPage[];
  recentEvents: BrainEvent[];
  importSummary: ProjectImportSummary | null;
}): ProjectBrief["unresolvedRisks"] {
  const risks: ProjectBrief["unresolvedRisks"] = [];

  for (const task of input.taskPages.slice(0, 2)) {
    if (normalizeTaskStatus(task.status) === "open") {
      risks.push({
        risk: `Open task: ${task.title}`,
        evidence: [task.path],
      });
    }
  }

  for (const frontier of input.frontierPages.slice(0, 1)) {
    risks.push({
      risk: `Frontier item still staged: ${frontier.title}`,
      evidence: [frontier.path],
    });
  }

  if (risks.length === 0 && input.recentProjectPages[0]) {
    risks.push({
      risk: "Recent study evidence has not yet been turned into an explicit task or decision.",
      evidence: [input.recentProjectPages[0].path],
    });
  }

  if (risks.length === 0 && input.recentEvents[0]) {
    risks.push({
      risk: `Recent activity needs review: ${input.recentEvents[0].type}`,
      evidence: [input.manifest.projectPagePath],
    });
  }

  if (risks.length === 0 && input.importSummary) {
    risks.push({
      risk: `Latest import still needs to become linked tasks or decisions: ${input.importSummary.name}`,
      evidence: [makeImportSummaryEvidencePath(input.manifest.slug)],
    });
  }

  return risks.slice(0, 3);
}

function buildNextMove(input: {
  manifest: ProjectManifest;
  topMatters: ProjectBrief["topMatters"];
  dueTasks: ProjectBrief["dueTasks"];
  unresolvedRisks: ProjectBrief["unresolvedRisks"];
  evidence: string[];
  importSummary: ProjectImportSummary | null;
}): ProjectBrief["nextMove"] {
  const nextTask = input.dueTasks[0];
  const nextMatter =
    input.topMatters.find(
      (matter) => !isGenericProjectMatter(matter.summary, input.manifest.title),
    ) ?? input.topMatters[0];
  const genericMatter =
    nextMatter && isGenericProjectMatter(nextMatter.summary, input.manifest.title);
  const summaryMove = input.importSummary
    ? `Review the latest import summary for ${input.manifest.title} and turn it into the first task or decision.`
    : null;
  const recommendation = nextTask
    ? `Complete ${nextTask.title} next.`
    : summaryMove
      ? summaryMove
      : nextMatter?.summary && !genericMatter
        ? `Review ${input.manifest.title}: ${nextMatter.summary}. Tighten the study direction.`
        : `Import a local archive or add a clear study description for ${input.manifest.title} so the brief can become specific.`;

  return {
    recommendation,
    assumptions: [
      `Study ${input.manifest.title} remains the active focus.`,
      "Linked pages and manifest state are current enough for this brief.",
      ...(input.importSummary ? ["A local import summary exists and can seed the next step."] : []),
    ],
    missingEvidence: input.evidence.length > 0
      ? ["A fresh capture or updated task status would improve confidence."]
      : ["Study-linked evidence is still sparse."],
  };
}

function isGenericProjectMatter(summary: string, projectTitle: string): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[.!?]+$/g, "");
  const normalizedSummary = normalize(summary);
  const normalizedTitle = normalize(projectTitle);
  let withoutTitlePrefix = normalizedSummary;
  const prefixes = [`${normalizedTitle} `, `study ${normalizedTitle} `, `project ${normalizedTitle} `];

  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of prefixes) {
      if (withoutTitlePrefix.startsWith(prefix)) {
        withoutTitlePrefix = withoutTitlePrefix.slice(prefix.length).trim();
        stripped = true;
      }
    }
  }

  if (!normalizedSummary) return true;
  if (withoutTitlePrefix === "new study" || withoutTitlePrefix === "new project") return true;
  if (withoutTitlePrefix === "is initialized and awaiting linked pages") return true;
  return false;
}

function buildFallbackProjectBrief(input: {
  manifest: ProjectManifest;
  importSummary: ProjectImportSummary | null;
  generatedAt: string;
}): ProjectBrief {
  const topMatters: ProjectBrief["topMatters"] = [];
  if (input.importSummary) {
    topMatters.push({
      summary: formatImportSummary(input.importSummary),
      evidence: [makeImportSummaryEvidencePath(input.manifest.slug)],
    });
  }
  topMatters.push({
    summary: `${input.manifest.title} is initialized and awaiting linked pages.`,
    evidence: [input.manifest.projectPagePath],
  });

  const unresolvedRisks: ProjectBrief["unresolvedRisks"] = [];
  if (input.importSummary) {
    unresolvedRisks.push({
      risk: `Latest import still needs tasks or decisions: ${input.importSummary.name}`,
      evidence: [makeImportSummaryEvidencePath(input.manifest.slug)],
    });
  } else {
    unresolvedRisks.push({
      risk: `Study ${input.manifest.title} still needs linked pages or a local import summary.`,
      evidence: [input.manifest.projectPagePath],
    });
  }

  return {
    project: input.manifest.slug,
    generatedAt: input.generatedAt,
    topMatters: topMatters.slice(0, 3),
    unresolvedRisks: unresolvedRisks.slice(0, 3),
    nextMove: {
      recommendation: input.importSummary
        ? `Review the latest import summary for ${input.manifest.title} and create the first linked task or decision.`
        : `Import or link study pages for ${input.manifest.title} so the brief can become more specific.`,
      assumptions: [
        `Study ${input.manifest.title} remains the active focus.`,
        "Only local state was available for this brief.",
      ],
      missingEvidence: input.importSummary
        ? ["A linked task or decision page would turn the summary into structured study memory."]
        : ["A local import summary or linked study pages would improve confidence."],
    },
    dueTasks: [],
    frontier: [],
  };
}

// This is a relative evidence label for the brief, not the on-disk state path.
function makeImportSummaryEvidencePath(project: string): string {
  return join("projects", project, ".brain", "state", "import-summary.json");
}

async function loadProjectImportSummary(
  config: BrainConfig,
  project: string,
): Promise<ProjectImportSummary | null> {
  try {
    if (isDefaultScienceSwarmBrainRoot(config.root)) {
      const canonicalSummaryRecord = await readProjectImportSummary(project);
      if (canonicalSummaryRecord) {
        return canonicalSummaryRecord.lastImport;
      }
    }

    const summaryRecord = await readProjectImportSummary(
      project,
      getProjectStateRootForBrainRoot(project, config.root),
    );
    if (summaryRecord) {
      return summaryRecord.lastImport;
    }
    const legacySummaryRecord = await readProjectImportSummary(project, join(config.root, "state"));
    return legacySummaryRecord?.lastImport ?? null;
  } catch {
    return null;
  }
}

function formatImportSummary(summary: ProjectImportSummary): string {
  const parts = [
    `${summary.name}`,
    `${summary.preparedFiles.toLocaleString("en-US")} files prepared`,
  ];

  if (typeof summary.detectedItems === "number" && summary.detectedItems > summary.preparedFiles) {
    parts.push(`${summary.detectedItems.toLocaleString("en-US")} items detected`);
  }

  if (typeof summary.detectedBytes === "number") {
    parts.push(`local size ${formatBytes(summary.detectedBytes)}`);
  }

  return `Latest import: ${parts.join(" • ")}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

async function safeRefreshProjectWatchFrontier(
  config: BrainConfig,
  manifest: ProjectManifest,
): Promise<ProjectManifest> {
  try {
    return await refreshProjectWatchFrontier(config, manifest);
  } catch {
    return manifest;
  }
}

function safeRecentEvents(config: BrainConfig): BrainEvent[] {
  try {
    return getRecentEvents(config, undefined, 20);
  } catch {
    return [];
  }
}

function buildSummary(content: string): string {
  const preferredContent = extractSection(content, "Summary") ?? content;
  let text = preferredContent
    .replace(/^#+\s*/gm, "")
    .replace(/^\-\s+/gm, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .trim()
    .replace(/\s+/g, " ");
  const title = extractTitle(content)?.replace(/\s+/g, " ").trim();
  if (title) {
    const duplicatedTitlePrefix = `${title} ${title}`;
    if (text.startsWith(duplicatedTitlePrefix)) {
      text = text.slice(title.length + 1).trimStart();
    }
  }
  return text.slice(0, 180) || "Linked page";
}

async function loadRecentProjectPages(
  project: string,
  projectPagePath: string,
): Promise<BriefingPage[]> {
  await ensureBrainStoreReady();
  const store = getBrainStore();
  const excludedProjectPaths = new Set(
    [
      projectPagePath,
      slugFromPagePath(projectPagePath),
      toBrainPageIdentifier(projectPagePath),
    ].filter(Boolean),
  );
  const pages = filterProjectPages(await store.listPages({ limit: 5000 }), project)
    .filter((page) => !excludedProjectPaths.has(page.path))
    .sort((left, right) => {
      const recencyDelta =
        briefingPageRecencyValue(right.frontmatter, right.path)
        - briefingPageRecencyValue(left.frontmatter, left.path);
      if (recencyDelta !== 0) return recencyDelta;
      return right.path.localeCompare(left.path);
    });

  return pages.slice(0, 3).map((page) => ({
    path: page.path,
    title: page.title || extractTitle(page.content) || page.path,
    summary: buildSummary(page.content),
    content: page.content,
    status: typeof page.frontmatter?.status === "string" ? page.frontmatter.status : undefined,
  }));
}

function briefingPageRecencyValue(
  frontmatter: Record<string, unknown> | undefined,
  path: string,
): number {
  const candidates = [
    typeof frontmatter?.compiled_truth_updated_at === "string"
      ? frontmatter.compiled_truth_updated_at
      : null,
    typeof frontmatter?.uploaded_at === "string" ? frontmatter.uploaded_at : null,
    typeof frontmatter?.created_at === "string" ? frontmatter.created_at : null,
    typeof frontmatter?.date === "string" ? frontmatter.date : null,
  ].filter((value): value is string => Boolean(value));

  for (const value of candidates) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  const fromPath = Date.parse(path);
  return Number.isFinite(fromPath) ? fromPath : 0;
}

function toBrainPageIdentifier(pagePath: string): string {
  return `${slugFromPagePath(pagePath)}.md`;
}

function normalizeBriefingPath(path: string): string {
  return basename(path);
}

function extractSection(content: string, heading: string): string | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^##\\s+${escapedHeading}\\s*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
    "m",
  );
  const match = content.match(pattern);
  return match?.[1]?.trim() || null;
}

function extractTitle(content: string): string | null {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1].trim() : null;
}

function inferProjectTitle(project: string): string {
  return project
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeTaskStatus(status?: string): ProjectBrief["dueTasks"][number]["status"] {
  if (status === "scheduled" || status === "done" || status === "dropped") return status;
  return "open";
}

function normalizeFrontierStatus(
  status?: string,
): ProjectBrief["frontier"][number]["status"] {
  if (status === "promoted" || status === "dismissed") return status;
  return "staged";
}

function collectEvidence(pages: Array<BriefingPage | null>): string[] {
  const evidence = new Set<string>();
  for (const page of pages) {
    if (!page) continue;
    evidence.add(page.path);
  }
  return Array.from(evidence);
}

async function countSourcePages(config: BrainConfig): Promise<number> {
  const pages = await search(config, {
    query: "",
    mode: "list",
    limit: 1000,
    profile: "synthesis",
  });
  return pages.length;
}

async function countCrossReferences(config: BrainConfig): Promise<number> {
  const pages = await search(config, {
    query: "",
    mode: "list",
    limit: 1000,
    profile: "synthesis",
  });
  return pages.reduce((acc, page) => acc + countWikiLinks(page.path, config), 0);
}

function countWikiLinks(pagePath: string, config: BrainConfig): number {
  const absPath = join(config.root, pagePath);
  if (!existsSync(absPath)) return 0;
  const content = readFileSync(absPath, "utf-8");
  return (content.match(/\[\[[^\]]+\]\]/g) ?? []).length;
}

function buildRecentChanges(events: BrainEvent[]): RecentChange[] {
  return events.slice(0, 10).map((event) => ({
    date: event.ts.slice(0, 10),
    operation: mapRecentOperation(event.type),
    description: event.contentType ? `${event.type} ${event.contentType}` : event.type,
    page: event.created?.[0] ?? event.updated?.[0] ?? "",
  }));
}

function mapRecentOperation(
  type: BrainEvent["type"],
): RecentChange["operation"] {
  if (type === "ingest" || type === "observe" || type === "ripple" || type === "lint") {
    return type;
  }
  return "lint";
}

function buildAlerts(events: BrainEvent[], suggestions: SearchResult[]): GuideBriefing["alerts"] {
  const alerts: GuideBriefing["alerts"] = [];
  if (events.length === 0) {
    alerts.push({
      severity: "info",
      message: "No recent brain events recorded yet.",
      page: "wiki/home.md",
      action: "Start by importing a project or saving a capture.",
    });
  }
  if (suggestions.length > 0) {
    alerts.push({
      severity: "warning",
      message: `Focus query matched ${suggestions.length} supporting pages.`,
      page: suggestions[0].path,
      action: "Review the most relevant match first.",
    });
  }
  return alerts;
}

// ── Enhanced Study Brief ────────────────────────────

import type { LLMClient } from "./llm";
import type { ContradictionReport } from "./types";
import { scanForContradictions as _scanForContradictions } from "./contradiction-detector";

export interface EnhancedProjectBrief extends ProjectBrief {
  contradictions: ContradictionReport;
  nextExperiment?: {
    hypothesis: string;
    method: string;
    expectedOutcome: string;
    reasoning: string;
  };
}

/**
 * Wraps the existing buildProjectBrief with contradiction detection
 * and next-experiment recommendation.
 */
export async function buildEnhancedProjectBrief(
  input: ProjectBriefingInput & { llm: LLMClient },
): Promise<EnhancedProjectBrief> {
  // Run the base brief and contradiction scan in parallel
  const [baseBrief, contradictions] = await Promise.all([
    buildProjectBrief(input),
    _scanForContradictions(input.config, input.llm, {
      project: input.project,
    }),
  ]);

  // If there are open tasks or unresolved risks, ask LLM for an experiment
  let nextExperiment: EnhancedProjectBrief["nextExperiment"];

  if (baseBrief.unresolvedRisks.length > 0 || baseBrief.dueTasks.length > 0) {
    try {
      const context = [
        `Study: ${baseBrief.project}`,
        `Top matters: ${baseBrief.topMatters.map((m) => m.summary).join("; ")}`,
        `Unresolved risks: ${baseBrief.unresolvedRisks.map((r) => r.risk).join("; ")}`,
        `Open tasks: ${baseBrief.dueTasks.filter((t) => t.status === "open").map((t) => t.title).join("; ")}`,
        contradictions.contradictions.length > 0
          ? `Contradictions: ${contradictions.contradictions.map((c) => c.implication).join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      const response = await input.llm.complete({
        system: `You are a research advisor. Given a project's current state, suggest the single most valuable experiment to run next. Output JSON: { "hypothesis": "...", "method": "...", "expectedOutcome": "...", "reasoning": "..." }`,
        user: context,
        model: input.config.extractionModel,
      });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        nextExperiment = {
          hypothesis: String(parsed.hypothesis ?? ""),
          method: String(parsed.method ?? ""),
          expectedOutcome: String(parsed.expectedOutcome ?? ""),
          reasoning: String(parsed.reasoning ?? ""),
        };
      }
    } catch {
      // Experiment suggestion is best-effort
    }
  }

  return {
    ...baseBrief,
    contradictions,
    nextExperiment,
  };
}
