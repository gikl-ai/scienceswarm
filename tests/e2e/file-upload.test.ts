import { describe, expect, it } from "vitest";
import { organizeFiles, type OrganizedFile } from "@/lib/auto-organize";

/**
 * E2E-style test: simulates the full file upload → auto-organize flow
 * that the dashboard would perform. Tests the user-visible outcome
 * (file tree structure) rather than internal implementation.
 */

describe("File upload → auto-organize flow", () => {
  function simulateUpload(
    files: Array<{ name: string; content?: string }>,
  ): OrganizedFile[] {
    return organizeFiles(files);
  }

  function getTreeFolders(organized: OrganizedFile[]): string[] {
    return [...new Set(organized.map((f) => f.organizedPath.split("/")[0]))].sort();
  }

  // ── CSV upload ─────────────────────────────────────────────────

  it("upload CSV → appears in file tree under data/", () => {
    const result = simulateUpload([{ name: "results.csv" }]);
    expect(result[0].organizedPath).toBe("data/results.csv");
    expect(result[0].category).toBe("data");
  });

  // ── PDF upload ─────────────────────────────────────────────────

  it("upload PDF → appears under papers/", () => {
    const result = simulateUpload([
      { name: "paper.pdf", content: "Abstract: We prove that..." },
    ]);
    expect(result[0].organizedPath).toBe("papers/paper.pdf");
    expect(result[0].category).toBe("papers");
  });

  // ── Python upload ──────────────────────────────────────────────

  it("upload .py → appears under code/", () => {
    const result = simulateUpload([{ name: "train.py" }]);
    expect(result[0].organizedPath).toBe("code/train.py");
    expect(result[0].category).toBe("code");
  });

  // ── Test file upload ───────────────────────────────────────────

  it("upload test_*.py → appears under code/tests/", () => {
    const result = simulateUpload([{ name: "test_model.py" }]);
    expect(result[0].organizedPath).toBe("code/tests/test_model.py");
    expect(result[0].category).toBe("tests");
  });

  // ── Organized file tree structure ──────────────────────────────

  it("file tree shows organized structure for mixed uploads", () => {
    const result = simulateUpload([
      { name: "paper.pdf" },
      { name: "train.py" },
      { name: "data.csv" },
      { name: "chart.png" },
      { name: "config.yaml" },
      { name: "notes.tex" },
    ]);

    const folders = getTreeFolders(result);
    expect(folders).toEqual(["code", "config", "data", "docs", "figures", "papers"]);
  });

  // ── Batch upload with all categories ───────────────────────────

  it("handles a realistic research project upload", () => {
    const files = [
      { name: "attention-is-all-you-need.pdf" },
      { name: "transformer.py" },
      { name: "test_transformer.py" },
      { name: "training_log.csv" },
      { name: "hyperparams.json" },
      { name: "paper.tex" },
      { name: "references.bib" },
      { name: "loss_curve.png" },
      { name: "attention_map.svg" },
      { name: "config.yaml" },
    ];

    const result = simulateUpload(files);

    // Verify each file ended up in the right place
    const paths = Object.fromEntries(
      result.map((r) => [r.originalName, r.organizedPath]),
    );

    expect(paths["attention-is-all-you-need.pdf"]).toBe(
      "papers/attention-is-all-you-need.pdf",
    );
    expect(paths["transformer.py"]).toBe("code/transformer.py");
    expect(paths["test_transformer.py"]).toBe("code/tests/test_transformer.py");
    expect(paths["training_log.csv"]).toBe("data/training_log.csv");
    expect(paths["hyperparams.json"]).toBe("data/hyperparams.json");
    expect(paths["paper.tex"]).toBe("docs/paper.tex");
    expect(paths["references.bib"]).toBe("docs/references.bib");
    expect(paths["loss_curve.png"]).toBe("figures/loss_curve.png");
    expect(paths["attention_map.svg"]).toBe("figures/attention_map.svg");
    expect(paths["config.yaml"]).toBe("config/config.yaml");
  });

  // ── Already-organized uploads ──────────────────────────────────

  it("preserves structure when files are already organized", () => {
    const files = [
      { name: "main.py", path: "code/main.py" },
      { name: "data.csv", path: "data/data.csv" },
      { name: "readme.md", path: "docs/readme.md" },
    ];

    const result = simulateUpload(files);

    expect(result[0].organizedPath).toBe("code/main.py");
    expect(result[1].organizedPath).toBe("data/data.csv");
    expect(result[2].organizedPath).toBe("docs/readme.md");
  });
});
