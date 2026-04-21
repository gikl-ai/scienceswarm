import { describe, expect, it } from "vitest";
import { buildImportPreview, classifyImportFile } from "@/lib/import/preview-core";

describe("buildImportPreview", () => {
  it("classifies researcher file types more specifically", () => {
    const preview = buildImportPreview({
      analysis: "Imported mixed archive",
      backend: "local-scan",
      summary: "Imported: leila-moreno-lab-archive (6 files)",
      sourceLabel: "leila-moreno-lab-archive",
      files: [
        { path: "analysis/notebooks/explore.ipynb", type: "ipynb", size: 1200, content: "{\"cells\":[]}" },
        { path: "analysis/stata/model.do", type: "do", size: 120, content: "reg y x" },
        { path: "data/raw/metadata.xlsx", type: "xlsx", size: 4096, content: "Workbook: metadata.xlsx" },
        { path: "writing/manuscript/draft.md", type: "md", size: 220, content: "# Draft Results" },
        { path: "notes/meetings/lab-meeting.md", type: "md", size: 180, content: "# Lab Meeting" },
        { path: "protocols/dna-extraction.md", type: "md", size: 140, content: "# DNA Extraction" },
      ],
    });

    expect(preview.files.map((file) => [file.path, file.classification])).toEqual([
      ["analysis/notebooks/explore.ipynb", "notebook"],
      ["analysis/stata/model.do", "stats"],
      ["data/raw/metadata.xlsx", "spreadsheet"],
      ["writing/manuscript/draft.md", "draft"],
      ["notes/meetings/lab-meeting.md", "meeting_note"],
      ["protocols/dna-extraction.md", "protocol"],
    ]);
  });

  it("returns multiple bucket suggestions instead of one high-confidence folder echo", () => {
    const preview = buildImportPreview({
      analysis: "Imported mixed archive",
      backend: "local-scan",
      summary: "Imported: leila-moreno-lab-archive (4 files)",
      sourceLabel: "leila-moreno-lab-archive",
      files: [
        { path: "analysis/results/model.txt", type: "txt", size: 100, content: "Drydown model summary" },
        { path: "writing/book-draft/chapter_02.md", type: "md", size: 100, content: "# Chapter 2" },
        { path: "coursework/book-club/reading_log.csv", type: "csv", size: 100, content: "date,title\n2024-01-01,Paper" },
        { path: "admin/project_timeline.csv", type: "csv", size: 100, content: "date,milestone\n2024-01-01,start" },
      ],
    });

    expect(preview.projects.map((project) => project.slug)).toEqual([
      "leila-moreno-research-archive",
      "active-research",
      "writing-and-publication",
      "coursework-and-reading",
      "operations-and-planning",
    ]);
    expect(preview.projects[0]).toMatchObject({
      confidence: "medium",
    });
  });

  it("keeps binary placeholders classified as binary", () => {
    expect(
      classifyImportFile({
        path: "figures/microscopy.raw",
        type: "raw",
        content: "[Binary file: 3.1 MB]",
      }),
    ).toBe("binary");
  });
});
