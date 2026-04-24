import type { Paper } from "@/components/research/papers-panel";
import type { Experiment } from "@/components/research/experiments-panel";
import type {
  ResultChartAsset,
  ResultFileGroup,
  ResultWorkspaceFile,
  ResultsData,
} from "@/components/research/results-viewer";

export interface WorkspaceTreeLikeNode {
  name: string;
  type: "file" | "directory";
  children?: WorkspaceTreeLikeNode[];
}

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  extension: string;
}

export interface WorkspaceTabSnapshot {
  papers: Paper[];
  experiments: Experiment[];
  resultsData: ResultsData | undefined;
  resultFiles: ResultWorkspaceFile[];
  chartAssets: ResultChartAsset[];
  dataFiles: WorkspaceFileEntry[];
  primaryDataFile: WorkspaceFileEntry | null;
}

const ALWAYS_PAPER_EXTENSIONS = new Set(["pdf"]);
const DATA_EXTENSIONS = new Set(["csv", "tsv", "json", "xlsx", "xls", "parquet", "dat", "npy", "npz"]);
const SCRIPT_EXTENSIONS = new Set(["py", "sh"]);
const CHART_EXTENSIONS = new Set(["svg", "png", "jpg", "jpeg", "webp", "gif", "html"]);
const RESULT_REPORT_EXTENSIONS = new Set(["md", "txt", "json", "html", "svg", "pdf"]);
const RESULT_TABLE_EXTENSIONS = new Set(["csv", "tsv", "xlsx", "xls", "parquet"]);
const RESULT_MEDIA_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov", "m4v", "ogg"]);
const RESULT_LOG_EXTENSIONS = new Set(["log", "out", "err", "trace"]);
const RESULT_EXTENSIONS = new Set([
  ...RESULT_REPORT_EXTENSIONS,
  ...RESULT_TABLE_EXTENSIONS,
  ...RESULT_MEDIA_EXTENSIONS,
  ...RESULT_LOG_EXTENSIONS,
]);
const EXPERIMENT_PRIMARY_NAME_HINTS = [
  "run",
  "train",
  "eval",
  "benchmark",
  "launch",
  "start",
  "main",
  "reproduce",
];
const EXPERIMENT_EXCLUDED_NAME_HINTS = [
  "util",
  "utils",
  "helper",
  "helpers",
  "test",
  "tests",
  "__init__",
  "fixture",
  "config",
];

function getExtension(fileName: string): string {
  const parts = fileName.split(".");
  return parts.length > 1 ? (parts.pop() || "").toLowerCase() : "";
}

function basenameWithoutExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(0, index) : fileName;
}

function prettifyLabel(input: string): string {
  return basenameWithoutExtension(input).replace(/[_-]+/g, " ").trim() || input;
}

function hasDirectoryHint(path: string, segment: string): boolean {
  return path.startsWith(`${segment}/`) || path.includes(`/${segment}/`);
}

function hasNameHint(path: string, hints: string[]): boolean {
  const baseName = basenameWithoutExtension(path.split("/").pop() || path).toLowerCase();
  return hints.some((hint) => (
    baseName === hint
    || baseName.startsWith(`${hint}-`)
    || baseName.startsWith(`${hint}_`)
    || baseName.includes(`-${hint}`)
    || baseName.includes(`_${hint}`)
  ));
}

function looksLikePaper(path: string, extension: string): boolean {
  const lower = path.toLowerCase();
  const hasPaperHint = hasDirectoryHint(lower, "papers")
    || (!DATA_EXTENSIONS.has(extension) && /\bpaper\b/.test(lower));
  return ALWAYS_PAPER_EXTENSIONS.has(extension) || hasPaperHint;
}

function looksLikeExperiment(path: string, extension: string): boolean {
  const lower = path.toLowerCase();
  const baseName = basenameWithoutExtension(path.split("/").pop() || lower).toLowerCase();
  const hasPrimaryNameHint = EXPERIMENT_PRIMARY_NAME_HINTS.some((hint) => baseName === hint || baseName.startsWith(`${hint}-`) || baseName.startsWith(`${hint}_`) || baseName.includes(`-${hint}`) || baseName.includes(`_${hint}`));
  const hasExcludedNameHint = EXPERIMENT_EXCLUDED_NAME_HINTS.some((hint) => baseName === hint || baseName.startsWith(`${hint}-`) || baseName.startsWith(`${hint}_`) || baseName.includes(`-${hint}`) || baseName.includes(`_${hint}`));
  if (!SCRIPT_EXTENSIONS.has(extension) || hasExcludedNameHint) {
    return false;
  }

  return (
    (hasDirectoryHint(lower, "experiments") && !hasExcludedNameHint)
    || hasPrimaryNameHint
    || lower.includes("/pipelines/")
    || lower.includes("/scripts/")
  );
}

