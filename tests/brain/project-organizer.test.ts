import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BrainPage, BrainStore } from "@/brain/store";
import type { BrainConfig, SearchInput, SearchResult, ContentType, IngestCost } from "@/brain/types";
import { buildProjectOrganizerReadout } from "@/brain/project-organizer";
import { buildArtifactSourceSnapshotFromPage } from "@/lib/artifact-source-snapshots";
import { writeProjectImportSummary } from "@/lib/state/project-import-summary";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

let testRoot = "";

function makeConfig(root: string): BrainConfig {
  return {
    root,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function makeStore(pages: BrainPage[]): BrainStore {
  return {
    async search(_input: SearchInput): Promise<SearchResult[]> {
      return [];
    },
    async getPage(): Promise<BrainPage | null> {
      return null;
    },
    async getTimeline(): Promise<Array<{ date: string; source?: string | null; summary: string; detail?: string | null }>> {
      return [];
    },
    async getLinks() {
      return [];
    },
    async getBacklinks() {
      return [];
    },
    async listPages(_filters?: { limit?: number; type?: ContentType }): Promise<BrainPage[]> {
      return pages;
    },
    async importCorpus(): Promise<{ imported: number; skipped: number; errors: Array<{ path: string; error: string }>; durationMs: number; cost?: IngestCost }> {
      return { imported: 0, skipped: 0, errors: [], durationMs: 0 };
    },
    async health() {
      return { ok: true, pageCount: pages.length };
    },
    async dispose() {},
  };
}

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true });
  }
  testRoot = "";
});

describe("buildProjectOrganizerReadout", () => {
  it("clusters candidate threads, finds duplicate project papers, and carries import summary forward", async () => {
    testRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-project-organizer-"));
    const config = makeConfig(testRoot);
    await writeProjectImportSummary(
      "alpha",
      {
        name: "alpha-archive",
        preparedFiles: 6,
        detectedItems: 8,
        duplicateGroups: 1,
        duplicateGroupDetails: [
          {
            id: "dup-1-hash-a",
            paths: ["papers/crispr-seq-a.pdf", "papers/crispr-seq-b.pdf"],
            reason: "Identical content hash abc123def456",
            hashPrefix: "abc123def456",
            contentType: "paper",
          },
        ],
        generatedAt: "2026-04-19T12:00:00.000Z",
        source: "background-local-import",
      },
      getProjectStateRootForBrainRoot("alpha", testRoot),
    );

    const originalPaperPage: BrainPage = {
      path: "wiki/entities/papers/crispr-seq-a",
      title: "CRISPR sequencing assay",
      type: "paper",
      content: "Original assay findings.",
      frontmatter: {
        project: "alpha",
        tags: ["crispr", "sequencing"],
        doi: "10.1000/alpha",
        relative_path: "papers/crispr-seq-a.pdf",
      },
    };
    const staleSnapshot = buildArtifactSourceSnapshotFromPage(originalPaperPage);

    const pages: BrainPage[] = [
      {
        ...originalPaperPage,
        content: "Updated assay findings with a new validation section.",
      },
      {
        path: "wiki/entities/papers/crispr-seq-b",
        title: "CRISPR sequencing assay duplicate copy",
        type: "paper",
        content: "",
        frontmatter: {
          project: "alpha",
          tags: ["crispr", "sequencing"],
          doi: "10.1000/alpha",
          relative_path: "papers/crispr-seq-b.pdf",
        },
      },
      {
        path: "wiki/tasks/validate-crispr-assay",
        title: "Validate CRISPR assay",
        type: "task",
        content: "",
        frontmatter: {
          project: "alpha",
          tags: ["crispr", "assay"],
        },
      },
      {
        path: "wiki/notes/seq-protocol",
        title: "Sequencing protocol prep",
        type: "note",
        content: "",
        frontmatter: {
          project: "alpha",
          tags: ["sequencing", "protocol"],
        },
      },
      {
        path: "wiki/entities/artifacts/openclaw-alpha-chart",
        title: "summary-chart.svg",
        type: "artifact",
        content: "# summary-chart.svg",
        frontmatter: {
          project: "alpha",
          relative_path: "figures/summary-chart.svg",
          uploaded_at: "2026-04-19T12:30:00.000Z",
          artifact_source_snapshots: [staleSnapshot],
        },
      },
      {
        path: "wiki/notes/beta-admin",
        title: "Beta admin note",
        type: "note",
        content: "",
        frontmatter: {
          project: "beta",
          tags: ["admin"],
        },
      },
    ];

    const readout = await buildProjectOrganizerReadout({
      config,
      project: "alpha",
      store: makeStore(pages),
    });

    expect(readout.project).toBe("alpha");
    expect(readout.pageCount).toBe(5);
    expect(readout.pageScanLimit).toBe(5000);
    expect(readout.pageScanLimitReached).toBe(false);
    expect(readout.importSummary).toEqual(
      expect.objectContaining({
        name: "alpha-archive",
        duplicateGroups: 1,
      }),
    );
    expect(readout.threads.map((thread) => thread.label)).toEqual(
      expect.arrayContaining(["Crispr", "Sequencing"]),
    );
    expect(readout.duplicatePapers).toEqual([
      expect.objectContaining({
        a: "papers/crispr-seq-a.pdf",
        b: "papers/crispr-seq-b.pdf",
        reason: "shared-doi",
      }),
    ]);
    expect(readout.importDuplicateGroups).toEqual([
      expect.objectContaining({
        members: ["papers/crispr-seq-a.pdf", "papers/crispr-seq-b.pdf"],
        contentType: "paper",
      }),
    ]);
    expect(readout.trackedExportCount).toBe(1);
    expect(readout.staleExports).toEqual([
      expect.objectContaining({
        projectPath: "figures/summary-chart.svg",
        staleSources: [
          expect.objectContaining({
            slug: "wiki/entities/papers/crispr-seq-a",
            reason: "updated-source",
          }),
        ],
      }),
    ]);
    expect(readout.suggestedPrompts.length).toBeGreaterThan(0);
  });
});
