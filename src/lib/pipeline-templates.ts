// ── Shared Pipeline Templates ─────────────────────────────────
// Single source of truth — used by both server (pipeline.ts) and client (scheduler-panel.tsx)

export type PipelineStepType = "script" | "transform" | "analyze" | "chart" | "notify" | "condition";

export interface PipelineTemplate {
  name: string;
  description: string;
  steps: { name: string; type: PipelineStepType; config: Record<string, unknown> }[];
}

export const PIPELINE_TEMPLATES: Record<string, PipelineTemplate> = {
  "experiment-and-analyze": {
    name: "Run Experiment -> Analyze -> Chart",
    description: "Execute an experiment script, clean results, run statistical analysis, and generate figures.",
    steps: [
      { name: "Run experiment", type: "script", config: { script: "" } },
      { name: "Clean results", type: "transform", config: { format: "csv-to-json" } },
      { name: "Statistical analysis", type: "analyze", config: {} },
      { name: "Generate figures", type: "chart", config: {} },
    ],
  },
  "literature-review": {
    name: "Parse Papers -> Extract -> Compare -> Summary",
    description: "Parse uploaded PDFs, extract key findings, compare across papers, and write a summary.",
    steps: [
      { name: "Parse PDFs", type: "transform", config: {} },
      { name: "Extract key findings", type: "analyze", config: {} },
      { name: "Compare across papers", type: "analyze", config: {} },
      { name: "Write summary", type: "analyze", config: {} },
    ],
  },
  "nightly-rerun": {
    name: "Nightly Experiment Rerun",
    description: "Pull latest data, run full test suite, compare with previous results, and send a summary.",
    steps: [
      { name: "Pull latest data", type: "script", config: {} },
      { name: "Run full test suite", type: "script", config: {} },
      { name: "Compare with previous", type: "transform", config: {} },
      { name: "Send results summary", type: "notify", config: { channels: ["telegram", "slack"] } },
    ],
  },
  "data-cleaning": {
    name: "Data Cleaning Pipeline",
    description: "Validate, clean, and transform raw data for analysis.",
    steps: [
      { name: "Validate data integrity", type: "script", config: { script: "validate.py" } },
      { name: "Remove outliers", type: "transform", config: { method: "iqr" } },
      { name: "Normalize columns", type: "transform", config: { method: "z-score" } },
      { name: "Export cleaned data", type: "script", config: { script: "export.py" } },
    ],
  },
};
