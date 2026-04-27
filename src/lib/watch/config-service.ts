import { ensureProjectManifest } from "@/lib/state/project-manifests";
import { deleteJob, scheduleJob } from "@/lib/scheduler";
import {
  createDefaultProjectWatchConfig,
  readProjectWatchConfig,
  writeProjectWatchConfig,
} from "./store";
import { normalizeWeeklyDays } from "./schedule-utils";
import type {
  CompiledWatchPlan,
} from "./compose";
import type {
  ProjectWatchConfig,
  ProjectWatchSchedule,
  ProjectWatchSource,
  WatchDeliveryChannel,
  WatchExecutionMode,
} from "./types";

export class WatchConfigError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WatchConfigError";
    this.status = status;
  }
}

export function isWatchDeliveryChannel(value: unknown): value is WatchDeliveryChannel {
  return value === "telegram"
    || value === "slack"
    || value === "web"
    || value === "discord"
    || value === "line"
    || value === "sms"
    || value === "whatsapp";
}

function isWatchExecutionMode(value: unknown): value is WatchExecutionMode {
  return value === "openclaw" || value === "native";
}

function isWatchSource(value: unknown): value is ProjectWatchSource {
  if (!value || typeof value !== "object") {
    return false;
  }

  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || !source.id.trim()) {
    return false;
  }

  if (source.type !== "rss" && source.type !== "arxiv" && source.type !== "web_search" && source.type !== "twitter" && source.type !== "discord" && source.type !== "slack") {
    return false;
  }

  if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
    return false;
  }

  if (source.label !== undefined && typeof source.label !== "string") {
    return false;
  }

  if (source.url !== undefined && typeof source.url !== "string") {
    return false;
  }

  if (source.query !== undefined && typeof source.query !== "string") {
    return false;
  }

  if (source.limit !== undefined && (typeof source.limit !== "number" || !Number.isFinite(source.limit))) {
    return false;
  }

  return true;
}

function isWatchSchedule(value: unknown): value is ProjectWatchSchedule {
  if (!value || typeof value !== "object") {
    return false;
  }

  const schedule = value as Record<string, unknown>;
  return typeof schedule.enabled === "boolean"
    && (schedule.cadence === "daily" || schedule.cadence === "weekdays" || schedule.cadence === "weekly")
    && typeof schedule.time === "string"
    && typeof schedule.timezone === "string"
    && (schedule.daysOfWeek === undefined
      || (Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.every((day) => typeof day === "number" && Number.isFinite(day))))
    && (schedule.dayOfWeek === undefined || (typeof schedule.dayOfWeek === "number" && Number.isFinite(schedule.dayOfWeek)))
    && (schedule.schedulerJobId === undefined || typeof schedule.schedulerJobId === "string");
}

function isLastRun(value: unknown): value is NonNullable<ProjectWatchConfig["lastRun"]> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const lastRun = value as Record<string, unknown>;
  return typeof lastRun.at === "string"
    && isWatchExecutionMode(lastRun.mode)
    && (lastRun.resultPath === undefined || typeof lastRun.resultPath === "string")
    && (lastRun.error === undefined || typeof lastRun.error === "string");
}

export function isWatchConfig(value: unknown): value is ProjectWatchConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const config = value as Record<string, unknown>;
  return config.version === 1
    && (config.objective === undefined || typeof config.objective === "string")
    && (config.compiledPrompt === undefined || typeof config.compiledPrompt === "string")
    && (config.searchQueries === undefined || (Array.isArray(config.searchQueries) && config.searchQueries.every((query) => typeof query === "string")))
    && (config.executionMode === undefined || isWatchExecutionMode(config.executionMode))
    && (config.deliveryChannel === undefined || isWatchDeliveryChannel(config.deliveryChannel))
    && (config.lastRun === undefined || isLastRun(config.lastRun))
    && (config.schedule === undefined || isWatchSchedule(config.schedule))
    && Array.isArray(config.keywords)
    && config.keywords.every((keyword) => typeof keyword === "string")
    && typeof config.promotionThreshold === "number"
    && Number.isFinite(config.promotionThreshold)
    && typeof config.stagingThreshold === "number"
    && Number.isFinite(config.stagingThreshold)
    && Array.isArray(config.sources)
    && config.sources.every(isWatchSource);
}

