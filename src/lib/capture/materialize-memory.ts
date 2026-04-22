/**
 * materializeMemory — gbrain writer (Phase B Track A).
 *
 * Phase B Track A of the ScienceSwarm -> gbrain pivot. This module replaces
 * the previous filesystem markdown writer with calls into gbrain's runtime
 * engine. The filing rules from PR #235 (inline `[Source: ...]` citations,
 * idempotent project Timeline back-link, ensure-project-on-first-touch,
 * privacy-aware project seeding) are preserved verbatim — we are swapping
 * the *writer*, not the rules.
 *
 * Why a rewrite, not a wrapper:
 *   * Under decision 2B (atomic intent for Phase B), the ScienceSwarm tree
 *     no longer maintains its own markdown taxonomy. Pages live inside
 *     gbrain's PGLite + chunk store, addressed by slug.
 *   * Under decision 1A (in-process runtime bridge for hot paths), the
 *     dashboard hot path uses `createRuntimeEngine` from
 *     `src/brain/stores/gbrain-runtime.mjs` instead of spawning a CLI.
 *   * Under decision 3A (`getCurrentUserHandle()` everywhere) the captured
 *     `[Source: ...]` line now carries the local ScienceSwarm handle
 *     alongside the external channel + user id, so writes have a real
 *     author identity from day one.
 *
 * Return shape:
 *   For backwards compatibility with callers that already use
 *   `materializedPath` as a stable identifier (audit log, persisted raw
 *   capture, dashboard reply text, telegram reply text, task-extractor
 *   `sourceCapture` ref, regex assertions in integration tests), we still
 *   return a `wiki/<kind-dir>/<slug>.md` path. Under Track A the
 *   captured page also lives on disk at that path as a mirror of the
 *   gbrain row — see "Disk back-compat mirror" below for why.
 *
 * Disk back-compat mirror (transitional, removed in Track C):
 *   gbrain is the new source of truth for captured pages. Track A
 *   completes the *write-side* swap: every captured page now goes
 *   through `engine.putPage` and is queryable via
 *   `engine.getPage(slug)`. But several read-side consumers still walk
 *   the disk filesystem to render briefings, build the dashboard, and
 *   power tests:
 *     - `src/brain/briefing.ts` reads `wiki/tasks/<slug>.md` etc.
 *       through the project manifest's `taskPaths` to compute
 *       `dueTasks`.
 *     - `src/brain/coldstart.ts` and various dashboard helpers walk
 *       `wiki/` directly.
 *     - Integration tests
 *       (`tests/lib/capture-service.test.ts`, etc.) historically read
 *       the markdown body off disk — they have been migrated in this
 *       PR to use `engine.getPage`, but third-party callers in
 *       `src/brain/*` and `src/lib/radar/*` still read disk.
 *   Migrating every consumer to gbrain is Track C's scope. To keep
 *   Track A landable in isolation, we mirror the captured page to
 *   disk *as well as* into gbrain. The disk file is byte-identical to
 *   the gbrain `compiled_truth` (with frontmatter wrapped via
 *   `matter.stringify`), so consumers that switch to gbrain mid-flight
 *   see the same content. Track C deletes this mirror block when
 *   briefing + dashboard read through gbrain.
 *
 * Engine lifecycle:
 *   * Production writes use the shared in-process BrainStore PGLite engine.
 *     Opening a second file-backed PGLite engine from the dashboard process
 *     can block on `.gbrain-lock` while read routes keep the shared connection
 *     alive, so capture materialization must share that connection.
 *   * Tests can still pass `engine` directly via the optional input field. The
 *     wider integration tests let production mode resolve the same shared
 *     BrainStore singleton as user-facing routes.
 *
 * What this module no longer does:
 *   * Writes markdown files to disk (gbrain owns persistence).
 *   * Calls `writeFileAtomic` / `appendProjectTimelineEntry` (deleted).
 *   * Calls `getBrainStore().importCorpus(...)` for indexing — gbrain
 *     puts the chunks in place inside `putPage`.
 *   * Reads `wiki/projects/<slug>.md` to mutate the project page in
 *     place. `engine.addTimelineEntry` is idempotent-by-date per the
 *     gbrain contract test, so the race condition PR #235 papered over
 *     with try/catch disappears entirely.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import {
  ensureBrainStoreReady,
  getBrainStore,
  resolveBrainStorePglitePath,
} from "@/brain/store";
import { logEvent } from "@/brain/cost";
import type { GbrainEngineAdapter } from "@/brain/stores/gbrain-engine-adapter";
import { createRuntimeEngine } from "@/brain/stores/gbrain-runtime.mjs";
import type {
  BrainConfig,
  CaptureKind,
  ContentType,
  PrivacyMode,
  ProjectManifest,
  SourceRef,
} from "@/brain/types";
import { enqueueGbrainWrite } from "@/lib/gbrain/write-queue";
import { buildSourceRefCitationLines } from "@/lib/capture/source-ref-lines";
import { assertSafeProjectSlug, updateProjectManifest } from "@/lib/state/project-manifests";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import type { PersistedRawCapture } from "./persist-raw";
import type { MaterializedCapture } from "./types";

// ── Page-type taxonomy ────────────────────────────────
//
// Pre-pivot we mapped capture kinds onto ScienceSwarm-flavored markdown
// directories (`wiki/decisions/`, `wiki/tasks/`, …). gbrain's MECE schema
// does not preserve those exact dirs, but we still need:
//   1. A *page type* string to put on the gbrain page row, so search and
//      briefings can filter by kind.
//   2. A pseudo-path the legacy callers can use as an identifier
//      (regex-matched in integration tests like
//      `expect(materializedPath).toMatch(/^wiki\/tasks\//)`).
// We keep the same mapping here so the wire-format string still looks
// `wiki/<kind-dir>/<slug>.md`, even though no file is written.

const KIND_DIRECTORY: Record<CaptureKind, string> = {
  note: "wiki/resources",
  observation: "wiki/observations",
  decision: "wiki/decisions",
  hypothesis: "wiki/hypotheses",
  task: "wiki/tasks",
  survey: "wiki/surveys",
  method: "wiki/methods",
  original_synthesis: "wiki/originals",
  research_packet: "wiki/packets",
  overnight_journal: "wiki/journals",
};

const KIND_HEADING: Record<CaptureKind, string> = {
  note: "Note",
  observation: "Observation",
  decision: "Decision",
  hypothesis: "Hypothesis",
  task: "Task",
  survey: "Survey",
  method: "Method",
  original_synthesis: "Original synthesis",
  research_packet: "Research packet",
  overnight_journal: "Overnight journal",
};

// gbrain's `Page.type` is a free-form string. We use the capture kind
// verbatim so a future migration from `note`-style strings to MECE
// directories (papers/, experiments/, …) is a search-and-replace, not a
// data shape change.
const KIND_PAGE_TYPE: Record<CaptureKind, ContentType> = {
  note: "note",
  observation: "observation",
  decision: "decision",
  hypothesis: "hypothesis",
  task: "task",
  survey: "survey",
  method: "method",
  original_synthesis: "original_synthesis",
  research_packet: "research_packet",
  overnight_journal: "overnight_journal",
};

function isArtifactCaptureKind(kind: CaptureKind): boolean {
  return kind === "research_packet" || kind === "overnight_journal";
}

// Minimal structural shape of the gbrain BrainEngine surface we use here.
// We re-declare it inline rather than importing from gbrain so that drift
// in gbrain's exported types does not silently change ScienceSwarm's
// expectations — the contract test in
// `tests/integration/gbrain-contract.test.ts` is the canonical pin.
export interface MaterializeEngine {
  connect(config: { engine: "pglite"; database_path?: string }): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: MaterializeEngine) => Promise<T>): Promise<T>;
  putPage(
    slug: string,
    page: {
      type: string;
      title: string;
      compiled_truth: string;
      timeline?: string;
      frontmatter?: Record<string, unknown>;
      content_hash?: string;
    },
  ): Promise<{ id: number; slug: string }>;
  getPage(slug: string): Promise<unknown | null>;
  addTimelineEntry(
    slug: string,
    entry: { date: string; source?: string; summary: string; detail?: string },
  ): Promise<void>;
  getTimeline(
    slug: string,
    opts?: { limit?: number },
  ): Promise<Array<{ date: string | Date; source: string; summary: string; detail: string }>>;
  addLink(
    from: string,
    to: string,
    context?: string,
    linkType?: string,
  ): Promise<void>;
}

interface MaterializeInput {
  brainRoot: string;
  capture: PersistedRawCapture;
  project: string | null;
  confidence: "low" | "medium" | "high";
  /**
   * Optional pre-connected engine. Tests inject an in-memory PGLite
   * engine here; production callers omit this and let `materializeMemory`
   * use the shared BrainStore engine.
   *
   * Lifecycle always stays with the caller or shared BrainStore.
   */
  engine?: MaterializeEngine;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "capture";
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTitle(kind: CaptureKind, content: string): string {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return `${KIND_HEADING[kind]} capture`;
  }

  return truncateAtWord(firstLine, 80);
}

