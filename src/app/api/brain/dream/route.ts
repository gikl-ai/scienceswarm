/**
 * /api/brain/dream
 *
 * GET returns the structured last-run pointer written by the dream-cycle
 * sidecar. POST preserves the manual trigger surface.
 */

import { runDreamCycle, type DreamCycleMode } from "@/brain/dream-cycle";
import { readDreamLastRun, writeDreamLastRun } from "@/brain/dream-report";
import { apiError, getBrainConfig, getLLMClient, isErrorResponse } from "../_shared";
import { isBrainBackendUnavailableError } from "@/brain/store";
import { isLocalRequest } from "@/lib/local-guard";

const VALID_MODES: DreamCycleMode[] = ["full", "sweep-only", "enrich-only"];

export async function GET(): Promise<Response> {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  return Response.json({
    lastRun: await readDreamLastRun(configOrError.root),
  });
}

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let mode: DreamCycleMode = "full";

  try {
    const body = await request.json();
    if (body && typeof body === "object" && "mode" in body) {
      if (typeof body.mode === "string" && VALID_MODES.includes(body.mode as DreamCycleMode)) {
        mode = body.mode as DreamCycleMode;
      } else if (body.mode !== undefined) {
        return Response.json(
          { error: `Invalid mode. Must be one of: ${VALID_MODES.join(", ")}` },
          { status: 400 },
        );
      }
    }
  } catch {
    // No body or invalid JSON — use default mode.
  }

  const startedAt = Date.now();

  try {
    const llm = getLLMClient(config);
    const result = await runDreamCycle(config, llm, mode);
    try {
      writeDreamLastRun(config.root, {
        timestamp: new Date().toISOString(),
        mode,
        journal_slug: result.journalSlug ?? undefined,
        pages_compiled: result.pagesCompiled,
        contradictions_found: result.contradictionsFound,
        backlinks_added: result.backlinksAdded,
        duration_ms: result.durationMs,
        duration_ms_per_stage: { total: result.durationMs },
        errors: [],
        partial: false,
        headline: result.headline ?? undefined,
      });
    } catch {
      // The manual run succeeded; keep the pointer write best-effort.
    }
    return Response.json(result);
  } catch (err) {
    return dreamCycleFailureResponse(err, config.root, mode, startedAt);
  }
}

interface DreamCycleFailure {
  status: number;
  error: string;
  code: string;
  cause: string;
  nextAction: string;
  details: {
    message: string;
  };
}

function dreamCycleFailureResponse(
  err: unknown,
  brainRoot: string,
  mode: DreamCycleMode,
  startedAt: number,
): Response {
  const failure = describeDreamCycleFailure(err);
  try {
    writeDreamLastRun(brainRoot, {
      timestamp: new Date().toISOString(),
      mode,
      pages_compiled: 0,
      contradictions_found: 0,
      backlinks_added: 0,
      duration_ms: Date.now() - startedAt,
      duration_ms_per_stage: { total: Date.now() - startedAt },
      errors: [failure.cause],
      partial: true,
      reason: failure.nextAction,
    });
  } catch {
    // Failure visibility should not depend on the sidecar pointer write.
  }

  return apiError(failure.status, {
    error: failure.error,
    code: failure.code,
    cause: failure.cause,
    nextAction: failure.nextAction,
    details: failure.details,
  });
}

function describeDreamCycleFailure(err: unknown): DreamCycleFailure {
  if (isDreamBrainStoreFailure(err)) {
    return {
      status: 503,
      error: "Dream Cycle could not complete.",
      code: "dream_cycle_brain_store_unavailable",
      cause:
        "The local brain store did not complete the synthesis request.",
      nextAction:
        "Close duplicate ScienceSwarm processes or restart ScienceSwarm to restore the local brain store, then click Retry Dream Cycle. Existing research material is retained.",
      details: {
        message:
          "Dream Cycle could not complete because the local brain store is unavailable.",
      },
    };
  }

  if (isDreamLocalModelFailure(err)) {
    return {
      status: 503,
      error: "Dream Cycle could not complete.",
      code: "dream_cycle_local_model_unavailable",
      cause:
        "The configured local model service did not complete the synthesis request.",
      nextAction:
        "Start Ollama or restore the configured local model, then click Retry Dream Cycle. Existing research material is retained.",
      details: {
        message:
          "Dream Cycle could not complete because the configured local model is unavailable.",
      },
    };
  }

  return {
    status: 500,
    error: "Dream Cycle could not complete.",
    code: "dream_cycle_failed",
    cause:
      "The configured Dream Cycle runtime did not complete the synthesis request.",
    nextAction:
      "Check ScienceSwarm runtime health, then click Retry Dream Cycle. Existing research material is retained.",
    details: {
      message: "Dream Cycle could not complete with the configured runtime.",
    },
  };
}

function isDreamBrainStoreFailure(err: unknown): boolean {
  if (isBrainBackendUnavailableError(err)) return true;
  if (!(err instanceof Error)) return false;
  return err.name === "BrainBackendUnavailableError"
    || /brain backend unavailable/i.test(err.message);
}

function isDreamLocalModelFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "StrictLocalPolicyError") return false;
  const evidence = [err.name, err.message, err.stack ?? ""].join("\n");
  return /ollama|local model|local-llm|completeLocal|brain LLM completion/i.test(evidence);
}
