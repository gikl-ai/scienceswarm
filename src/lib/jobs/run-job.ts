/**
 * run_job / check_job orchestrator.
 *
 * Generic primitive: given a `kind` (a string like `revise_paper`),
 * input refs (a map of role → gbrain slug), and expected artifacts,
 * render the per-kind prompt template, start an OpenHands conversation,
 * and return a handle the agent can poll via check_job. The actual
 * heavy compute stays inside the sandbox — this module is just
 * orchestration + a durable handle registry.
 *
 * The OpenHands transport is dependency-injected so unit tests can
 * substitute an in-process fake; the real client lives in
 * `src/lib/openhands.ts` and is bound by `buildDefaultJobDeps`.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  generateJobHandle,
  getJobStore,
  type JobRecord,
  type JobStatus,
  type JobStore,
} from "./job-store";
import { parseJobFooter } from "./footer-parser";
import { isJobCancelled } from "@/brain/audit-revise-plan";

export interface OpenHandsTransport {
  startConversation(prompt: string): Promise<{ conversationId: string }>;
  waitForFinish(
    conversationId: string,
    options: { timeoutMs: number; pollIntervalMs: number; isCancelled: () => boolean },
  ): Promise<FinishedConversation>;
}

export interface FinishedConversation {
  status: "finished" | "failed" | "timed_out" | "cancelled";
  finalMessage: string | null;
  errorMessage?: string;
}

export interface JobDeps {
  openhands: OpenHandsTransport;
  store: JobStore;
  loadDefinition: (kind: string) => Promise<string>;
  now?: () => Date;
}

export interface RunJobInput {
  kind: string;
  project?: string;
  input_refs: Record<string, string>;
  expected_artifacts?: string[];
  /** Hard wall-clock timeout. Defaults to 20 minutes per runbook §H. */
  timeoutMs?: number;
  /** Poll interval. Defaults to 5s. */
  pollIntervalMs?: number;
}

export interface RunJobResult {
  handle: string;
  status: JobStatus;
  conversation_id?: string;
  started_at: string;
}

export interface CheckJobResult {
  handle: string;
  status: JobStatus;
  elapsed_s: number;
  partial_artifacts: string[];
  final_artifacts: string[];
  log_excerpt?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 5_000;
export const SUPPORTED_JOB_KINDS = [
  "revise_paper",
  "write_cover_letter",
  "rerun_stats_and_regenerate_figure",
  "translate_paper",
] as const;

/**
 * Start a job and register its handle. Returns immediately after the
 * OpenHands conversation starts; the caller polls via check_job.
 */
export async function runJob(
  deps: JobDeps,
  input: RunJobInput,
): Promise<RunJobResult> {
  if (!input.kind || input.kind.trim().length === 0) {
    throw new Error("run_job: kind is required");
  }
  if (!input.input_refs || typeof input.input_refs !== "object") {
    throw new Error("run_job: input_refs must be an object");
  }

  const definition = await deps.loadDefinition(input.kind);
  const prompt = renderPrompt(definition, input);
  const { conversationId } = await deps.openhands.startConversation(prompt);

  const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
  const handle = generateJobHandle();
  const record: JobRecord = {
    handle,
    kind: input.kind,
    project: input.project,
    input_refs: { ...input.input_refs },
    expected_artifacts: input.expected_artifacts ?? [],
    started_at: nowIso,
    updated_at: nowIso,
    conversation_id: conversationId,
    status: "running",
  };
  deps.store.register(record);

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_MS;

  // Fire-and-forget the wait-for-finish loop. `check_job` reads the
  // store for current state; this just keeps the promise rejection
  // from propagating to the caller.
  void (async () => {
    try {
      const finished = await deps.openhands.waitForFinish(conversationId, {
        timeoutMs,
        pollIntervalMs,
        isCancelled: () => isJobCancelled(handle),
      });
      applyFinished(deps, handle, finished);
    } catch (error) {
      deps.store.update(handle, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finished_at: new Date().toISOString(),
      });
    }
  })();

  return {
    handle,
    status: record.status,
    conversation_id: conversationId,
    started_at: nowIso,
  };
}