// Truncate to <= maxChars at the last word boundary. No trailing ellipsis —
// the date prefix and capture-id suffix on the slug already disambiguate,
// and a literal "..." baked into the page title is ugly in briefings forever.
function truncateAtWord(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const slice = value.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  return lastSpace > maxChars / 2 ? slice.slice(0, lastSpace).trimEnd() : slice;
}

function buildFrontmatter(
  input: MaterializeInput,
  title: string,
  sourceRef: SourceRef,
): Record<string, unknown> {
  const createdAt = new Date(input.capture.createdAt);
  const status =
    input.capture.kind === "task"
      ? "open"
      : undefined;

  const frontmatter = {
    title,
    date: formatDate(createdAt),
    type: input.capture.kind,
    para: input.project ? "projects" : "resources",
    tags: [],
    project: input.project ?? undefined,
    source_refs: [sourceRef, ...input.capture.sourceRefs],
    confidence: input.confidence,
    privacy: input.capture.privacy,
    status,
  };

  return Object.fromEntries(
    Object.entries(frontmatter).filter(([, value]) => value !== undefined),
  );
}

/**
 * Build the inline `[Source: ...]` citation lines. PR #235 introduced
 * the three-citation pattern (user attribution, external refs,
 * synthesis fallback). Track A keeps that pattern but threads the local
 * ScienceSwarm handle (`getCurrentUserHandle()`) into the user line so
 * every write carries a real author identity — the multi-user-per-brain
 * pressure point from the spec.
 *
 * Format change vs PR #235:
 *
 *   PR #235:  `[Source: User via telegram, user-42, 2026-04-13]`
 *   Track A:  `[Source: @alice via telegram:user-42, 2026-04-13]`
 *
 * `@handle` is the canonical identity; `channel:user-id` is the
 * external locator (so we can still trace which Telegram account
 * captured the message). Decision 3A: if `SCIENCESWARM_USER_HANDLE` is
 * unset, `getCurrentUserHandle()` throws and the whole capture fails
 * loudly — we never default to "User".
 */
