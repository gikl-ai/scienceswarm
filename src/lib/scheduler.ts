import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startConversation, getConversation } from "./openhands";
import { completeChat } from "./message-handler";
import { executePipeline, type Pipeline } from "./pipeline";
import { loadBrainConfig } from "@/brain/config";
import { readProjectManifest } from "@/lib/state/project-manifests";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";
import { getScienceSwarmStateRoot } from "@/lib/scienceswarm-paths";
import { refreshProjectWatchFrontier } from "@/lib/watch";

// ── Types ──────────────────────────────────────────────────────

export interface JobAction {
  type: "run-script" | "transform-data" | "generate-chart" | "ai-analysis" | "pipeline" | "notify" | "condition" | "frontier-watch";
  script?: string;
  config?: Record<string, unknown>;
  pipelineSteps?: JobAction[];
}

export interface JobResult {
  success: boolean;
  output: unknown;
  duration: number;
  error?: string;
}

export interface ScheduledJob {
  id: string;
  name: string;
  type: "once" | "recurring" | "on-event";
  schedule?: string;
  triggerEvent?: string;
  runAt?: Date;
  timezone?: string;
  action: JobAction;
  status: "pending" | "running" | "completed" | "failed" | "paused";
  lastRun?: Date;
  nextRun?: Date;
  logs: string[];
  createdAt: Date;
  result?: JobResult;
}

// ── Cron Parser (minimal) ──────────────────────────────────────

