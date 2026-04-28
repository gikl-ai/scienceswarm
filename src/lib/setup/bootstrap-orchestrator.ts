/**
 * Bootstrap orchestrator: runs install tasks, merges their per-task
 * event streams into a single sequence, and emits a final summary.
 * Most tasks run in parallel. The Telegram bot task runs after the
 * OpenClaw setup phase because it writes OpenClaw channel config and
 * restarts the gateway; running it while `openclaw onboard` is
 * mutating the same state can trip upstream config conflict guards.
 *
 * The orchestrator stamps `task` and `type: "task"` on every event
 * yielded by child tasks, so callers only see a single normalized
 * stream shape.
 *
 * Writing `SCIENCESWARM_USER_HANDLE` and `GIT_USER_EMAIL` into .env is
 * done up front, synchronously, before any task runs. That way even if
 * every task fails the handle+email are persisted and the user won't
 * hit the hidden SCIENCESWARM_USER_HANDLE error on the first capture.
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";

import { buildLocalOpenClawAllowedModels } from "@/lib/openclaw/model-config";
import { resolveConfiguredLocalModel } from "@/lib/runtime/model-catalog";
import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
} from "@/lib/setup/env-writer";
import { buildOpenClawOllamaProviderConfig } from "@/lib/openclaw/ollama-provider";

import type {
  BootstrapEvent,
  BootstrapInput,
  BootstrapStreamEvent,
  BootstrapStepStatus,
  BootstrapTaskId,
  InstallTask,
} from "./install-tasks/types";

import { gbrainInitTask } from "./install-tasks/gbrain-init";
import { openclawTask } from "./install-tasks/openclaw";
import { openhandsDockerTask } from "./install-tasks/openhands-docker";
import { ollamaGemmaTask } from "./install-tasks/ollama-gemma";
import { telegramBotTask } from "./install-tasks/telegram-bot";

const DEFAULT_TASKS: InstallTask[] = [
  gbrainInitTask,
  openclawTask,
  openhandsDockerTask,
  ollamaGemmaTask,
  telegramBotTask,
];

function toOpenClawOllamaModelRef(model: string): string {
  const normalized = model.trim().replace(/^(ollama|openai)\//, "");
  return `ollama/${normalized}`;
}

function isTerminalBootstrapStatus(
  status: BootstrapStepStatus | undefined,
): status is Extract<BootstrapStepStatus, "succeeded" | "failed" | "skipped"> {
  return status === "succeeded" || status === "failed" || status === "skipped";
}

export interface OrchestratorOptions {
  tasks?: InstallTask[];
}

export async function persistIdentity(
  input: BootstrapInput,
): Promise<void> {
  const envPath = path.join(input.repoRoot, ".env");
  let existing = "";
  try {
    existing = await fs.readFile(envPath, { encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const doc = parseEnvFile(existing);
  // Writes:
  // - SCIENCESWARM_USER_HANDLE: always set from input.handle
  // - GIT_USER_EMAIL: set when provided
  //
  // Clears (by removing any pre-existing entry):
  // - OPENCLAW_URL: historical `.env.example` default was
  //   `ws://127.0.0.1:18789/ws`. Task 2.6 removes that active default.
  //   To stop stale user `.env` files from shadowing port-based URL
  //   derivation, bootstrap explicitly clears any pre-existing value
  //   so downstream code paths fall through to port-based derivation.
  //
  // Intentional non-writes (drift guards — do NOT reintroduce):
  // - OPENCLAW_PORT: the single source of truth is
  //   `DEFAULT_PORTS.openclaw` in `src/lib/config/ports.ts`. Writing
  //   the same literal into `.env` creates drift the moment either
  //   side changes.
  // - OPENCLAW_PROFILE: state-dir mode is the default, and that
  //   means the env var is unset. The wrapper at
  //   `src/lib/openclaw/runner.ts` picks the right mode based on
  //   whether `OPENCLAW_PROFILE` is set.
  const updates: Record<string, string | null> = {
    SCIENCESWARM_USER_HANDLE: input.handle,
    OPENCLAW_URL: null,
  };
  if (input.email) updates.GIT_USER_EMAIL = input.email;
  const merged = mergeEnvValues(doc, updates);
  const serialized = serializeEnvDocument(merged);
  await writeEnvFileAtomic(envPath, serialized);
}

async function hasPersistedTelegramBotToken(repoRoot: string): Promise<boolean> {
  const envPath = path.join(repoRoot, ".env");
  let existing = "";
  try {
    existing = await fs.readFile(envPath, { encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const doc = parseEnvFile(existing);
  return doc.lines.some(
    (line) =>
      line.type === "entry" &&
      line.key === "TELEGRAM_BOT_TOKEN" &&
      line.value.trim().length > 0,
  );
}

async function readPersistedOllamaModel(repoRoot: string): Promise<string> {
  const envPath = path.join(repoRoot, ".env");
  let existing = "";
  try {
    existing = await fs.readFile(envPath, { encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const doc = parseEnvFile(existing);
  const entries = doc.lines.filter(
    (line): line is Extract<typeof line, { type: "entry" }> =>
      line.type === "entry",
  );
  const persistedModel = entries.find((line) =>
    line.key === "OLLAMA_MODEL"
  )?.value?.trim();
  const persistedDefaultModel = entries.find((line) =>
    line.key === "SCIENCESWARM_DEFAULT_OLLAMA_MODEL"
  )?.value?.trim();
  return resolveConfiguredLocalModel({
    OLLAMA_MODEL: persistedModel,
    SCIENCESWARM_DEFAULT_OLLAMA_MODEL: persistedDefaultModel,
  });
}

/**
 * Runs install tasks in phases, yielding a merged stream of events.
 * Within each phase, tasks push into a shared queue and the generator
 * drains it until the phase settles.
 */