function buildCitations(capture: PersistedRawCapture): string[] {
  const handle = getCurrentUserHandle();
  const citations: string[] = [];
  const date = formatDate(new Date(capture.createdAt));

  citations.push(
    `[Source: ${handle} via ${capture.channel}:${capture.userId}, ${date}]`,
  );

  // Any external source refs (papers, URLs, datasets) get their own
  // citation line so each fact can be traced back to its origin
  // independent of the user attribution above.
  citations.push(...buildSourceRefCitationLines(capture.sourceRefs));

  // Synthesis fallback: always emit a compiled-from line keyed to the
  // capture id so even notes with no external refs are grep-able back to
  // the raw capture record on disk.
  citations.push(`[Source: compiled from capture ${capture.captureId}]`);

  return citations;
}

function manifestUpdater(
  capture: PersistedRawCapture,
  project: string,
  materializedPath: string,
  sourceRef: SourceRef,
): (current: ProjectManifest | null) => ProjectManifest {
  return (current) => {
    const now = new Date().toISOString();
    const manifest = current ?? {
      version: 1 as const,
      projectId: project,
      slug: project,
      title: project.replace(/-/g, " "),
      privacy: capture.privacy,
      status: "active" as const,
      projectPagePath: `wiki/projects/${project}.md`,
      sourceRefs: [],
      decisionPaths: [],
      taskPaths: [],
      artifactPaths: [],
      frontierPaths: [],
      activeThreads: [],
      dedupeKeys: [],
      updatedAt: now,
    };

    const threadId = `${capture.channel}:${capture.userId}`;
    const activeThreads = manifest.activeThreads.filter(
      (thread) => !(thread.channel === capture.channel && thread.threadId === threadId),
    );
    activeThreads.push({
      channel: capture.channel,
      threadId,
      lastCaptureId: capture.captureId,
      lastActivityAt: now,
    });

    const sourceRefs = dedupeSourceRefs([...manifest.sourceRefs, sourceRef, ...capture.sourceRefs]);

    return {
      ...manifest,
      privacy: mergePrivacy(manifest.privacy, capture.privacy),
      sourceRefs,
      decisionPaths:
        capture.kind === "decision"
          ? dedupePaths([...manifest.decisionPaths, materializedPath])
          : manifest.decisionPaths,
      taskPaths:
        capture.kind === "task"
          ? dedupePaths([...manifest.taskPaths, materializedPath])
          : manifest.taskPaths,
      artifactPaths:
        isArtifactCaptureKind(capture.kind)
          ? dedupePaths([...manifest.artifactPaths, materializedPath])
          : manifest.artifactPaths,
      activeThreads,
      updatedAt: now,
    };
  };
}

