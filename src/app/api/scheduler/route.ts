import {
  scheduleJob,
  cancelJob,
  deleteJob,
  getJobs,
  getJob,
  runJob,
  pauseJob,
  resumeJob,
  emitEvent,
  type JobAction,
} from "@/lib/scheduler";
import {
  createPipeline,
  createPipelineFromTemplate,
  executePipeline,
  getPipeline,
  getPipelines,
  deletePipeline,
} from "@/lib/pipeline";
import { isLocalRequest } from "@/lib/local-guard";

const JOB_TYPES = new Set(["once", "recurring", "on-event"]);
const JOB_ACTION_TYPES = new Set([
  "run-script",
  "transform-data",
  "generate-chart",
  "ai-analysis",
  "pipeline",
  "notify",
  "condition",
  "frontier-watch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJobAction(value: unknown): value is JobAction {
  if (!isRecord(value) || typeof value.type !== "string" || !JOB_ACTION_TYPES.has(value.type)) {
    return false;
  }

  if (value.script !== undefined && typeof value.script !== "string") {
    return false;
  }

  if (value.config !== undefined && !isRecord(value.config)) {
    return false;
  }

  if (value.pipelineSteps !== undefined && !Array.isArray(value.pipelineSteps)) {
    return false;
  }

  if (Array.isArray(value.pipelineSteps) && !value.pipelineSteps.every(isJobAction)) {
    return false;
  }

  if (value.type === "frontier-watch") {
    return isRecord(value.config) && typeof value.config.project === "string" && Boolean(value.config.project.trim());
  }

  return true;
}

// ── GET: list jobs and pipelines ───────────────────────────────

export async function GET(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get("type"); // "jobs" | "pipelines" | "job" | "pipeline"
  const id = url.searchParams.get("id");

  if (type === "job" && id) {
    const job = getJob(id);
    if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
    return Response.json(job);
  }

  if (type === "pipeline" && id) {
    const pipeline = getPipeline(id);
    if (!pipeline) return Response.json({ error: "Pipeline not found" }, { status: 404 });
    return Response.json(pipeline);
  }

  if (type === "pipelines") {
    return Response.json({ pipelines: getPipelines() });
  }

  // Default: return both
  return Response.json({
    jobs: getJobs(),
    pipelines: getPipelines(),
  });
}

// ── POST: create jobs, pipelines, emit events ──────────────────

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json() as Record<string, unknown>;
  const action = body.action as string;

  switch (action) {
    case "schedule-job": {
      const jobData = body.job;

      if (!isRecord(jobData) || typeof jobData.name !== "string" || !jobData.name.trim() || !isJobAction(jobData.action)) {
        return Response.json({ error: "Missing name or action" }, { status: 400 });
      }

      if (typeof jobData.type !== "string" || !JOB_TYPES.has(jobData.type)) {
        return Response.json({ error: "Invalid or missing job type" }, { status: 400 });
      }

      const schedule = typeof jobData.schedule === "string" ? jobData.schedule.trim() : undefined;
      const triggerEvent = typeof jobData.triggerEvent === "string" ? jobData.triggerEvent.trim() : undefined;
      const timezone = typeof jobData.timezone === "string" ? jobData.timezone.trim() || undefined : undefined;
      let runAt: Date | undefined;

      if (jobData.type === "recurring" && !schedule) {
        return Response.json({ error: "Recurring jobs require a schedule" }, { status: 400 });
      }

      if (jobData.type === "on-event" && !triggerEvent) {
        return Response.json({ error: "Event-triggered jobs require a triggerEvent" }, { status: 400 });
      }

      if (jobData.runAt !== undefined) {
        if (typeof jobData.runAt !== "string") {
          return Response.json({ error: "runAt must be an ISO date string" }, { status: 400 });
        }
        runAt = new Date(jobData.runAt);
        if (Number.isNaN(runAt.getTime())) {
          return Response.json({ error: "runAt must be a valid ISO date string" }, { status: 400 });
        }
      }

      const id = scheduleJob({
        name: jobData.name.trim(),
        type: jobData.type as "once" | "recurring" | "on-event",
        schedule,
        triggerEvent,
        runAt,
        timezone,
        action: jobData.action,
      });

      return Response.json({ id, status: "scheduled" });
    }

    case "run-job": {
      const jobId = body.id as string;
      if (!jobId) return Response.json({ error: "Missing job id" }, { status: 400 });
      const result = await runJob(jobId);
      return Response.json(result);
    }

    case "create-pipeline": {
      const pipelineData = body.pipeline as {
        name: string;
        description?: string;
        steps: {
          name: string;
          type: "script" | "transform" | "analyze" | "chart" | "notify" | "condition";
          config: Record<string, unknown>;
          dependsOn?: string[];
        }[];
      };

      if (!pipelineData?.name || !Array.isArray(pipelineData.steps) || pipelineData.steps.length === 0) {
        return Response.json({ error: "Missing pipeline name or steps must be a non-empty array" }, { status: 400 });
      }

      const pipeline = createPipeline(
        pipelineData.name,
        pipelineData.description ?? "",
        pipelineData.steps
      );
      return Response.json({ id: pipeline.id, pipeline });
    }

    case "create-from-template": {
      const templateKey = body.template as string;
      const overrides = body.overrides as {
        name?: string;
        description?: string;
        stepConfigs?: Record<number, Record<string, unknown>>;
      } | undefined;

      const pipeline = createPipelineFromTemplate(templateKey, overrides);
      if (!pipeline) {
        return Response.json({ error: "Template not found" }, { status: 404 });
      }
      return Response.json({ id: pipeline.id, pipeline });
    }

    case "run-pipeline": {
      const pipelineId = body.id as string;
      if (!pipelineId) return Response.json({ error: "Missing pipeline id" }, { status: 400 });
      const pipeline = getPipeline(pipelineId);
      if (!pipeline) return Response.json({ error: "Pipeline not found" }, { status: 404 });
      const result = await executePipeline(pipeline);
      return Response.json(result);
    }

    case "emit-event": {
      const event = body.event as string;
      const data = body.data;
      if (!event) return Response.json({ error: "Missing event" }, { status: 400 });
      emitEvent(event, data);
      return Response.json({ emitted: event });
    }

    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}

// ── PATCH: pause, resume, cancel ───────────────────────────────

export async function PATCH(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json() as Record<string, unknown>;
  const id = body.id as string;
  const action = body.action as string;

  if (!id || !action) {
    return Response.json({ error: "Missing id or action" }, { status: 400 });
  }

  switch (action) {
    case "pause":
      pauseJob(id);
      return Response.json({ id, status: "paused" });
    case "resume":
      resumeJob(id);
      return Response.json({ id, status: "resumed" });
    case "cancel":
      cancelJob(id);
      return Response.json({ id, status: "cancelled" });
    default:
      return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}

// ── DELETE: remove a job or pipeline ───────────────────────────

export async function DELETE(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const type = url.searchParams.get("type") ?? "job";

  if (!id) {
    return Response.json({ error: "Missing id" }, { status: 400 });
  }

  if (type === "pipeline") {
    deletePipeline(id);
  } else {
    deleteJob(id);
  }

  return Response.json({ deleted: id });
}
