/**
 * GET /api/brain/status
 *
 * Returns brain health: monthly cost, budget status, recent events, page count.
 *
 * Phase C extension (TODO #2 from the eng review): also reads the
 * radar skill runner's last-run pointer at `<BRAIN_ROOT>/.radar-last-run.json`
 * and returns it as `radar: { last_run, concepts_processed, errors,
 * age_ms, stale }`. The dashboard surfaces this so a crashed skill
 * runner is visible to the user instead of silently rotting.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getMonthCost, getRecentEvents } from "@/brain/cost";
import { countPagesFromDisk } from "@/brain/search";
import {
  getBrainStore,
  ensureBrainStoreReady,
  type BrainStoreHealth,
} from "@/brain/store";
import { getBrainConfig, isErrorResponse } from "../_shared";

const RADAR_LAST_RUN_FILENAME = ".radar-last-run.json";
const DEFAULT_RADAR_INTERVAL_MINUTES = 30;

interface RadarLastRunFile {
  timestamp: string;
  concepts_processed: number;
  errors_count: number;
  schedule_interval_ms: number;
}

interface RadarHealthPayload {
  last_run: string;
  concepts_processed: number;
  errors: number;
  age_ms: number;
  stale: boolean;
  schedule_interval_ms: number;
}

/**
 * Read and validate the radar last-run pointer. Returns null on
 * any failure mode — missing file, malformed JSON, missing fields,
 * non-finite numbers — so the status route degrades gracefully when
 * the runner has never executed (or has been removed).
 */
async function readRadarLastRun(brainRoot: string): Promise<RadarHealthPayload | null> {
  const path = join(brainRoot, RADAR_LAST_RUN_FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const file = parsed as Partial<RadarLastRunFile>;
  if (typeof file.timestamp !== "string") return null;
  if (typeof file.concepts_processed !== "number") return null;
  if (typeof file.errors_count !== "number") return null;

  const ts = Date.parse(file.timestamp);
  if (!Number.isFinite(ts)) return null;

  const intervalMs = typeof file.schedule_interval_ms === "number" && file.schedule_interval_ms > 0
    ? file.schedule_interval_ms
    : DEFAULT_RADAR_INTERVAL_MINUTES * 60_000;

  const ageMs = Math.max(0, Date.now() - ts);

  return {
    last_run: file.timestamp,
    concepts_processed: file.concepts_processed,
    errors: file.errors_count,
    age_ms: ageMs,
    // "Stale" = the runner missed at least two of its own scheduled
    // intervals. Two-interval grace gives a single skipped run room
    // to recover before we surface a warning chip on the dashboard.
    stale: ageMs > 2 * intervalMs,
    schedule_interval_ms: intervalMs,
  };
}

export async function GET() {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  try {
    const monthCost = getMonthCost(config);
    const budgetExceeded = monthCost >= config.paperWatchBudget;
    const recentEvents = getRecentEvents(config, undefined, 10);

    // Backend health from the active BrainStore (PGLite). This is the
    // single source of truth for page count in the happy path; we only
    // fall through to a filesystem walk when the store is unavailable.
    let storeHealth: BrainStoreHealth | undefined;
    try {
      await ensureBrainStoreReady();
      const store = getBrainStore();
      storeHealth = await store.health();
    } catch {
      storeHealth = { ok: false, pageCount: 0 };
    }

    // Prefer store page count when available, fall back to filesystem count.
    // `countPagesFromDisk` is sync + filesystem-only so the healthy path
    // does not pay for a second `store.health()` round-trip.
    const responsePageCount = storeHealth?.ok
      ? storeHealth.pageCount
      : countPagesFromDisk(config);

    // Radar visibility (TODO #2). Best-effort: any failure resolves
    // to `null` so a missing pointer file never breaks the status
    // endpoint that the dashboard polls on every load.
    const radar = await readRadarLastRun(config.root);

    return Response.json({
      monthCost,
      budgetExceeded,
      recentEvents,
      pageCount: responsePageCount,
      backend: "pglite",
      store: storeHealth,
      radar,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status check failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
