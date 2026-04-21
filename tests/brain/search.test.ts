/**
 * Phase B Track C: `src/brain/search.ts` is a thin gbrain-backed shim.
 * These tests exercise the shim through the shared BrainStore singleton
 * (GbrainEngineAdapter → PGLite), seeding rows via the low-level runtime
 * engine so we cover: the `search` routing, the `SearchResult` shape,
 * the `countPages` health call, and `isStructuralWikiPage`/
 * `inferTypeFromPath` helpers.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { search, countPages, isStructuralWikiPage, inferTypeFromPath } from "@/brain/search";
import { cachedSearchWithSource, ensureBrainStoreReady, getBrainStore } from "@/brain/store";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import type { GbrainEngineAdapter } from "@/brain/stores/gbrain-engine-adapter";
import { createTestBrain, destroyTestBrain, type TestBrainContext } from "../helpers/test-brain";
import type { BrainConfig } from "@/brain/types";

function makeConfig(brainRoot: string): BrainConfig {
  return {
    root: brainRoot,
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

async function seedPageThroughSingleton(
  slug: string,
  opts: {
    title: string;
    type: string;
    compiled_truth: string;
    timeline?: string;
  },
): Promise<void> {
  // Seed through the shared BrainStore singleton so `search()` (which
  // resolves its adapter through `getBrainStore()`) sees the seeded rows
  // on the same PGLite connection. Seeding via a separate adapter can
  // race against the singleton's connection lifetime.
  await ensureBrainStoreReady();
  const adapter = getBrainStore() as unknown as GbrainEngineAdapter;
  const engine = adapter.engine;
  await engine.putPage(slug, {
    type: opts.type,
    title: opts.title,
    compiled_truth: opts.compiled_truth,
    timeline: opts.timeline ?? "",
    frontmatter: {},
  });
  const chunks: Array<{
    chunk_index: number;
    chunk_text: string;
    chunk_source: "compiled_truth" | "timeline";
  }> = [
    {
      chunk_index: 0,
      chunk_text: opts.compiled_truth,
      chunk_source: "compiled_truth",
    },
  ];
  if (opts.timeline) {
    chunks.push({
      chunk_index: 1,
      chunk_text: opts.timeline,
      chunk_source: "timeline",
    });
  }
  await engine.upsertChunks(slug, chunks);
}

describe("search (gbrain-backed)", () => {
  let ctx: TestBrainContext;

  beforeAll(async () => {
    ctx = await createTestBrain();
    await seedPageThroughSingleton("entities/papers/chen-2024-cas12a", {
      title: "Cas12a Specificity Study",
      type: "paper",
      compiled_truth: "This paper studies Cas12a off-target effects in CRISPR systems.",
    });
    await seedPageThroughSingleton("concepts/crispr-off-target", {
      title: "CRISPR Off-Target Effects",
      type: "concept",
      compiled_truth: "Off-target effects are unintended modifications. Cas12a helps study them.",
    });
    await seedPageThroughSingleton("entities/papers/smith-2025-crispr", {
      title: "Cas9 Context Dependency",
      type: "paper",
      compiled_truth: "Cas9 off-target rates vary by cell type in CRISPR experiments.",
    });
  });

  afterAll(async () => {
    await destroyTestBrain(ctx);
  });

  it("grep mode: finds pages matching query", async () => {
    const results = await search(makeConfig(ctx.brainRoot), { query: "Cas12a", mode: "grep" });
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Cas12a Specificity Study",
          type: "paper",
        }),
        expect.objectContaining({
          title: "CRISPR Off-Target Effects",
          type: "concept",
        }),
      ]),
    );
  });

  it("adds compiled-view metadata for concept search results", async () => {
    await ensureBrainStoreReady();
    const adapter = getBrainStore() as unknown as GbrainEngineAdapter;
    await adapter.engine.addLink(
      "concepts/crispr-off-target",
      "entities/papers/chen-2024-cas12a",
      "compiled evidence",
      "cites",
    );
    await adapter.engine.addTimelineEntry("concepts/crispr-off-target", {
      date: "2026-04-18",
      source: "dream-cycle",
      summary: "Compiled truth updated",
    });

    const results = await search(makeConfig(ctx.brainRoot), {
      query: "Off-target effects",
      mode: "grep",
    });
    const concept = results.find((result) => result.path === "concepts/crispr-off-target.md");

    expect(concept?.compiledView).toMatchObject({
      pagePath: "concepts/crispr-off-target.md",
      sourceCounts: expect.objectContaining({ papers: 1 }),
      totalSources: 1,
      lastUpdated: "2026-04-18T00:00:00.000Z",
    });
    expect(concept?.snippet).toContain("Off-target effects are unintended modifications");
  });

  it("grep mode: returns empty for no matches", async () => {
    const results = await search(makeConfig(ctx.brainRoot), {
      query: "quantum-entanglement-xyz",
      mode: "grep",
    });
    expect(results.length).toBe(0);
  });

  it("qmd mode: routes through gbrain store", async () => {
    const results = await search(makeConfig(ctx.brainRoot), { query: "CRISPR", mode: "qmd" });
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Cas12a Specificity Study",
          type: "paper",
        }),
        expect.objectContaining({
          title: "CRISPR Off-Target Effects",
          type: "concept",
        }),
        expect.objectContaining({
          title: "Cas9 Context Dependency",
          type: "paper",
        }),
      ]),
    );
  });

  it("finds pages written through the in-process gbrain client", async () => {
    const client = createInProcessGbrainClient();
    await client.putPage(
      "entities/papers/in-process-indexed",
      [
        "---",
        "type: paper",
        "title: In Process Indexed Paper",
        "---",
        "",
        "# In Process Indexed Paper",
        "",
        "UniqueIndexToken appears in this imported paper body.",
      ].join("\n"),
    );

    const results = await search(makeConfig(ctx.brainRoot), {
      query: "UniqueIndexToken",
      mode: "qmd",
      limit: 5,
    });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "In Process Indexed Paper",
          type: "paper",
        }),
      ]),
    );
  });

  it("normalizes in-process gbrain slugs before chunk writes", async () => {
    const client = createInProcessGbrainClient();
    const result = await client.putPage(
      "Resources/Imports/Project-Alpha/README-CAPS",
      [
        "---",
        "type: note",
        "title: Uppercase Import Source",
        "---",
        "",
        "# Uppercase Import Source",
        "",
        "MixedCaseChunkToken appears in this fallback import body.",
      ].join("\n"),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      slug: "resources/imports/project-alpha/readme-caps",
    });

    const results = await search(makeConfig(ctx.brainRoot), {
      query: "MixedCaseChunkToken",
      mode: "qmd",
      limit: 5,
    });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Uppercase Import Source",
          type: "note",
        }),
      ]),
    );
  });

  it("respects limit parameter", async () => {
    const results = await search(makeConfig(ctx.brainRoot), {
      query: "CRISPR",
      mode: "grep",
      limit: 1,
    });
    expect(results).toHaveLength(1);
  });

  it("separates cached results by gbrain detail level", async () => {
    await seedPageThroughSingleton("concepts/detail-cache-signal", {
      title: "Detail Cache Signal",
      type: "concept",
      compiled_truth: "DetailCacheSignal compiled truth evidence.",
      timeline: "2026-04-16: DetailCacheSignal timeline evidence.",
    });

    const low = await cachedSearchWithSource({
      query: "DetailCacheSignal",
      mode: "qmd",
      limit: 10,
      detail: "low",
    });
    const high = await cachedSearchWithSource({
      query: "DetailCacheSignal",
      mode: "qmd",
      limit: 10,
      detail: "high",
    });

    expect(low.results.length).toBeGreaterThan(0);
    expect(low.results.every((result) => result.chunkIndex === 0)).toBe(true);
    expect(high.results.some((result) => result.chunkIndex === 1)).toBe(true);
  });
});

describe("countPages", () => {
  let ctx: TestBrainContext;

  beforeAll(async () => {
    ctx = await createTestBrain();
    await seedPageThroughSingleton("entities/papers/count-check-paper", {
      title: "Count Check Paper",
      type: "paper",
      compiled_truth: "A seeded paper for the page-count check.",
    });
    await seedPageThroughSingleton("concepts/count-check-concept", {
      title: "Count Check Concept",
      type: "concept",
      compiled_truth: "A seeded concept for the page-count check.",
    });
  });

  afterAll(async () => {
    await destroyTestBrain(ctx);
  });

  it("returns the exact page count from gbrain", async () => {
    const count = await countPages(makeConfig(ctx.brainRoot));
    expect(count).toBe(2);
  });
});

describe("isStructuralWikiPage", () => {
  it("recognizes classic structural page basenames", () => {
    expect(isStructuralWikiPage("wiki/log.md")).toBe(true);
    expect(isStructuralWikiPage("wiki/home.md")).toBe(true);
    expect(isStructuralWikiPage("wiki/index.md")).toBe(true);
    expect(isStructuralWikiPage("wiki/overview.md")).toBe(true);
  });

  it("does not misclassify content pages", () => {
    expect(isStructuralWikiPage("wiki/entities/papers/chen-2024-cas12a.md")).toBe(false);
  });

  it("handles bare slug form (no wiki/ prefix)", () => {
    expect(isStructuralWikiPage("log.md")).toBe(true);
    expect(isStructuralWikiPage("chen-2024.md")).toBe(false);
  });
});

describe("inferTypeFromPath", () => {
  it("infers paper type from entities/papers/ prefix", () => {
    expect(inferTypeFromPath("entities/papers/chen-2024")).toBe("paper");
  });

  it("infers project type from projects/ prefix", () => {
    expect(inferTypeFromPath("projects/project-alpha")).toBe("project");
  });

  it("infers decision type even when path contains other keywords", () => {
    expect(inferTypeFromPath("decisions/multi-projects-review")).toBe("decision");
  });

  it("falls back to note for unknown prefixes", () => {
    expect(inferTypeFromPath("unclassified/thing")).toBe("note");
  });
});
