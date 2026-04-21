import { describe, it, expect } from "vitest";
import {
  createTestBrain,
  destroyTestBrain,
  readBrainPage,
  searchBrainKeyword,
  seedBrainPage,
} from "./test-brain";
import { writeCorpusToDisk, AI_RESEARCHER_CORPUS } from "./test-corpus";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("test helpers", () => {
  it("creates and destroys a test brain", async () => {
    const ctx = await createTestBrain();
    expect(existsSync(join(ctx.brainRoot, "wiki/projects"))).toBe(true);
    const health = await ctx.adapter.health();
    expect(health.ok).toBe(true);
    await destroyTestBrain(ctx);
    expect(existsSync(ctx.brainRoot)).toBe(false);
  });

  it("writes corpus files to disk", async () => {
    const ctx = await createTestBrain();
    const corpusDir = join(ctx.brainRoot, "raw/imports/test-corpus");
    writeCorpusToDisk(corpusDir);
    expect(existsSync(join(corpusDir, "notes/sae-ideas.md"))).toBe(true);
    expect(existsSync(join(corpusDir, "papers/topk-saes.md"))).toBe(true);
    expect(existsSync(join(corpusDir, "data/probe-results.csv"))).toBe(true);
    expect(AI_RESEARCHER_CORPUS.length).toBe(5);
    await destroyTestBrain(ctx);
  });

  // Track C.1: the gbrain-first helpers (`seedBrainPage`, `readBrainPage`,
  // `searchBrainKeyword`) are the migration target for downstream tests.
  // This test pins the round-trip so future test migrations have a
  // reference shape to copy from.
  it("seeds, reads, and searches gbrain pages via the helpers", async () => {
    const ctx = await createTestBrain();
    try {
      await seedBrainPage(ctx, {
        slug: "sae-interpretation",
        type: "concept",
        title: "Sparse Autoencoder Interpretation",
        compiledTruth:
          "Sparse autoencoders decompose model activations into interpretable features.",
        timeline: "Initial draft seeded by Track C.1 round-trip test.",
        frontmatter: { para: "concepts", privacy: "cloud-ok" },
      });

      const page = await readBrainPage(ctx, "sae-interpretation");
      expect(page).not.toBeNull();
      expect(page?.slug).toBe("sae-interpretation");
      expect(page?.type).toBe("concept");
      expect(page?.title).toBe("Sparse Autoencoder Interpretation");
      expect(page?.compiled_truth).toContain("decompose model activations");
      expect(page?.timeline).toContain("Track C.1");

      const results = await searchBrainKeyword(ctx, "autoencoder", { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.slug === "sae-interpretation")).toBe(true);
    } finally {
      await destroyTestBrain(ctx);
    }
  });
});
