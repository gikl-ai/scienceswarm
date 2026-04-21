import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import type { BrainConfig, ProjectManifest } from "@/brain/types";
import {
  listProjectManifests,
  readProjectManifest,
} from "@/lib/state/project-manifests";
import {
  getProjectLocalStateRoot,
  isDefaultGlobalStateRoot,
} from "@/lib/state/project-storage";
import { compileWatchPlan } from "./compose";
import {
  buildPromptFirstWatchConfig,
  isWatchDeliveryChannel,
  saveProjectWatchConfig,
} from "./config-service";
import { runOpenClawFrontierWatch } from "./openclaw-executor";
import {
  formatWatchScheduleSummary,
  normalizeWeeklyDays,
} from "./schedule-utils";
import type { ProjectWatchSchedule, WatchDeliveryChannel } from "./types";

export interface WatchConversationResult {
  handled: boolean;
  response?: string;
}

interface WatchConversationInput {
  config: BrainConfig;
  message: string;
  channel: string;
  userId: string;
  timezone?: string;
}

interface ParsedWatchRequest {
  kind: "configure" | "adhoc";
  project?: string;
  objective: string;
  schedule?: ProjectWatchSchedule;
}

async function listActiveProjects(stateRoot: string): Promise<ProjectManifest[]> {
  if (!isDefaultGlobalStateRoot(stateRoot)) {
    const projectsDir = path.join(stateRoot, "projects");
    try {
      await access(projectsDir, constants.F_OK);
    } catch {
      return [];
    }

    const entries = await readdir(projectsDir, { withFileTypes: true });
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readProjectManifest(entry.name, stateRoot)),
    );

    return manifests
      .filter((manifest): manifest is ProjectManifest => Boolean(manifest && manifest.status !== "archived"))
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  // Default listing only sees canonical project directories. Legacy brain-only
  // projects appear here after another endpoint touches them and triggers the
  // lazy migration into `SCIENCESWARM_DIR/projects/<slug>/.brain`.
  const manifests = await listProjectManifests();
  return manifests
    .filter((manifest) => manifest.status !== "archived")
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function looksLikeWatchRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  const frontierTopic = /\b(frontier|news|brief|briefing|papers?|research|models?|releases?|breakthroughs?|funding|labs?|startups?)\b/.test(normalized);
  const directSearchVerb = /\b(watch|scan|search|monitor)\b/.test(normalized);
  const trackFrontierTopic = /\btrack\b/.test(normalized) && frontierTopic;
  const topicSignal = frontierTopic || directSearchVerb || trackFrontierTopic;
  const actionSignal = /\b(schedule|every|daily|weekday|weekdays|weekly|adhoc|ad hoc|one-off|run|now|today|tomorrow|morning|afternoon|evening)\b/.test(normalized);
  return topicSignal && actionSignal;
}

function extractProject(text: string, projects: ProjectManifest[]): string | undefined {
  const explicit = text.match(/\b(?:project|for)\s+([a-z0-9-]{2,})\b/i)?.[1];
  if (explicit && projects.some((project) => project.slug === explicit.toLowerCase())) {
    return explicit.toLowerCase();
  }

  const normalized = text.toLowerCase();
  const matches = projects.filter((project) => {
    const slugPattern = new RegExp(`(^|\\W)${escapeRegExp(project.slug)}(\\W|$)`, "i");
    return slugPattern.test(normalized) || normalized.includes(project.title.toLowerCase());
  });
  if (matches.length === 1) {
    return matches[0].slug;
  }

  if (projects.length === 1) {
    return projects[0].slug;
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTimezone(text: string, fallback: string | undefined): string {
  const iana = text.match(/\b[A-Z][A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/)?.[0];
  if (iana) return iana;

  const normalized = text.toLowerCase();
  if (/\b(pt|pst|pdt|pacific)\b/.test(normalized)) return "America/Los_Angeles";
  if (/\b(et|est|edt|eastern)\b/.test(normalized)) return "America/New_York";
  if (/\b(ct|cst|cdt|central)\b/.test(normalized)) return "America/Chicago";
  if (/\b(mt|mst|mdt|mountain)\b/.test(normalized)) return "America/Denver";
  return fallback?.trim() || "local";
}

function parseTime(text: string): string | undefined {
  const normalized = text.toLowerCase();
  const meridiem = normalized.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (meridiem) {
    let hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] ?? "0");
    if (meridiem[3] === "pm" && hour < 12) hour += 12;
    if (meridiem[3] === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }

  const twentyFourHour = normalized.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFourHour) {
    return `${String(Number(twentyFourHour[1])).padStart(2, "0")}:${twentyFourHour[2]}`;
  }

  if (/\bnoon\b/.test(normalized)) return "12:00";
  if (/\bmorning\b/.test(normalized)) return "08:00";
  if (/\bafternoon\b/.test(normalized)) return "13:00";
  if (/\bevening\b/.test(normalized)) return "17:00";
  return undefined;
}

function parseCadence(text: string): ProjectWatchSchedule["cadence"] | undefined {
  const normalized = text.toLowerCase();
  if (/\b(weekday|weekdays|business days?)\b/.test(normalized)) return "weekdays";
  if (/\bweekly|every week|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?\b/.test(normalized)) return "weekly";
  if (/\bdaily|every day|every morning|each morning|schedule|recurring|every weekday\b/.test(normalized)) return "daily";
  return undefined;
}

function parseDaysOfWeek(text: string): number[] {
  const normalized = text.toLowerCase();
  const matchedDays = [
    { value: 0, pattern: /\bsun(?:day)?s?\b/ },
    { value: 1, pattern: /\bmon(?:day)?s?\b/ },
    { value: 2, pattern: /\btue(?:s|sday)?s?\b/ },
    { value: 3, pattern: /\bwed(?:nesday)?s?\b/ },
    { value: 4, pattern: /\bthu(?:rs|rsday)?s?\b/ },
    { value: 5, pattern: /\bfri(?:day)?s?\b/ },
    { value: 6, pattern: /\bsat(?:urday)?s?\b/ },
  ]
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ value }) => value);

  return normalizeWeeklyDays(matchedDays);
}

