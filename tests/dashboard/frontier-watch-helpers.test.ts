import { describe, expect, it } from "vitest";
import {
  applyObjectiveToWatchConfig,
  buildArxivQuery,
  extractKeywordsFromObjective,
  summarizeWatchConfig,
} from "@/components/settings/frontier-watch-helpers";

describe("frontier watch helpers", () => {
  it("extracts stable keywords from a natural-language objective", () => {
    expect(
      extractKeywordsFromObjective(
        "Track daily CRISPR sequencing papers and lab feeds for primer design.",
      ),
    ).toEqual(["crispr sequencing", "primer design"]);
  });

  it("adds a web-search source and optional legacy sources when applying an objective", () => {
    const next = applyObjectiveToWatchConfig(
      {
        version: 1,
        keywords: [],
        promotionThreshold: 5,
        stagingThreshold: 2,
        sources: [],
      },
      "Watch CRISPR sequencing updates and https://example.com/feed.xml for primer design.",
      "Alpha Project",
    );

    expect(next.keywords).toEqual(["crispr sequencing", "primer design"]);
    expect(next.sources).toHaveLength(3);
    expect(next.sources.find((source) => source.type === "web_search")?.query).toContain("Search for and compile");
    expect(next.sources.find((source) => source.type === "rss")?.url).toBe("https://example.com/feed.xml");
    expect(next.sources.find((source) => source.type === "arxiv")?.query).toBe(
      buildArxivQuery(["crispr sequencing", "primer design"]),
    );
    expect(next.compiledPrompt).toContain("Top Stories");
  });

  it("refreshes generated sources when re-applying an objective", () => {
    const first = applyObjectiveToWatchConfig(
      {
        version: 1,
        keywords: [],
        promotionThreshold: 5,
        stagingThreshold: 2,
        sources: [],
      },
      "Watch CRISPR sequencing updates and https://example.com/feed.xml.",
      "Alpha Project",
    );

    const next = applyObjectiveToWatchConfig(
      first,
      "Watch protein design breakthroughs and https://example.com/updated.xml).",
      "Alpha Project",
    );

    expect(next.sources.filter((source) => source.type === "web_search")).toHaveLength(1);
    expect(next.sources.filter((source) => source.type === "arxiv")).toHaveLength(1);
    expect(next.sources.find((source) => source.type === "web_search")?.query).toContain("protein design");
    expect(next.sources.find((source) => source.type === "arxiv")?.query).toContain("protein design");
    expect(next.sources.find((source) => source.type === "rss" && source.url === "https://example.com/updated.xml")).toBeDefined();
  });

  it("summarizes the configured watch in plain language", () => {
    expect(
      summarizeWatchConfig(
        {
          version: 1,
          keywords: ["crispr sequencing", "primer design"],
          promotionThreshold: 5,
          stagingThreshold: 2,
          sources: [],
        },
        "Alpha Project",
      ),
    ).toContain("Alpha Project");
  });
});