function looksLikeData(path: string, extension: string): boolean {
  const lower = path.toLowerCase();
  return DATA_EXTENSIONS.has(extension) || hasDirectoryHint(lower, "data");
}

function prefersDataTab(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    hasDirectoryHint(lower, "data")
    || lower.includes("dataset")
    || lower.includes("table")
    || lower.includes("records")
  );
}

function looksLikeChart(path: string, extension: string): boolean {
  if (!CHART_EXTENSIONS.has(extension)) {
    return false;
  }

  const lower = path.toLowerCase();
  const hasPathHint = (
    lower.includes("chart")
    || lower.includes("plot")
    || lower.includes("figure")
    || hasDirectoryHint(lower, "figures")
    || hasDirectoryHint(lower, "charts")
  );

  return hasPathHint;
}

function looksLikeLog(path: string, extension: string): boolean {
  const lower = path.toLowerCase();

  return (
    RESULT_LOG_EXTENSIONS.has(extension)
    || hasDirectoryHint(lower, "logs")
    || hasDirectoryHint(lower, "traces")
    || hasNameHint(lower, ["log", "stdout", "stderr", "trace", "console"])
  );
}

function looksLikeResult(path: string, extension: string): boolean {
  const lower = path.toLowerCase();
  if (hasDirectoryHint(lower, "data")) {
    return false;
  }

  return (
    looksLikeChart(path, extension)
    || looksLikeLog(path, extension)
    || (RESULT_EXTENSIONS.has(extension) && (
      lower.includes("result")
      || lower.includes("metric")
      || lower.includes("report")
      || lower.includes("summary")
      || lower.includes("output")
      || lower.includes("artifact")
      || hasDirectoryHint(lower, "results")
      || hasDirectoryHint(lower, "outputs")
      || hasDirectoryHint(lower, "artifacts")
      || hasDirectoryHint(lower, "reports")
      || hasDirectoryHint(lower, "media")
      || hasDirectoryHint(lower, "tables")
      || hasDirectoryHint(lower, "logs")
    ))
  );
}

function getResultFileGroup(path: string, extension: string): Exclude<ResultFileGroup, "chart"> {
  if (looksLikeLog(path, extension)) {
    return "log";
  }
  if (RESULT_TABLE_EXTENSIONS.has(extension)) {
    return "table";
  }
  if (RESULT_MEDIA_EXTENSIONS.has(extension)) {
    return "media";
  }
  return "report";
}

function formatResultFileGroup(group: Exclude<ResultFileGroup, "chart">): string {
  switch (group) {
    case "report":
      return "Report";
    case "media":
      return "Media";
    case "table":
      return "Table";
    case "log":
      return "Log";
  }
}

export function flattenWorkspaceTree(
  nodes: WorkspaceTreeLikeNode[],
  prefix = "",
): WorkspaceFileEntry[] {
  const files: WorkspaceFileEntry[] = [];

  for (const node of nodes) {
    const currentPath = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.type === "directory") {
      files.push(...flattenWorkspaceTree(node.children || [], currentPath));
      continue;
    }

    files.push({
      path: currentPath,
      name: node.name,
      extension: getExtension(node.name),
    });
  }

  return files;
}

function buildPapers(files: WorkspaceFileEntry[]): Paper[] {
  return files
    .filter((file) => looksLikePaper(file.path, file.extension))
    .map((file, index) => ({
      id: `paper-${index}-${file.path}`,
      title: prettifyLabel(file.name),
      authors: "Unknown",
      year: new Date().getFullYear(),
      status: "unread" as const,
      tags: file.extension ? [file.extension] : [],
      file: file.path,
    }));
}

function buildExperiments(files: WorkspaceFileEntry[]): Experiment[] {
  return files
    .filter((file) => looksLikeExperiment(file.path, file.extension))
    .map((file, index) => {
      const language: Experiment["language"] = file.extension === "sh" ? "shell" : "python";
      return {
        id: `experiment-${index}-${file.path}`,
        name: prettifyLabel(file.name),
        script: file.path,
        description: inferExperimentDescription(file),
        language,
        status: "pending" as const,
      };
    })
    .sort((left, right) => left.script.localeCompare(right.script));
}

