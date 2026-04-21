/**
 * Research Radar — skill runner shared body
 *
 * Phase C Lane 1 of the gbrain pivot. This module is the shared body
 * that backs both the standalone `scripts/run-research-radar.ts` script
 * and any future in-process invocation. Decision 1A from the spec:
 * long-running skills run as their own node process so a crash cannot
 * take the dashboard down with it. Keeping the body here (and the
 * standalone entry as a thin wrapper) means the test suite can drive
 * the same code path the cron does without spawning a child process.
 *
 * Responsibilities (in order):
 *
 *   1. Resolve the ScienceSwarm user handle via getCurrentUserHandle().
 *      Decision 3A — every brain write needs a real author. We fail
 *      loudly here (synchronously, before any I/O) if the env is unset.
 *   2. Open a gbrain runtime engine bound to <BRAIN_ROOT>/db (PGLite).
 *   3. Hand the existing radar pipeline (src/lib/radar/pipeline.ts) the
 *      brainStore + LLM it expects. The pipeline's internal queries
 *      already route through @/brain/search → @/brain/store → gbrain
 *      thanks to Track C, so we don't re-thread the runtime engine
 *      through it directly. The runtime engine is for the WRITE-BACK.
 *   4. After each radar run, write the briefing back to gbrain via the
 *      runtime engine: putPage for the briefing summary, addTimelineEntry
 *      for each touched concept, addLink for the back-link graph.
 *   5. Drop a `.radar-last-run.json` pointer into the brain root that
 *      /api/brain/status reads on every request. This is the visibility
 *      hook for eng review TODO #2 — without it, a crashed runner is
 *      silent to the dashboard.
 *   6. Dispose the engine in a finally block.
 *
 * Failure semantics:
 *   - Missing SCIENCESWARM_USER_HANDLE → throw (caller exits 1).
 *   - Missing BRAIN_ROOT or empty radar dir → resolve with an empty
 *     summary and STILL write the last-run pointer. Empty is a valid
 *     state and we want the freshness check to see "fresh and empty"
 *     rather than "stale because we returned early".
 *   - LLM transient error (rate limit, timeout, parse) → retry once
 *     with a short backoff; if it still fails, count it in errors_count
 *     and continue.
 *   - gbrain write error on a single concept → record in errors and
 *     continue to the next concept. Never let one bad write stop the
 *     run.
 *   - Engine open or top-level failure → propagate. The standalone
 *     script catches it, logs to stderr, exits 1.
 */

