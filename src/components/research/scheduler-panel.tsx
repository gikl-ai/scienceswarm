"use client";

import { useState, useEffect, useCallback } from "react";
import { PIPELINE_TEMPLATES } from "@/lib/pipeline-templates";

// ── Types (mirror server types for client use) ─────────────────

interface JobAction {
  type: "run-script" | "transform-data" | "generate-chart" | "ai-analysis" | "pipeline" | "notify" | "condition";
  script?: string;
  config?: Record<string, unknown>;
  pipelineSteps?: JobAction[];
}

interface ScheduledJob {
  id: string;
  name: string;
  type: "once" | "recurring" | "on-event";
  schedule?: string;
  triggerEvent?: string;
  runAt?: string;
  action: JobAction;
  status: "pending" | "running" | "completed" | "failed" | "paused";
  lastRun?: string;
  nextRun?: string;
  logs: string[];
  createdAt: string;
}

interface PipelineStep {
  id: string;
  name: string;
  type: "script" | "transform" | "analyze" | "chart" | "notify" | "condition";
  config: Record<string, unknown>;
  dependsOn?: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: unknown;
}

interface Pipeline {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  status: "idle" | "running" | "completed" | "failed";
  currentStep: number;
}

// ── Status Config ──────────────────────────────────────────────

const jobStatusConfig: Record<string, { color: string; icon: string }> = {
  pending: { color: "bg-sunk text-dim", icon: "○" },
  running: { color: "bg-accent/10 text-accent", icon: "◉" },
  completed: { color: "bg-ok/10 text-ok", icon: "✓" },
  failed: { color: "bg-danger/10 text-danger", icon: "✕" },
  paused: { color: "bg-warn/10 text-warn", icon: "⏸" },
};

const stepStatusConfig: Record<string, { color: string; bg: string }> = {
  pending: { color: "border-rule bg-sunk", bg: "bg-dim" },
  running: { color: "border-accent/40 bg-accent/10", bg: "bg-accent" },
  completed: { color: "border-ok/40 bg-ok/10", bg: "bg-ok" },
  failed: { color: "border-danger/40 bg-danger/10", bg: "bg-danger" },
  skipped: { color: "border-rule-soft bg-sunk opacity-50", bg: "bg-rule" },
};

const stepTypeIcons: Record<string, string> = {
  script: "{ }",
  transform: "~>",
  analyze: "AI",
  chart: "[]",
  notify: ">>",
  condition: "?!",
};

// ── Cron Presets ───────────────────────────────────────────────

const cronPresets = [
  { label: "Every 5 min", value: "*/5 * * * *" },
  { label: "Every 15 min", value: "*/15 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Daily at 9am", value: "0 9 * * *" },
  { label: "Weekly (Sunday)", value: "0 0 * * 0" },
];

// Templates imported from @/lib/pipeline-templates (single source of truth)
const templates = PIPELINE_TEMPLATES;

// ── Sub-views ──────────────────────────────────────────────────

type View = "list" | "new-job" | "new-pipeline" | "job-detail" | "pipeline-detail" | "logs";

// ── Component ──────────────────────────────────────────────────

interface SchedulerPanelProps {
  projectId?: string | null;
  defaultJobName?: string;
  defaultJobType?: "once" | "recurring" | "on-event";
  defaultSchedule?: string;
  defaultActionType?: JobAction["type"];
  defaultScript?: string;
  defaultOutputPath?: string;
}