function applyFinished(
  deps: JobDeps,
  handle: string,
  finished: FinishedConversation,
): void {
  const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
  if (finished.status === "finished") {
    const footer = parseJobFooter(finished.finalMessage);
    deps.store.update(handle, {
      status: "finished",
      final: footer,
      finished_at: nowIso,
    });
    return;
  }
  if (finished.status === "timed_out") {
    deps.store.update(handle, {
      status: "timed_out",
      error: finished.errorMessage ?? "job exceeded wall-clock timeout",
      finished_at: nowIso,
    });
    return;
  }
  if (finished.status === "cancelled") {
    // Greptile P1 on #288: cooperative cancel via isJobCancelled must
    // surface as cancelled, not failed, so the audit-revise skill
    // and cancel_job can distinguish "user pressed cancel" from
    // "job crashed".
    deps.store.update(handle, {
      status: "cancelled",
      error: finished.errorMessage ?? "job cancelled by user",
      finished_at: nowIso,
    });
    return;
  }
  deps.store.update(handle, {
    status: "failed",
    error: finished.errorMessage ?? "job failed",
    finished_at: nowIso,
  });
}

/**
 * Get the current state of a job. Does NOT re-poll OpenHands; the
 * run-time wait loop is responsible for keeping the store fresh.
 */
export function checkJob(
  deps: JobDeps,
  handle: string,
): CheckJobResult {
  const record = deps.store.find(handle);
  if (!record) {
    throw new Error(`check_job: no handle '${handle}'`);
  }
  const startedAt = new Date(record.started_at).getTime();
  const reference = record.finished_at
    ? new Date(record.finished_at).getTime()
    : (deps.now ? deps.now() : new Date()).getTime();
  const elapsed_s = Math.max(0, Math.round((reference - startedAt) / 1000));
  return {
    handle,
    status: record.status,
    elapsed_s,
    partial_artifacts: [],
    // Greptile P1 on #288: include both slugs and file SHAs. The
    // revise_paper prompt writes a file sha to the footer; a caller
    // that wants to retrieve the uploaded PDF by hash needs it here.
    final_artifacts: [
      ...(record.final?.slugs ?? []),
      ...(record.final?.files ?? []),
    ],
    error: record.error,
  };
}

