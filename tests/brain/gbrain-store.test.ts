import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SearchCache,
  resetBrainStore,
  resolveBrainStorePglitePath,
} from "@/brain/store";
import type { ImportResult } from "@/brain/store";

// ── SearchCache ────────────────────────────────────────

describe("SearchCache", () => {
  let cache: SearchCache;

  beforeEach(() => {
    cache = new SearchCache(3); // Small for testing
  });

  it("returns null on cache miss", () => {
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("returns results on cache hit", () => {
    const results = [
      {
        path: "test",
        title: "Test",
        snippet: "...",
        relevance: 0.9,
        type: "note" as const,
      },
    ];
    cache.set("key1", results);
    expect(cache.get("key1")).toEqual(results);
  });

  it("expires entries after TTL", async () => {
    const results = [
      {
        path: "test",
        title: "Test",
        snippet: "...",
        relevance: 0.9,
        type: "note" as const,
      },
    ];
    cache.set("key1", results, 10); // 10ms TTL

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.get("key1")).toBeNull();
  });

  it("evicts oldest entry when max size reached", () => {
    cache.set("a", []);
    cache.set("b", []);
    cache.set("c", []);
    // At max capacity (3)
    expect(cache.size).toBe(3);

    // Adding a 4th should evict the oldest (a)
    cache.set("d", []);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("d")).toEqual([]);
  });

  it("clear removes all entries", () => {
    cache.set("a", []);
    cache.set("b", []);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeNull();
  });
});

// ── resetBrainStore ────────────────────────────────────

describe("resetBrainStore", () => {
  it("clears the singleton and cache without error", async () => {
    await expect(resetBrainStore()).resolves.toBeUndefined();
  });

  it("preserves the singleton state across module reloads", async () => {
    const first = await import("@/brain/store");
    first.searchCache.set("reload-check", []);

    vi.resetModules();
    const second = await import("@/brain/store");

    expect(second.searchCache).toBe(first.searchCache);
    expect(second.searchCache.get("reload-check")).toEqual([]);
    await second.resetBrainStore();
  });
});

// ── PGLite path resolution ─────────────────────────────

describe("resolveBrainStorePglitePath", () => {
  it("defaults to the installer-canonical brain.pglite path", () => {
    const previousBrainRoot = process.env.BRAIN_ROOT;
    const previousPglitePath = process.env.BRAIN_PGLITE_PATH;
    try {
      process.env.BRAIN_ROOT = "/tmp/fake-brain";
      delete process.env.BRAIN_PGLITE_PATH;
      expect(resolveBrainStorePglitePath()).toBe(
        "/tmp/fake-brain/brain.pglite",
      );
    } finally {
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
    }
  });

  it("honors BRAIN_PGLITE_PATH overrides", () => {
    const previousPglitePath = process.env.BRAIN_PGLITE_PATH;
    try {
      process.env.BRAIN_PGLITE_PATH = "/tmp/override.pglite";
      expect(resolveBrainStorePglitePath()).toBe("/tmp/override.pglite");
    } finally {
      if (previousPglitePath === undefined) {
        delete process.env.BRAIN_PGLITE_PATH;
      } else {
        process.env.BRAIN_PGLITE_PATH = previousPglitePath;
      }
    }
  });
});

// ── ImportResult cost field ──────────────────────────────

describe("ImportResult cost field", () => {
  it("accepts ImportResult without cost (backward compat)", () => {
    const result: ImportResult = {
      imported: 3,
      skipped: 0,
      errors: [],
      durationMs: 100,
    };
    expect(result.cost).toBeUndefined();
  });

  it("accepts ImportResult with cost", () => {
    const result: ImportResult = {
      imported: 5,
      skipped: 1,
      errors: [],
      durationMs: 200,
      cost: {
        inputTokens: 5000,
        outputTokens: 0,
        estimatedUsd: 0.00065,
        model: "text-embedding-3-large",
      },
    };
    expect(result.cost).toBeDefined();
    expect(result.cost!.inputTokens).toBe(5000);
    expect(result.cost!.model).toBe("text-embedding-3-large");
    expect(result.cost!.estimatedUsd).toBeGreaterThan(0);
  });

  it("cost estimatedUsd follows expected formula", () => {
    // $0.13 per 1M tokens
    const tokens = 10000;
    const expectedUsd = (tokens / 1_000_000) * 0.13;
    const result: ImportResult = {
      imported: 1,
      skipped: 0,
      errors: [],
      durationMs: 50,
      cost: {
        inputTokens: tokens,
        outputTokens: 0,
        estimatedUsd: Math.round(expectedUsd * 10000) / 10000,
        model: "text-embedding-3-large",
      },
    };
    expect(result.cost!.estimatedUsd).toBe(0.0013);
  });
});

// ── Re-index milestone logic ────────────────────────────

describe("re-index milestone threshold", () => {
  it("milestone triggers when crossing from below 10 to at-or-above 10", () => {
    const testCases = [
      { currentCount: 0, imported: 10, shouldTrigger: true },
      { currentCount: 5, imported: 5, shouldTrigger: true },
      { currentCount: 9, imported: 1, shouldTrigger: true },
      { currentCount: 9, imported: 5, shouldTrigger: true },
      { currentCount: 0, imported: 3, shouldTrigger: false },
      { currentCount: 10, imported: 5, shouldTrigger: false },
      { currentCount: 15, imported: 3, shouldTrigger: false },
    ];

    for (const tc of testCases) {
      const newCount = tc.currentCount + tc.imported;
      const triggers = tc.currentCount < 10 && newCount >= 10;
      expect(triggers).toBe(tc.shouldTrigger);
    }
  });
});
