import { describe, expect, it } from "vitest";
import { buildFallbackWatchPlan } from "@/lib/watch/compose";

describe("watch compose fallback", () => {
  it("normalizes awkward keyword fragments into cleaner concepts and entities", () => {
    const plan = buildFallbackWatchPlan({
      objective: "Watch for major model releases, frontier lab announcements, research breakthroughs, Anthropic, Google DeepMind.",
      now: new Date("2026-04-09T12:00:00.000Z"),
    });

    expect(plan.keywords).toEqual(expect.arrayContaining([
      "model releases",
      "frontier lab announcements",
      "research breakthroughs",
      "anthropic",
      "deepmind",
    ]));
    expect(plan.keywords).not.toContain("for major model releases");
    expect(plan.keywords).not.toContain("google deepmind");
  });

  it("builds search-native queries instead of sentence fragments", () => {
    const plan = buildFallbackWatchPlan({
      objective: "Track major model releases and reasoning agents from OpenAI, Anthropic, and Google DeepMind.",
      now: new Date("2026-04-09T12:00:00.000Z"),
    });

    expect(plan.searchQueries.every((query) => !query.startsWith("for "))).toBe(true);
    expect(plan.searchQueries.some((query) => query.includes("april 2026"))).toBe(true);
    expect(plan.searchQueries.some((query) => query.includes("deepmind"))).toBe(true);
  });

  it("preserves research-first output structures instead of forcing top stories", () => {
    const plan = buildFallbackWatchPlan({
      objective: "Watch for new papers, datasets, methods, and open-source releases. Output a research-first briefing with sections for Papers, Datasets, Methods, and Tools.",
      now: new Date("2026-04-09T12:00:00.000Z"),
    });

    expect(plan.compiledPrompt).toContain("Preserve the user's requested briefing structure");
    expect(plan.compiledPrompt).toContain("1. Papers");
    expect(plan.compiledPrompt).toContain("2. Datasets");
    expect(plan.compiledPrompt).toContain("3. Methods");
    expect(plan.compiledPrompt).toContain("4. Tools");
    expect(plan.compiledPrompt).not.toContain("Top Stories");
  });
});
