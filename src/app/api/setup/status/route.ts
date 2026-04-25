/**
 * GET /api/setup/status
 *
 * Returns the current `ConfigStatus` snapshot for the running install.
 *
 * This route is the backbone of the `/setup` page: on every render the
 * UI calls it to decide whether to show "ready" or a specific field-
 * level error. We intentionally re-read `.env` from disk on every
 * request (via `getConfigStatus`) rather than trusting `process.env`,
 * because `process.env` only reflects the snapshot Next.js loaded at
 * server boot — any `.env` edits made after boot (either by the
 * user in a text editor or by `POST /api/setup`) are invisible to
 * `process.env` until the Next.js process restarts.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { isGbrainRootReady } from "@/lib/brain/readiness";
import { hasRecommendedOllamaModel } from "@/lib/ollama-models";
import { getOllamaInstallStatus } from "@/lib/ollama-install";
import { getOpenClawSetupSummary } from "@/lib/openclaw-status";
import { isStrictLocalOnlyEnabled } from "@/lib/env-flags";
import {
  buildOpenHandsLocalEvidenceSnapshot,
  buildRuntimeCapabilityContract,
  readOpenHandsLocalEvidence,
} from "@/lib/runtime";
import { resolveScienceSwarmBrainRootFromValues } from "@/lib/scienceswarm-paths";
import {
  getConfigStatus,
  type OllamaStatusSummary,
  type OpenClawStatusSummary,
} from "@/lib/setup/config-status";
import { migrateEnvLocalOnce } from "@/lib/setup/env-migration";

const exec = promisify(execFile);

type ConfigStatusForRuntime = Awaited<ReturnType<typeof getConfigStatus>>;

function getConfiguredProvider(
  status: ConfigStatusForRuntime,
): "local" | "openai" {
  return status.rawValues.LLM_PROVIDER?.trim().toLowerCase() === "local"
    ? "local"
    : "openai";
}

function getConfiguredAgent(status: ConfigStatusForRuntime): string {
  const backend = status.rawValues.AGENT_BACKEND?.trim().toLowerCase();
  return backend || "none";
}

function getGbrainSnapshot(status: ConfigStatusForRuntime) {
  const root = resolveScienceSwarmBrainRootFromValues(status.rawValues);
  const ready = isGbrainRootReady(root);
  return {
    read: ready,
    write: ready,
    capture: ready,
    maintenance: ready,
    uploadFiles: ready,
    localFolder: ready,
  };
}

/**
 * Probe the local Ollama daemon by invoking `ollama list`. A
 * successful exit means the daemon is running; the parsed stdout
 * then tells us whether the recommended model is already pulled.
 *
 * Running status is deliberately independent of model presence — a
 * daemon that's up but missing the recommended model should still
 * surface as `running: true` so the UI can show the pull prompt
 * instead of sending the user back to the start command.
 *
 * We parse stdout line-by-line instead of using `--format json`
 * because older Ollama builds don't support the flag. Matching treats
 * `gemma4` and `gemma4:latest` as the same default model, but keeps
 * other tagged variants distinct.
 *
 * Failure is non-fatal: the /setup UI treats "not running" the same
 * as "unknown daemon" and prompts the user to start it.
 */
async function probeOllamaRuntime(
  binaryPath: string | null,
): Promise<{ running: boolean; hasModel: boolean; models: string[] }> {
  const binary = binaryPath ?? "ollama";
  try {
    const { stdout } = await exec(binary, ["list"], { timeout: 5000 });
    const lines = typeof stdout === "string" ? stdout.split("\n") : [];
    const models = lines
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((modelName) => modelName.length > 0 && modelName !== "NAME");
    const hasModel = hasRecommendedOllamaModel(models);
    return { running: true, hasModel, models };
  } catch {
    return { running: false, hasModel: false, models: [] };
  }
}

/**
 * Gracefully probe OpenClaw. Returns `undefined` on throw so the
 * caller can leave the field out of the response rather than pretend
 * OpenClaw is definitively "not installed" when a probe crashed.
 */
async function probeOpenClawOrUndefined(): Promise<
  OpenClawStatusSummary | undefined
> {
  try {
    return await getOpenClawSetupSummary();
  } catch (err) {
    console.warn(
      "api/setup/status: openclaw probe failed (non-blocking)",
      err instanceof Error ? err.name : typeof err,
    );
    return undefined;
  }
}

