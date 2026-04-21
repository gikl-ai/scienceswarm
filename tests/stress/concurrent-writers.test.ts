/**
 * Spec 7 — Concurrent writer stress test.
 *
 * Purpose: catch race conditions between dashboard capture, Telegram capture,
 * radar runner, task-extractor, and coldstart when they write the same brain
 * simultaneously.
 *
 * Notes on concurrency model:
 *   PGLite is a single-connection in-process engine, so writes through the
 *   same `engine` handle are effectively serialized even when we fire the
 *   public API off under `Promise.all`. That is fine — the assertions here
 *   still pin correctness of the nominal concurrent API surface, and if a
 *   future gbrain bump swaps in a multi-connection or actually-parallel
 *   backend, these tests are the early-warning that the pages/links/timeline
 *   write paths need real locking.
 *
 * What each scenario pins:
 *   1. `addTimelineEntry` under fan-out: 10 concurrent appends against a
 *      single page all land and are readable via `getTimeline`. Regression
 *      guard if gbrain ever introduces a buggy batched path that drops rows.
 *   2. `putPage` + `upsertChunks` under fan-out: 20 concurrent transactions
 *      on distinct slugs all commit; `getStats().page_count` reflects every
 *      row. Regression guard for any future batching layer that might lose
 *      writes or deadlock on chunk FK.
 *   3. `putPage` + `addLink` on the *same* page: mixing a full-page
 *      overwrite with a metadata-only append must leave both the updated
 *      compiled_truth AND the new link intact.
 *   4. Transaction rollback on throw: aborting mid-transaction must leave
 *      the DB untouched — the half-written page must be invisible.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestBrain,
  destroyTestBrain,
  seedBrainPage,
  type TestBrainContext,
} from "../helpers/test-brain";

// Extended runtime surface for this test. The adapter's public
// `GbrainRuntimeEngine` type intentionally only exposes the subset of methods
// ScienceSwarm's adapter wraps today; the underlying gbrain `BrainEngine`
// provides the full surface we need for timeline + link stress. Mirrors the
// pattern used by `tests/integration/gbrain-contract.test.ts`.
interface StressEngine {
  transaction<T>(fn: (engine: StressEngine) => Promise<T>): Promise<T>;
  putPage(
    slug: string,
    page: {
      type: string;
      title: string;
      compiled_truth: string;
      timeline?: string;
      frontmatter?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  upsertChunks(
    slug: string,
    chunks: Array<{
      chunk_index: number;
      chunk_text: string;
      chunk_source: "compiled_truth" | "timeline";
    }>,
  ): Promise<void>;
  getPage(slug: string): Promise<{ compiled_truth: string } | null>;
  addTimelineEntry(
    slug: string,
    entry: { date: string; source?: string; summary: string; detail?: string },
  ): Promise<void>;
  getTimeline(
    slug: string,
    opts?: { limit?: number },
  ): Promise<Array<{ summary: string; source: string }>>;
  addLink(
    from: string,
    to: string,
    context?: string,
    linkType?: string,
  ): Promise<void>;
  getLinks(
    slug: string,
  ): Promise<Array<{ from_slug: string; to_slug: string; link_type: string }>>;
  getStats(): Promise<{ page_count: number }>;
}

function stressEngine(ctx: TestBrainContext): StressEngine {
  return ctx.engine as unknown as StressEngine;
}

describe("concurrent writers (Spec 7)", () => {
  let ctx: TestBrainContext;

  beforeEach(async () => {
    process.env.SCIENCESWARM_USER_HANDLE = "stress-test";
    ctx = await createTestBrain();
    await seedBrainPage(ctx, {
      slug: "shared-project",
      type: "project",
      title: "Shared project",
      compiledTruth: "initial shared project body",
      timeline: "",
    });
  });

  afterEach(async () => {
    await destroyTestBrain(ctx);
    delete process.env.SCIENCESWARM_USER_HANDLE;
  });

  it("10 concurrent addTimelineEntry calls all land", async () => {
    const engine = stressEngine(ctx);

    const writes = Array.from({ length: 10 }, (_, i) =>
      engine.addTimelineEntry("shared-project", {
        date: "2026-04-14",
        source: `writer-${i}`,
        summary: `event-${i}`,
      }),
    );
    await Promise.all(writes);

    const timeline = await engine.getTimeline("shared-project", { limit: 200 });
    const events = timeline.filter((e) => e.summary.startsWith("event-"));
    expect(events).toHaveLength(10);
    // Every writer identity preserved — no row got its source dropped.
    const sources = new Set(events.map((e) => e.source));
    expect(sources.size).toBe(10);
  });

  it("20 concurrent putPage calls on distinct slugs all land", async () => {
    const engine = stressEngine(ctx);

    const writes = Array.from({ length: 20 }, (_, i) =>
      engine.transaction(async (tx) => {
        const slug = `note-${i}`;
        await tx.putPage(slug, {
          type: "note",
          title: `Note ${i}`,
          compiled_truth: `body for note ${i}`,
          timeline: "",
        });
        await tx.upsertChunks(slug, [
          {
            chunk_index: 0,
            chunk_text: `body for note ${i}`,
            chunk_source: "compiled_truth",
          },
        ]);
      }),
    );
    await Promise.all(writes);

    const stats = await engine.getStats();
    // 20 notes + the shared-project seed = 21 exactly. Asserting equality
    // (not `>=`) also guards against a hypothetical batching layer that
    // duplicates rows under contention — `>=` would silently accept that.
    expect(stats.page_count).toBe(21);

    // Spot-check that every slug is independently retrievable (guards
    // against a hypothetical batching layer that silently drops the last
    // write in a race).
    for (let i = 0; i < 20; i += 1) {
      const page = await engine.getPage(`note-${i}`);
      expect(page, `note-${i} should exist`).not.toBeNull();
      expect(page?.compiled_truth).toBe(`body for note ${i}`);
    }
  });

  it("concurrent putPage + addLink on same page preserves both", async () => {
    const engine = stressEngine(ctx);

    // `addLink` needs both endpoints to exist; seed the target first.
    await seedBrainPage(ctx, {
      slug: "other-thing",
      type: "note",
      title: "Other thing",
      compiledTruth: "other thing body",
    });

    await Promise.all([
      engine.transaction(async (tx) => {
        await tx.putPage("shared-project", {
          type: "project",
          title: "Shared project",
          compiled_truth: "updated shared project body",
          timeline: "",
        });
        await tx.upsertChunks("shared-project", [
          {
            chunk_index: 0,
            chunk_text: "updated shared project body",
            chunk_source: "compiled_truth",
          },
        ]);
      }),
      engine.addLink("shared-project", "other-thing", undefined, "references"),
    ]);

    const page = await engine.getPage("shared-project");
    expect(page?.compiled_truth).toBe("updated shared project body");

    const links = await engine.getLinks("shared-project");
    // Assert the link row exists AND its `link_type` survived — guards
    // against a future batching path that could land the row with empty
    // or wrong metadata under contention.
    const link = links.find((l) => l.to_slug === "other-thing");
    expect(link).toBeDefined();
    expect(link?.link_type).toBe("references");
  });

  it("transaction rollback on throw leaves no trace", async () => {
    const engine = stressEngine(ctx);

    const fail = engine.transaction(async (tx) => {
      await tx.putPage("half-written", {
        type: "note",
        title: "will abort",
        compiled_truth: "body that must not persist",
        timeline: "",
      });
      throw new Error("simulated crash");
    });

    await expect(fail).rejects.toThrow("simulated crash");

    const page = await engine.getPage("half-written");
    expect(page).toBeNull();
  });
});