export function normalizeWatchConfig(config: ProjectWatchConfig): ProjectWatchConfig {
  const stagingThreshold = Math.max(0, Math.round(config.stagingThreshold));
  const promotionThreshold = Math.max(1, stagingThreshold, Math.round(config.promotionThreshold));
  const keywords = Array.from(
    new Set(
      config.keywords
        .map((keyword) => keyword.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  const sources = config.sources.map((source, index) => {
    const normalizedSource: ProjectWatchSource = {
      id: source.id.trim() || `source-${index + 1}`,
      type: source.type,
      enabled: source.enabled ?? true,
      label: source.label?.trim() || undefined,
      limit: source.limit === undefined ? 10 : Math.max(1, Math.min(50, Math.round(source.limit))),
    };

    if (source.type === "rss") {
      normalizedSource.url = source.url?.trim() || "";
    } else if (source.type === "web_search") {
      normalizedSource.query = source.query?.trim() || config.compiledPrompt?.trim() || config.objective?.trim() || "";
    } else if (source.type === "twitter") {
      // query holds comma-separated handles; url can hold a direct Nitter RSS feed
      normalizedSource.query = source.query?.trim() || "";
      normalizedSource.url = source.url?.trim() || undefined;
    } else if (source.type === "discord" || source.type === "slack") {
      // query holds comma-separated channel IDs
      normalizedSource.query = source.query?.trim() || "";
    } else {
      normalizedSource.query = source.query?.trim() || "";
    }

    return normalizedSource;
  });

  const searchQueries = Array.from(
    new Set((config.searchQueries ?? []).map((query) => query.trim()).filter(Boolean)),
  ).slice(0, 10);
  const schedule = normalizeSchedule(config.schedule);
  const executionMode = config.executionMode ?? inferExecutionMode(config);

  return {
    version: 1,
    objective: config.objective?.trim() || undefined,
    compiledPrompt: config.compiledPrompt?.trim() || undefined,
    searchQueries,
    executionMode,
    deliveryChannel: config.deliveryChannel,
    lastRun: config.lastRun,
    schedule,
    keywords,
    promotionThreshold,
    stagingThreshold,
    sources,
  };
}

function inferExecutionMode(config: ProjectWatchConfig): WatchExecutionMode | undefined {
  if (config.executionMode) return config.executionMode;
  if (config.compiledPrompt?.trim() || config.objective?.trim()) {
    return "openclaw";
  }
  if (config.sources.some((source) => source.type === "web_search")) {
    return "openclaw";
  }
  return undefined;
}

function normalizeSchedule(schedule: ProjectWatchSchedule | undefined): ProjectWatchSchedule | undefined {
  if (!schedule) return undefined;

  const time = /^\d{2}:\d{2}$/.test(schedule.time) ? schedule.time : "08:00";
  const daysOfWeek = schedule.cadence === "weekly"
    ? normalizeWeeklyDays(schedule.daysOfWeek, schedule.dayOfWeek)
    : [];
  const normalizedDaysOfWeek = schedule.cadence === "weekly"
    ? (daysOfWeek.length > 0 ? daysOfWeek : [1])
    : undefined;
  const dayOfWeek = normalizedDaysOfWeek?.length === 1 ? normalizedDaysOfWeek[0] : undefined;

  return {
    enabled: schedule.enabled,
    cadence: schedule.cadence,
    time,
    timezone: schedule.timezone.trim() || "local",
    daysOfWeek: normalizedDaysOfWeek,
    dayOfWeek,
    schedulerJobId: schedule.schedulerJobId?.trim() || undefined,
  };
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

export function cronForSchedule(schedule: ProjectWatchSchedule): string {
  const [hourText, minuteText] = schedule.time.split(":");
  const hour = boundedInteger(hourText, 8, 0, 23);
  const minute = boundedInteger(minuteText, 0, 0, 59);
  if (schedule.cadence === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (schedule.cadence === "weekly") {
    const daysOfWeek = normalizeWeeklyDays(schedule.daysOfWeek, schedule.dayOfWeek);
    return `${minute} ${hour} * * ${(daysOfWeek.length > 0 ? daysOfWeek : [1]).join(",")}`;
  }
  return `${minute} ${hour} * * *`;
}

export function validateWatchConfigSources(config: ProjectWatchConfig): void {
  for (const source of config.sources) {
    if (source.type === "rss" && !source.url) {
      throw new WatchConfigError(`RSS source ${source.id} requires a URL`);
    }
    if (source.type === "arxiv" && !source.query) {
      throw new WatchConfigError(`arXiv source ${source.id} requires a query`);
    }
    if (source.type === "web_search" && !source.query && !config.compiledPrompt && !config.objective) {
      throw new WatchConfigError(`Web search source ${source.id} requires a query or compiled prompt`);
    }
    if (source.type === "twitter" && !source.query && !source.url) {
      throw new WatchConfigError(`Twitter source ${source.id} requires handles (in query) or a Nitter RSS URL`);
    }
    if (source.type === "discord" && !source.query) {
      throw new WatchConfigError(`Discord source ${source.id} requires channel IDs (in query)`);
    }
    if (source.type === "slack" && !source.query) {
      throw new WatchConfigError(`Slack source ${source.id} requires channel IDs (in query)`);
    }
  }
}

export async function ensureWatchProject(project: string, stateRoot: string): Promise<void> {
  const manifest = await ensureProjectManifest(project, stateRoot);
  if (!manifest) {
    throw new WatchConfigError(`Study ${project} was not found in brain state.`, 404);
  }
}

async function syncSchedulerJob(
  project: string,
  config: ProjectWatchConfig,
  stateRoot: string,
  previousConfig?: ProjectWatchConfig | null,
): Promise<ProjectWatchConfig> {
  const schedule = config.schedule;
  const schedulerJobIds = Array.from(
    new Set([
      previousConfig?.schedule?.schedulerJobId,
      schedule?.schedulerJobId,
    ].filter((jobId): jobId is string => Boolean(jobId))),
  );
  for (const jobId of schedulerJobIds) {
    deleteJob(jobId);
  }

  if (!schedule) {
    await writeProjectWatchConfig(project, config, stateRoot);
    return config;
  }

  if (!schedule.enabled) {
    const updatedConfig = {
      ...config,
      schedule: {
        ...schedule,
        schedulerJobId: undefined,
      },
    };
    await writeProjectWatchConfig(project, updatedConfig, stateRoot);
    return updatedConfig;
  }

  const jobId = scheduleJob({
    name: `Frontier Watch: ${project}`,
    type: "recurring",
    schedule: cronForSchedule(schedule),
    timezone: schedule.timezone,
    action: {
      type: "frontier-watch",
      config: { project },
    },
  });
  const updatedConfig = {
    ...config,
    schedule: {
      ...schedule,
      schedulerJobId: jobId,
    },
  };
  await writeProjectWatchConfig(project, updatedConfig, stateRoot);
  return updatedConfig;
}

export async function saveProjectWatchConfig(input: {
  project: string;
  config: ProjectWatchConfig;
  stateRoot: string;
}): Promise<ProjectWatchConfig> {
  await ensureWatchProject(input.project, input.stateRoot);
  const normalizedConfig = normalizeWatchConfig(input.config);
  validateWatchConfigSources(normalizedConfig);
  const previousConfig = await readProjectWatchConfig(input.project, input.stateRoot);
  return syncSchedulerJob(input.project, normalizedConfig, input.stateRoot, previousConfig);
}

export function buildPromptFirstWatchConfig(input: {
  plan: CompiledWatchPlan;
  schedule?: ProjectWatchSchedule;
  deliveryChannel?: WatchDeliveryChannel;
  executionMode?: WatchExecutionMode;
}): ProjectWatchConfig {
  const sourceQuery = input.plan.compiledPrompt || input.plan.objective;
  return {
    ...createDefaultProjectWatchConfig(),
    objective: input.plan.objective,
    compiledPrompt: input.plan.compiledPrompt,
    searchQueries: input.plan.searchQueries,
    executionMode: input.executionMode ?? "openclaw",
    deliveryChannel: input.deliveryChannel,
    schedule: input.schedule,
    keywords: input.plan.keywords,
    sources: [
      {
        id: "openclaw-web",
        type: "web_search",
        label: "OpenClaw web research",
        query: sourceQuery,
        limit: 8,
      },
    ],
  };
}
