import { describe, expect, it } from "vitest";
import {
  buildWorkspaceTabSnapshot,
  flattenWorkspaceTree,
  type WorkspaceTreeLikeNode,
} from "@/lib/project-workspace-tabs";

describe("flattenWorkspaceTree", () => {
  it("flattens files relative to the visible study workspace root and normalizes extensions", () => {
    const tree: WorkspaceTreeLikeNode[] = [
      {
        name: "papers",
        type: "directory",
        children: [
          {
            name: "archive",
            type: "directory",
            children: [
              { name: "GenomeStudy.PDF", type: "file" },
              { name: "Appendix.TeX", type: "file" },
              { name: "empty", type: "directory" },
            ],
          },
        ],
      },
      { name: "raw-data.CSV", type: "file" },
      { name: "README", type: "file" },
    ];

    expect(flattenWorkspaceTree(tree)).toEqual([
      {
        path: "papers/archive/GenomeStudy.PDF",
        name: "GenomeStudy.PDF",
        extension: "pdf",
      },
      {
        path: "papers/archive/Appendix.TeX",
        name: "Appendix.TeX",
        extension: "tex",
      },
      {
        path: "raw-data.CSV",
        name: "raw-data.CSV",
        extension: "csv",
      },
      {
        path: "README",
        name: "README",
        extension: "",
      },
    ]);
  });
});

