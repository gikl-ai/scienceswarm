import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScienceSwarmMaintenanceContext } from "@/brain/maintenance-context";
import type { BrainHealthReport } from "@/brain/brain-health";

function makeReport(
  overrides: Partial<BrainHealthReport> = {},
): BrainHealthReport {
  return {
    generatedAt: "2026-04-16T00:00:00.000Z",
    source: "gbrain",
    score: 95,
    brainScore: 95,
    embedCoverage: 0.99,
    issueCounts: {
      stalePages: 0,
      orphanPages: 0,
      deadLinks: 0,
      missingEmbeddings: 0,
    },
    coverage: {
      totalPages: 10,
      papersWithAbstracts: 0,
      papersWithoutAbstracts: 0,
      papersWithCitations: 0,
      authorPagesCount: 0,
      conceptPagesCount: 0,
      coveragePercent: 100,
    },
    orphans: [],
    stalePages: [],
    missingLinks: [],
    embeddingGaps: 0,
    suggestions: [],
    ...overrides,
  };
}

describe("buildScienceSwarmMaintenanceContext", () => {
  it("preserves unknown sync state when gbrain omits sync repo metadata", () => {
    const context = buildScienceSwarmMaintenanceContext(
      makeReport({ stats: {} }),
      {},
    );

    expect(context.syncConfigured).toBeUndefined();
  });

  it("detects configured sync only from a non-empty repo path", () => {
    expect(
      buildScienceSwarmMaintenanceContext(
        makeReport({ stats: { syncRepoPath: "/research/brain" } }),
        {},
      ).syncConfigured,
    ).toBe(true);

    expect(
      buildScienceSwarmMaintenanceContext(
        makeReport({ stats: { syncRepoPath: "  " } }),
        {},
      ).syncConfigured,
    ).toBe(false);
  });

  it("detects legacy research homes when a brain root is provided", () => {
    const root = mkdtempSync(join(tmpdir(), "scienceswarm-maintenance-context-"));
    try {
      mkdirSync(join(root, "concepts"), { recursive: true });
      mkdirSync(join(root, "wiki", "entities", "papers"), { recursive: true });
      writeFileSync(join(root, "concepts", "rlhf.md"), "# RLHF\n", "utf-8");
      writeFileSync(
        join(root, "wiki", "entities", "papers", "smith-2026.md"),
        "# Smith 2026\n",
        "utf-8",
      );

      const context = buildScienceSwarmMaintenanceContext(
        makeReport(),
        {},
        root,
      );

      expect(context.researchLayout).toMatchObject({
        legacyHomesDetected: 2,
        legacyPagesDetected: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