export async function* runBootstrap(
  input: BootstrapInput,
  options: OrchestratorOptions = {},
): AsyncGenerator<BootstrapStreamEvent, void, unknown> {
  // 0. Persist identity first, synchronously. Failures here are fatal
  // and deliberately NOT attributed to any specific install task —
  // pinning a .env write failure on `gbrain-init` would mislead a
  // user into debugging PGLite when the real cause is filesystem
  // permissions. The summary carries a top-level `error` field that
  // the /setup page renders in the failed-state card.
  try {
    await persistIdentity(input);
  } catch (err) {
    yield {
      type: "summary",
      status: "failed",
      failed: [],
      skipped: [],
      error: `Failed to write .env: ${(err as Error).message}`,
    };
    return;
  }

  const allTasks = options.tasks ?? DEFAULT_TASKS;
  const shouldRunTelegramTask =
    !!input.phone ||
    !!input.existingBot?.token ||
    (await hasPersistedTelegramBotToken(input.repoRoot));
  const tasks = allTasks.filter(
    (t) => t.id !== "telegram-bot" || shouldRunTelegramTask,
  );

  type QueueItem =
    | { kind: "event"; event: BootstrapEvent }
    | { kind: "done" };
  const queue: QueueItem[] = [];
  const wakers: Array<() => void> = [];

  function push(item: QueueItem): void {
    queue.push(item);
    const w = wakers.shift();
    if (w) w();
  }

  function waitForItem(): Promise<void> {
    if (queue.length > 0) return Promise.resolve();
    return new Promise((resolve) => wakers.push(resolve));
  }

  // Dedupe via Sets so a task that yields `failed` and then also
  // throws (or yields multiple `failed` events in sequence) only
  // counts once toward the final summary status.
  const failedSet = new Set<BootstrapTaskId>();
  const skippedSet = new Set<BootstrapTaskId>();
  const latestTaskStatus = new Map<BootstrapTaskId, BootstrapStepStatus>();
  const availableTaskIds = new Set(tasks.map((task) => task.id));
  let readyFlagsFinalized = false;
  let openClawDefaultsFinalized = false;

  // Emit pending events up front so the UI can show every row before
  // the phased execution below starts.
  for (const task of tasks) {
    yield { type: "task", task: task.id, status: "pending" };
  }

  const taskSucceeded = (taskId: BootstrapTaskId): boolean =>
    availableTaskIds.has(taskId) && latestTaskStatus.get(taskId) === "succeeded";

  const maybeFinalizeConfiguredRuntime = async (): Promise<void> => {
    const readinessDeps = (["openclaw", "ollama-gemma"] as const)
      .filter((taskId) => availableTaskIds.has(taskId));
    if (
      !readyFlagsFinalized &&
      readinessDeps.length > 0 &&
      readinessDeps.every((taskId) => isTerminalBootstrapStatus(latestTaskStatus.get(taskId)))
    ) {
      await finalizeReadyFlags({
        repoRoot: input.repoRoot,
        openclawSucceeded: taskSucceeded("openclaw"),
        ollamaSucceeded: taskSucceeded("ollama-gemma"),
      });
      readyFlagsFinalized = true;
    }

    if (
      !openClawDefaultsFinalized &&
      taskSucceeded("openclaw") &&
      taskSucceeded("ollama-gemma")
    ) {
      await finalizeOpenClawDefaults({
        repoRoot: input.repoRoot,
        openclawSucceeded: true,
        ollamaSucceeded: true,
      });
      openClawDefaultsFinalized = true;
    }
  };

  async function* runTaskPhase(
    phaseTasks: InstallTask[],
  ): AsyncGenerator<BootstrapStreamEvent, void, unknown> {
    let activeTasks = phaseTasks.length;
    if (activeTasks === 0) return;

    for (const task of phaseTasks) {
      void (async () => {
        try {
          for await (const e of task.run(input)) {
            push({
              kind: "event",
              event: { type: "task", task: task.id, ...e },
            });
            if (e.status === "failed") failedSet.add(task.id);
            if (e.status === "skipped") skippedSet.add(task.id);
          }
        } catch (err) {
          failedSet.add(task.id);
          push({
            kind: "event",
            event: {
              type: "task",
              task: task.id,
              status: "failed",
              error: (err as Error).message,
            },
          });
        } finally {
          push({ kind: "done" });
        }
      })();
    }

    while (activeTasks > 0) {
      await waitForItem();
      const item = queue.shift();
      if (!item) continue;
      if (item.kind === "event") {
        latestTaskStatus.set(item.event.task, item.event.status);
        yield item.event;
        try {
          await maybeFinalizeConfiguredRuntime();
        } catch {
          // Keep the already-emitted task terminal states intact. Emitting a
          // synthetic task event here would overwrite the task row in the setup
          // UI even though the task itself already succeeded or failed.
        }
      } else {
        activeTasks -= 1;
      }
    }

    // Drain any residual events that landed after the last `done` notice
    // (can happen if push order interleaves event/done/event).
    while (queue.length > 0) {
      const item = queue.shift();
      if (item?.kind === "event") yield item.event;
    }
  }

  const telegramTasks = tasks.filter((task) => task.id === "telegram-bot");
  const nonTelegramTasks = tasks.filter((task) => task.id !== "telegram-bot");
  yield* runTaskPhase(nonTelegramTasks);
  yield* runTaskPhase(telegramTasks);

  const failed = Array.from(failedSet);
  const skipped = Array.from(skippedSet);

  // Complete the config so `/dashboard` stops bouncing the user back
  // to `/setup`. `getConfigStatus` requires `AGENT_BACKEND` and a
  // usable LLM path (either `OPENAI_API_KEY` or
  // `LLM_PROVIDER=local` + `OLLAMA_MODEL`). Neither is set by the
  // individual install tasks, so without this write the user sits in
  // a redirect loop after a fully-successful bootstrap. This was added
  // after dogfooding exposed a setup-success / app-not-ready mismatch
  // on the next page load.
  if (!readyFlagsFinalized) {
    try {
      await finalizeReadyFlags({
        repoRoot: input.repoRoot,
        openclawSucceeded: taskSucceeded("openclaw"),
        ollamaSucceeded: taskSucceeded("ollama-gemma"),
      });
    } catch {
      // Keep the already-emitted task terminal states intact. Emitting a
      // synthetic task event here would overwrite the OpenClaw row back to
      // `running` in the setup UI even though the task itself already
      // succeeded or failed.
    }
  }

  // Point OpenClaw's default model at the local Ollama provider so the
  // bot responds without any cloud credentials. Only runs when both
  // openclaw and ollama-gemma succeeded, so we know the provider
  // plugin has a live model to call. Without this step a fresh
  // install answers every Telegram DM with "Missing API key for
  // OpenAI on the gateway" — OpenClaw's stock default is
  // `openai/gpt-4.1`, which requires a credential ScienceSwarm's
  // one-screen setup flow never collects.
  if (!openClawDefaultsFinalized) {
    try {
      await finalizeOpenClawDefaults({
        repoRoot: input.repoRoot,
        openclawSucceeded: taskSucceeded("openclaw"),
        ollamaSucceeded: taskSucceeded("ollama-gemma"),
      });
    } catch {
      // Same reasoning as above: the per-task rows are already terminal,
      // don't clobber them. Worst case the user sees the OpenAI-key
      // error on their first bot message and can fix it from
      // /dashboard/settings.
    }
  }

  const status: "ok" | "partial" | "failed" =
    failed.length === 0
      ? "ok"
      : failed.length === tasks.length
        ? "failed"
        : "partial";
  yield { type: "summary", status, failed, skipped };
}

