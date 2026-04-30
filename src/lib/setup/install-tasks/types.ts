/**
 * Shared contract for every parallel install task the bootstrap
 * orchestrator drives. Each task is an async generator yielding partial
 * `BootstrapEvent`s; the orchestrator stamps the `task` field on every
 * yielded event so callers see a single normalized shape.
 */

import type { BrainPresetId } from "@/brain/presets/types";

export type BootstrapTaskId =
  | "gbrain-init"
  | "openclaw"
  | "openclaw-gateway"
  | "openhands-docker"
  | "ollama-gemma"
  | "telegram-bot";

export type BootstrapStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "skipped"
  | "failed"
  | "waiting-for-input";

export interface BootstrapEvent {
  type: "task";
  task: BootstrapTaskId;
  status: BootstrapStepStatus;
  detail?: string;
  needs?: "telegram-code" | "telegram-nonce-claim";
  sessionId?: string;
  nonceClaim?: {
    deeplink: string;
    botUsername: string;
  };
  error?: string;
}

export interface BootstrapSummaryEvent {
  type: "summary";
  status: "ok" | "partial" | "failed";
  failed: BootstrapTaskId[];
  skipped: BootstrapTaskId[];
  /**
   * Set when the orchestrator itself throws before emitting any task
   * events (e.g. .env write failure). The UI surfaces it in the
   * failed-state card so the user isn't left with a task list pinned
   * at 'pending' and no explanation.
   */
  error?: string;
}

export type BootstrapStreamEvent = BootstrapEvent | BootstrapSummaryEvent;

export interface BootstrapInput {
  handle: string;
  email?: string;
  phone?: string;
  brainPreset?: BrainPresetId;
  telegramMode?: "fresh" | "reuse";
  existingBot?: {
    token: string;
  };
  repoRoot: string;
}

/**
 * A child-task yields these partial events; the orchestrator augments
 * them with `type: "task"` and the task id to produce full
 * `BootstrapEvent`s.
 */
export type TaskYield = Omit<BootstrapEvent, "type" | "task">;

export interface InstallTask {
  id: BootstrapTaskId;
  run(input: BootstrapInput): AsyncGenerator<TaskYield, void, unknown>;
}