import { dirname as pathDirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { getScienceSwarmBrainRoot, resolveConfiguredPath } from "@/lib/scienceswarm-paths";
import { getActiveRadar } from "@/lib/radar/store";
import { runRadarPipeline } from "@/lib/radar/pipeline";
import { buildProductionFetchers } from "@/lib/radar/fetchers/index";
import type { BrainStore } from "@/brain/store";
import type { Radar, RadarBriefing } from "@/lib/radar/types";

// -----------------------------------------------------------------
// Public types
// -----------------------------------------------------------------

/** Last-run pointer schema. Read by /api/brain/status. */
export interface RadarLastRun {
  /** ISO timestamp of when the runner finished (success or partial). */
  timestamp: string;
  /** How many concepts (radar topics) the run touched in total. */
  concepts_processed: number;
  /** How many concepts errored mid-write. 0 on a clean run. */
  errors_count: number;
  /** Schedule interval the runner was launched against, in ms. */
  schedule_interval_ms: number;
}

export interface SkillRunnerResult {
  /** Number of radars enumerated and processed. */
  radars_processed: number;
  /** Sum of concepts touched across all radars. */
  concepts_processed: number;
  /** Per-error messages (one per failure, deduped by concept slug). */
  errors: string[];
  /** Path the last-run pointer was written to. */
  last_run_path: string;
  /** The pointer payload that was written. */
  last_run: RadarLastRun;
}

/**
 * Minimal structural shape we need from a gbrain runtime engine. We
 * keep this co-located with the runner so a gbrain pin bump that
 * changes the shape goes red here AND in the contract test
 * (tests/integration/gbrain-contract.test.ts), which is exactly the
 * early-warning behaviour we want.
 */
export interface RadarEngineLike {
  connect(config: { engine: "pglite"; database_path: string }): Promise<void>;
  initSchema(): Promise<void>;
  disconnect(): Promise<void>;
  putPage(slug: string, page: {
    type: string;
    title: string;
    compiled_truth: string;
    timeline?: string;
    frontmatter?: Record<string, unknown>;
  }): Promise<{ id: number; slug: string }>;
  addTimelineEntry(slug: string, entry: {
    date: string;
    source?: string;
    summary: string;
    detail?: string;
  }): Promise<void>;
  addLink(
    from: string,
    to: string,
    context?: string,
    linkType?: string,
  ): Promise<void>;
}

/**
 * Adapter contract for everything the runner pulls from outside the
 * module. Production code calls `defaultRunnerEnvironment()`; tests
 * inject fakes so the happy path, the LLM-retry path, and the missing
 * user-handle path can all be exercised without touching disk, the
 * network, or a real PGLite.
 *
 * We keep this seam at the *runner* level (not the pipeline level)
 * because the pipeline already has its own injected `brainStore` /
 * `llm` / `fetchers` parameters. The runner's job is to assemble those
 * and to wire the gbrain write-back, so the seam lives where the
 * assembly happens.
 */
export interface SkillRunnerEnvironment {
  resolveBrainRoot(): string;
  /** Open a gbrain runtime engine bound to the given PGLite path. */
  openEngine(databasePath: string): Promise<RadarEngineLike>;
  /** Resolve the BrainStore the pipeline ranks against. */
  getBrainStore(): Promise<BrainStore>;
  /**
   * Resolve the LLMClient adapter the radar pipeline expects (the one
   * with a `generate(prompt: string)` method, distinct from gbrain's
   * own `complete(LLMCall)` shape).
   */
  getRadarLLM(): Promise<{ generate(prompt: string): Promise<string> }>;
  /** Build the source fetchers map. Tests inject pure mocks. */
  buildFetchers(): ReturnType<typeof buildProductionFetchers>;
  /** Read the radar config from disk. Returns null if no radar configured. */
  loadActiveRadar(stateDir: string): Promise<Radar | null>;
  /** Persist the last-run pointer. */
  writeLastRunPointer(filePath: string, payload: RadarLastRun): Promise<void>;
  /** Wall-clock now. Tests inject a fixed timestamp. */
  now(): Date;
  /**
   * Drive the radar pipeline. Hoisted onto the env seam so tests can
   * stub it without re-implementing the entire fetch+rank+synthesize
   * chain.
   */
  runPipeline: typeof runRadarPipeline;
}

export interface SkillRunnerOptions {
  /** Override the brain root. Defaults to the env-resolved root. */
  brainRoot?: string;
  /** Cron interval, in ms. Defaults from SCIENCESWARM_RADAR_INTERVAL_MINUTES. */
  scheduleIntervalMs?: number;
  /**
   * If true, skip writing the last-run pointer. Used by --dry-run mode
   * so you can exercise the runner without flipping the freshness flag.
   */
  dryRun?: boolean;
  /**
   * Max retries on a single LLM call. Default 1 (one retry, total two
   * attempts). Set to 0 in tests that want to assert on the no-retry
   * path.
   */
  llmRetries?: number;
}

// -----------------------------------------------------------------
// Constants
// -----------------------------------------------------------------

const LAST_RUN_FILENAME = ".radar-last-run.json";
const DEFAULT_SCHEDULE_MINUTES = 30;

// -----------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------

/**
 * Run the research-radar skill once. This is the function the
 * standalone script calls AND the function the tests drive directly.
 *
 * Order of operations is documented in the file header. We do NOT
 * handle the process exit code here — that's the caller's job, so the
 * tests can inspect the result without `process.exit` killing them.
 */
export async function runResearchRadarSkill(
  env: SkillRunnerEnvironment,
  options: SkillRunnerOptions = {},
): Promise<SkillRunnerResult> {
  // Step 1: user attribution — fail loudly BEFORE any I/O.
  // `getCurrentUserHandle` throws if SCIENCESWARM_USER_HANDLE is unset.
  // We don't actually use the handle yet for radar writes (briefings
  // are owned by the user implicitly), but the spec wants every code
  // path that touches the brain to surface the missing-handle error in
  // the same shape, and the test suite asserts on it.
  const userHandle = getCurrentUserHandle();

  const brainRoot = options.brainRoot ?? env.resolveBrainRoot();
  const scheduleIntervalMs =
    options.scheduleIntervalMs ?? resolveScheduleIntervalMs();
  const llmRetries = options.llmRetries ?? 1;

  const databasePath = join(brainRoot, "db");
  const lastRunPath = join(brainRoot, LAST_RUN_FILENAME);

  // Step 2: open the runtime engine. We do this BEFORE checking for a
  // radar config because a top-level engine open failure should bubble
  // up as a fatal error the script can exit 1 on; an empty radar dir
  // is a normal "no work to do" state and should still write a fresh
  // pointer.
  const engine = await env.openEngine(databasePath);

  const errors: string[] = [];
  let conceptsProcessed = 0;
  let radarsProcessed = 0;

  try {
    // connect() and initSchema() live inside the try so a failure in
    // either still routes through the finally{} disconnect path. PGLite
    // file locks survive a partial init; the only safe recovery is to
    // always run disconnect.
    await engine.connect({ engine: "pglite", database_path: databasePath });
    await engine.initSchema();

    // Step 3: enumerate tracked radars. MVP: single radar per user via
    // the existing getActiveRadar helper. When we lift the multi-radar
    // restriction, swap this for a real listAll() and loop the
    // pipeline body below.
    const radar = await env.loadActiveRadar(brainRoot);

    if (radar) {
      radarsProcessed = 1;

      // Step 4: pipeline run. Pulls signals, ranks, synthesizes.
      // Wrap in try so a pipeline-level failure (e.g. all sources
      // unreachable + LLM transient) doesn't take down the run; we
      // record it and still write the freshness pointer.
      try {
        const brainStore = await env.getBrainStore();
        const radarLLM = await env.getRadarLLM();
        const wrappedLLM = wrapLLMWithRetry(radarLLM, llmRetries);

        const result = await env.runPipeline({
          stateDir: brainRoot,
          radarId: radar.id,
          fetchers: env.buildFetchers(),
          brainStore,
          llm: wrappedLLM,
        });

        // Step 5: write back to gbrain.
        if (result) {
          // userHandle is resolved at the top of the runner so the
          // missing-handle failure mode trips before any I/O. We don't
          // thread it into the per-write call because gbrain owns the
          // attribution path inside `putPage` / `addTimelineEntry` —
          // every write inherits the handle from the engine session.
          // The const below is load-bearing: it gives `userHandle` a
          // typed second use so a future refactor that accidentally
          // removes the top-level `getCurrentUserHandle()` call will
          // trigger a TS "cannot find name" error here, rather than
          // silently dropping the fail-loud guard.
          const _ensureHandleResolved: string = userHandle;
          void _ensureHandleResolved;
          const writeOutcome = await writeBriefingToGbrain(
            engine,
            result.briefing,
            radar,
          );
          conceptsProcessed += writeOutcome.conceptsTouched;
          errors.push(...writeOutcome.errors);
        }
      } catch (err) {
        errors.push(`pipeline failed: ${errMessage(err)}`);
      }
    }

    // Step 6: write the last-run pointer (unless dry-run).
    const lastRun: RadarLastRun = {
      timestamp: env.now().toISOString(),
      concepts_processed: conceptsProcessed,
      errors_count: errors.length,
      schedule_interval_ms: scheduleIntervalMs,
    };

    if (!options.dryRun) {
      await env.writeLastRunPointer(lastRunPath, lastRun);
    }

    return {
      radars_processed: radarsProcessed,
      concepts_processed: conceptsProcessed,
      errors,
      last_run_path: lastRunPath,
      last_run: lastRun,
    };
  } finally {
    // Step 7: always release the engine. PGLite's lock semantics can
    // wedge a stale connection across runs if we leak this — and the
    // cron is explicitly designed to be fired-and-forgotten by gbrain's
    // hook layer, so a leak here would compound across runs.
    try {
      await engine.disconnect();
    } catch {
      // Non-fatal: the schema is already on disk and the next run
      // re-opens fresh. We swallow rather than throw so a disconnect
      // failure doesn't mask a successful run.
    }
  }
}

// -----------------------------------------------------------------
// Default environment (production)
// -----------------------------------------------------------------

/**
 * Production-grade `SkillRunnerEnvironment`. Everything that touches
 * the real disk, the real network, or the real PGLite is gathered
 * here so the test suite can stub a single function call.
 */
export async function defaultRunnerEnvironment(): Promise<SkillRunnerEnvironment> {
  // We import the runtime bridge lazily so a test that injects its
  // own environment never pays for the gbrain package load.
  return {
    resolveBrainRoot(): string {
      return (
        resolveConfiguredPath(process.env.BRAIN_ROOT) ??
        getScienceSwarmBrainRoot()
      );
    },
    async openEngine(databasePath: string): Promise<RadarEngineLike> {
      const bridge = (await import("@/brain/stores/gbrain-runtime.mjs")) as {
        createRuntimeEngine(config: {
          engine: "pglite";
          database_path: string;
        }): Promise<RadarEngineLike>;
      };
      return bridge.createRuntimeEngine({
        engine: "pglite",
        database_path: databasePath,
      });
    },
    async getBrainStore(): Promise<BrainStore> {
      const { getBrainStore: getStore, ensureBrainStoreReady } = await import(
        "@/brain/store"
      );
      await ensureBrainStoreReady();
      return getStore();
    },
    async getRadarLLM(): Promise<{ generate(prompt: string): Promise<string> }> {
      const { loadBrainConfig } = await import("@/brain/config");
      const { createLLMClient } = await import("@/brain/llm");
      const config = loadBrainConfig();
      if (!config) {
        throw new Error(
          "BRAIN_ROOT is not configured — research-radar cannot synthesize without an LLM client.",
        );
      }
      const brainLLM = createLLMClient(config);
      // Adapt brain LLMClient.complete() → radar's generate() shape.
      // Same adapter the briefing route uses, kept identical so the
      // two call sites can never drift apart.
      return {
        async generate(prompt: string): Promise<string> {
          const response = await brainLLM.complete({
            system: "You are a research assistant.",
            user: prompt,
          });
          return response.content;
        },
      };
    },
    buildFetchers() {
      return buildProductionFetchers();
    },
    async loadActiveRadar(stateDir: string): Promise<Radar | null> {
      return getActiveRadar(stateDir);
    },
    async writeLastRunPointer(
      filePath: string,
      payload: RadarLastRun,
    ): Promise<void> {
      await mkdir(pathDirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    },
    now() {
      return new Date();
    },
    runPipeline: runRadarPipeline,
  };
}

// -----------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------

/**
 * Wrap the radar LLM with a single-retry policy. Decision: keep the
 * retry tight (one attempt + one retry = max 2 calls per concept)
 * because the radar runs every 30 minutes and a stuck LLM call would
 * eat the entire interval. Production overrides via `llmRetries`.
 *
 * The inner `generate` is responsible for surfacing JSON parse errors
 * itself; we only retry on thrown errors. Parse failures already
 * downgrade gracefully inside `rank.ts` and `synthesize.ts`, so we
 * avoid double-handling them here.
 */
function wrapLLMWithRetry(
  llm: { generate(prompt: string): Promise<string> },
  retries: number,
): { generate(prompt: string): Promise<string> } {
  return {
    async generate(prompt: string): Promise<string> {
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          return await llm.generate(prompt);
        } catch (err) {
          lastError = err;
          if (attempt < retries) {
            // Tiny linear backoff — 200ms times the attempt number.
            // Keeps the worst case under 500ms total for the default
            // single-retry config.
            await sleep(200 * (attempt + 1));
          }
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveScheduleIntervalMs(): number {
  const raw = process.env.SCIENCESWARM_RADAR_INTERVAL_MINUTES;
  if (raw === undefined || raw === "") {
    return DEFAULT_SCHEDULE_MINUTES * 60_000;
  }
  const minutes = Number.parseInt(raw, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    // Surface the bad config: start.sh prints its own warning before the
    // loop, but `npm run radar:run` runs this code path directly with no
    // shell guard above it. Without this stderr line, an operator with
    // a typo'd interval env var would see a schedule mismatch in the
    // dashboard freshness chip and have nothing in the logs to explain
    // it.
    process.stderr.write(
      `research-radar: SCIENCESWARM_RADAR_INTERVAL_MINUTES='${raw}' is not a positive integer; defaulting to ${DEFAULT_SCHEDULE_MINUTES} minutes.\n`,
    );
    return DEFAULT_SCHEDULE_MINUTES * 60_000;
  }
  return minutes * 60_000;
}

interface WriteBackOutcome {
  conceptsTouched: number;
  errors: string[];
}

/**
 * Write the synthesized briefing back into gbrain. For each item in
 * the briefing's matters/horizon, we:
 *
 *   1. putPage a `briefings/<date>-<radar-id>` summary page so the
 *      briefing is searchable as first-class memory.
 *   2. addTimelineEntry to each touched concept slug (derived from the
 *      briefing's matchedTopics field) so the concept page accumulates
 *      a history of radar touches.
 *   3. addLink from briefing → concept with link_type "supports" so
 *      the back-link graph reflects what the briefing was about.
 *
 * Failures inside the loop are recorded but do NOT abort the run:
 * one bad concept write must not invalidate the rest of the briefing.
 */
async function writeBriefingToGbrain(
  engine: RadarEngineLike,
  briefing: RadarBriefing,
  radar: Radar,
): Promise<WriteBackOutcome> {
  const errors: string[] = [];
  let conceptsTouched = 0;

  const date = briefing.generatedAt.slice(0, 10); // YYYY-MM-DD
  const briefingSlug = `briefings/${date}-${radar.id}`;
  const briefingTitle = briefing.nothingToday
    ? `Radar — ${date} (quiet)`
    : `Radar — ${date}`;

  const compiledTruth = renderBriefingMarkdown(briefing);

  try {
    await engine.putPage(briefingSlug, {
      type: "briefing",
      title: briefingTitle,
      compiled_truth: compiledTruth,
      timeline: "",
      frontmatter: {
        radar_id: radar.id,
        generated_at: briefing.generatedAt,
        nothing_today: briefing.nothingToday,
        signals_fetched: briefing.stats.signalsFetched,
        sources_failed: briefing.stats.sourcesFailed,
      },
    });
  } catch (err) {
    errors.push(`putPage(${briefingSlug}) failed: ${errMessage(err)}`);
    // If we can't write the briefing summary itself, the timeline
    // back-links would be orphaned. Bail early on this radar.
    return { conceptsTouched, errors };
  }

  // Collect the unique matched-topic slugs from both matters and horizon.
  // The briefing items already carry matchedTopics (from rank.ts);
  // we lower-case + slugify them to match the concept page convention.
  const touchedTopicSlugs = new Set<string>();
  for (const item of [...briefing.matters, ...briefing.horizon]) {
    for (const topicName of item.signal.matchedTopics) {
      const slug = `concepts/${slugify(topicName)}`;
      touchedTopicSlugs.add(slug);
    }
  }

  for (const conceptSlug of touchedTopicSlugs) {
    try {
      await engine.addTimelineEntry(conceptSlug, {
        date,
        source: "research-radar",
        summary: `Radar briefing on ${date} touched ${conceptSlug.replace("concepts/", "")}`,
        detail: `See ${briefingSlug} for the synthesized "why it matters" notes.`,
      });
      await engine.addLink(briefingSlug, conceptSlug, "radar-touch", "supports");
      conceptsTouched++;
    } catch (err) {
      errors.push(
        `addTimelineEntry/addLink(${conceptSlug}) failed: ${errMessage(err)}`,
      );
    }
  }

  return { conceptsTouched, errors };
}

/**
 * Render a RadarBriefing as a Compiled-Truth markdown body. We keep
 * this intentionally simple — the briefing is itself the source of
 * truth, and the dashboard already has a richer renderer for the
 * dashboard payload. The gbrain page just needs to be searchable and
 * human-readable.
 */
function renderBriefingMarkdown(briefing: RadarBriefing): string {
  const lines: string[] = [];
  lines.push(`# Research Radar — ${briefing.generatedAt.slice(0, 10)}`);
  lines.push("");
  lines.push(
    `Generated at ${briefing.generatedAt}. ${briefing.stats.signalsFetched} signals fetched, ` +
      `${briefing.stats.signalsRanked} ranked, ${briefing.stats.sourcesQueried} sources queried.`,
  );
  if (briefing.stats.sourcesFailed.length > 0) {
    lines.push(`Sources failed: ${briefing.stats.sourcesFailed.join(", ")}.`);
  }
  lines.push("");

  if (briefing.nothingToday) {
    lines.push("Quiet day — nothing in the user's areas worth a flag.");
    return lines.join("\n");
  }

  if (briefing.matters.length > 0) {
    lines.push("## What matters today");
    for (const item of briefing.matters) {
      lines.push(`- **${item.signal.title}** — ${item.whyItMatters}`);
      lines.push(`  ${item.signal.url}`);
    }
    lines.push("");
  }

  if (briefing.horizon.length > 0) {
    lines.push("## On the horizon");
    for (const item of briefing.horizon) {
      lines.push(`- **${item.signal.title}** — ${item.whyItMatters}`);
      lines.push(`  ${item.signal.url}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