function renderPrompt(definition: string, input: RunJobInput): string {
  // Templated substitution: every {{key}} in the definition becomes
  // the matching value from input.input_refs or expected_artifacts.
  let out = definition;
  for (const [key, value] of Object.entries(input.input_refs)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  if (input.expected_artifacts && input.expected_artifacts.length > 0) {
    out = out.replaceAll(
      "{{expected_artifacts}}",
      input.expected_artifacts.join(", "),
    );
  }
  if (input.project) {
    out = out.replaceAll("{{project}}", input.project);
  }
  return out;
}

/**
 * Real-dependencies builder used by mcp-server.ts.
 */
export function buildDefaultJobDeps(): JobDeps {
  return {
    openhands: createLiveOpenHandsTransport(),
    store: getJobStore(),
    loadDefinition: loadDefinitionFromFs,
    now: () => new Date(),
  };
}

const KIND_PATTERN = /^[a-z][a-z0-9_]*$/;
const DEFINITIONS_SUBDIR = "src/lib/jobs/definitions";

/**
 * Load a job-kind prompt template from disk. The `kind` string is
 * validated against a conservative allowlist regex BEFORE it is
 * interpolated into any filesystem path, so an LLM (or any caller
 * once run_job is wired to the MCP surface) cannot supply
 * `../../CLAUDE` or an absolute path and escape the definitions
 * directory. Greptile P1 on PR #288.
 */
export async function loadDefinitionFromFs(kind: string): Promise<string> {
  if (!KIND_PATTERN.test(kind)) {
    throw new Error(
      `run_job: invalid kind '${kind}' — must match ${KIND_PATTERN}`,
    );
  }
  if (!SUPPORTED_JOB_KINDS.includes(kind as (typeof SUPPORTED_JOB_KINDS)[number])) {
    throw new Error(
      `run_job: unknown kind '${kind}'. Supported kinds: ${SUPPORTED_JOB_KINDS.join(", ")}`,
    );
  }
  const filePath = path.resolve(
    process.cwd(),
    DEFINITIONS_SUBDIR,
    `${kind}.md`,
  );
  const definitionsRoot = path.resolve(process.cwd(), DEFINITIONS_SUBDIR);
  if (!filePath.startsWith(`${definitionsRoot}${path.sep}`)) {
    throw new Error(
      `run_job: resolved definition path escapes ${definitionsRoot}`,
    );
  }
  return fs.readFile(filePath, "utf8");
}

function createLiveOpenHandsTransport(): OpenHandsTransport {
  return {
    async startConversation(prompt) {
      const mod = await import("@/lib/openhands");
      // OpenHands V1 has two independent message-dispatch contracts:
      //
      // 1. `initial_message` on POST /api/v1/app-conversations — this
      //    rides along with the start-conversation request that the
      //    orchestrator then forwards to the sandbox's
      //    /api/conversations endpoint inside the start RPC body.
      //    Empirically the agent loop does NOT pick this up in our
      //    headless setup (conversation reaches `running` state but no
      //    LLM call is ever fired; the sandbox's auto-title generator
      //    logs "No user messages found in conversation events").
      //
      // 2. `pending-messages` queue — the orchestrator persists messages
      //    keyed by `task-<hex>`, then in `_process_pending_messages`
      //    delivers them to the sandbox at
      //    `/api/conversations/<conv_id>/events` with `run: True`.
      //    This is the path the OH frontend uses when its WebSocket
      //    isn't connected, and it reliably fires the agent loop.
      //
      // We therefore POST the start request with `initial_message: null`
      // and immediately queue the user prompt as a pending message
      // under the task id. The orchestrator delivers it once the
      // start-task transitions to READY.
      //
      // See OpenHands source:
      //   openhands/app_server/app_conversation/live_status_app_conversation_service.py
      //   openhands/app_server/pending_messages/pending_message_router.py
      //   frontend/src/contexts/conversation-websocket-context.tsx
      const task = (await mod.startConversation({
        message: prompt,
      })) as { id: string };
      // Race-window note: `_process_pending_messages` runs after the
      // start-task transitions to READY, which takes 5-30s for the
      // sandbox to boot. Our queue POST happens within ~100ms of the
      // start POST returning, so the message is in the DB long before
      // the orchestrator looks for it.
      await mod.queuePendingMessage(task.id, prompt);
      return { conversationId: task.id };
    },
    async waitForFinish(conversationId, options) {
      const mod = await import("@/lib/openhands");
      const taskId = conversationId;
      const start = Date.now();

      // Phase 1: resolve task_id → app_conversation_id. The task
      // starts in status WORKING and flips to READY with an
      // `app_conversation_id` once the sandbox is assigned. OpenHands
      // V1 takes 5-30s to spin up the sandbox container on first
      // use (image pull / cold boot), so we allow up to half the
      // deadline for the resolve step before giving up.
      const RESOLVE_DEADLINE_FRACTION = 0.5;
      const resolveDeadline = start + options.timeoutMs * RESOLVE_DEADLINE_FRACTION;
      let appConversationId: string | null = null;
      while (Date.now() < resolveDeadline) {
        if (options.isCancelled()) {
          return {
            status: "cancelled",
            finalMessage: null,
            errorMessage: "job cancelled by user",
          };
        }
        const taskStatus = (await mod.getStartTaskStatus(taskId)) as
          | Array<{
              id: string;
              status?: string;
              app_conversation_id?: string | null;
              detail?: unknown;
            }>
          | null;
        const row = Array.isArray(taskStatus) ? taskStatus[0] : null;
        if (row) {
          if (row.status === "FAILED" || row.status === "ERROR") {
            return {
              status: "failed",
              finalMessage: null,
              errorMessage: `OpenHands start-task '${taskId}' reported status='${row.status}' detail=${JSON.stringify(row.detail)}`,
            };
          }
          if (row.app_conversation_id) {
            appConversationId = row.app_conversation_id;
            break;
          }
        }
        await new Promise((resolve) =>
          setTimeout(resolve, options.pollIntervalMs),
        );
      }
      if (!appConversationId) {
        return {
          status: "failed",
          finalMessage: null,
          errorMessage: `OpenHands start-task '${taskId}' never resolved to an app_conversation_id before the grace deadline (${Math.round(options.timeoutMs * RESOLVE_DEADLINE_FRACTION)}ms) — sandbox likely failed to boot.`,
        };
      }

      // Phase 2: poll the resolved conversation for terminal state.
      const NULL_GRACE_POLLS = 12;
      let nullStreak = 0;
      while (Date.now() - start < options.timeoutMs) {
        if (options.isCancelled()) {
          return {
            status: "cancelled",
            finalMessage: null,
            errorMessage: "job cancelled by user",
          };
        }
        const conv = (await mod.getConversation(appConversationId)) as
          | { execution_status?: string }
          | null
          | undefined;
        if (!conv) {
          nullStreak += 1;
          if (nullStreak >= NULL_GRACE_POLLS) {
            return {
              status: "failed",
              finalMessage: null,
              errorMessage: `OpenHands conversation '${appConversationId}' (task '${taskId}') returned null for ${nullStreak} consecutive polls — the sandbox may have died.`,
            };
          }
          await new Promise((resolve) =>
            setTimeout(resolve, options.pollIntervalMs),
          );
          continue;
        }
        nullStreak = 0;
        const status = conv.execution_status;
        if (status === "finished") {
          // OH V1 stores messages as MessageEvent with
          //   kind: "MessageEvent"
          //   source: "user" | "agent"
          //   llm_message.role: "user" | "assistant"
          //   llm_message.content: [{type: "text", text: "..."}]
          // We want the agent's last reply, so filter by source='agent'.
          // 50 is enough for the tail of any reasonable run; the
          // sort_order parameter is the OH V1 enum, NOT asc/desc.
          //
          // Race window: execution_status can flip to "finished" a few
          // seconds before the events search index has indexed the
          // agent's final MessageEvent. Without retries we'd return a
          // null finalMessage and the footer parser would emit an
          // empty artifact list. Retry up to 5x with 2s backoff —
          // empirically the message is indexed within ~10s of status
          // flipping.
          type EventRow = {
            kind?: string;
            source?: string;
            llm_message?: {
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
            };
          };
          let llmText: string | undefined;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            // getEvents normalizes OH 1.5 (raw array) and OH V1
            // (`{items: [...]}`) into a single array shape, so we
            // can just iterate directly.
            const events = (await mod.getEvents(
              appConversationId,
              50,
              "TIMESTAMP_DESC",
            )) as EventRow[];
            const last = events.find(
              (event) =>
                event.kind === "MessageEvent" && event.source === "agent",
            );
            llmText = last?.llm_message?.content
              ?.map((c) => (c?.type === "text" ? c.text ?? "" : ""))
              .filter((t) => t.length > 0)
              .join("\n");
            if (llmText && llmText.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }
          return {
            status: "finished",
            finalMessage: llmText ?? null,
          };
        }
        // OpenHands V1 ConversationExecutionStatus:
        //   idle, running, paused, waiting_for_confirmation,
        //   finished, error, stuck, deleting
        // We already handled "finished" above. The remaining
        // terminal-ish values:
        //   error / stuck / deleting → failed
        //   waiting_for_confirmation  → failed (non-interactive run)
        //   idle / running / paused   → keep polling
        if (status === "error" || status === "stuck" || status === "deleting") {
          return {
            status: "failed",
            finalMessage: null,
            errorMessage: `OpenHands reported execution_status=${status}`,
          };
        }
        if (status === "waiting_for_confirmation") {
          return {
            status: "failed",
            finalMessage: null,
            errorMessage:
              "OpenHands reported execution_status=waiting_for_confirmation — the agent is asking for user input, but this job is non-interactive. Disable confirmation_mode in OpenHands settings or rewrite the prompt to avoid confirmation prompts.",
          };
        }
        await new Promise((resolve) =>
          setTimeout(resolve, options.pollIntervalMs),
        );
      }
      return {
        status: "timed_out",
        finalMessage: null,
        errorMessage: `OpenHands wait exceeded ${options.timeoutMs}ms (task '${taskId}' → conv '${appConversationId}')`,
      };
    },
  };
}
