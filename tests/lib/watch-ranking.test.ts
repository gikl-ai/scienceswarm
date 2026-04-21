import { describe, expect, it } from "vitest";
import { rankWatchItems } from "@/lib/watch/ranking";
import type { ProjectManifest } from "@/brain/types";
import type { ProjectWatchConfig } from "@/lib/watch/types";

const manifest: ProjectManifest = {
  version: 1,
  projectId: "alpha-project",
  slug: "alpha-project",
  title: "Alpha Project",
  privacy: "cloud-ok",
  status: "active",
  projectPagePath: "wiki/projects/alpha-project.md",
  sourceRefs: [{ kind: "import", ref: "crispr sequencing alpha project" }],
  decisionPaths: [],
  taskPaths: [],
  artifactPaths: [],
  frontierPaths: [],
  activeThreads: [],
  dedupeKeys: [],
  updatedAt: "2026-04-08T00:00:00.000Z",
};

const watchConfig: ProjectWatchConfig = {
  version: 1,
  keywords: ["crispr", "sequencing"],
  promotionThreshold: 5,
  stagingThreshold: 2,
  sources: [],
};

describe("watch ranking", () => {
  it("promotes high-signal items and stages lower-confidence matches", () => {
    const ranked = rankWatchItems({
      manifest,
      watchConfig,
      items: [
        {
          dedupeKey: "high",
          title: "CRISPR sequencing breakthrough for alpha project",
          summary: "A recent sequencing result directly relevant to alpha project planning.",
          url: "https://example.com/high",
          sourceLabel: "rss",
          publishedAt: new Date().toISOString(),
        },
        {
          dedupeKey: "low",
          title: "General lab tooling update",
          summary: "A broad update with only a light mention of sequencing.",
          url: "https://example.com/low",
          sourceLabel: "rss",
        },
      ],
    });

    expect(ranked[0].dedupeKey).toBe("high");
    expect(ranked[0].status).toBe("promoted");
    expect(ranked[1].dedupeKey).toBe("low");
    expect(ranked[1].status).toBe("staged");
  });

  it("does not let URL-shaped source refs inflate generic match scores", () => {
    const ranked = rankWatchItems({
      manifest: {
        ...manifest,
        sourceRefs: [{ kind: "external", ref: "https://example.com/paper" }],
      },
      watchConfig,
      items: [
        {
          dedupeKey: "generic",
          title: "General research update",
          summary: "Paper roundup from multiple labs.",
          url: "https://example.com/update",
          sourceLabel: "rss",
        },
      ],
    });

    expect(ranked).toEqual([]);
  });
});
