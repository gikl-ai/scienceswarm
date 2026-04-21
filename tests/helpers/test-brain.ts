/**
 * Shared test helper: creates a PGLite in-memory BrainEngine + wiki scaffolding.
 *
 * Track C.1 expansion (additive):
 *   The original helper still creates the legacy filesystem wiki tree via
 *   `initBrain()` so the ~30 test files that expect it keep working. On top
 *   of that we now expose gbrain-first conveniences — `seedBrainPage`,
 *   `readBrainPage`, `searchBrainKeyword` — so newly written or migrated
 *   tests can route through `engine.putPage` / `engine.getPage` directly.
 *   Eventually (Track C.2+) the filesystem scaffolding goes away and the
 *   gbrain helpers become the only path; for now we ship them side-by-side.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { initBrain } from "@/brain/init";
import { resetBrainStore } from "@/brain/store";
import {
  GbrainEngineAdapter,
  type GbrainRuntimeEngine,
} from "@/brain/stores/gbrain-engine-adapter";
import { chunkText } from "@/brain/stores/gbrain-chunker";

export interface TestBrainContext {
  brainRoot: string;
  adapter: GbrainEngineAdapter;
  engine: GbrainRuntimeEngine;
  cleanup: () => Promise<void>;
}

export async function createTestBrain(): Promise<TestBrainContext> {
  const id = randomBytes(4).toString("hex");
  const brainRoot = join(tmpdir(), `scienceswarm-test-brain-${id}`);
  const previousBrainRoot = process.env.BRAIN_ROOT;
  const previousPglitePath = process.env.BRAIN_PGLITE_PATH;

  await resetBrainStore();
  process.env.BRAIN_ROOT = brainRoot;
  process.env.BRAIN_PGLITE_PATH = join(brainRoot, "db");
  initBrain({ root: brainRoot, name: "Test Researcher" });
  const adapter = new GbrainEngineAdapter();
  await adapter.initialize({ engine: "pglite" });
  return {
    brainRoot,
    adapter,
    engine: adapter.engine,
    cleanup: async () => {
      await resetBrainStore();
      await adapter.dispose();
      if (previousBrainRoot === undefined) {
        delete process.env.BRAIN_ROOT;
      } else {
        process.env.BRAIN_ROOT = previousBrainRoot;
      }
      if (previousPglitePath === undefined) {
        delete process.env.BRAIN_PGLITE_PATH;
      } else {
        process.env.BRAIN_PGLITE_PATH = previousPglitePath;
      }
      rmSync(brainRoot, { recursive: true, force: true });
    },
  };
}

export async function destroyTestBrain(ctx: TestBrainContext): Promise<void> {
  await ctx.cleanup();
}

// ── gbrain-first helpers (Track C.1) ─────────────────────────────────
//
// These wrap engine.putPage / engine.getPage / engine.searchKeyword so
// migrated tests can avoid hand-rolling slug + Compiled-Truth + Timeline
// plumbing. Pre-migration tests can ignore this section entirely.

export interface SeedBrainPageInput {
  slug: string;
  type: string;
  title: string;
  compiledTruth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
}

/**
 * Write a gbrain page through the adapter's underlying runtime engine.
 *
 * Shape note: this helper builds the same `compiled_truth` + `timeline` +
 * `frontmatter` payload that production write paths (`materializeMemory`,
 * `importCorpus`) emit, then chunks `compiledTruth` (and `timeline` if
 * supplied) via the same `chunkText` helper `importCorpus` uses, so a
 * subsequent `searchKeyword` call can surface the page. `engine.putPage`
 * does NOT auto-chunk — callers must populate the chunk store separately
 * or `searchKeyword` will see zero results.
 *
 * Atomicity: the `putPage` and `upsertChunks` calls run inside a single
 * `engine.transaction()` (matching the production `importCorpus` path).
 * If chunk insertion fails, the page write rolls back, so a half-seeded
 * page can never become invisible to keyword search.
 *
 * Empty-input guard: if `compiledTruth` chunks down to zero entries
 * (e.g. an empty string), this throws before touching the engine.
 * Otherwise `putPage` would commit a page with no chunks and
 * `searchBrainKeyword` would silently return zero results for it,
 * defeating the helper's contract.
 *
 * Intentional divergence from production: this helper does NOT compute or
 * pass `content_hash`. `content_hash` is typed as optional on `putPage`
 * and only matters for the `importCorpus` idempotency guard
 * (`if (existing?.content_hash === contentHash) { skipped++ }`). Tests
 * that need to exercise that guard should either call `importCorpus`
 * directly or set `content_hash` explicitly via the engine.
 */
export async function seedBrainPage(
  ctx: TestBrainContext,
  input: SeedBrainPageInput,
): Promise<void> {
  const chunks: Array<{
    chunk_index: number;
    chunk_text: string;
    chunk_source: "compiled_truth" | "timeline";
  }> = [];
  let chunkIndex = 0;
  for (const chunk of chunkText(input.compiledTruth)) {
    chunks.push({
      chunk_index: chunkIndex,
      chunk_text: chunk.text,
      chunk_source: "compiled_truth",
    });
    chunkIndex += 1;
  }
  if (input.timeline) {
    for (const chunk of chunkText(input.timeline)) {
      chunks.push({
        chunk_index: chunkIndex,
        chunk_text: chunk.text,
        chunk_source: "timeline",
      });
      chunkIndex += 1;
    }
  }

  if (chunks.length === 0) {
    throw new Error(
      `seedBrainPage: compiledTruth for "${input.slug}" produced no chunks — ` +
        "page would be invisible to searchBrainKeyword. Provide non-empty compiledTruth.",
    );
  }

  await ctx.engine.transaction(async (tx) => {
    await tx.putPage(input.slug, {
      type: input.type,
      title: input.title,
      compiled_truth: input.compiledTruth,
      timeline: input.timeline ?? "",
      frontmatter: input.frontmatter ?? {},
    });
    await tx.upsertChunks(input.slug, chunks);
  });
}

/**
 * Read a gbrain page by slug. Returns `null` if the page does not exist.
 * Use for assertion-style "the writer put a page in gbrain" checks.
 */
export async function readBrainPage(
  ctx: TestBrainContext,
  slug: string,
): Promise<{
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
} | null> {
  const page = await ctx.engine.getPage(slug);
  if (!page) return null;
  return {
    slug: page.slug,
    type: page.type,
    title: page.title,
    compiled_truth: page.compiled_truth,
    timeline: page.timeline,
    frontmatter: page.frontmatter,
  };
}

/**
 * Run a keyword search against the gbrain engine. Returns the raw result
 * shape — migrated tests typically assert on `length` and `slug`.
 */
export async function searchBrainKeyword(
  ctx: TestBrainContext,
  query: string,
  opts?: { limit?: number; detail?: "low" | "medium" | "high" },
): Promise<Array<{
  slug: string;
  title: string;
  type: string;
  chunk_text: string;
  chunk_id?: number;
  chunk_index?: number;
  score: number;
}>> {
  return ctx.engine.searchKeyword(query, opts);
}
