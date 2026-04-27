import { describe, expect, it } from "vitest";

import {
  formatProjectOrganizerChatSummary,
  type ProjectOrganizerReadout,
} from "@/lib/project-organizer-summary";

describe("formatProjectOrganizerChatSummary", () => {
  it("formats the organizer findings into a user-facing chat summary", () => {
    const readout: ProjectOrganizerReadout = {
      project: "alpha",
      generatedAt: "2026-04-19T12:00:00.000Z",
      pageCount: 6,
      pageScanLimit: 5000,
      pageScanLimitReached: true,
      pageCountsByType: { paper: 2, task: 1, note: 1, frontier_item: 1, artifact: 1 },
      importSummary: {
        name: "alpha-archive",
        preparedFiles: 6,
        detectedItems: 8,
        duplicateGroups: 1,
        generatedAt: "2026-04-19T12:00:00.000Z",
        source: "background-local-import",
      },
      threads: [
        {
          label: "Crispr",
          confidence: "high",
          pageCount: 4,
          pageTypes: ["note", "paper", "task"],
          keywords: ["Crispr", "Sequencing"],
          evidence: [
            { path: "wiki/entities/papers/a", title: "A", type: "paper" },
          ],
        },
      ],
      duplicatePapers: [
        {
          a: "papers/a.pdf",
          b: "papers/b.pdf",
          reason: "shared-doi",
          similarity: 1,
        },
      ],
      importDuplicateGroups: [
        {
          id: "dup-1-hash-a",
          members: ["notes/a.ipynb", "notes/b.ipynb"],
          reason: "Identical content hash abc123def456",
          hashPrefix: "abc123def456",
          contentType: "notebook",
        },
      ],
      trackedExportCount: 1,
      staleExports: [
        {
          slug: "openclaw-alpha-summary-chart",
          projectPath: "figures/summary-chart.svg",
          title: "summary-chart.svg",
          generatedAt: "2026-04-19T12:30:00.000Z",
          trackedSourceCount: 1,
          staleSources: [
            {
              slug: "wiki/entities/papers/a",
              title: "A",
              reason: "updated-source",
              workspacePath: "papers/a.pdf",
              observedAt: "2026-04-19T13:00:00.000Z",
            },
          ],
        },
      ],
      nextMove: {
        recommendation: "Review the imported CRISPR notes before drafting tasks.",
      },
      dueTasks: [
        { path: "wiki/tasks/review.md", title: "Review CRISPR notes", status: "open" },
      ],
      frontier: [
        {
          path: "wiki/entities/frontier/item-1.md",
          title: "New CRISPR sequencing benchmark",
          status: "promoted",
          whyItMatters: "Directly relevant to the current assay design.",
        },
      ],
      suggestedPrompts: [
        "Explain the Crispr thread and what to do next.",
      ],
    };

    const summary = formatProjectOrganizerChatSummary(readout);

    expect(summary).toContain("Imported **alpha-archive** into **alpha**");
    expect(summary).toContain("Coverage warning: organizer scan limit reached at 5,000 pages");
    expect(summary).toContain("Candidate threads: Crispr");
    expect(summary).toContain("Possible duplicate papers: papers/a.pdf <> papers/b.pdf");
    expect(summary).toContain("Import duplicate groups: notebook: notes/a.ipynb, notes/b.ipynb, hash abc123def456");
    expect(summary).toContain("Stale exports: figures/summary-chart.svg");
    expect(summary).toContain("Next move: Review the imported CRISPR notes before drafting tasks.");
    expect(summary).toContain("Try asking:");
  });

  it("stays honest when the organizer cannot infer stable threads or duplicates yet", () => {
    const readout: ProjectOrganizerReadout = {
      project: "alpha",
      generatedAt: "2026-04-19T12:00:00.000Z",
      pageCount: 1,
      pageScanLimit: 5000,
      pageScanLimitReached: false,
      pageCountsByType: { project: 1 },
      importSummary: null,
      threads: [],
      duplicatePapers: [],
      importDuplicateGroups: [],
      trackedExportCount: 0,
      staleExports: [],
      nextMove: undefined,
      dueTasks: [],
      frontier: [],
      suggestedPrompts: [],
    };

    const summary = formatProjectOrganizerChatSummary(readout);

    expect(summary).toContain("Organizer summary for **alpha**.");
    expect(summary).toContain("not enough repeated tags or titles");
    expect(summary).toContain("none surfaced from the current gbrain study pages");
    expect(summary).toContain("Import duplicate groups: none recorded in the current import state.");
    expect(summary).toContain("none with tracked gbrain source snapshots yet");
  });

  it("uses the frontier-aware fallback prompt when suggested prompts are absent", () => {
    const readout: ProjectOrganizerReadout = {
      project: "alpha",
      generatedAt: "2026-04-19T12:00:00.000Z",
      pageCount: 2,
      pageScanLimit: 5000,
      pageScanLimitReached: false,
      pageCountsByType: { frontier_item: 1, project: 1 },
      importSummary: null,
      threads: [],
      duplicatePapers: [],
      importDuplicateGroups: [],
      trackedExportCount: 0,
      staleExports: [],
      nextMove: undefined,
      dueTasks: [],
      frontier: [
        {
          path: "wiki/entities/frontier/item-1.md",
          title: "Open benchmark thread",
          status: "promoted",
          whyItMatters: "Helps choose the next experiment.",
        },
      ],
      suggestedPrompts: [],
    };

    const summary = formatProjectOrganizerChatSummary(readout);

    expect(summary).toContain("Summarize why Open benchmark thread matters for this study.");
  });

  it("does not relabel import duplicate groups as duplicate papers when no paper duplicates are verified", () => {
    const readout: ProjectOrganizerReadout = {
      project: "alpha",
      generatedAt: "2026-04-19T12:00:00.000Z",
      pageCount: 4,
      pageScanLimit: 5000,
      pageScanLimitReached: false,
      pageCountsByType: { note: 2, dataset: 2 },
      importSummary: {
        name: "alpha-archive",
        preparedFiles: 4,
        detectedItems: 4,
        duplicateGroups: 1,
        generatedAt: "2026-04-19T12:00:00.000Z",
        source: "background-local-import",
      },
      threads: [],
      duplicatePapers: [],
      importDuplicateGroups: [
        {
          id: "dup-1-hash-a",
          members: ["notes/a.ipynb", "notes/b.ipynb"],
          reason: "Identical content hash abc123def456",
          hashPrefix: "abc123def456",
          contentType: "notebook",
        },
      ],
      trackedExportCount: 0,
      staleExports: [],
      nextMove: undefined,
      dueTasks: [],
      frontier: [],
      suggestedPrompts: [],
    };

    const summary = formatProjectOrganizerChatSummary(readout);

    expect(summary).toContain("Possible duplicate papers: none surfaced from the current gbrain study pages.");
    expect(summary).toContain("Import duplicate groups: notebook: notes/a.ipynb, notes/b.ipynb, hash abc123def456");
    expect(summary).not.toContain("Possible duplicate papers: 1 duplicate group");
  });
});