/**
 * Write `AGENT_BACKEND` and `LLM_PROVIDER` (+ `OLLAMA_MODEL` when
 * local) to `.env` so `getConfigStatus(...).ready` becomes true.
 * Neither the individual install tasks nor `persistIdentity` write
 * these, so without this step every fresh install gets stuck on
 * `/setup` after a successful bootstrap — the dashboard layout
 * reads `.env`, sees `AGENT_BACKEND` empty, and redirects back.
 *
 * Provider selection:
 *
 *   - `AGENT_BACKEND=openclaw` if the openclaw task succeeded.
 *     If it did not, we leave `AGENT_BACKEND` unset so the user can
 *     retry from `/dashboard/settings` (or manually set `nanoclaw`).
 *
 *   - If the ollama-gemma task succeeded, write `LLM_PROVIDER=local`
 *     and the configured `OLLAMA_MODEL` (the model the task actually
 *     downloads). This is the common fresh-install path — the one-screen
 *     setup form deliberately does NOT ask the user to choose between
 *     local and cloud during bootstrap, so a successful local install
 *     should land in local mode by default even when `.env` already
 *     contains an optional OpenAI key for later use.
 *
 *   - Otherwise, if the user's `.env` already carries a non-empty
 *     `OPENAI_API_KEY` (they pre-seeded it) and Ollama did not succeed,
 *     write `LLM_PROVIDER=openai` so the install still ends with a
 *     usable LLM path.
 *
 *   - Otherwise, leave the LLM flags unset. The user will see
 *     "Setup did not complete" on `/setup` and can recover from
 *     `/dashboard/settings` once they install a provider.
 */