function readStringConfig(config: Record<string, unknown> | undefined, key: string): string | null {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function SchedulerPanel({
  projectId,
  defaultJobName = "",
  defaultJobType = "once",
  defaultSchedule = "0 0 * * *",
  defaultActionType = "run-script",
  defaultScript = "",
  defaultOutputPath = "",
}: SchedulerPanelProps = {}) {
  const [view, setView] = useState<View>("list");
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedJob, setSelectedJob] = useState<ScheduledJob | null>(null);
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(false);

  // New Job form state
  const [jobName, setJobName] = useState(defaultJobName);
  const [jobType, setJobType] = useState<"once" | "recurring" | "on-event">(defaultJobType);
  const [jobCron, setJobCron] = useState(defaultSchedule);
  const [jobEvent, setJobEvent] = useState("experiment-complete");
  const [jobRunAt, setJobRunAt] = useState("");
  const [jobActionType, setJobActionType] = useState<JobAction["type"]>(defaultActionType);
  const [jobScript, setJobScript] = useState(defaultScript);
  const [jobOutputPath, setJobOutputPath] = useState(defaultOutputPath);
  const [jobPipelineTemplate, setJobPipelineTemplate] = useState<string | null>(null);

  // New Pipeline form state
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [pipelineName, setPipelineName] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/scheduler");
      const data = await res.json() as { jobs: ScheduledJob[]; pipelines: Pipeline[] };
      const freshJobs = data.jobs ?? [];
      const freshPipelines = data.pipelines ?? [];
      setJobs(freshJobs);
      setPipelines(freshPipelines);

      // Keep selected items in sync with fresh data
      setSelectedJob((prev) =>
        prev ? freshJobs.find((j) => j.id === prev.id) ?? null : null
      );
      setSelectedPipeline((prev) =>
        prev ? freshPipelines.find((p) => p.id === prev.id) ?? null : null
      );
    } catch {
      // silently fail — data stays as-is
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // ── Actions ────────────────────────────────────────────────

  const createJob = async () => {
    if (!jobName.trim()) return;
    setLoading(true);
    try {
      await fetch("/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: jobName,
            type: jobType,
            schedule: jobType === "recurring" ? jobCron : undefined,
            triggerEvent: jobType === "on-event" ? jobEvent : undefined,
            runAt: jobType === "once" && jobRunAt ? new Date(jobRunAt).toISOString() : undefined,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            action: {
              type: jobActionType,
              script: jobActionType === "run-script" ? jobScript : undefined,
              config: {
                ...(projectId ? { projectId } : {}),
                ...(jobOutputPath.trim()
                  ? { expectedOutputPath: jobOutputPath.trim() }
                  : {}),
              },
              pipelineSteps: jobActionType === "pipeline" && jobPipelineTemplate
                ? templates[jobPipelineTemplate]?.steps
                    .map((s) => ({
                    type: s.type === "script" ? "run-script"
                      : s.type === "transform" ? "transform-data"
                      : s.type === "analyze" ? "ai-analysis"
                      : s.type === "notify" ? "notify"
                      : s.type === "condition" ? "condition"
                      : "generate-chart",
                    config: s.config,
                  } as JobAction))
                : undefined,
            },
          },
        }),
      });
      setJobName(defaultJobName);
      setJobScript(defaultScript);
      setJobOutputPath(defaultOutputPath);
      setJobType(defaultJobType);
      setJobCron(defaultSchedule);
      setJobEvent("experiment-complete");
      setJobRunAt("");
      setJobActionType(defaultActionType);
      setJobPipelineTemplate(null);
      setView("list");
      await fetchData();
    } finally {
      setLoading(false);
    }
  };

  const createPipelineFromTpl = async () => {
    if (!selectedTemplate) return;
    setLoading(true);
    try {
      await fetch("/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-from-template",
          template: selectedTemplate,
          overrides: pipelineName ? { name: pipelineName } : undefined,
        }),
      });
      setSelectedTemplate(null);
      setPipelineName("");
      setView("list");
      await fetchData();
    } finally {
      setLoading(false);
    }
  };

  const runJobNow = async (id: string) => {
    setLoading(true);
    try {
      await fetch("/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-job", id }),
      });
      await fetchData();
    } finally {
      setLoading(false);
    }
  };

  const patchJob = async (id: string, action: string) => {
    await fetch("/api/scheduler", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    await fetchData();
  };

  const removeJob = async (id: string) => {
    await fetch(`/api/scheduler?id=${id}&type=job`, { method: "DELETE" });
    setSelectedJob(null);
    setView("list");
    await fetchData();
  };

  const runPipelineNow = async (id: string) => {
    setLoading(true);
    try {
      await fetch("/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-pipeline", id }),
      });
      await fetchData();
    } finally {
      setLoading(false);
    }
  };

  const removePipeline = async (id: string) => {
    await fetch(`/api/scheduler?id=${id}&type=pipeline`, { method: "DELETE" });
    setSelectedPipeline(null);
    setView("list");
    await fetchData();
  };

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b-2 border-border flex-shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {view !== "list" && (
              <button
                onClick={() => setView("list")}
                className="text-xs text-muted hover:text-foreground transition-colors mr-1"
              >
                &larr; Back
              </button>
            )}
            <h2 className="text-lg font-bold">
              {view === "list" && "Pipelines & Jobs"}
              {view === "new-job" && "New Scheduled Job"}
              {view === "new-pipeline" && "New Pipeline"}
              {view === "job-detail" && selectedJob?.name}
              {view === "pipeline-detail" && selectedPipeline?.name}
              {view === "logs" && "Job Logs"}
            </h2>
          </div>
          {view === "list" && (
            <div className="flex gap-2">
              <button
                onClick={() => setView("new-job")}
                className="text-sm bg-accent text-white px-3 py-1.5 rounded-lg hover:bg-accent-hover transition-colors font-medium"
              >
                + New Job
              </button>
              <button
                onClick={() => setView("new-pipeline")}
                className="text-sm bg-surface border-2 border-border text-foreground px-3 py-1.5 rounded-lg hover:border-accent transition-colors font-medium"
              >
                + New Pipeline
              </button>
            </div>
          )}
        </div>
        {view === "list" && (
          <div className="flex gap-4 text-xs text-muted">
            <span>{jobs.filter((j) => j.status === "running").length} running</span>
            <span>{jobs.filter((j) => j.status === "pending").length} pending</span>
            <span>{pipelines.length} pipelines</span>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* ── List View ── */}
        {view === "list" && (
          <div>
            {/* Jobs */}
            {jobs.length > 0 && (
              <div>
                <div className="px-4 pt-4 pb-2">
                  <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Scheduled Jobs</h3>
                </div>
                <div className="divide-y divide-border/50">
                  {jobs.map((job) => {
                    const sc = jobStatusConfig[job.status] ?? jobStatusConfig.pending;
                    return (
                      <button
                        key={job.id}
                        onClick={() => { setSelectedJob(job); setView("job-detail"); }}
                        className="w-full text-left p-4 hover:bg-surface/50 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-mono font-medium ${sc.color}`}>
                              {sc.icon} {job.status}
                            </span>
                            <h3 className="text-sm font-semibold">{job.name}</h3>
                          </div>
                          <span className="text-[10px] text-muted font-mono">
                            {job.type === "recurring" && job.schedule}
                            {job.type === "on-event" && `on: ${job.triggerEvent}`}
                            {job.type === "once" && "one-time"}
                          </span>
                        </div>
                        <div className="flex gap-3 text-[10px] text-muted">
                          <span>Type: {job.action.type}</span>
                          {job.lastRun && <span>Last: {new Date(job.lastRun).toLocaleString()}</span>}
                          {job.nextRun && <span>Next: {new Date(job.nextRun).toLocaleString()}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Pipelines */}
            {pipelines.length > 0 && (
              <div>
                <div className="px-4 pt-4 pb-2">
                  <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Pipelines</h3>
                </div>
                <div className="divide-y divide-border/50">
                  {pipelines.map((pipeline) => {
                    const psc = jobStatusConfig[pipeline.status === "idle" ? "pending" : pipeline.status] ?? jobStatusConfig.pending;
                    return (
                      <button
                        key={pipeline.id}
                        onClick={() => { setSelectedPipeline(pipeline); setView("pipeline-detail"); }}
                        className="w-full text-left p-4 hover:bg-surface/50 transition-colors"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-mono font-medium ${psc.color}`}>
                              {psc.icon} {pipeline.status}
                            </span>
                            <h3 className="text-sm font-semibold">{pipeline.name}</h3>
                          </div>
                          <span className="text-[10px] text-muted font-mono">{pipeline.steps.length} steps</span>
                        </div>
                        {pipeline.description && (
                          <p className="text-xs text-muted mb-2">{pipeline.description}</p>
                        )}
                        {/* Mini step indicator */}
                        <div className="flex gap-1 items-center">
                          {pipeline.steps.map((step, i) => {
                            const ssc = stepStatusConfig[step.status] ?? stepStatusConfig.pending;
                            return (
                              <div key={step.id} className="flex items-center gap-1">
                                <div className={`w-5 h-5 rounded border text-[8px] font-bold flex items-center justify-center ${ssc.color}`}>
                                  {stepTypeIcons[step.type] ?? "?"}
                                </div>
                                {i < pipeline.steps.length - 1 && (
                                  <div className="w-3 h-px bg-border" />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Empty state */}
            {jobs.length === 0 && pipelines.length === 0 && (
              <div className="p-8 text-center text-muted text-sm">
                <div className="text-3xl mb-3">{"{ }"}</div>
                <p className="font-medium mb-1">No scheduled jobs or pipelines yet</p>
                <p>Create a scheduled job to automate experiment runs, or build a pipeline to chain multiple steps together.</p>
              </div>
            )}
          </div>
        )}

        {/* ── New Job Form ── */}
        {view === "new-job" && (
          <div className="p-4 space-y-4">
            <div>
              <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Job Name</label>
              <input
                type="text"
                value={jobName}
                onChange={(e) => setJobName(e.target.value)}
                placeholder="e.g., Nightly experiment rerun"
                className="w-full bg-surface border-2 border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Schedule Type</label>
              <div className="flex gap-2">
                {(["once", "recurring", "on-event"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setJobType(t)}
                    className={`flex-1 text-xs font-medium px-3 py-2 rounded-lg border-2 transition-colors ${
                      jobType === t
                        ? "border-accent bg-accent/5 text-accent"
                        : "border-border bg-surface text-muted hover:border-accent/50"
                    }`}
                  >
                    {t === "once" ? "One-time" : t === "recurring" ? "Recurring" : "On Event"}
                  </button>
                ))}
              </div>
            </div>

            {jobType === "recurring" && (
              <div>
                <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Schedule (cron)</label>
                <div className="flex gap-2 flex-wrap mb-2">
                  {cronPresets.map((preset) => (
                    <button
                      key={preset.value}
                      onClick={() => setJobCron(preset.value)}
                      className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
                        jobCron === preset.value
                          ? "border-accent bg-accent/10 text-accent"
                          : "border-border bg-surface text-muted hover:border-accent/50"
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={jobCron}
                  onChange={(e) => setJobCron(e.target.value)}
                  placeholder="* * * * *"
                  className="w-full bg-surface border-2 border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent transition-colors"
                />
              </div>
            )}

            {jobType === "on-event" && (
              <div>
                <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Trigger Event</label>
                <div className="flex gap-2 flex-wrap mb-2">
                  {["experiment-complete", "file-uploaded", "job-complete", "data-ready"].map((evt) => (
                    <button
                      key={evt}
                      onClick={() => setJobEvent(evt)}
                      className={`text-[10px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
                        jobEvent === evt
                          ? "border-accent bg-accent/10 text-accent"
                          : "border-border bg-surface text-muted hover:border-accent/50"
                      }`}
                    >
                      {evt}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={jobEvent}
                  onChange={(e) => setJobEvent(e.target.value)}
                  className="w-full bg-surface border-2 border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent transition-colors"
                />
              </div>
            )}

            {jobType === "once" && (
              <div>
                <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Run At (optional, blank = now)</label>
                <input
                  type="datetime-local"
                  value={jobRunAt}
                  onChange={(e) => setJobRunAt(e.target.value)}
                  className="w-full bg-surface border-2 border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent transition-colors"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Action Type</label>
              <div className="flex gap-2 flex-wrap">
                {(["run-script", "transform-data", "generate-chart", "ai-analysis", "pipeline"] as const).map((at) => (
                  <button
                    key={at}
                    onClick={() => {
                      if (at === jobActionType) return;
                      setJobActionType(at);
                      setJobScript(at === "run-script" ? defaultScript : "");
                    }}
                    className={`text-xs font-medium px-3 py-1.5 rounded-lg border-2 transition-colors ${
                      jobActionType === at
                        ? "border-accent bg-accent/5 text-accent"
                        : "border-border bg-surface text-muted hover:border-accent/50"
                    }`}
                  >
                    {at}
                  </button>
                ))}
              </div>
            </div>

            {jobActionType === "run-script" && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Script or Command</label>
                  <textarea
                    value={jobScript}
                    onChange={(e) => setJobScript(e.target.value)}
                    placeholder="e.g., python experiments/project_alpha_eval.py --dataset data/original-observations.csv --output results/rerun-result.md"
                    rows={3}
                    className="w-full bg-surface border-2 border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Expected Output Path</label>
                  <input
                    type="text"
                    value={jobOutputPath}
                    onChange={(e) => setJobOutputPath(e.target.value)}
                    placeholder="e.g., results/nightly-rerun-result.md"
                    className="w-full bg-surface border-2 border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent transition-colors"
                  />
                  <p className="mt-1 text-[10px] text-muted">
                    This appears in job details so reruns stay tied to a visible study artifact.
                  </p>
                </div>
              </div>
            )}

            {jobActionType !== "run-script" && (
              <div>
                <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Expected Output Path</label>
                <input
                  type="text"
                  value={jobOutputPath}
                  onChange={(e) => setJobOutputPath(e.target.value)}
                  placeholder="e.g., results/nightly-analysis.md"
                  className="w-full bg-surface border-2 border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent transition-colors"
                />
              </div>
            )}

            {jobActionType === "pipeline" && (
              <div>
                <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Pipeline Template</label>
                <div className="space-y-2">
                  {Object.entries(templates).map(([key, tpl]) => (
                    <button
                      key={key}
                      onClick={() => setJobPipelineTemplate(key)}
                      className={`w-full text-left p-3 rounded-lg border-2 transition-colors ${
                        jobPipelineTemplate === key
                          ? "border-accent bg-accent/5"
                          : "border-border bg-surface hover:border-accent/50"
                      }`}
                    >
                      <h4 className="text-sm font-semibold mb-0.5">{tpl.name}</h4>
                      <p className="text-xs text-muted">{tpl.steps.length} steps</p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={() => void createJob()}
              disabled={loading || !jobName.trim()}
              className="w-full bg-accent text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-accent-hover transition-colors disabled:opacity-40"
            >
              {loading ? "Creating..." : "Create Job"}
            </button>
          </div>
        )}

        {/* ── New Pipeline Form ── */}
        {view === "new-pipeline" && (
          <div className="p-4 space-y-4">
            <div>
              <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Choose a Template</label>
              <div className="space-y-2">
                {Object.entries(templates).map(([key, tpl]) => (
                  <button
                    key={key}
                    onClick={() => { setSelectedTemplate(key); setPipelineName(tpl.name); }}
                    className={`w-full text-left p-3 rounded-lg border-2 transition-colors ${
                      selectedTemplate === key
                        ? "border-accent bg-accent/5"
                        : "border-border bg-surface hover:border-accent/50"
                    }`}
                  >
                    <h4 className="text-sm font-semibold mb-1">{tpl.name}</h4>
                    <p className="text-xs text-muted mb-2">{tpl.description}</p>
                    <div className="flex gap-1 items-center">
                      {tpl.steps.map((step, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <div className="bg-surface border border-border rounded px-1.5 py-0.5 text-[9px] font-mono font-bold text-muted">
                            {stepTypeIcons[step.type] ?? "?"}
                          </div>
                          {i < tpl.steps.length - 1 && <div className="w-2 h-px bg-border" />}
                        </div>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {selectedTemplate && (
              <>
                <div>
                  <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1.5">Pipeline Name</label>
                  <input
                    type="text"
                    value={pipelineName}
                    onChange={(e) => setPipelineName(e.target.value)}
                    className="w-full bg-surface border-2 border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent transition-colors"
                  />
                </div>

                <button
                  onClick={() => void createPipelineFromTpl()}
                  disabled={loading}
                  className="w-full bg-accent text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-accent-hover transition-colors disabled:opacity-40"
                >
                  {loading ? "Creating..." : "Create Pipeline"}
                </button>
              </>
            )}
          </div>
        )}

        {/* ── Job Detail View ── */}
        {view === "job-detail" && selectedJob && (
          <div className="p-4 space-y-4">
            {(() => {
              const expectedOutputPath = readStringConfig(
                selectedJob.action.config,
                "expectedOutputPath",
              );
              const jobProjectId = readStringConfig(selectedJob.action.config, "projectId");
              return (
                <div className="rounded-lg border-2 border-border bg-white p-4">
                  <h3 className="text-xs font-bold text-muted uppercase tracking-wider">
                    What This Job Will Run
                  </h3>
                  <dl className="mt-3 grid gap-3 text-xs">
                    {jobProjectId ? (
                      <div>
                        <dt className="text-muted">Study</dt>
                        <dd className="mt-1 font-mono text-foreground">{jobProjectId}</dd>
                      </div>
                    ) : null}
                    {selectedJob.action.script ? (
                      <div>
                        <dt className="text-muted">Script or command</dt>
                        <dd className="mt-1 whitespace-pre-wrap rounded bg-surface px-3 py-2 font-mono text-foreground">
                          {selectedJob.action.script}
                        </dd>
                      </div>
                    ) : (
                      <div>
                        <dt className="text-muted">Action</dt>
                        <dd className="mt-1 font-mono text-foreground">{selectedJob.action.type}</dd>
                      </div>
                    )}
                    {expectedOutputPath ? (
                      <div>
                        <dt className="text-muted">Expected output</dt>
                        <dd className="mt-1 font-mono text-foreground">{expectedOutputPath}</dd>
                      </div>
                    ) : null}
                  </dl>
                </div>
              );
            })()}
            {/* Status + meta */}
            <div className="bg-surface border-2 border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className={`text-xs px-2.5 py-1 rounded-full font-mono font-medium ${(jobStatusConfig[selectedJob.status] ?? jobStatusConfig.pending).color}`}>
                  {(jobStatusConfig[selectedJob.status] ?? jobStatusConfig.pending).icon} {selectedJob.status}
                </span>
                <span className="text-[10px] text-muted font-mono">
                  {selectedJob.type} | {selectedJob.action.type}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                {selectedJob.schedule && (
                  <div>
                    <span className="text-muted block">Schedule</span>
                    <span className="font-mono font-medium">{selectedJob.schedule}</span>
                  </div>
                )}
                {selectedJob.triggerEvent && (
                  <div>
                    <span className="text-muted block">Trigger</span>
                    <span className="font-mono font-medium">{selectedJob.triggerEvent}</span>
                  </div>
                )}
                {selectedJob.lastRun && (
                  <div>
                    <span className="text-muted block">Last Run</span>
                    <span className="font-mono">{new Date(selectedJob.lastRun).toLocaleString()}</span>
                  </div>
                )}
                {selectedJob.nextRun && (
                  <div>
                    <span className="text-muted block">Next Run</span>
                    <span className="font-mono">{new Date(selectedJob.nextRun).toLocaleString()}</span>
                  </div>
                )}
                <div>
                  <span className="text-muted block">Created</span>
                  <span className="font-mono">{new Date(selectedJob.createdAt).toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => void runJobNow(selectedJob.id)}
                disabled={loading || selectedJob.status === "running"}
                className="text-xs bg-accent text-white px-3 py-1.5 rounded-lg hover:bg-accent-hover transition-colors font-medium disabled:opacity-40"
              >
                Run Now
              </button>
              {selectedJob.status === "paused" ? (
                <button
                  onClick={() => void patchJob(selectedJob.id, "resume")}
                  className="text-xs bg-surface border-2 border-border px-3 py-1.5 rounded-lg hover:border-accent transition-colors font-medium"
                >
                  Resume
                </button>
              ) : (
                <button
                  onClick={() => void patchJob(selectedJob.id, "pause")}
                  disabled={selectedJob.status === "running"}
                  className="text-xs bg-surface border-2 border-border px-3 py-1.5 rounded-lg hover:border-accent transition-colors font-medium disabled:opacity-40"
                >
                  Pause
                </button>
              )}
              <button
                onClick={() => void patchJob(selectedJob.id, "cancel")}
                className="text-xs bg-surface border-2 border-border px-3 py-1.5 rounded-lg hover:border-danger/40 text-danger transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => void removeJob(selectedJob.id)}
                className="text-xs bg-danger/10 border-2 border-danger/30 px-3 py-1.5 rounded-lg hover:bg-danger/20 text-danger transition-colors font-medium"
              >
                Delete
              </button>
            </div>

            {/* Logs */}
            <div>
              <h3 className="text-xs font-bold text-muted uppercase tracking-wider mb-2">Logs</h3>
              <div className="bg-ink text-quiet rounded-lg p-3 max-h-64 overflow-y-auto font-mono text-[11px] leading-relaxed">
                {selectedJob.logs.length === 0 ? (
                  <span className="text-dim">No logs yet</span>
                ) : (
                  selectedJob.logs.map((log, i) => (
                    <div key={i} className="whitespace-pre-wrap">{log}</div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Pipeline Detail View ── */}
        {view === "pipeline-detail" && selectedPipeline && (
          <div className="p-4 space-y-4">
            {/* Status */}
            <div className="bg-surface border-2 border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className={`text-xs px-2.5 py-1 rounded-full font-mono font-medium ${(jobStatusConfig[selectedPipeline.status === "idle" ? "pending" : selectedPipeline.status] ?? jobStatusConfig.pending).color}`}>
                  {selectedPipeline.status}
                </span>
                <span className="text-[10px] text-muted font-mono">{selectedPipeline.steps.length} steps</span>
              </div>
              {selectedPipeline.description && (
                <p className="text-xs text-muted">{selectedPipeline.description}</p>
              )}
            </div>

            {/* Pipeline visualizer */}
            <div>
              <h3 className="text-xs font-bold text-muted uppercase tracking-wider mb-3">Pipeline Steps</h3>
              <div className="space-y-0">
                {selectedPipeline.steps.map((step, i) => {
                  const ssc = stepStatusConfig[step.status] ?? stepStatusConfig.pending;
                  return (
                    <div key={step.id}>
                      <div className={`relative flex items-start gap-3 p-3 rounded-lg border-2 ${ssc.color}`}>
                        {/* Step number + connector */}
                        <div className="flex flex-col items-center flex-shrink-0">
                          <div className={`w-7 h-7 rounded-full ${ssc.bg} text-white text-xs font-bold flex items-center justify-center`}>
                            {i + 1}
                          </div>
                        </div>
                        {/* Step info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] font-mono font-bold text-muted bg-white/50 rounded px-1.5 py-0.5">
                              {stepTypeIcons[step.type] ?? "?"}
                            </span>
                            <h4 className="text-sm font-semibold truncate">{step.name}</h4>
                          </div>
                          <div className="flex gap-2 text-[10px] text-muted">
                            <span>Type: {step.type}</span>
                            <span>Status: {step.status}</span>
                          </div>
                          {step.output != null && step.status === "completed" && (
                            <div className="mt-1.5 bg-white/80 rounded px-2 py-1 text-[10px] font-mono text-muted max-h-16 overflow-hidden">
                              {String(typeof step.output === "string" ? step.output : JSON.stringify(step.output)).slice(0, 200)}
                              {String(typeof step.output === "string" ? step.output : JSON.stringify(step.output)).length > 200 && "..."}
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Connector line */}
                      {i < selectedPipeline.steps.length - 1 && (
                        <div className="flex justify-start ml-[22px]">
                          <div className="w-px h-3 bg-border" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onClick={() => void runPipelineNow(selectedPipeline.id)}
                disabled={loading || selectedPipeline.status === "running"}
                className="text-xs bg-accent text-white px-3 py-1.5 rounded-lg hover:bg-accent-hover transition-colors font-medium disabled:opacity-40"
              >
                {selectedPipeline.status === "running" ? "Running..." : "Run Pipeline"}
              </button>
              <button
                onClick={() => void removePipeline(selectedPipeline.id)}
                className="text-xs bg-danger/10 border-2 border-danger/30 px-3 py-1.5 rounded-lg hover:bg-danger/20 text-danger transition-colors font-medium"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