function parseWatchRequest(input: {
  message: string;
  timezone?: string;
  projects: ProjectManifest[];
}): ParsedWatchRequest | null {
  if (!looksLikeWatchRequest(input.message)) {
    return null;
  }

  const normalized = input.message.toLowerCase();
  const cadence = parseCadence(input.message);
  const hasAdhocSignal = /\b(now|adhoc|ad hoc|one-off|run this|run a|scan now|search now)\b/.test(normalized)
    || (/\btoday\b/.test(normalized) && !cadence);
  const kind = hasAdhocSignal ? "adhoc" : "configure";
  const time = cadence ? parseTime(input.message) ?? "08:00" : undefined;
  const weeklyDays = cadence === "weekly"
    ? parseDaysOfWeek(input.message)
    : [];
  const schedule = cadence && time
    ? {
        enabled: true,
        cadence,
        time,
        timezone: extractTimezone(input.message, input.timezone),
        daysOfWeek: cadence === "weekly" ? (weeklyDays.length > 0 ? weeklyDays : [1]) : undefined,
        dayOfWeek: cadence === "weekly" && weeklyDays.length <= 1 ? (weeklyDays[0] ?? 1) : undefined,
      }
    : undefined;

  return {
    kind,
    project: extractProject(input.message, input.projects),
    objective: input.message.trim(),
    schedule,
  };
}

function settingsLink(project: string): string {
  return `/dashboard/settings?project=${encodeURIComponent(project)}#frontier-watch`;
}

function deliveryChannelFor(channel: string): WatchDeliveryChannel | undefined {
  return isWatchDeliveryChannel(channel) ? channel : undefined;
}

function formatSchedule(schedule: ProjectWatchSchedule | undefined): string {
  return formatWatchScheduleSummary(schedule);
}

export async function handleWatchConversation(
  input: WatchConversationInput,
): Promise<WatchConversationResult> {
  const stateRoot = path.join(input.config.root, "state");
  const projects = await listActiveProjects(stateRoot);
  const parsed = parseWatchRequest({
    message: input.message,
    timezone: input.timezone,
    projects,
  });

  if (!parsed) {
    return { handled: false };
  }

  if (!parsed.project) {
    const choices = projects.length > 0
      ? projects.map((project) => `- ${project.slug} (${project.title})`).join("\n")
      : "- No active projects found. Import or create a project first.";
    return {
      handled: true,
      response: [
        "Which project should I use for this frontier watch?",
        "",
        choices,
      ].join("\n"),
    };
  }

  const manifest = await readProjectManifest(
    parsed.project,
    isDefaultGlobalStateRoot(stateRoot) ? undefined : stateRoot,
  );
  if (!manifest) {
    return {
      handled: true,
      response: `I could not find project \`${parsed.project}\` in the brain state. Import or create that project first.`,
    };
  }

  const plan = await compileWatchPlan({
    objective: parsed.objective,
    projectTitle: manifest.title,
    timezone: parsed.schedule?.timezone ?? input.timezone,
  });
  const watchConfig = buildPromptFirstWatchConfig({
    plan,
    schedule: parsed.schedule,
    deliveryChannel: deliveryChannelFor(input.channel),
    executionMode: "openclaw",
  });

  if (parsed.kind === "adhoc") {
    try {
      const result = await runOpenClawFrontierWatch({
        config: input.config,
        manifest,
        watchConfig,
        deliveryChannel: deliveryChannelFor(input.channel),
        adhoc: true,
      });
      return {
        handled: true,
        response: [
          `Ran the OpenClaw frontier search for \`${manifest.slug}\`.`,
          `Saved the briefing to \`${result.resultPath}\`.`,
          "",
          result.response,
          "",
          `You can turn this into a recurring watch or tweak it in Settings: ${settingsLink(manifest.slug)}`,
        ].join("\n"),
      };
    } catch (error) {
      return {
        handled: true,
        response: [
          `I understood the adhoc frontier search for \`${manifest.slug}\`, but OpenClaw could not run it right now.`,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
          "",
          `You can still configure or tweak the watch in Settings: ${settingsLink(manifest.slug)}`,
        ].join("\n"),
      };
    }
  }

  const savedConfig = await saveProjectWatchConfig({
    project: manifest.slug,
    config: watchConfig,
    stateRoot: isDefaultGlobalStateRoot(stateRoot)
      ? getProjectLocalStateRoot(manifest.slug)
      : stateRoot,
  });

  return {
    handled: true,
    response: [
      `Configured an OpenClaw-powered frontier watch for \`${manifest.slug}\`.`,
      `Schedule: ${formatSchedule(savedConfig.schedule)}.`,
      "Execution: OpenClaw will run the web/news research and analysis; ScienceSwarm stores the config, schedule, and saved briefing copies.",
      "",
      `You can tweak the generated prompt, schedule, and advanced settings here: ${settingsLink(manifest.slug)}`,
    ].join("\n"),
  };
}