async function finalizeReadyFlags(args: {
  repoRoot: string;
  openclawSucceeded: boolean;
  ollamaSucceeded: boolean;
}): Promise<void> {
  const envPath = path.join(args.repoRoot, ".env");
  let existing = "";
  try {
    existing = await fs.readFile(envPath, { encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const doc = parseEnvFile(existing);

  // Read the already-saved OPENAI_API_KEY from the parsed doc so we can
  // keep it available for optional cloud fallback without forcing the
  // bootstrap out of the documented local-first path.
  const currentKey = doc.lines
    .find(
      (line): line is Extract<typeof line, { type: "entry" }> =>
        line.type === "entry" && line.key === "OPENAI_API_KEY",
    )
    ?.value?.trim();
  const hasApiKey = !!currentKey && currentKey.length > 0;
  const currentProvider = doc.lines
    .find(
      (line): line is Extract<typeof line, { type: "entry" }> =>
        line.type === "entry" && line.key === "LLM_PROVIDER",
    )
    ?.value?.trim();
  const hasConfiguredProvider = !!currentProvider && currentProvider.length > 0;

  const currentOllamaApiKey = doc.lines
    .find(
      (line): line is Extract<typeof line, { type: "entry" }> =>
        line.type === "entry" && line.key === "OLLAMA_API_KEY",
    )
    ?.value?.trim();
  const hasConfiguredOllamaApiKey =
    !!currentOllamaApiKey && currentOllamaApiKey.length > 0;
  const currentOllamaModel = doc.lines
    .find(
      (line): line is Extract<typeof line, { type: "entry" }> =>
        line.type === "entry" && line.key === "OLLAMA_MODEL",
    )
    ?.value?.trim();
  const currentDefaultOllamaModel = doc.lines
    .find(
      (line): line is Extract<typeof line, { type: "entry" }> =>
        line.type === "entry" &&
        line.key === "SCIENCESWARM_DEFAULT_OLLAMA_MODEL",
    )
    ?.value?.trim();

  const updates: Record<string, string | null> = {};
  const defaultLocalModel = resolveConfiguredLocalModel({
    OLLAMA_MODEL: currentOllamaModel,
    SCIENCESWARM_DEFAULT_OLLAMA_MODEL: currentDefaultOllamaModel,
  });
  if (args.openclawSucceeded) {
    updates.AGENT_BACKEND = "openclaw";
  }
  if (!hasConfiguredProvider) {
    if (args.ollamaSucceeded) {
      updates.LLM_PROVIDER = "local";
      updates.OLLAMA_MODEL = defaultLocalModel;
    } else if (hasApiKey) {
      updates.LLM_PROVIDER = "openai";
    }
  }

  // Ensure OLLAMA_MODEL is set whenever the effective provider is "local".
  // The block above only writes it on first run (!hasConfiguredProvider).
  // If LLM_PROVIDER=local already exists in .env from a previous run but
  // OLLAMA_MODEL was never persisted, the dashboard readiness check sees
  // LLM_PROVIDER=local + empty OLLAMA_MODEL → ready=false → redirect loop.
  if (
    (updates.LLM_PROVIDER ?? currentProvider) === "local" &&
    !updates.OLLAMA_MODEL &&
    !(currentOllamaModel ?? "").length
  ) {
    updates.OLLAMA_MODEL = defaultLocalModel;
  }

  const effectiveProvider = updates.LLM_PROVIDER ?? currentProvider;
  if (
    args.ollamaSucceeded &&
    effectiveProvider === "local" &&
    !hasConfiguredOllamaApiKey
  ) {
    // OpenClaw's Ollama provider plugin requires OLLAMA_API_KEY to
    // be set to SOMETHING before it treats Ollama as a registered
    // provider. Any string works — the plugin literally tells you
    // so in its error message ("Set OLLAMA_API_KEY='ollama-local'
    // (any value works)"). Without this env var, every first
    // message to the local model fails with "Unknown model:
    // the configured ollama model and the bot replies "Something went wrong
    // while processing your request." Writing the sentinel here
    // so start.sh picks it up on the next launch, even when the user
    // already had LLM_PROVIDER=local in their .env.
    updates.OLLAMA_API_KEY = "ollama-local";
  }

  if (Object.keys(updates).length === 0) return;

  const merged = mergeEnvValues(doc, updates);
  const serialized = serializeEnvDocument(merged);
  await writeEnvFileAtomic(envPath, serialized);
}

/**
 * Point OpenClaw's default model at the local Ollama provider after a
 * successful fresh-install bootstrap, and
 * register the provider itself in `openclaw.json`.
 *
 * Why: OpenClaw's stock default is `openai/gpt-5.4`, which requires
 * an OpenAI API key or an `openai-codex/*` OAuth credential. Neither
 * is collected by ScienceSwarm's one-screen setup form, so a brand-
 * new user completes bootstrap and then gets "Missing API key for
 * OpenAI on the gateway. Use openai-codex/gpt-5.4 for OAuth, or
 * set OPENAI_API_KEY, then try again." on their very first Telegram
 * DM. This step switches the default to the local model we just
 * pulled in the ollama-gemma install task. We write an explicit provider
 * entry because `openclaw models set ollama/<model>` only updates
 * `agents.defaults.*`; without `models.providers.ollama`, a fresh gateway
 * can still mark the model as `missing` and log
 * `Unknown model: ollama/<model>` during startup.
 *
 * We only run this step when:
 *   - openclaw task succeeded (so the CLI is installed and on PATH)
 *   - ollama-gemma task succeeded (so the local model actually exists)
 *
 * If either didn't succeed, the stock OpenClaw default stays in
 * place and the user can recover from `/dashboard/settings` later
 * (or by running `openclaw models set ollama/<model>` themselves).
 *
 * The call goes through `runOpenClaw`, which exports
 * `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH` for the spawned child,
 * so the write lands in the ScienceSwarm-managed state dir —
 * `$SCIENCESWARM_DIR/openclaw/openclaw.json` — NOT the user's
 * personal `~/.openclaw/openclaw.json`.
 */
async function finalizeOpenClawDefaults(args: {
  repoRoot: string;
  openclawSucceeded: boolean;
  ollamaSucceeded: boolean;
}): Promise<void> {
  if (!args.openclawSucceeded || !args.ollamaSucceeded) return;

  // Import lazily so unit tests that exercise runBootstrap don't
  // need the full openclaw/runner module graph. The dynamic import
  // is resolved once at call time; there's no measurable overhead.
  const { runOpenClaw } = await import("@/lib/openclaw/runner");
  const localModel = await readPersistedOllamaModel(args.repoRoot);
  const openClawOllamaModelRef = toOpenClawOllamaModelRef(localModel);

  const providerResult = await runOpenClaw(
    [
      "config",
      "set",
      "models.providers.ollama",
      JSON.stringify(buildOpenClawOllamaProviderConfig(openClawOllamaModelRef)),
      "--strict-json",
    ],
    { timeoutMs: 10_000 },
  );
  if (!providerResult.ok) {
    throw new Error(
      `openclaw config set models.providers.ollama failed: ${providerResult.stderr || `exit ${providerResult.code}`}`,
    );
  }

  const allowedModelsResult = await runOpenClaw(
    [
      "config",
      "set",
      "agents.defaults.models",
      JSON.stringify(buildLocalOpenClawAllowedModels(openClawOllamaModelRef)),
      "--strict-json",
    ],
    { timeoutMs: 10_000 },
  );
  if (!allowedModelsResult.ok) {
    throw new Error(
      `openclaw config set agents.defaults.models failed: ${allowedModelsResult.stderr || `exit ${allowedModelsResult.code}`}`,
    );
  }

  // The model id format is `<provider>/<model>`. `ollama` is a
  // bundled provider plugin (`@openclaw/ollama-provider`), and
  // `localModel` is the exact model tag the ollama-gemma install
  // task downloads from Ollama. Changing either side requires
  // updating the other.
  const modelResult = await runOpenClaw(["models", "set", openClawOllamaModelRef], {
    timeoutMs: 10_000,
    extraEnv: { OLLAMA_API_KEY: "ollama-local" },
  });
  if (!modelResult.ok) {
    throw new Error(
      `openclaw models set ${openClawOllamaModelRef} failed: ${modelResult.stderr || `exit ${modelResult.code}`}`,
    );
  }
}
