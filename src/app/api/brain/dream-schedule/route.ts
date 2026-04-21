/**
 * /api/brain/dream-schedule
 *
 * GET  — Read the current dream schedule config.
 * POST — Update the dream schedule config, or trigger "run-if-due".
 *
 * POST body variants:
 *   { action: "run-if-due" }          — check shouldRunNow, trigger if true
 *   { enabled, schedule, mode, ... }  — update the schedule config
 */

import {
  readScheduleConfig,
  writeScheduleConfig,
  shouldRunNow,
  getNextRunTime,
  type DreamScheduleConfig,
} from "@/brain/dream-scheduler";
import { runDreamCycle, type DreamCycleMode } from "@/brain/dream-cycle";
import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";
import { getBrainConfig, getLLMClient, isErrorResponse } from "../_shared";
import type { LLMClient } from "@/brain/llm";
import {
  executeScheduledRadar,
  shouldRunNow as radarShouldRunNow,
  sendTelegramBriefing,
} from "@/lib/radar/schedule";

/** Adapt the brain LLMClient (complete) to the radar generate(prompt) interface. */
function toRadarLLM(llm: LLMClient): { generate(prompt: string): Promise<string> } {
  return {
    generate(prompt: string) {
      return llm
        .complete({ system: "You are a helpful research assistant.", user: prompt })
        .then((r) => r.content);
    },
  };
}

const VALID_MODES: DreamCycleMode[] = ["full", "sweep-only", "enrich-only"];

export async function GET() {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  const schedule = readScheduleConfig(config);
  const nextRun = getNextRunTime(schedule);

  return Response.json({
    ...schedule,
    nextRun: nextRun?.toISOString() ?? null,
  });
}

export async function POST(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // ── Action: run-if-due ───────────────────────────────
  if (body.action === "run-if-due") {
    const schedule = readScheduleConfig(config);
    if (!shouldRunNow(schedule)) {
      const nextRun = getNextRunTime(schedule);
      return Response.json({
        ran: false,
        reason: "Not due yet",
        nextRun: nextRun?.toISOString() ?? null,
      });
    }

    try {
      const llm = getLLMClient(config);
      const result = await runDreamCycle(config, llm, schedule.mode);

      // ── Radar pipeline (runs alongside dream cycle when due) ──
      let radarResult: { ran: boolean; error?: string } = { ran: false };
      try {
        await ensureBrainStoreReady();
        const brainStore = getBrainStore();
        const radar = await import("@/lib/radar/store").then((m) =>
          m.getActiveRadar(config.root)
        );
        if (radar && radarShouldRunNow(radar.schedule.cron, radar.schedule.timezone)) {
          const pipelineResult = await executeScheduledRadar({
            stateDir: config.root,
            brainStore,
            llm: toRadarLLM(llm),
          });
          if (pipelineResult) {
            if (radar.channels.telegram) {
              await sendTelegramBriefing(pipelineResult.telegram);
            }
            radarResult = { ran: true };
          }
        }
      } catch (radarErr) {
        const msg = radarErr instanceof Error ? radarErr.message : "Radar pipeline failed";
        console.error("[radar] scheduled run error:", msg);
        radarResult = { ran: false, error: msg };
      }

      return Response.json({ ran: true, result, radar: radarResult });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Dream cycle failed";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // ── Update schedule config ───────────────────────────
  const current = readScheduleConfig(config);

  const updated: DreamScheduleConfig = {
    enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
    schedule: typeof body.schedule === "string" ? body.schedule : current.schedule,
    mode:
      typeof body.mode === "string" && VALID_MODES.includes(body.mode as DreamCycleMode)
        ? (body.mode as DreamCycleMode)
        : current.mode,
    quietHoursStart:
      typeof body.quietHoursStart === "number"
        ? body.quietHoursStart
        : current.quietHoursStart,
    quietHoursEnd:
      typeof body.quietHoursEnd === "number"
        ? body.quietHoursEnd
        : current.quietHoursEnd,
  };

  writeScheduleConfig(config, updated);

  const nextRun = getNextRunTime(updated);
  return Response.json({
    ...updated,
    nextRun: nextRun?.toISOString() ?? null,
  });
}