function parseDowTargets(value: string | undefined): number[] | null {
  if (!value || value === "*") return null;
  const parsedTargets = value.split(",").flatMap((segment) => {
    const trimmed = segment.trim();
    if (!trimmed) return [];

    if (/^\d+$/.test(trimmed)) {
      const day = Number(trimmed) % 7;
      return day >= 0 && day <= 6 ? [day] : [];
    }

    const range = trimmed.match(/^(\d+)-(\d+)$/);
    if (!range) return [];

    const start = Number(range[1]) % 7;
    const end = Number(range[2]) % 7;
    if (start <= end) {
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
    return [
      ...Array.from({ length: 7 - start }, (_, index) => start + index),
      ...Array.from({ length: end + 1 }, (_, index) => index),
    ];
  });

  if (parsedTargets.length === 0) return null;
  return Array.from(new Set(parsedTargets)).sort((left, right) => left - right);
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const timeZoneFormatters = new Map<string, Intl.DateTimeFormat>();

function normalizeSchedulerTimeZone(timezone: string | undefined): string | undefined {
  const trimmed = timezone?.trim();
  if (!trimmed || trimmed === "local") return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return undefined;
  }
}

function getTimeZoneFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = timeZoneFormatters.get(timezone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  timeZoneFormatters.set(timezone, formatter);
  return formatter;
}

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  const values: Record<string, number> = {};
  for (const part of getTimeZoneFormatter(timezone).formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function getTimeZoneOffsetMs(date: Date, timezone: string): number {
  const parts = getZonedDateParts(date, timezone);
  const zonedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return zonedAsUtc - date.getTime();
}

function zonedDateTimeToUtc(parts: Omit<ZonedDateParts, "second">, timezone: string): Date {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  let candidate = new Date(localAsUtc);

  for (let index = 0; index < 2; index++) {
    candidate = new Date(localAsUtc - getTimeZoneOffsetMs(candidate, timezone));
  }

  return candidate;
}

function addCalendarDays(parts: ZonedDateParts, days: number): Omit<ZonedDateParts, "second"> {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

function zonedDayOfWeek(parts: Pick<ZonedDateParts, "year" | "month" | "day">): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function nextCronDateForTime(hour: number, minute: number, timezone: string | undefined): Date {
  const now = new Date();
  if (!timezone) {
    const next = new Date(now);
    next.setMinutes(minute, 0, 0);
    next.setHours(hour);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  const nowParts = getZonedDateParts(now, timezone);
  const candidateParts = { ...nowParts, hour, minute };
  let candidate = zonedDateTimeToUtc(candidateParts, timezone);
  if (candidate <= now) {
    candidate = zonedDateTimeToUtc(addCalendarDays(candidateParts, 1), timezone);
  }
  return candidate;
}

function nextCronDateForTimeAndDays(
  hour: number,
  minute: number,
  targetDays: number[],
  timezone?: string,
): Date {
  const now = new Date();
  let best: Date | null = null;

  for (const targetDow of targetDays) {
    let candidate: Date;
    let currentDow: number;
    if (timezone) {
      const nowParts = getZonedDateParts(now, timezone);
      currentDow = zonedDayOfWeek(nowParts);
      let daysUntil = (targetDow - currentDow + 7) % 7;
      candidate = zonedDateTimeToUtc({ ...addCalendarDays(nowParts, daysUntil), hour, minute }, timezone);
      if (daysUntil === 0 && candidate <= now) {
        daysUntil = 7;
        candidate = zonedDateTimeToUtc({ ...addCalendarDays(nowParts, daysUntil), hour, minute }, timezone);
      }
    } else {
      candidate = new Date(now);
      candidate.setMinutes(minute, 0, 0);
      candidate.setHours(hour);
      currentDow = candidate.getDay();
      let daysUntil = (targetDow - currentDow + 7) % 7;
      if (daysUntil === 0 && candidate <= now) daysUntil = 7;
      candidate.setDate(candidate.getDate() + daysUntil);
    }

    if (!best || candidate < best) {
      best = candidate;
    }
  }

  return best ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
}

function parseCronToMs(cron: string): number | null {
  // Supports simple patterns: */N for minutes
  // Full cron: min hour dom month dow
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return null;

  const minPart = parts[0];
  if (minPart.startsWith("*/")) {
    const interval = parseInt(minPart.slice(2), 10);
    if (!isNaN(interval) && interval > 0) return interval * 60 * 1000;
  }

  // Common exact presets
  if (cron === "0 * * * *") return 60 * 60 * 1000;          // hourly
  if (cron === "0 0 * * *") return 24 * 60 * 60 * 1000;     // daily midnight
  if (cron === "0 0 * * 0") return 7 * 24 * 60 * 60 * 1000; // weekly

  // Hour-field */N  e.g. "0 */6 * * *"
  const hourPart = parts[1];
  if (hourPart.startsWith("*/")) {
    const interval = parseInt(hourPart.slice(2), 10);
    if (!isNaN(interval) && interval > 0) return interval * 60 * 60 * 1000;
  }

  // Specific hour, run daily  e.g. "0 9 * * *"
  // Only match when dom, month, and dow are all wildcards to avoid
  // collapsing constrained schedules (e.g. "0 9 * * 1") into daily.
  if (
    !isNaN(parseInt(minPart, 10)) &&
    !isNaN(parseInt(parts[1], 10)) &&
    parts[2] === "*" &&
    parts[3] === "*" &&
    parts[4] === "*"
  ) {
    return 24 * 60 * 60 * 1000;
  }

  // Specific day-of-week or range, run on matching days  e.g. "0 9 * * 1" or "0 9 * * 1-5"
  if (
    !isNaN(parseInt(minPart, 10)) &&
    !isNaN(parseInt(parts[1], 10)) &&
    parts[2] === "*" &&
    parts[3] === "*" &&
    parts[4] !== "*"
  ) {
    const targetMinute = parseInt(minPart, 10);
    const targetHour = parseInt(parts[1], 10);
    const targetDays = parseDowTargets(parts[4]);
    if (!targetDays) return 60 * 60 * 1000;
    const next = nextCronDateForTimeAndDays(targetHour, targetMinute, targetDays);
    return next.getTime() - Date.now();
  }

  // Default: run every hour for unrecognized patterns
  return 60 * 60 * 1000;
}

function getNextRunFromCron(cron: string, timezone?: string): Date {
  const parts = cron.trim().split(/\s+/);
  const normalizedTimeZone = normalizeSchedulerTimeZone(timezone);
  const now = new Date();

  // Try to align to the next natural boundary
  if (parts.length >= 5) {
    const next = new Date(now);

    // Specific day-of-week or range, run on matching days
    if (!isNaN(parseInt(parts[0], 10)) && !parts[1].startsWith("*") && parts[2] === "*" && parts[3] === "*" && parts[4] !== "*") {
      const targetMinute = parseInt(parts[0], 10);
      const targetHour = parseInt(parts[1], 10);
      const targetDays = parseDowTargets(parts[4]);
      if (!isNaN(targetMinute) && !isNaN(targetHour) && targetDays) {
        return nextCronDateForTimeAndDays(targetHour, targetMinute, targetDays, normalizedTimeZone);
      }
    }

    // Specific hour patterns like "0 9 * * *" — next occurrence of that hour
    if (
      !isNaN(parseInt(parts[0], 10)) &&
      !parts[1].startsWith("*") &&
      parts[2] === "*" &&
      parts[3] === "*" &&
      parts[4] === "*"
    ) {
      const targetMinute = parseInt(parts[0], 10);
      const targetHour = parseInt(parts[1], 10);
      if (!isNaN(targetMinute) && !isNaN(targetHour)) {
        return nextCronDateForTime(targetHour, targetMinute, normalizedTimeZone);
      }
    }

    // Hourly "0 * * * *" — next top of the hour
    if (cron === "0 * * * *") {
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      return next;
    }

    // Daily at midnight "0 0 * * *"
    if (cron === "0 0 * * *") {
      next.setHours(0, 0, 0, 0);
      next.setDate(next.getDate() + 1);
      return next;
    }
  }

  // Fallback: interval from now
  const intervalMs = parseCronToMs(cron);
  return new Date(Date.now() + (intervalMs ?? 60 * 60 * 1000));
}

// ── In-Memory Store ────────────────────────────────────────────

const jobs = new Map<string, ScheduledJob>();
const timers = new Map<string, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();
const eventListeners = new Map<string, Set<string>>(); // event -> job IDs

interface StoredJob extends Omit<ScheduledJob, "runAt" | "lastRun" | "nextRun" | "createdAt"> {
  runAt?: string;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
}

interface StoredSchedulerState {
  version: 1;
  jobs: Record<string, StoredJob>;
  eventListeners: Record<string, string[]>;
  updatedAt: string;
}

function getSchedulerStorePath(): string {
  return join(getScienceSwarmStateRoot(), "schedules", "jobs.json");
}

function serializeJob(job: ScheduledJob): StoredJob {
  return {
    ...job,
    runAt: job.runAt?.toISOString(),
    lastRun: job.lastRun?.toISOString(),
    nextRun: job.nextRun?.toISOString(),
    createdAt: job.createdAt.toISOString(),
    result: job.result,
  };
}

function deserializeJob(job: StoredJob): ScheduledJob {
  return {
    ...job,
    runAt: job.runAt ? new Date(job.runAt) : undefined,
    lastRun: job.lastRun ? new Date(job.lastRun) : undefined,
    nextRun: job.nextRun ? new Date(job.nextRun) : undefined,
    createdAt: new Date(job.createdAt),
  };
}

function persistSchedulerState(): void {
  const root = getScienceSwarmStateRoot();
  const storePath = getSchedulerStorePath();
  mkdirSync(join(root, "schedules"), { recursive: true });

  const state: StoredSchedulerState = {
    version: 1,
    jobs: Object.fromEntries(
      Array.from(jobs.entries(), ([id, job]) => [id, serializeJob(job)]),
    ),
    eventListeners: Object.fromEntries(
      Array.from(eventListeners.entries(), ([event, ids]) => [event, Array.from(ids)]),
    ),
    updatedAt: new Date().toISOString(),
  };

  const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, storePath);
}

function loadSchedulerState(): void {
  const storePath = getSchedulerStorePath();
  if (!existsSync(storePath)) return;

  try {
    const raw = readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw) as StoredSchedulerState;

    jobs.clear();
    eventListeners.clear();

    for (const [id, job] of Object.entries(parsed.jobs ?? {})) {
      const deserialized = deserializeJob(job);
      if (deserialized.status === "running") {
        deserialized.status = "failed";
        deserialized.logs.push(
          `[${new Date().toISOString()}] Reset from "running" to "failed" on restart`,
        );
      }
      jobs.set(id, deserialized);
    }

    for (const [event, ids] of Object.entries(parsed.eventListeners ?? {})) {
      eventListeners.set(event, new Set(ids));
    }
  } catch {
    // Corrupted store should not break scheduler startup.
  }
}

function scheduleTimerForJob(job: ScheduledJob): void {
  if (job.status === "paused") return;
  if (job.type !== "on-event" && job.status !== "pending" && job.status !== "running") {
    return;
  }

  if (job.type === "once") {
    const delay = job.runAt ? Math.max(0, job.runAt.getTime() - Date.now()) : 0;
    const timer = setTimeout(() => void runJob(job.id), delay);
    timers.set(job.id, timer);
    return;
  }

  if (job.type === "recurring" && job.schedule) {
    job.nextRun ??= getNextRunFromCron(job.schedule, job.timezone);
    const initialDelay = Math.max(0, job.nextRun.getTime() - Date.now());

    function scheduleNext(delay: number) {
      const timer = setTimeout(() => {
        void runJob(job.id).then(() => {
          const current = jobs.get(job.id);
          if (current && current.status !== "paused" && timers.has(job.id)) {
            const nextRun = getNextRunFromCron(job.schedule!, job.timezone);
            current.nextRun = nextRun;
            persistSchedulerState();
            scheduleNext(Math.max(0, nextRun.getTime() - Date.now()));
          }
        });
      }, delay);
      timers.set(job.id, timer);
    }

    scheduleNext(initialDelay);
    return;
  }

  if (job.type === "on-event" && job.triggerEvent) {
    if (!eventListeners.has(job.triggerEvent)) {
      eventListeners.set(job.triggerEvent, new Set());
    }
    eventListeners.get(job.triggerEvent)!.add(job.id);
  }
}

// ── Job Execution ──────────────────────────────────────────────

async function executeAction(action: JobAction, job: ScheduledJob): Promise<JobResult> {
  const start = Date.now();

  try {
    switch (action.type) {
      case "run-script": {
        job.logs.push(`[${new Date().toISOString()}] Executing script: ${action.script ?? "unknown"}`);
        const conversation = await startConversation({
          message: `Run the following script and report the results:\n\`\`\`\n${action.script}\n\`\`\``,
        });
        // Poll for completion (up to 5 minutes)
        let status = "running";
        for (let i = 0; i < 30 && status === "running"; i++) {
          await new Promise((r) => setTimeout(r, 10_000));
          const conv = await getConversation(conversation.id ?? conversation.conversation_id);
          status = conv.execution_status;
        }
        job.logs.push(`[${new Date().toISOString()}] Script finished with status: ${status}`);
        return {
          success: status === "finished" || status === "idle",
          output: { conversationId: conversation.id ?? conversation.conversation_id, status },
          duration: Date.now() - start,
        };
      }

      case "transform-data": {
        const format = (action.config?.format as string) ?? "csv-to-json";
        job.logs.push(`[${new Date().toISOString()}] Transforming data (${format})`);
        const result = await completeChat({
          messages: [
            {
              role: "user",
              content: `Transform the following data. Format: ${format}. Config: ${JSON.stringify(action.config ?? {})}. Return only the transformed data.`,
            },
          ],
          channel: "web",
        });
        job.logs.push(`[${new Date().toISOString()}] Transform complete`);
        return { success: true, output: result, duration: Date.now() - start };
      }

      case "generate-chart": {
        job.logs.push(`[${new Date().toISOString()}] Generating chart`);
        const chartCode = await completeChat({
          messages: [
            {
              role: "user",
              content: `Generate Python matplotlib code for the following chart request: ${JSON.stringify(action.config ?? {})}. Return only executable Python code.`,
            },
          ],
          channel: "web",
        });
        // Execute the chart code via OpenHands
        const conversation = await startConversation({
          message: `Run this Python chart generation code and save the output:\n\`\`\`python\n${chartCode}\n\`\`\``,
        });
        job.logs.push(`[${new Date().toISOString()}] Chart generation submitted`);
        return {
          success: true,
          output: { chartCode, conversationId: conversation.id ?? conversation.conversation_id },
          duration: Date.now() - start,
        };
      }

      case "ai-analysis": {
        job.logs.push(`[${new Date().toISOString()}] Running AI analysis`);
        const prompt = (action.config?.prompt as string) ?? "Analyze the following results and provide insights.";
        const analysisResult = await completeChat({
          messages: [{ role: "user", content: prompt }],
          channel: "web",
          maxTokens: 4096,
        });
        job.logs.push(`[${new Date().toISOString()}] Analysis complete`);
        return { success: true, output: analysisResult, duration: Date.now() - start };
      }

      case "pipeline": {
        if (!action.pipelineSteps || action.pipelineSteps.length === 0) {
          throw new Error("Pipeline action requires pipelineSteps");
        }
        job.logs.push(`[${new Date().toISOString()}] Running pipeline with ${action.pipelineSteps.length} steps`);
        const pipeline: Pipeline = {
          id: `pipeline-${job.id}`,
          name: `Pipeline for ${job.name}`,
          description: "",
          steps: action.pipelineSteps.map((step, i) => ({
            id: `step-${i}`,
            name: `Step ${i + 1}: ${step.type}`,
            type: step.type === "run-script" ? "script"
              : step.type === "transform-data" ? "transform"
              : step.type === "generate-chart" ? "chart"
              : step.type === "ai-analysis" ? "analyze"
              : step.type === "notify" ? "notify"
              : step.type === "condition" ? "condition"
              : "script",
            config: { ...step.config, script: step.script },
            status: "pending" as const,
          })),
          status: "idle",
          currentStep: 0,
          results: [],
        };
        const pipelineResult = await executePipeline(pipeline);
        job.logs.push(`[${new Date().toISOString()}] Pipeline finished: ${pipelineResult.status}`);
        return {
          success: pipelineResult.status === "completed",
          output: pipelineResult,
          duration: Date.now() - start,
        };
      }

      case "frontier-watch": {
        const project = action.config?.project;
        if (typeof project !== "string" || !project.trim()) {
          throw new Error("Frontier watch action requires a project");
        }
        const config = loadBrainConfig();
        if (!config) {
          throw new Error("No research brain is initialized yet for frontier watch");
        }
        const safeProject = project.trim();
        const manifest = await readProjectManifest(
          safeProject,
          getProjectStateRootForBrainRoot(safeProject, config.root),
        );
        if (!manifest) {
          throw new Error(`Study ${project} was not found in brain state`);
        }
        const refreshed = await refreshProjectWatchFrontier(config, manifest);
        job.logs.push(`[${new Date().toISOString()}] Frontier watch refreshed for ${project}`);
        return {
          success: true,
          output: {
            project,
            frontierPaths: refreshed.frontierPaths,
          },
          duration: Date.now() - start,
        };
      }

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    job.logs.push(`[${new Date().toISOString()}] ERROR: ${errorMsg}`);
    return { success: false, output: null, duration: Date.now() - start, error: errorMsg };
  }
}

// ── Core Scheduler Functions ───────────────────────────────────

export function scheduleJob(
  job: Omit<ScheduledJob, "id" | "status" | "logs" | "createdAt">
): string {
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const scheduledJob: ScheduledJob = {
    ...job,
    id,
    status: "pending",
    logs: [`[${new Date().toISOString()}] Job created: ${job.name}`],
    createdAt: new Date(),
  };

  // Compute nextRun
  if (job.type === "once" && job.runAt) {
    scheduledJob.nextRun = job.runAt;
  } else if (job.type === "recurring" && job.schedule) {
    scheduledJob.nextRun = getNextRunFromCron(job.schedule, job.timezone);
  }

  jobs.set(id, scheduledJob);
  scheduleTimerForJob(scheduledJob);
  persistSchedulerState();

  return id;
}

export function cancelJob(id: string): void {
  const job = jobs.get(id);
  if (!job) return;

  // Clear timer
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
    clearInterval(timer as ReturnType<typeof setInterval>);
    timers.delete(id);
  }

  // Remove event listener
  if (job.type === "on-event" && job.triggerEvent) {
    eventListeners.get(job.triggerEvent)?.delete(id);
  }

  job.status = "paused";
  job.logs.push(`[${new Date().toISOString()}] Job cancelled`);
  persistSchedulerState();
}

export function deleteJob(id: string): void {
  cancelJob(id);
  jobs.delete(id);
  persistSchedulerState();
}

export function getJobs(): ScheduledJob[] {
  return Array.from(jobs.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
}

export function getJob(id: string): ScheduledJob | undefined {
  return jobs.get(id);
}

export async function runJob(id: string): Promise<JobResult> {
  const job = jobs.get(id);
  if (!job) {
    return { success: false, output: null, duration: 0, error: "Job not found" };
  }

  if (job.status === "paused") {
    return { success: false, output: null, duration: 0, error: "Job is paused" };
  }

  if (job.status === "running") {
    return { success: false, output: null, duration: 0, error: "Job is already running" };
  }

  job.status = "running";
  job.lastRun = new Date();
  job.logs.push(`[${new Date().toISOString()}] Job started`);

  const result = await executeAction(job.action, job);

  job.status = result.success ? "completed" : "failed";
  job.result = result;

  if (job.type === "recurring" && job.schedule) {
    // Reset to pending for recurring jobs
    job.status = "pending";
    job.nextRun = getNextRunFromCron(job.schedule, job.timezone);
    job.logs.push(`[${new Date().toISOString()}] Next run scheduled for ${job.nextRun.toISOString()}`);
  }

  job.logs.push(`[${new Date().toISOString()}] Job finished (${result.success ? "success" : "failed"}) in ${result.duration}ms`);
  persistSchedulerState();

  if (job.type !== "on-event") {
    // Emit "job-complete" event for dependent jobs
    emitEvent("job-complete", { jobId: id, result });
  }

  return result;
}

export function pauseJob(id: string): void {
  const job = jobs.get(id);
  if (!job || job.status === "running") return;

  job.status = "paused";
  job.logs.push(`[${new Date().toISOString()}] Job paused`);

  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
    clearInterval(timer as ReturnType<typeof setInterval>);
    timers.delete(id);
  }
  persistSchedulerState();
}

export function resumeJob(id: string): void {
  const job = jobs.get(id);
  if (!job || job.status !== "paused") return;

  job.status = "pending";
  job.logs.push(`[${new Date().toISOString()}] Job resumed`);

  // Re-schedule using recursive setTimeout (matches scheduleJob)
  if (job.type === "recurring" && job.schedule) {
    const schedule = job.schedule;
    job.nextRun = getNextRunFromCron(schedule, job.timezone);
    const initialDelay = Math.max(0, job.nextRun.getTime() - Date.now());
    function scheduleNext(delay: number) {
      const timer = setTimeout(() => {
        void runJob(id).then(() => {
          const j = jobs.get(id);
          if (j && j.status !== "paused" && timers.has(id)) {
            const nextRun = getNextRunFromCron(schedule, j.timezone);
            j.nextRun = nextRun;
            scheduleNext(Math.max(0, nextRun.getTime() - Date.now()));
          }
        });
      }, delay);
      timers.set(id, timer);
    }
    scheduleNext(initialDelay);
  } else if (job.type === "once" && job.runAt) {
    const delay = Math.max(0, job.runAt.getTime() - Date.now());
    const timer = setTimeout(() => void runJob(id), delay);
    timers.set(id, timer);
  } else if (job.type === "on-event" && job.triggerEvent) {
    if (!eventListeners.has(job.triggerEvent)) {
      eventListeners.set(job.triggerEvent, new Set());
    }
    eventListeners.get(job.triggerEvent)!.add(id);
  }
  persistSchedulerState();
}

// ── Event System ───────────────────────────────────────────────

export function emitEvent(event: string, data?: unknown): void {
  void data;
  const listenerJobIds = eventListeners.get(event);
  if (!listenerJobIds) return;

  for (const jobId of listenerJobIds) {
    const job = jobs.get(jobId);
    if (job && job.status !== "paused") {
      job.logs.push(`[${new Date().toISOString()}] Triggered by event: ${event}`);
      void runJob(jobId);
    }
  }
}

loadSchedulerState();
for (const job of jobs.values()) {
  scheduleTimerForJob(job);
}