function logCaptureIngestEvent(input: {
  brainRoot: string;
  createdAt: string;
  kind: CaptureKind;
  pageSlug: string;
}): void {
  logEvent(
    { root: input.brainRoot } as BrainConfig,
    {
      ts: input.createdAt,
      type: "ingest",
      contentType: KIND_PAGE_TYPE[input.kind],
      created: [`${input.pageSlug}.md`],
    },
  );
}

function dedupePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function dedupeSourceRefs(sourceRefs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const deduped: SourceRef[] = [];

  for (const sourceRef of sourceRefs) {
    const key = `${sourceRef.kind}:${sourceRef.ref}:${sourceRef.hash ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(sourceRef);
  }

  return deduped;
}

function mergePrivacy(current: PrivacyMode, next: PrivacyMode): PrivacyMode {
  const rank: Record<PrivacyMode, number> = {
    "local-only": 0,
    "cloud-ok": 1,
    "execution-ok": 2,
  };

  return rank[next] < rank[current] ? next : current;
}

// ── Engine connection helpers ─────────────────────────

/**
 * Canonical filename the installer writes the PGLite database to. Exported
 * so tests and future callers can derive the same path without hardcoding
 * the string.
 *
 * Must match `PGLITE_DBNAME` in `src/lib/setup/gbrain-installer.ts` and the
 * default PGLite path in `src/brain/store.ts`.
 */
export const PGLITE_DB_FILENAME = "brain.pglite";

/**
 * Resolve the PGLite database file `materializeMemory` should read/write.
 *
 * Precedence, high → low:
 *   1. `BRAIN_PGLITE_PATH` env var — honored for parity with
 *      `src/brain/store.ts#resolveBrainStorePglitePath`. Test harnesses (notably
 *      `tests/helpers/test-brain.ts`) set this to isolate per-test brains
 *      and legacy integration tests may override it to point at a custom
 *      filename.
 *   2. `<brainRoot>/brain.pglite` — matches the installer's canonical
 *      layout (`PGLITE_DBNAME` in `src/lib/setup/gbrain-installer.ts`).
 *
 * Exporting the resolver lets caller tests read from the exact same
 * database file the writer targets, eliminating the Track A / installer
 * path drift that flagged this fix in the first place.
 */
export function resolvePgliteDatabasePath(brainRoot: string): string {
  const override = process.env.BRAIN_PGLITE_PATH;
  if (override && override.length > 0) {
    return override;
  }
  return path.join(brainRoot, PGLITE_DB_FILENAME);
}

async function getSharedMaterializeEngine(): Promise<MaterializeEngine> {
  await ensureBrainStoreReady();
  return (getBrainStore() as GbrainEngineAdapter).engine as unknown as MaterializeEngine;
}

async function connectPglite(brainRoot: string): Promise<MaterializeEngine> {
  const databasePath = resolvePgliteDatabasePath(brainRoot);
  const engine = (await createRuntimeEngine({
    engine: "pglite",
    database_path: databasePath,
  })) as MaterializeEngine;
  await engine.connect({ engine: "pglite", database_path: databasePath });
  await engine.initSchema();
  return engine;
}

async function resolveMaterializeEngine(
  brainRoot: string,
  injected?: MaterializeEngine,
): Promise<{ engine: MaterializeEngine; ownsEngine: boolean }> {
  if (injected) {
    return { engine: injected, ownsEngine: false };
  }

  const targetPath = path.resolve(resolvePgliteDatabasePath(brainRoot));
  const sharedPath = path.resolve(resolveBrainStorePglitePath());
  if (targetPath === sharedPath) {
    return { engine: await getSharedMaterializeEngine(), ownsEngine: false };
  }

  return { engine: await connectPglite(brainRoot), ownsEngine: true };
}

/**
 * Upsert the project page if it does not yet exist. Pre-pivot this
 * scaffolded `wiki/projects/<slug>.md` on disk; under gbrain
 * `engine.putPage` is upsert-on-slug, so a "create-if-missing" amounts
 * to a putPage with a seed body. We do NOT overwrite an existing page
 * — gbrain's putPage replaces `title` and `compiled_truth` on conflict,
 * which would clobber a user-edited project description on every
 * capture. So we read first and only write the seed if the page is
 * absent.
 */
async function ensureProjectPage(
  engine: MaterializeEngine,
  brainRoot: string,
  project: string,
  privacy: PrivacyMode,
): Promise<void> {
  const safeProject = assertSafeProjectSlug(project);
  const projectPagePath = path.join(brainRoot, "wiki", "projects", `${safeProject}.md`);

  const [existing, diskExists] = await Promise.all([
    engine.getPage(safeProject),
    access(projectPagePath).then(
      () => true,
      () => false,
    ),
  ]);

  // Both sides already present → nothing to do. If the gbrain page is
  // present but the disk mirror is missing, fall through and
  // re-materialize the mirror so briefing / dashboard consumers that
  // still read `<brainRoot>/wiki/projects/<slug>.md` off disk recover
  // from a prior partial write (gbrain putPage succeeded, disk write
  // threw). Greptile flagged this transitional gap; Track C deletes
  // the mirror and this branch along with it.
  if (existing != null && diskExists) {
    return;
  }
  const title = safeProject.replace(/-/g, " ");
  const seedBody = [
    `# ${title}`,
    "",
    "## Overview",
    "",
    "Project page created by the capture pipeline.",
    "",
    "## Timeline",
  ].join("\n");
  const seedFrontmatter = {
    title,
    date: formatDate(new Date()),
    type: "project",
    para: "projects",
    tags: [],
    privacy,
  };

  // Decide what to write to disk. Two paths:
  //   1. Cold start (gbrain row missing): seed gbrain with the
  //      template AND write the same template to disk.
  //   2. Recovery (gbrain row exists, disk mirror missing): do NOT
  //      call putPage (it would clobber a user-edited gbrain page).
  //      Mirror the existing gbrain compiled_truth + frontmatter to
  //      disk instead.
  let diskBodyRaw = seedBody;
  let diskFrontmatter: Record<string, unknown> = seedFrontmatter;
  if (existing == null) {
    await engine.putPage(safeProject, {
      type: "project",
      title,
      compiled_truth: seedBody,
      timeline: "",
      frontmatter: seedFrontmatter,
    });
  } else {
    // Recovery branch: rehydrate the disk mirror from the gbrain row
    // so a user-edited compiled_truth is not overwritten by the seed.
    // `existing` is typed `unknown` on the contract engine so we
    // narrow it defensively.
    const page = existing as {
      compiled_truth?: unknown;
      frontmatter?: unknown;
    };
    if (typeof page.compiled_truth === "string") {
      diskBodyRaw = page.compiled_truth;
    }
    if (page.frontmatter != null && typeof page.frontmatter === "object") {
      diskFrontmatter = page.frontmatter as Record<string, unknown>;
    }
  }

  // Disk back-compat mirror — see the module header. Briefing's
  // `loadPage` reads `wiki/projects/<slug>.md` directly and will
  // 404 silently if we don't mirror the project page on first touch.
  // This write is idempotent and retried by the disk-exists guard
  // above, so a transient disk-write failure self-heals on the
  // next capture.
  await mkdir(path.dirname(projectPagePath), { recursive: true });
  const diskBody = matter.stringify(diskBodyRaw, diskFrontmatter);
  await writeFile(projectPagePath, diskBody, "utf-8");
}

// ── Public entrypoint ────────────────────────────────

export async function materializeMemory(input: MaterializeInput): Promise<MaterializedCapture> {
  const sourceRef: SourceRef = {
    kind: "capture",
    ref: input.capture.rawPath,
  };

  if (!input.project) {
    return {
      materializedPath: undefined,
      project: null,
      sourceRef,
    };
  }
  const safeProject = assertSafeProjectSlug(input.project);

  const createdAt = new Date(input.capture.createdAt);
  const title = formatTitle(input.capture.kind, input.capture.content);
  const captureSuffix = slugify(input.capture.captureId).slice(0, 12) || "capture";
  // Page slug doubles as the gbrain entity id and as the suffix on the
  // pseudo-path returned to callers. Keeping it date-prefixed + capture-
  // suffixed mirrors the pre-pivot filename so duplicate-content
  // captures still get distinct slugs (test:
  // "materializes captures with unique filenames for repeated titles").
  const pageSlug = `${formatDate(createdAt)}-${slugify(title)}-${captureSuffix}`;
  const relativeDir = KIND_DIRECTORY[input.capture.kind];
  const materializedPath = path
    .join(relativeDir, `${pageSlug}.md`)
    .replaceAll("\\", "/");

  // Resolve the engine. `getCurrentUserHandle()` is invoked inside
  // `buildCitations` further down so we still throw at the same loud
  // boundary if it's unset. We don't pre-check here because the test
  // for "unset SCIENCESWARM_USER_HANDLE" should exercise the full
  // citation path, not a separate guard.
  const { engine, ownsEngine } = await resolveMaterializeEngine(
    input.brainRoot,
    input.engine,
  );

  const writeMaterializedCapture = async () => {
    // 1. Ensure the project page exists. Upsert-by-slug is idempotent in
    //    gbrain (contract pin), so this is safe to call on every capture.
    await ensureProjectPage(engine, input.brainRoot, safeProject, input.capture.privacy);

    // 2. Build the captured page body. We reproduce PR #235's body
    //    layout (heading + content + `---` + citation lines + optional
    //    transcript) so existing assertions on body shape still pass —
    //    the citation lines and the transcript section are part of the
    //    Compiled-Truth, not separate gbrain fields.
    const citations = buildCitations(input.capture);
    const bodyParts: string[] = [
      `# ${title}`,
      "",
      input.capture.content,
      "",
      "---",
      "",
      ...citations,
    ];
    if (input.capture.transcript) {
      bodyParts.push("", "## Transcript", "", input.capture.transcript);
    }
    const compiledTruth = bodyParts.join("\n");

    // 3. Write the captured page itself into gbrain.
    const pageFrontmatter = buildFrontmatter(
      { ...input, project: safeProject },
      title,
      sourceRef,
    );
    await engine.putPage(pageSlug, {
      type: KIND_PAGE_TYPE[input.capture.kind],
      title,
      compiled_truth: compiledTruth,
      timeline: "",
      frontmatter: pageFrontmatter,
    });

    // 3b. Disk back-compat mirror — see the "Disk back-compat mirror"
    //     note in the module header. We write the same body that is
    //     now in gbrain to `<brainRoot>/<materializedPath>` so every
    //     existing read-side consumer (briefing, dashboard, radar,
    //     warm-start) keeps working until Track C migrates them.
    //     This is the ONE filesystem write Track A leaves behind on
    //     purpose; Track C deletes it. Failure here is fatal — the
    //     mirror is load-bearing for briefings until then.
    const absolutePath = path.join(input.brainRoot, materializedPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const diskPage = matter.stringify(compiledTruth, pageFrontmatter);
    await writeFile(absolutePath, diskPage, "utf-8");

    // 4. Iron Law back-link: capture page <-> project page. gbrain's
    //    addLink is keyed on (from, to, link_type) per the contract
    //    test, so calling it twice with the same context+link_type is a
    //    no-op (gbrain de-dupes). We use `link_type="references"` and
    //    `context="capture"` so briefings can filter back-links by
    //    semantic kind down the road.
    await engine.addLink(pageSlug, safeProject, "capture", "references");

    // 5. Project Timeline back-link entry. gbrain's `addTimelineEntry`
    //    is a plain INSERT against `timeline_entries` with no unique
    //    constraint on (slug, date, summary) — so we have to enforce
    //    de-dup ourselves before the call, otherwise re-materializing
    //    the same capture would stack rows. We do that by reading the
    //    existing timeline first and skipping the insert if a row with
    //    the same date+summary already exists. Unlike the PR #235
    //    markdown read-modify-write, the gbrain version wraps the
    //    check-then-insert in `engine.transaction(...)` (see below),
    //    which PGLite serializes through its single WASM-backed
    //    connection queue. That gives concurrent in-process callers
    //    the equivalent of an advisory-locked SELECT-then-INSERT and
    //    resolves the P1 race concern PR #235 deferred — proved by
    //    the 10-way `Promise.all` unit test. Cross-process / multi-
    //    tenant coordination is still gbrain's responsibility and is
    //    pinned via `tests/integration/gbrain-contract.test.ts`.
    //
    //    The read ceiling below needs to be >= the maximum number of
    //    rows we might need to search for a duplicate. For a single
    //    project the timeline grows at ~one row per capture, and even
    //    a very active MVP user is unlikely to exceed a few hundred.
    //    A 1000-row window gives comfortable headroom without paying
    //    for a full scan on every capture; if we outgrow that,
    //    gbrain's next contract bump should add a targeted
    //    `hasTimelineEntry(slug, date, summary)` query and we'll
    //    switch to it.
    const summary = `Referenced in ${title}`;
    const dateStr = formatDate(createdAt);
    // Wrap the read-modify-write in a gbrain transaction so the
    // dedup check is serialized with the insert. PGLite's transaction
    // API queues operations through the same WASM-backed connection,
    // which gives us the equivalent of advisory-locked
    // SELECT-then-INSERT for the common in-process case. (The deeper
    // story for cross-process / multi-tenant brains is gbrain's
    // problem — we pin the contract via
    // `tests/integration/gbrain-contract.test.ts` and rely on it.)
    await engine.transaction(async (tx) => {
      const existing = await tx.getTimeline(safeProject, { limit: 1000 });
      const alreadyPresent = existing.some((row) => {
        const rowDate =
          row.date instanceof Date
            ? row.date.toISOString().slice(0, 10)
            : String(row.date).slice(0, 10);
        return rowDate === dateStr && row.summary === summary;
      });
      if (alreadyPresent) {
        return;
      }
      await tx.addTimelineEntry(safeProject, {
        date: dateStr,
        source: `${input.capture.channel}:${input.capture.userId}`,
        summary,
        detail: `${input.capture.kind} via ${input.capture.channel} → ${materializedPath}`,
      });
    });
  };

  try {
    if (ownsEngine) {
      await writeMaterializedCapture();
    } else {
      await enqueueGbrainWrite(writeMaterializedCapture);
    }

    logCaptureIngestEvent({
      brainRoot: input.brainRoot,
      createdAt: input.capture.createdAt,
      kind: input.capture.kind,
      pageSlug,
    });
  } finally {
    if (ownsEngine) {
      await engine.disconnect().catch(() => {});
    }
  }

  // 6. Project manifest update lives on the ScienceSwarm side (state
  //    dir, not gbrain) and tracks the per-project decision/task path
  //    lists used by briefings. This is unchanged from PR #235.
  await updateProjectManifest(
    safeProject,
    manifestUpdater(input.capture, safeProject, materializedPath, sourceRef),
    path.join(input.brainRoot, "state"),
  );

  return {
    materializedPath,
    project: safeProject,
    sourceRef,
  };
}
