/**
 * gbrain contract test — pins the upstream surface ScienceSwarm depends on.
 *
 * Why this exists (eng review Issue 4):
 * gbrain is a pinned git dependency that ships daily. If a pin bump silently
 * changes the shape of `BrainEngine` (renamed field, dropped method, swapped
 * argument order), ScienceSwarm breaks at runtime — and there is no
 * `BRAIN_BACKEND` flag to roll back to. PR #231 already burned
 * us once. This test is the early-warning system: every PR and every gbrain
 * pin bump runs it, and a red result on a pin bump means the bump must be
 * reverted (or the test deliberately updated to acknowledge the new shape).
 *
 * What it pins:
 * For every gbrain `BrainEngine` method ScienceSwarm calls today (or will call
 * imminently in the Phase B rewrite), this test asserts:
 *   1. The method exists on the engine returned from `createEngine({ engine: 'pglite' })`.
 *   2. It accepts the arguments ScienceSwarm passes today.
 *   3. Its return value has the structural shape ScienceSwarm reads.
 *
 * How to update on a deliberate gbrain bump:
 *   1. Bump the gbrain pin in package.json.
 *   2. Run `npm test -- gbrain-contract` and read every failure carefully.
 *   3. For each red assertion, decide: is the new shape something ScienceSwarm
 *      can adopt cleanly? If yes, update the assertion AND update the
 *      caller(s) in src/brain/ in the same PR. If no, revert the pin bump.
 *   4. Never silently delete an assertion. Each pinned shape is load-bearing.
 *
 * Test setup uses in-memory PGLite (`engine: 'pglite'`, no `database_path`),
 * so it has zero external dependencies and runs as part of `npm run test`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeEngine } from "@/brain/stores/gbrain-runtime.mjs";

// We re-declare the shapes we depend on inline (rather than importing them
// from the gbrain package). This is intentional: the inline shapes are the
// contract ScienceSwarm reads. If gbrain's exported types drift but the
// runtime shape still satisfies these assertions, ScienceSwarm is fine. If
// the runtime shape drifts, this test goes red — exactly the early-warning
// behavior we want.

interface BrainEngineLike {
  // Lifecycle
  connect(config: EngineConfigLike): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: BrainEngineLike) => Promise<T>): Promise<T>;

  // Pages
  getPage(slug: string): Promise<PageLike | null>;
  putPage(slug: string, page: PageInputLike): Promise<PageLike>;
  listPages(filters?: PageFiltersLike): Promise<PageLike[]>;

  // Chunks (needed so searchKeyword has something to surface)
  upsertChunks(slug: string, chunks: ChunkInputLike[]): Promise<void>;

  // Search
  searchKeyword(query: string, opts?: SearchOptsLike): Promise<SearchResultLike[]>;
  searchVector(embedding: Float32Array, opts?: SearchOptsLike): Promise<SearchResultLike[]>;
  getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>>;

  // Links
  // NOTE: gbrain API order is (from, to, context, linkType) — context comes BEFORE linkType.
  // This is the opposite of the LinkLike return shape field order (link_type, context).
  addLink(from: string, to: string, context?: string, linkType?: string): Promise<void>;
  getLinks(slug: string): Promise<LinkLike[]>;
  getBacklinks(slug: string): Promise<LinkLike[]>;

  // Timeline
  addTimelineEntry(slug: string, entry: TimelineInputLike): Promise<void>;
  getTimeline(slug: string, opts?: { limit?: number }): Promise<TimelineEntryLike[]>;

  // Tags
  addTag(slug: string, tag: string): Promise<void>;
  getTags(slug: string): Promise<string[]>;
  removeTag(slug: string, tag: string): Promise<void>;

  // Stats + health
  getStats(): Promise<BrainStatsLike>;
  getHealth(): Promise<BrainHealthLike>;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;
}

interface EngineConfigLike {
  engine?: "pglite" | "postgres";
  database_path?: string;
  database_url?: string;
}

interface PageInputLike {
  type: string;
  title: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  content_hash?: string;
}

interface PageLike {
  id: number;
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  content_hash?: string;
}

interface PageFiltersLike {
  type?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

interface ChunkInputLike {
  chunk_index: number;
  chunk_text: string;
  chunk_source: "compiled_truth" | "timeline";
  embedding?: Float32Array;
  model?: string;
  token_count?: number;
}

interface SearchOptsLike {
  limit?: number;
  offset?: number;
  detail?: "low" | "medium" | "high";
}

interface SearchResultLike {
  slug: string;
  page_id: number;
  title: string;
  type: string;
  chunk_text: string;
  chunk_source: "compiled_truth" | "timeline";
  chunk_id: number;
  chunk_index: number;
  score: number;
  stale: boolean;
  source_id?: string;
}

interface LinkLike {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
}

interface TimelineInputLike {
  date: string;
  source?: string;
  summary: string;
  detail?: string;
}

interface TimelineEntryLike {
  page_id: number;
  date: string | Date;
  source: string;
  summary: string;
  detail: string;
  created_at: Date | string;
}

interface BrainStatsLike {
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  link_count: number;
  tag_count: number;
  timeline_entry_count: number;
  pages_by_type: Record<string, number>;
}

interface BrainHealthLike {
  page_count: number;
  embed_coverage: number;
  stale_pages: number;
  orphan_pages: number;
  dead_links: number;
  missing_embeddings: number;
  brain_score: number;
}

let engine: BrainEngineLike;

beforeEach(async () => {
  engine = (await createRuntimeEngine({
    engine: "pglite",
    // database_path intentionally omitted -> in-memory PGLite
  })) as unknown as BrainEngineLike;
  await engine.connect({ engine: "pglite" });
  await engine.initSchema();
});

afterEach(async () => {
  if (engine) {
    await engine.disconnect();
  }
});

async function seedPage(slug: string, overrides: Partial<PageInputLike> = {}): Promise<PageLike> {
  return engine.putPage(slug, {
    type: "concept",
    title: "Seed Page",
    compiled_truth: "Seed body about sparse autoencoders learning monosemantic features.",
    timeline: "",
    frontmatter: {},
    ...overrides,
  });
}

describe("gbrain contract: lifecycle", () => {
  it("createEngine returns an object that exposes every BrainEngine method we depend on", () => {
    const requiredMethods: Array<keyof BrainEngineLike> = [
      "connect",
      "disconnect",
      "initSchema",
      "transaction",
      "getPage",
      "putPage",
      "listPages",
      "upsertChunks",
      "searchKeyword",
      "searchVector",
      "getEmbeddingsByChunkIds",
      "addLink",
      "getLinks",
      "getBacklinks",
      "addTimelineEntry",
      "getTimeline",
      "addTag",
      "getTags",
      "removeTag",
      "getStats",
      "getHealth",
      "getConfig",
      "setConfig",
    ];

    for (const method of requiredMethods) {
      expect(typeof engine[method], `engine.${method} should be a function`).toBe("function");
    }
  });

  it("transaction passes a child engine that has the same surface", async () => {
    const result = await engine.transaction(async (tx) => {
      expect(typeof tx.putPage).toBe("function");
      expect(typeof tx.getPage).toBe("function");
      const page = await tx.putPage("tx-page", {
        type: "concept",
        title: "Tx Page",
        compiled_truth: "Body inside a transaction.",
      });
      return page.slug;
    });

    expect(result).toBe("tx-page");
    const persisted = await engine.getPage("tx-page");
    expect(persisted).not.toBeNull();
  });
});

describe("gbrain contract: putPage", () => {
  it("returns a Page row with id, slug, timestamps, and the persisted body", async () => {
    const result = await engine.putPage("contract-put-page", {
      type: "concept",
      title: "Put Page Contract",
      compiled_truth: "Body that must round-trip exactly.",
      timeline: "",
      frontmatter: { source: "contract-test" },
    });

    expect(result).toMatchObject({
      slug: "contract-put-page",
      type: "concept",
      title: "Put Page Contract",
      compiled_truth: "Body that must round-trip exactly.",
    });
    expect(typeof result.id).toBe("number");
    expect(result.id).toBeGreaterThan(0);
    expect(result.frontmatter).toEqual({ source: "contract-test" });
    expect(result.created_at).toBeDefined();
    expect(result.updated_at).toBeDefined();
  });

  it("upserts on conflict by slug (second putPage with same slug returns the same id)", async () => {
    const first = await seedPage("upsert-target", { title: "First" });
    const second = await engine.putPage("upsert-target", {
      type: "concept",
      title: "Second",
      compiled_truth: "Updated body.",
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("Second");
    expect(second.compiled_truth).toBe("Updated body.");
  });
});

describe("gbrain contract: getPage", () => {
  it("returns the full Page shape for an existing slug", async () => {
    await seedPage("get-page-target", { title: "Get Target" });
    const page = await engine.getPage("get-page-target");

    expect(page).not.toBeNull();
    expect(page).toMatchObject({
      slug: "get-page-target",
      title: "Get Target",
      type: "concept",
    });
    expect(page!.compiled_truth.length).toBeGreaterThan(0);
    expect(typeof page!.id).toBe("number");
    expect(page!.frontmatter).toBeDefined();
    expect(typeof page!.timeline).toBe("string");
  });

  it("returns null for a missing slug (does not throw)", async () => {
    const page = await engine.getPage("definitely-not-a-real-slug-xyz-123");
    expect(page).toBeNull();
  });
});

describe("gbrain contract: listPages", () => {
  it("returns Page[] and honors type/limit filters ScienceSwarm passes", async () => {
    await seedPage("list-concept-one", { title: "List Concept One" });
    await seedPage("list-concept-two", { title: "List Concept Two" });
    await seedPage("list-note", {
      type: "note",
      title: "List Note",
      compiled_truth: "Note body.",
    });

    const concepts = await engine.listPages({ type: "concept", limit: 10 });
    expect(Array.isArray(concepts)).toBe(true);
    expect(concepts.some((page) => page.slug === "list-concept-one")).toBe(true);
    expect(concepts.some((page) => page.slug === "list-note")).toBe(false);

    const limited = await engine.listPages({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({
      slug: expect.any(String),
      title: expect.any(String),
      compiled_truth: expect.any(String),
    });
  });
});

describe("gbrain contract: searchKeyword", () => {
  it("returns SearchResult[] with slug/title/type/chunk identity/score/stale fields", async () => {
    await seedPage("kw-target", {
      title: "Keyword Target",
      compiled_truth: "Sparse autoencoders learn monosemantic features.",
    });
    await engine.upsertChunks("kw-target", [
      {
        chunk_index: 0,
        chunk_text: "Sparse autoencoders learn monosemantic features.",
        chunk_source: "compiled_truth",
      },
    ]);

    const results = await engine.searchKeyword("monosemantic", { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    const top = results[0];
    expect(top).toMatchObject({
      slug: "kw-target",
      title: "Keyword Target",
      type: "concept",
      chunk_source: "compiled_truth",
      source_id: "default",
    });
    expect(typeof top.page_id).toBe("number");
    expect(typeof top.chunk_id).toBe("number");
    expect(top.chunk_id).toBeGreaterThan(0);
    expect(top.chunk_index).toBe(0);
    expect(typeof top.score).toBe("number");
    expect(typeof top.stale).toBe("boolean");
    expect(top.chunk_text).toContain("monosemantic");
  });

  it("accepts the v0.10 detail option and low detail limits results to compiled_truth chunks", async () => {
    await seedPage("kw-detail-target", {
      title: "Detail Target",
      compiled_truth: "Monosemantic sparse autoencoders are useful for interpretability.",
      timeline: "2026-04-16: Monosemantic timeline note.",
    });
    await engine.upsertChunks("kw-detail-target", [
      {
        chunk_index: 0,
        chunk_text: "Monosemantic sparse autoencoders are useful for interpretability.",
        chunk_source: "compiled_truth",
      },
      {
        chunk_index: 1,
        chunk_text: "2026-04-16: Monosemantic timeline note.",
        chunk_source: "timeline",
      },
    ]);

    for (const detail of ["low", "medium", "high"] as const) {
      const results = await engine.searchKeyword("monosemantic", { limit: 10, detail });
      expect(Array.isArray(results), `detail=${detail} should return an array`).toBe(true);
    }

    const lowResults = await engine.searchKeyword("monosemantic", { limit: 10, detail: "low" });
    expect(lowResults.length).toBeGreaterThan(0);
    expect(lowResults.every((result) => result.chunk_source === "compiled_truth")).toBe(true);
  });

  it("returns an empty array for a query with no hits (does not throw)", async () => {
    const results = await engine.searchKeyword("zzzznothingmatchesthisquery", { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });
});

describe("gbrain contract: getEmbeddingsByChunkIds", () => {
  it("returns an empty Map for empty input", async () => {
    const embeddings = await engine.getEmbeddingsByChunkIds([]);
    expect(embeddings).toBeInstanceOf(Map);
    expect(embeddings.size).toBe(0);
  });

  it("returns stored embeddings keyed by chunk_id", async () => {
    const embedding = new Float32Array(1536);
    embedding[0] = 0.125;
    embedding[1535] = 0.5;

    await seedPage("embedding-lookup-target", {
      title: "Embedding Lookup Target",
      compiled_truth: "Chunk identity lets search re-rank exact evidence.",
    });
    await engine.upsertChunks("embedding-lookup-target", [
      {
        chunk_index: 0,
        chunk_text: "Chunk identity lets search re-rank exact evidence.",
        chunk_source: "compiled_truth",
        embedding,
        model: "contract-test",
        token_count: 8,
      },
    ]);

    const [top] = await engine.searchKeyword("evidence", { limit: 1 });
    expect(top.chunk_id).toBeGreaterThan(0);

    const embeddings = await engine.getEmbeddingsByChunkIds([top.chunk_id]);
    expect(embeddings).toBeInstanceOf(Map);
    expect(embeddings.has(top.chunk_id)).toBe(true);
    expect(embeddings.get(top.chunk_id)?.length).toBe(1536);
  });
});

describe("gbrain contract: searchVector", () => {
  it("returns SearchResult[] when called with a Float32Array embedding", async () => {
    // Seed a page + chunk with an embedding so vector search has something to find.
    // gbrain's PGLite engine uses 1536-dim vectors (see pglite-schema config:
    // embedding_dimensions=1536). The contract we care about here is shape-only.
    // We assert the call accepts a Float32Array and returns the right shape —
    // even if the result is empty because no embeddings have been stored, the
    // empty-array contract still tells us the API is alive and the return
    // shape is unchanged.
    const dummy = new Float32Array(1536);
    dummy[0] = 0.1;

    const results = await engine.searchVector(dummy, { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // No chunks have embeddings yet, so we expect an empty array. This still
    // pins: (a) the method accepts Float32Array, (b) it accepts SearchOpts,
    // (c) it returns an array (not undefined, not an object).
    expect(results.length).toBe(0);
  });
});

describe("gbrain contract: addTimelineEntry", () => {
  it("appends an entry that getTimeline returns with date/summary/source/detail fields", async () => {
    await seedPage("timeline-target");
    await engine.addTimelineEntry("timeline-target", {
      date: "2026-04-13",
      source: "contract-test",
      summary: "Pinned timeline entry summary",
      detail: "Pinned detail body",
    });

    const entries = await engine.getTimeline("timeline-target", { limit: 10 });
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(1);
    const entry = entries[0];
    expect(entry).toMatchObject({
      source: "contract-test",
      summary: "Pinned timeline entry summary",
      detail: "Pinned detail body",
    });
    expect(typeof entry.page_id).toBe("number");
    expect(entry.date).toBeDefined();
    expect(entry.created_at).toBeDefined();
  });
});

describe("gbrain contract: addLink", () => {
  it("creates a link that getLinks/getBacklinks return with from_slug/to_slug/link_type/context", async () => {
    await seedPage("link-from", { title: "From" });
    await seedPage("link-to", { title: "To" });

    await engine.addLink("link-from", "link-to", "mentions", "supports");

    const outgoing = await engine.getLinks("link-from");
    expect(Array.isArray(outgoing)).toBe(true);
    expect(outgoing.length).toBe(1);
    expect(outgoing[0]).toMatchObject({
      from_slug: "link-from",
      to_slug: "link-to",
      link_type: "supports",
      context: "mentions",
    });

    const incoming = await engine.getBacklinks("link-to");
    expect(incoming.length).toBe(1);
    expect(incoming[0]).toMatchObject({
      from_slug: "link-from",
      to_slug: "link-to",
    });
  });

  it("addLink accepts the minimal 2-argument form (no context, no linkType)", async () => {
    await seedPage("link-min-from");
    await seedPage("link-min-to");
    await expect(engine.addLink("link-min-from", "link-min-to")).resolves.toBeUndefined();
  });
});

describe("gbrain contract: getHealth", () => {
  it("returns a BrainHealth object with the numeric fields ScienceSwarm reads", async () => {
    const health = await engine.getHealth();
    expect(health).toMatchObject({
      page_count: expect.any(Number),
      embed_coverage: expect.any(Number),
      stale_pages: expect.any(Number),
      orphan_pages: expect.any(Number),
      dead_links: expect.any(Number),
      missing_embeddings: expect.any(Number),
      brain_score: expect.any(Number),
    });
  });
});

describe("gbrain contract: getStats", () => {
  it("returns a BrainStats object with page_count and pages_by_type", async () => {
    await seedPage("stats-page-1");
    await seedPage("stats-page-2", { title: "Stats Two" });

    const stats = await engine.getStats();
    expect(stats).toMatchObject({
      page_count: expect.any(Number),
      chunk_count: expect.any(Number),
      embedded_count: expect.any(Number),
      link_count: expect.any(Number),
      tag_count: expect.any(Number),
      timeline_entry_count: expect.any(Number),
    });
    expect(stats.page_count).toBeGreaterThanOrEqual(2);
    expect(typeof stats.pages_by_type).toBe("object");
    expect(stats.pages_by_type).not.toBeNull();
    // pages_by_type is a Record<string, number> keyed by page type.
    expect(stats.pages_by_type.concept).toBeGreaterThanOrEqual(2);
  });
});

describe("gbrain contract: config", () => {
  it("round-trips config values and returns null for missing keys", async () => {
    await expect(engine.getConfig("science.missing")).resolves.toBeNull();
    await engine.setConfig("science.repo_path", "/tmp/scienceswarm-brain");
    await expect(engine.getConfig("science.repo_path")).resolves.toBe(
      "/tmp/scienceswarm-brain",
    );
  });
});

describe("gbrain contract: disconnect", () => {
  it("disconnect resolves cleanly and a fresh engine can be created afterward", async () => {
    await seedPage("disconnect-target");
    await engine.disconnect();

    // Re-create so afterEach's disconnect does not double-close.
    engine = (await createRuntimeEngine({
      engine: "pglite",
    })) as unknown as BrainEngineLike;
    await engine.connect({ engine: "pglite" });
    await engine.initSchema();

    // Fresh in-memory engine: previous data must NOT be present.
    const page = await engine.getPage("disconnect-target");
    expect(page).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Behavioral assertions (Spec 3)
//
// Everything above this line pins *shape* — method exists, return has
// these fields, arguments accepted. Everything below pins *behavior* —
// the operations do what ScienceSwarm assumes. A gbrain pin bump can
// ship a compatible shape with different semantics (e.g. `putPage`
// wipes timeline entries, `addTimelineEntry` silently deduplicates),
// and those drifts only surface as runtime bugs unless something
// pins them. These tests are that something.
// ══════════════════════════════════════════════════════════════════

// `putPage` alone is invisible to keyword search (pinned as behavior 2),
// so tests that exercise searchKeyword must seed chunks too.
async function seedPageWithChunks(
  slug: string,
  overrides: Partial<PageInputLike> = {},
): Promise<PageLike> {
  const page = await seedPage(slug, overrides);
  await engine.upsertChunks(slug, [
    {
      chunk_index: 0,
      chunk_text: page.compiled_truth,
      chunk_source: "compiled_truth",
    },
  ]);
  return page;
}

describe("gbrain contract behaviors: putPage", () => {
  it("1. preserves timeline_entries across a subsequent putPage upsert", async () => {
    // putPage writes to `pages`; addTimelineEntry writes to the separate
    // `timeline_entries` table keyed by page_id FK. A pin bump that made
    // putPage cascade-delete timeline entries would be a silent data-loss
    // regression that shape pinning alone cannot catch.
    await seedPage("behavior-put-timeline", { title: "T1", compiled_truth: "initial" });
    await engine.addTimelineEntry("behavior-put-timeline", {
      date: "2026-04-14",
      source: "seed",
      summary: "first event",
      detail: "",
    });

    // Upsert the page body; timeline_entries must survive.
    await engine.putPage("behavior-put-timeline", {
      type: "concept",
      title: "T1",
      compiled_truth: "updated body",
      timeline: "",
      frontmatter: {},
    });

    const entries = await engine.getTimeline("behavior-put-timeline", { limit: 10 });
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({ summary: "first event", source: "seed" });

    const page = await engine.getPage("behavior-put-timeline");
    expect(page!.compiled_truth).toBe("updated body");
  });

  it("2. putPage without upsertChunks is invisible to searchKeyword (Track C.1 hard contract)", async () => {
    // The production-load-bearing gotcha: `putPage` does NOT auto-chunk.
    // A page exists in `pages` but not in `content_chunks`, and searchKeyword
    // INNER JOINs chunks, so the page is silently unfindable. This contract
    // is what makes `seedBrainPage` (tests/helpers/test-brain.ts) have to
    // wrap putPage + upsertChunks in a single transaction. Pin it so any
    // future "searchKeyword now falls back to page-level text" upstream
    // change fires loudly.
    await engine.putPage("behavior-no-chunks", {
      type: "concept",
      title: "Unique xyzzyplover title",
      compiled_truth: "body mentioning xyzzyplover nowhere else",
      timeline: "",
      frontmatter: {},
    });

    const before = await engine.searchKeyword("xyzzyplover", { limit: 5 });
    expect(before).toEqual([]);

    await engine.upsertChunks("behavior-no-chunks", [
      {
        chunk_index: 0,
        chunk_text: "body mentioning xyzzyplover nowhere else",
        chunk_source: "compiled_truth",
      },
    ]);

    const after = await engine.searchKeyword("xyzzyplover", { limit: 5 });
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].slug).toBe("behavior-no-chunks");
  });

  it("9. persists content_hash through putPage → getPage (production idempotency contract)", async () => {
    // ScienceSwarm's importCorpus skip check (src/brain/stores/gbrain-engine-adapter.ts)
    // reads `existing.content_hash` to decide whether to re-ingest. If the gbrain
    // engine ever stopped persisting or returning content_hash, that skip would
    // silently become a no-op and every import would rewrite every page.
    // At the engine layer we pin: putPage accepts content_hash, getPage returns
    // the same value, and overwrites replace it. The higher-level importCorpus
    // skip contract is covered in tests/integration/gbrain-engine-adapter.test.ts.
    const first = (await engine.putPage("behavior-content-hash", {
      type: "concept",
      title: "CH",
      compiled_truth: "hash body",
      timeline: "",
      frontmatter: {},
      content_hash: "sha256-abc123",
    }));
    expect(first.content_hash).toBe("sha256-abc123");

    const fetched = await engine.getPage("behavior-content-hash");
    expect(fetched).not.toBeNull();
    expect(fetched!.content_hash).toBe("sha256-abc123");

    // Overwriting with a new hash updates the stored value — this is the
    // other half of the contract (import reads it, import writes it).
    const second = (await engine.putPage("behavior-content-hash", {
      type: "concept",
      title: "CH",
      compiled_truth: "hash body changed",
      timeline: "",
      frontmatter: {},
      content_hash: "sha256-def456",
    }));
    expect(second.id).toBe(first.id);
    expect(second.content_hash).toBe("sha256-def456");
  });
});

describe("gbrain contract behaviors: timeline", () => {
  // gbrain v0.16 adds a timeline dedup index and ON CONFLICT handling, so
  // ScienceSwarm can now enforce the idempotent append behavior its capture
  // paths already assumed.
  it("3. addTimelineEntry is idempotent by (page, date, summary)", async () => {
    await seedPage("behavior-timeline-idem");
    const entry = {
      date: "2026-04-14",
      source: "test",
      summary: "duplicate-me",
      detail: "",
    };
    await engine.addTimelineEntry("behavior-timeline-idem", entry);
    await engine.addTimelineEntry("behavior-timeline-idem", entry);

    const rows = await engine.getTimeline("behavior-timeline-idem", { limit: 10 });
    expect(rows.filter((e) => e.summary === "duplicate-me")).toHaveLength(1);
  });

  it("10. concurrent addTimelineEntry calls serialize and both rows persist", async () => {
    // Bridge to Spec 7 (concurrent writer stress). The weaker-but-still-useful
    // contract: two overlapping inserts into the same page do not clobber each
    // other, do not throw, and both end up visible via getTimeline.
    await seedPage("behavior-timeline-concurrent");

    await Promise.all([
      engine.addTimelineEntry("behavior-timeline-concurrent", {
        date: "2026-04-14",
        source: "a",
        summary: "event-one",
        detail: "",
      }),
      engine.addTimelineEntry("behavior-timeline-concurrent", {
        date: "2026-04-14",
        source: "b",
        summary: "event-two",
        detail: "",
      }),
    ]);

    const rows = await engine.getTimeline("behavior-timeline-concurrent", { limit: 10 });
    const summaries = rows.map((r) => r.summary).sort();
    expect(summaries).toEqual(["event-one", "event-two"]);
  });
});

describe("gbrain contract behaviors: links", () => {
  it("4. addLink is idempotent on repeat (from, to, linkType) — only one row", async () => {
    await seedPage("behavior-link-a");
    await seedPage("behavior-link-b");

    await engine.addLink("behavior-link-a", "behavior-link-b", undefined, "cites");
    await engine.addLink("behavior-link-a", "behavior-link-b", undefined, "cites");

    const outgoing = await engine.getLinks("behavior-link-a");
    const matching = outgoing.filter(
      (l) => l.to_slug === "behavior-link-b" && l.link_type === "cites",
    );
    expect(matching).toHaveLength(1);
  });

  it("5. addLink creates a bidirectional back-link visible through getBacklinks", async () => {
    await seedPage("behavior-backlink-from");
    await seedPage("behavior-backlink-to");

    await engine.addLink("behavior-backlink-from", "behavior-backlink-to", undefined, "cites");

    const backlinks = await engine.getBacklinks("behavior-backlink-to");
    expect(backlinks.length).toBeGreaterThan(0);
    expect(backlinks.some((l) => l.from_slug === "behavior-backlink-from")).toBe(true);
  });
});

describe("gbrain contract behaviors: search", () => {
  it("6. searchKeyword returns chunk-grain body matches", async () => {
    // v0.21 moves keyword search from page search_vector to
    // content_chunks.search_vector. A title-only hit is no longer enough;
    // callers should expect matched chunk metadata from body/chunk content.
    await seedPageWithChunks("behavior-rank-body-a", {
      title: "Mechanistic interpretability primer",
      compiled_truth: "Monosemantic neurons appear in sparse feature circuits.",
    });
    await seedPageWithChunks("behavior-rank-body-b", {
      title: "Weather forecasting primer",
      compiled_truth: "A long discussion that happens to mention monosemantic features once.",
    });
    await seedPageWithChunks("behavior-rank-title-only", {
      title: "monosemantic neurons explained",
      compiled_truth: "Some unrelated filler text about weather patterns.",
    });

    const results = await engine.searchKeyword("monosemantic", { limit: 5 });
    expect(results.length).toBeGreaterThanOrEqual(2);
    const slugs = results.map((result) => result.slug);
    expect(slugs).toContain("behavior-rank-body-a");
    expect(slugs).toContain("behavior-rank-body-b");
    expect(slugs).not.toContain("behavior-rank-title-only");
    expect(results.every((result) => /monosemantic/i.test(result.chunk_text))).toBe(true);
  });

  it("7. searchVector with a zero vector returns [] (no hits, no error)", async () => {
    // gbrain PGLite engine uses 1536-dim vectors (pglite-schema config:
    // embedding_dimensions=1536). With no chunks having embeddings, the
    // query returns an empty array — the contract we pin is
    // "no throw, empty result" for the degenerate input.
    const zero = new Float32Array(1536);
    const results = await engine.searchVector(zero, { limit: 10 });
    expect(Array.isArray(results)).toBe(true);
    expect(results).toEqual([]);
  });
});

describe("gbrain contract behaviors: transactions", () => {
  it("8. transaction rollback on throw leaves no trace in pages", async () => {
    // The importCorpus path wraps every page write in engine.transaction(),
    // relying on "throw inside the callback = full rollback". If a pin bump
    // changed transaction semantics to auto-commit partial work on error,
    // every partial import would leave half-written pages behind.
    await expect(
      engine.transaction(async (tx) => {
        await tx.putPage("behavior-tx-abort", {
          type: "concept",
          title: "Should not persist",
          compiled_truth: "rolled back body",
          timeline: "",
          frontmatter: {},
        });
        // Sanity: within the tx, the page IS visible to the tx engine.
        const inTx = await tx.getPage("behavior-tx-abort");
        expect(inTx).not.toBeNull();
        throw new Error("intentional-rollback");
      }),
    ).rejects.toThrow("intentional-rollback");

    // After the throw, outer engine must not see the page.
    const after = await engine.getPage("behavior-tx-abort");
    expect(after).toBeNull();
  });
});
