import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateGbrainSuggestions,
  generateHealthReportWithGbrain,
} from "@/brain/brain-health";
import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";
import type { BrainConfig } from "@/brain/types";
import type { GbrainEngineAdapter } from "@/brain/stores/gbrain-engine-adapter";
import { createTestBrain, destroyTestBrain, type TestBrainContext } from "../helpers/test-brain";

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

async function seedSingletonPage(): Promise<void> {
  await ensureBrainStoreReady();
  const adapter = getBrainStore() as unknown as GbrainEngineAdapter;
  const engine = adapter.engine;
  await engine.putPage("concepts/gbrain-health", {
    type: "concept",
    title: "gbrain Health",
    compiled_truth: "gbrain health uses native brain_score metrics.",
    timeline: "",
    frontmatter: {},
  });
  await engine.upsertChunks("concepts/gbrain-health", [
    {
      chunk_index: 0,
      chunk_text: "gbrain health uses native brain_score metrics.",
      chunk_source: "compiled_truth",
    },
  ]);
}

describe("generateHealthReportWithGbrain", () => {
  let ctx: TestBrainContext | null = null;

  afterEach(async () => {
    if (ctx) {
      await destroyTestBrain(ctx);
      ctx = null;
    }
  });

  it("prefers gbrain health when the configured BrainStore database exists", async () => {
    ctx = await createTestBrain();
    await seedSingletonPage();
    mkdirSync(join(ctx.brainRoot, "wiki", "concepts"), { recursive: true });
    writeFileSync(
      join(ctx.brainRoot, "wiki", "concepts", "disk-only-stale.md"),
      [
        "---",
        "type: concept",
        "---",
        "",
        "# Disk Only Stale",
        "",
        "[Missing](missing.md)",
      ].join("\n"),
      "utf-8",
    );

    const report = await generateHealthReportWithGbrain(makeConfig(ctx.brainRoot));

    expect(report.source).toBe("gbrain");
    expect(report.score).toEqual(expect.any(Number));
    expect(report.brainScore).toBe(report.score);
    expect(report.embedCoverage).toEqual(expect.any(Number));
    expect(report.coverage.totalPages).toBe(1);
    expect(report.orphans).toEqual([]);
    expect(report.stalePages).toEqual([]);
    expect(report.missingLinks).toEqual([]);
    expect(report.embeddingGaps).toEqual(expect.any(Number));
    expect(report.stats).toEqual(
      expect.objectContaining({
        chunkCount: expect.any(Number),
        linkCount: expect.any(Number),
        timelineEntryCount: expect.any(Number),
      }),
    );
    expect(report.issueCounts).toEqual(
      expect.objectContaining({
        stalePages: expect.any(Number),
        orphanPages: expect.any(Number),
        deadLinks: expect.any(Number),
        missingEmbeddings: expect.any(Number),
      }),
    );
  });

  it("does not merge disk fallback suggestions into gbrain health guidance", async () => {
    ctx = await createTestBrain();
    await seedSingletonPage();
    mkdirSync(join(ctx.brainRoot, "wiki", "papers"), { recursive: true });
    writeFileSync(
      join(ctx.brainRoot, "wiki", "papers", "missing-abstract.md"),
      ["---", "type: paper", "---", "", "# Missing Abstract"].join("\n"),
      "utf-8",
    );

    const report = await generateHealthReportWithGbrain(makeConfig(ctx.brainRoot));

    expect(report.source).toBe("gbrain");
    expect(report.suggestions.join("\n")).not.toContain("paper(s) lack abstracts");
  });

  it("generates stale-page guidance from gbrain health signals", () => {
    const suggestions = generateGbrainSuggestions({
      ok: true,
      pageCount: 3,
      brainScore: 82,
      stalePages: 2,
    });

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("2 active page(s) are stale"),
      ]),
    );
  });

  it("falls back to the disk scanner when no gbrain database exists yet", async () => {
    ctx = await createTestBrain();
    mkdirSync(join(ctx.brainRoot, "wiki", "concepts"), { recursive: true });
    writeFileSync(
      join(ctx.brainRoot, "wiki", "concepts", "disk-only.md"),
      ["---", "type: concept", "---", "", "# Disk Only", "", "Fallback content."].join("\n"),
      "utf-8",
    );

    const report = await generateHealthReportWithGbrain(makeConfig(ctx.brainRoot));

    expect(report.source).toBe("disk-fallback");
    expect(report.coverage.totalPages).toBeGreaterThan(0);
  });
});
