import { describe, expect, it } from "vitest";
import {
  buildEnrichmentCacheKey,
  getUsableCacheEntry,
  isSourcePaused,
  updateSourceHealth,
  upsertCacheEntry,
} from "@/lib/paper-library/enrichment-cache";
import { PAPER_LIBRARY_STATE_VERSION, type EnrichmentCacheStore } from "@/lib/paper-library/contracts";

function emptyCache(): EnrichmentCacheStore {
  return { version: PAPER_LIBRARY_STATE_VERSION, entries: {}, sourceHealth: {} };
}

describe("paper-library enrichment cache", () => {
  it("stores success entries without expiration", () => {
    const key = buildEnrichmentCacheKey("openalex", "10.1000/ABC");
    const cache = upsertCacheEntry(emptyCache(), {
      key,
      source: "openalex",
      status: "success",
      value: { title: "Paper" },
    });

    expect(cache.entries[key]).toMatchObject({
      source: "openalex",
      status: "success",
      value: { title: "Paper" },
      attempts: 1,
    });
    expect(cache.entries[key].expiresAt).toBeUndefined();
    expect(getUsableCacheEntry(cache, key)?.value).toEqual({ title: "Paper" });
  });

  it("stores short-lived negative entries", () => {
    const key = buildEnrichmentCacheKey("crossref", "missing title");
    const cache = upsertCacheEntry(emptyCache(), {
      key,
      source: "crossref",
      status: "negative",
      ttlMs: 10,
    });

    expect(cache.entries[key].expiresAt).toBeDefined();
    expect(getUsableCacheEntry(cache, key, new Date(Date.now() + 60_000))).toBeNull();
  });

  it("pauses repeatedly failing sources", () => {
    let cache = emptyCache();
    cache = updateSourceHealth(cache, { source: "openalex", status: "degraded", failure: true });
    cache = updateSourceHealth(cache, { source: "openalex", status: "degraded", failure: true });
    cache = updateSourceHealth(cache, { source: "openalex", status: "degraded", failure: true });

    expect(cache.sourceHealth.openalex).toMatchObject({
      status: "paused",
      consecutiveFailures: 3,
    });
    expect(isSourcePaused(cache, "openalex")).toBe(true);
  });
});