/**
 * Gracefully probe Ollama. Maps the richer install-status shape into
 * the slim summary the /setup page renders. Failures come back as
 * `undefined` for the same reason as OpenClaw.
 */
async function probeOllamaOrUndefined(): Promise<
  OllamaStatusSummary | undefined
> {
  try {
    const ollama = await getOllamaInstallStatus();
    const installed = ollama.binaryInstalled && ollama.binaryCompatible;
    // Running is probed independently of model presence: a successful
    // `ollama list` exit means the daemon is up, even if it has no
    // recommended model pulled yet. Misclassifying a running-but-empty
    // daemon as "not running" would push users back to the start
    // command instead of the pull prompt.
    const runtime = installed
      ? await probeOllamaRuntime(ollama.binaryPath)
      : { running: false, hasModel: false, models: [] };

    const summary: OllamaStatusSummary = {
      installed,
      running: runtime.running,
      hasRecommendedModel: runtime.hasModel,
      models: runtime.models,
    };
    if (ollama.installCommand) {
      summary.installCommand = ollama.installCommand;
    }
    if (ollama.startCommand) {
      summary.startCommand = ollama.startCommand;
    }
    return summary;
  } catch (err) {
    console.warn(
      "api/setup/status: ollama probe failed (non-blocking)",
      err instanceof Error ? err.name : typeof err,
    );
    return undefined;
  }
}

export async function GET(request: Request): Promise<Response> {
  void request;
  // One-time idempotent migration from `.env.local` → `.env`. This is
  // an unauthenticated route hit early on `/setup`, making it the
  // earliest reliable boot hook we have. The module guards itself with
  // a sentinel file so repeat invocations are cheap no-ops. We
  // swallow errors so a migration failure never blocks the status
  // probe — the user will still see the underlying config state.
  try {
    await migrateEnvLocalOnce(process.cwd());
  } catch (err) {
    console.warn(
      "api/setup/status: env migration failed (non-blocking)",
      err instanceof Error ? err.name : typeof err,
    );
  }

  try {
    const [status, openclawStatus, ollamaStatus] = await Promise.all([
      getConfigStatus(process.cwd()),
      probeOpenClawOrUndefined(),
      probeOllamaOrUndefined(),
    ]);
    const defaultHandle = (process.env.USER ?? process.env.LOGNAME ?? "").trim();
    const agentType = getConfiguredAgent(status);
    const runtimeEnv = { ...process.env, ...status.rawValues };
    const openHandsEvidence = await readOpenHandsLocalEvidence(runtimeEnv);
    const openHandsLocalEvidence = buildOpenHandsLocalEvidenceSnapshot({
      env: runtimeEnv,
      evidence: openHandsEvidence,
    });
    const runtimeContract = buildRuntimeCapabilityContract({
      strictLocalOnly: isStrictLocalOnlyEnabled(runtimeEnv),
      llmProvider: getConfiguredProvider(status),
      localModel: status.rawValues.OLLAMA_MODEL,
      ollama: {
        running: ollamaStatus?.running === true,
        models: ollamaStatus?.models ?? [],
      },
      agent: {
        type: agentType,
        status:
          agentType === "openclaw" && openclawStatus?.running === true
            ? "connected"
            : "disconnected",
      },
      openhands: {
        status: "disconnected",
        ...openHandsLocalEvidence,
      },
      openaiKeyConfigured: status.openaiApiKey.state === "ok",
      structuredCritiqueConfigured: false,
      telegramConfigured: Boolean(status.rawValues.TELEGRAM_BOT_TOKEN),
      gbrain: getGbrainSnapshot(status),
    });
    return Response.json({
      ...status,
      openclawStatus,
      ollamaStatus,
      runtimeContract,
      defaultHandle,
    });
  } catch (err) {
    // Log the specific error server-side so an operator can see what
    // happened, but never echo raw exception text to the client — I/O
    // errors can embed absolute paths that reveal the user's home
    // layout. The client only needs a generic 500 to know the status
    // probe failed and fall back to prompting the user.
    console.error(
      "api/setup/status: failed to read config status",
      err instanceof Error ? err.name : typeof err,
    );
    return Response.json(
      { error: "Failed to read config status" },
      { status: 500 },
    );
  }
}