function inferExperimentDescription(file: WorkspaceFileEntry): string {
  const lower = file.path.toLowerCase();
  const baseName = basenameWithoutExtension(file.name).toLowerCase();

  if (baseName.includes("benchmark")) {
    return "Runs the main benchmark or comparison pipeline for this project.";
  }
  if (baseName.includes("eval")) {
    return "Evaluates existing checkpoints or generated outputs against project metrics.";
  }
  if (baseName.includes("train")) {
    return "Launches the main training or fine-tuning run for this workspace.";
  }
  if (baseName.includes("reproduce")) {
    return "Reproduces the primary experiment flow described in the project materials.";
  }
  if (file.extension === "sh") {
    return lower.includes("/pipelines/") || lower.includes("/experiments/")
      ? "Shell entry point that orchestrates the main experiment pipeline."
      : "Shell entry point for a project run.";
  }
  return "Python entry point for a project experiment or evaluation run.";
}

function buildResultsData(
  files: WorkspaceFileEntry[],
  papers: Paper[],
  experiments: Experiment[],
  dataFiles: WorkspaceFileEntry[],
  chartAssets: ResultChartAsset[],
  resultFiles: ResultWorkspaceFile[],
): ResultsData | undefined {
  const chartAssetPaths = new Set(chartAssets.map((asset) => asset.path));
  const nonChartResultFiles = resultFiles.filter((file) => !chartAssetPaths.has(file.path));

  if (
    files.length === 0
    && papers.length === 0
    && experiments.length === 0
    && dataFiles.length === 0
    && chartAssets.length === 0
    && resultFiles.length === 0
  ) {
    return undefined;
  }

  return {
    stats: [
      { label: "Workspace files", value: String(files.length) },
      { label: "Literature files", value: String(papers.length) },
      { label: "Experiments", value: String(experiments.length) },
      { label: "Data files", value: String(dataFiles.length) },
      { label: "Chart outputs", value: String(chartAssets.length) },
    ],
    chartData: [
      { label: "Papers", value: papers.length, color: "var(--chart-ocean-1)" },
      { label: "Experiments", value: experiments.length, color: "var(--chart-ocean-2)" },
      { label: "Data", value: dataFiles.length, color: "var(--chart-ocean-3)" },
      { label: "Charts", value: chartAssets.length, color: "var(--chart-ocean-8)" },
    ],
    tableHeaders: ["Type", "Result file", "Path"],
    tableRows: nonChartResultFiles.slice(0, 8).map((file) => [
      formatResultFileGroup(file.group),
      file.name,
      file.path,
    ]),
    tableRowPaths: nonChartResultFiles.slice(0, 8).map((file) => file.path),
    tableTitle: nonChartResultFiles.length > 0 ? "Detected outputs" : "Workspace overview",
  };
}

export function buildWorkspaceTabSnapshot(
  nodes: WorkspaceTreeLikeNode[],
): WorkspaceTabSnapshot {
  const files = flattenWorkspaceTree(nodes);
  const papers = buildPapers(files);
  const experiments = buildExperiments(files);
  const dataFiles = files.filter((file) => (
    looksLikeData(file.path, file.extension)
    && !looksLikePaper(file.path, file.extension)
    && !looksLikeExperiment(file.path, file.extension)
  )).sort((left, right) => {
    const leftPreferred = prefersDataTab(left.path) ? 0 : 1;
    const rightPreferred = prefersDataTab(right.path) ? 0 : 1;
    if (leftPreferred !== rightPreferred) {
      return leftPreferred - rightPreferred;
    }
    return left.path.localeCompare(right.path);
  });
  const chartAssets = files
    .filter((file) => looksLikeChart(file.path, file.extension))
    .map((file) => ({
      path: file.path,
      name: file.name,
      extension: file.extension,
      group: "chart" as const,
    }));
  const resultFiles = files.filter((file) => (
    looksLikeResult(file.path, file.extension)
    && !looksLikeChart(file.path, file.extension)
  )).map((file) => ({
    path: file.path,
    name: file.name,
    group: getResultFileGroup(file.path, file.extension),
  }));
  const primaryDataFile = dataFiles.find((file) => prefersDataTab(file.path)) ?? dataFiles[0] ?? null;

  return {
    papers,
    experiments,
    resultsData: buildResultsData(files, papers, experiments, dataFiles, chartAssets, resultFiles),
    resultFiles,
    chartAssets,
    dataFiles,
    primaryDataFile,
  };
}