describe("buildWorkspaceTabSnapshot", () => {
  it("classifies files relative to the visible study workspace root", () => {
    const tree: WorkspaceTreeLikeNode[] = [
      {
        name: "papers",
        type: "directory",
        children: [
          { name: "foundation-models.pdf", type: "file" },
          { name: "citations.bib", type: "file" },
        ],
      },
      {
        name: "code",
        type: "directory",
        children: [
          { name: "template.tex", type: "file" },
          { name: "references.bib", type: "file" },
        ],
      },
      {
        name: "experiments",
        type: "directory",
        children: [
          { name: "train_model.py", type: "file" },
          { name: "run-benchmark.sh", type: "file" },
          { name: "helper_utils.py", type: "file" },
        ],
      },
      {
        name: "data",
        type: "directory",
        children: [
          { name: "01-primary.tsv", type: "file" },
          { name: "secondary.json", type: "file" },
        ],
      },
      {
        name: "results",
        type: "directory",
        children: [
          { name: "report-summary.md", type: "file" },
          { name: "metrics.json", type: "file" },
        ],
      },
      {
        name: "figures",
        type: "directory",
        children: [
          { name: "accuracy-plot.svg", type: "file" },
          { name: "embedding-overview.png", type: "file" },
        ],
      },
    ];

    const snapshot = buildWorkspaceTabSnapshot(tree);

    expect(snapshot.papers.map((paper) => paper.file)).toEqual([
      "papers/foundation-models.pdf",
      "papers/citations.bib",
    ]);
    expect(snapshot.papers.map((paper) => paper.title)).toEqual([
      "foundation models",
      "citations",
    ]);

    expect(snapshot.experiments.map((experiment) => experiment.script)).toEqual([
      "experiments/run-benchmark.sh",
      "experiments/train_model.py",
    ]);
    expect(snapshot.experiments.map((experiment) => experiment.name)).toEqual([
      "run benchmark",
      "train model",
    ]);
    expect(snapshot.experiments.map((experiment) => experiment.description)).toEqual([
      "Runs the main benchmark or comparison pipeline for this study.",
      "Launches the main training or fine-tuning run for this workspace.",
    ]);

    expect(snapshot.chartAssets.map((asset) => asset.path)).toEqual([
      "figures/accuracy-plot.svg",
      "figures/embedding-overview.png",
    ]);

    expect(snapshot.resultFiles.map((file) => file.path)).toEqual([
      "results/report-summary.md",
      "results/metrics.json",
    ]);

    expect(snapshot.primaryDataFile).toEqual({
      path: "data/01-primary.tsv",
      name: "01-primary.tsv",
      extension: "tsv",
    });
    expect(snapshot.dataFiles.map((file) => file.path)).toEqual([
      "data/01-primary.tsv",
      "data/secondary.json",
      "results/metrics.json",
    ]);

    expect(snapshot.resultsData).toMatchObject({
      tableTitle: "Detected outputs",
      stats: [
        { label: "Workspace files", value: "13" },
        { label: "Literature files", value: "2" },
        { label: "Experiments", value: "2" },
        { label: "Data files", value: "3" },
        { label: "Chart outputs", value: "2" },
      ],
      tableRows: [
        ["Report", "report-summary.md", "results/report-summary.md"],
        ["Report", "metrics.json", "results/metrics.json"],
      ],
    });
  });

  it("does not classify result artifacts as experiments or the primary data file", () => {
    const tree: WorkspaceTreeLikeNode[] = [
      {
        name: "results",
        type: "directory",
        children: [
          { name: "benchmark-results.json", type: "file" },
          { name: "eval-summary.csv", type: "file" },
        ],
      },
      {
        name: "scripts",
        type: "directory",
        children: [
          { name: "cleanup.sh", type: "file" },
        ],
      },
      {
        name: "data",
        type: "directory",
        children: [
          { name: "primary-metrics.tsv", type: "file" },
        ],
      },
    ];

    const snapshot = buildWorkspaceTabSnapshot(tree);

    expect(snapshot.experiments).toEqual([]);
    expect(snapshot.primaryDataFile).toEqual({
      path: "data/primary-metrics.tsv",
      name: "primary-metrics.tsv",
      extension: "tsv",
    });
    expect(snapshot.resultFiles.map((file) => file.path)).toEqual([
      "results/benchmark-results.json",
      "results/eval-summary.csv",
    ]);
    expect(snapshot.dataFiles.map((file) => file.path)).toEqual([
      "data/primary-metrics.tsv",
      "results/benchmark-results.json",
      "results/eval-summary.csv",
    ]);
  });

  it("keeps result-scoped spreadsheets visible in the Data tab", () => {
    const tree: WorkspaceTreeLikeNode[] = [
      {
        name: "results",
        type: "directory",
        children: [
          { name: "summary-table.xlsx", type: "file" },
          { name: "metrics.csv", type: "file" },
        ],
      },
    ];

    const snapshot = buildWorkspaceTabSnapshot(tree);

    expect(snapshot.dataFiles.map((file) => file.path)).toEqual([
      "results/summary-table.xlsx",
      "results/metrics.csv",
    ]);
    expect(snapshot.primaryDataFile).toEqual({
      path: "results/summary-table.xlsx",
      name: "summary-table.xlsx",
      extension: "xlsx",
    });
  });

  it("groups result outputs by type while keeping charts on the chart asset path", () => {
    const tree: WorkspaceTreeLikeNode[] = [
      {
        name: "figures",
        type: "directory",
        children: [
          { name: "accuracy-chart.svg", type: "file" },
        ],
      },
      {
        name: "results",
        type: "directory",
        children: [
          { name: "study-report.pdf", type: "file" },
          { name: "preview-frame.png", type: "file" },
          { name: "summary-table.xlsx", type: "file" },
          { name: "stdout.txt", type: "file" },
        ],
      },
    ];

    const snapshot = buildWorkspaceTabSnapshot(tree);

    expect(snapshot.chartAssets).toEqual([
      {
        path: "figures/accuracy-chart.svg",
        name: "accuracy-chart.svg",
        extension: "svg",
        group: "chart",
      },
    ]);
    expect(snapshot.resultFiles).toEqual([
      {
        path: "results/study-report.pdf",
        name: "study-report.pdf",
        group: "report",
      },
      {
        path: "results/preview-frame.png",
        name: "preview-frame.png",
        group: "media",
      },
      {
        path: "results/summary-table.xlsx",
        name: "summary-table.xlsx",
        group: "table",
      },
      {
        path: "results/stdout.txt",
        name: "stdout.txt",
        group: "log",
      },
    ]);
    expect(snapshot.dataFiles.map((file) => file.path)).toEqual([
      "results/summary-table.xlsx",
    ]);
    expect(snapshot.resultsData).toMatchObject({
      tableHeaders: ["Type", "Result file", "Path"],
      tableRows: [
        ["Report", "study-report.pdf", "results/study-report.pdf"],
        ["Media", "preview-frame.png", "results/preview-frame.png"],
        ["Table", "summary-table.xlsx", "results/summary-table.xlsx"],
        ["Log", "stdout.txt", "results/stdout.txt"],
      ],
    });
  });

  it("only surfaces main python and shell entry points in Experiments", () => {
    const tree: WorkspaceTreeLikeNode[] = [
      {
        name: "scripts",
        type: "directory",
        children: [
          { name: "run_pipeline.sh", type: "file" },
          { name: "train_model.py", type: "file" },
          { name: "helper_utils.py", type: "file" },
          { name: "config_loader.py", type: "file" },
        ],
      },
      {
        name: "code",
        type: "directory",
        children: [
          { name: "benchmark_eval.py", type: "file" },
          { name: "test_runner.py", type: "file" },
        ],
      },
    ];

    const snapshot = buildWorkspaceTabSnapshot(tree);

    expect(snapshot.experiments.map((experiment) => experiment.script)).toEqual([
      "code/benchmark_eval.py",
      "scripts/run_pipeline.sh",
      "scripts/train_model.py",
    ]);
    expect(snapshot.experiments.map((experiment) => experiment.language)).toEqual([
      "python",
      "shell",
      "python",
    ]);
  });

  it("does not treat bare 'paper' substrings or unrelated html files as papers or charts", () => {
    const tree: WorkspaceTreeLikeNode[] = [
      { name: "newspaper-coverage.csv", type: "file" },
      { name: "paper-survey.csv", type: "file" },
      { name: "README.html", type: "file" },
      { name: "docs/logo.png", type: "file" },
      { name: "code/figure_utils.py", type: "file" },
      {
        name: "figures",
        type: "directory",
        children: [
          { name: "chart-preview.html", type: "file" },
        ],
      },
    ];

    const snapshot = buildWorkspaceTabSnapshot(tree);

    expect(snapshot.papers).toEqual([]);
    expect(snapshot.dataFiles.map((file) => file.path)).toEqual([
      "newspaper-coverage.csv",
      "paper-survey.csv",
    ]);
    expect(snapshot.primaryDataFile).toEqual({
      path: "newspaper-coverage.csv",
      name: "newspaper-coverage.csv",
      extension: "csv",
    });
    expect(snapshot.resultFiles.map((asset) => asset.path)).not.toContain("paper-survey.csv");
    expect(snapshot.chartAssets.map((asset) => asset.path)).toEqual([
      "figures/chart-preview.html",
    ]);
    expect(snapshot.chartAssets.map((asset) => asset.path)).not.toContain("README.html");
    expect(snapshot.chartAssets.map((asset) => asset.path)).not.toContain("docs/logo.png");
    expect(snapshot.chartAssets.map((asset) => asset.path)).not.toContain("code/figure_utils.py");
  });
});
