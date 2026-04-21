import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BrainPage, BrainStore } from "@/brain/store";
import type { BrainConfig, SearchInput, SearchResult, ContentType, IngestCost } from "@/brain/types";
import {
  buildProjectImportRegistry,
  formatProjectImportRegistryForPrompt,
  isGeneratedArtifactPage,
} from "@/brain/import-registry";
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
    async getPage(path: string): Promise<BrainPage | null> {
      return pages.find((page) => page.path === path) ?? null;
    },
    async getTimeline() {
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

describe("buildProjectImportRegistry", () => {
  it("returns authoritative project import entries and exact duplicate groups", async () => {
    testRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-import-registry-"));
    const config = makeConfig(testRoot);
    await writeProjectImportSummary(
      "alpha",
      {
        name: "alpha-archive",
        preparedFiles: 4,
        detectedItems: 5,
        duplicateGroups: 1,
        duplicateGroupDetails: [
          {
            id: "dup-1-hash-a",
            paths: ["papers/a.pdf", "papers/b.pdf"],
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

    const pages: BrainPage[] = [
      {
        path: "wiki/projects/alpha.md",
        title: "Alpha",
        type: "project",
        content: [
          "# Alpha",
          "",
          "## Duplicate Groups",
          "- Identical content hash abc123def456: papers/a.pdf, papers/b.pdf",
          "",
        ].join("\n"),
        frontmatter: {
          project: "alpha",
        },
      },
      {
        path: "wiki/entities/papers/a",
        title: "Paper A",
        type: "paper",
        content: "Paper A",
        frontmatter: {
          project: "alpha",
          relative_path: "papers/a.pdf",
          source_refs: [{ kind: "import", ref: "papers/a.pdf", hash: "hash-a" }],
          file_refs: [
            {
              role: "source",
              fileObjectId: `sha256:${"a".repeat(64)}`,
              sha256: "a".repeat(64),
              filename: "papers/a.pdf",
              mime: "application/pdf",
              sizeBytes: 1024,
            },
          ],
          page_count: 12,
        },
      },
      {
        path: "wiki/entities/datasets/counts",
        title: "Counts Dataset",
        type: "dataset",
        content: "Counts",
        frontmatter: {
          project: "alpha",
          relative_path: "data/counts.csv",
        },
      },
      {
        path: "wiki/entities/artifacts/openclaw-alpha-summary",
        title: "Generated summary",
        type: "artifact",
        content: "Generated",
        frontmatter: {
          project: "alpha",
          artifact_tool: "OpenClaw CLI",
          artifact_source_snapshots: [],
        },
      },
    ];

    const registry = await buildProjectImportRegistry({
      config,
      project: "alpha",
      store: makeStore(pages),
    });

    expect(registry.detectedItemCount).toBe(5);
    expect(registry.registeredItemCount).toBe(2);
    expect(registry.entries.map((entry) => entry.pagePath)).toEqual([
      "wiki/entities/datasets/counts",
      "wiki/entities/papers/a",
    ]);
    expect(registry.entries[0]).toMatchObject({
      pagePath: "wiki/entities/datasets/counts",
      verificationState: "unavailable",
      missingFields: ["sourceRefs", "fileRefs", "pageCount"],
    });
    expect(registry.entries[1]).toMatchObject({
      pagePath: "wiki/entities/papers/a",
      verificationState: "verified",
      projectPath: "papers/a.pdf",
      pageCount: 12,
    });
    expect(registry.duplicateGroups).toEqual([
      expect.objectContaining({
        members: ["papers/a.pdf", "papers/b.pdf"],
        hashPrefix: "abc123def456",
        contentType: "paper",
      }),
    ]);
    expect(registry.warnings[0]).toContain("detected 5 item(s)");

    const prompt = formatProjectImportRegistryForPrompt(registry);
    expect(prompt).toContain("## Authoritative Import Registry");
    expect(prompt).toContain("\"missing_fields\"");
    expect(prompt).toContain("\"duplicate_groups\"");
  });

  it("treats an empty duplicateGroupDetails array as authoritative", async () => {
    testRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-import-registry-empty-dups-"));
    const config = makeConfig(testRoot);
    await writeProjectImportSummary(
      "alpha",
      {
        name: "alpha-archive",
        preparedFiles: 2,
        detectedItems: 2,
        duplicateGroups: 0,
        duplicateGroupDetails: [],
        generatedAt: "2026-04-19T12:00:00.000Z",
        source: "background-local-import",
      },
      getProjectStateRootForBrainRoot("alpha", testRoot),
    );

    const registry = await buildProjectImportRegistry({
      config,
      project: "alpha",
      store: makeStore([
        {
          path: "wiki/projects/alpha.md",
          title: "Alpha",
          type: "project",
          content: [
            "# Alpha",
            "",
            "## Duplicate Groups",
            "- Stale duplicate section: papers/a.pdf, papers/b.pdf",
          ].join("\n"),
          frontmatter: { project: "alpha" },
        },
      ]),
    });

    expect(registry.duplicateGroups).toEqual([]);
  });

  it("warns when the registry scan hits the page scan limit", async () => {
    testRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-import-registry-page-limit-"));
    const config = makeConfig(testRoot);
    const pages: BrainPage[] = Array.from({ length: 5000 }, (_, index) => ({
      path: `wiki/notes/page-${index}`,
      title: `Page ${index}`,
      type: "note",
      content: "",
      frontmatter: {
        project: index === 0 ? "alpha" : "beta",
      },
    }));

    const registry = await buildProjectImportRegistry({
      config,
      project: "alpha",
      store: makeStore(pages),
    });

    expect(registry.warnings).toContain(
      "Import registry scanned 5000 page(s), so project results may be truncated if the brain currently holds additional pages.",
    );
  });

  it("flags generated artifact pages separately from source pages", () => {
    expect(isGeneratedArtifactPage({
      path: "wiki/entities/artifacts/openclaw-alpha-summary",
      title: "Generated summary",
      type: "artifact",
      content: "Generated",
      frontmatter: {
        artifact_tool: "OpenClaw CLI",
      },
    })).toBe(true);

    expect(isGeneratedArtifactPage({
      path: "wiki/entities/papers/a",
      title: "Paper A",
      type: "paper",
      content: "Paper A",
      frontmatter: {
        source_refs: [{ kind: "import", ref: "papers/a.pdf" }],
      },
    })).toBe(false);
  });
});
