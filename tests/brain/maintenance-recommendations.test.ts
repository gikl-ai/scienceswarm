import { describe, expect, it } from "vitest";
import {
  buildBrainMaintenancePlan,
  type BrainMaintenanceRecommendation,
} from "@/brain/maintenance-recommendations";
import type { BrainHealthReport } from "@/brain/brain-health";

function makeReport(overrides: Partial<BrainHealthReport> = {}): BrainHealthReport {
  return {
    generatedAt: "2026-04-16T00:00:00.000Z",
    source: "gbrain",
    score: 72,
    brainScore: 72,
    embedCoverage: 0.65,
    issueCounts: {
      stalePages: 2,
      orphanPages: 3,
      deadLinks: 1,
      missingEmbeddings: 4,
    },
    coverage: {
      totalPages: 10,
      papersWithAbstracts: 0,
      papersWithoutAbstracts: 0,
      papersWithCitations: 0,
      authorPagesCount: 0,
      conceptPagesCount: 0,
      coveragePercent: 65,
    },
    orphans: [],
    stalePages: [],
    missingLinks: [],
    embeddingGaps: 4,
    suggestions: [],
    ...overrides,
  };
}

function ids(
  recommendations: BrainMaintenanceRecommendation[],
): string[] {
  return recommendations.map((recommendation) => recommendation.id);
}

describe("buildBrainMaintenancePlan", () => {
  it("turns gbrain health gaps into ranked recommendations", () => {
    const plan = buildBrainMaintenancePlan(makeReport());

    expect(plan.signals).toMatchObject({
      score: 72,
      embedCoverage: 0.65,
      stalePages: 2,
      orphanPages: 3,
      deadLinks: 1,
      missingEmbeddings: 4,
    });
    expect(ids(plan.recommendations)).toEqual([
      "refresh-embeddings",
      "compile-stale-pages",
      "extract-links",
      "repair-dead-links",
    ]);
    expect(plan.recommendations[0]).toMatchObject({
      priority: "high",
      category: "search",
      approvalRequired: true,
      automatable: true,
    });
  });

  it("ports gbrain feature signals into ScienceSwarm recommendations", () => {
    const plan = buildBrainMaintenancePlan(
      makeReport({
        score: 88,
        brainScore: 88,
        embedCoverage: 0.92,
        issueCounts: {
          stalePages: 0,
          orphanPages: 0,
          deadLinks: 0,
          missingEmbeddings: 0,
        },
        embeddingGaps: 0,
        stats: {
          linkCount: 0,
          timelineEntryCount: 0,
          syncRepoPath: null,
        },
      }),
      {
        integrations: [
          { id: "gmail", label: "Gmail", configured: false },
          { id: "zotero", label: "Zotero", configured: true },
        ],
        syncConfigured: false,
      },
    );

    expect(plan.signals).toMatchObject({
      linkCount: 0,
      timelineEntryCount: 0,
      unconfiguredIntegrations: ["Gmail"],
      syncConfigured: false,
    });
    expect(ids(plan.recommendations)).toEqual([
      "extract-links",
      "extract-timeline",
      "configure-sync",
      "configure-integrations",
    ]);
  });

  it("uses disk fallback counts when native issue counts are absent", () => {
    const plan = buildBrainMaintenancePlan(
      makeReport({
        source: "disk-fallback",
        issueCounts: undefined,
        embedCoverage: undefined,
        orphans: [
          { path: "wiki/orphan.md", title: "Orphan", reason: "No backlinks" },
        ],
        stalePages: [
          {
            path: "wiki/stale.md",
            title: "Stale",
            daysSinceUpdate: 45,
            suggestedAction: "Update Compiled-Truth",
          },
        ],
        missingLinks: [
          {
            sourcePage: "wiki/source.md",
            mentionedEntity: "Target",
            suggestedTarget: "wiki/target.md",
          },
        ],
        embeddingGaps: 0,
      }),
    );

    expect(plan.signals).toMatchObject({
      stalePages: 1,
      orphanPages: 1,
      deadLinks: 1,
      missingEmbeddings: 0,
      missingLinkCandidates: 1,
    });
    expect(ids(plan.recommendations)).toContain("extract-links");
  });

  it("returns a no-action recommendation for healthy brains", () => {
    const plan = buildBrainMaintenancePlan(
      makeReport({
        score: 95,
        brainScore: 95,
        embedCoverage: 0.99,
        issueCounts: {
          stalePages: 0,
          orphanPages: 0,
          deadLinks: 0,
          missingEmbeddings: 0,
        },
        embeddingGaps: 0,
      }),
    );

    expect(plan.recommendations).toHaveLength(1);
    expect(plan.recommendations[0]).toMatchObject({
      id: "no-action",
      approvalRequired: false,
      automatable: false,
    });
  });
});
