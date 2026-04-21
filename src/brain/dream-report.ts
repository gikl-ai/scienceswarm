import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DreamHeadlineSummary } from "./dream-headline";

export interface DreamLastRun {
  timestamp: string;
  mode: string;
  pages_compiled: number;
  contradictions_found: number;
  backlinks_added: number;
  duration_ms: number;
  duration_ms_per_stage: Record<string, number>;
  errors: string[];
  partial: boolean;
  skipped?: boolean;
  reason?: string;
  headline?: DreamHeadlineSummary;
}

export function dreamLastRunPath(brainRoot: string): string {
  return join(brainRoot, ".dream-last-run.json");
}

export async function readDreamLastRun(brainRoot: string): Promise<DreamLastRun | null> {
  const path = dreamLastRunPath(brainRoot);
  try {
    return parseDreamLastRun(JSON.parse(await readFile(path, "utf-8")));
  } catch {
    return null;
  }
}

export function writeDreamLastRun(brainRoot: string, report: DreamLastRun): string {
  const path = dreamLastRunPath(brainRoot);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function parseDreamLastRun(value: unknown): DreamLastRun | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<DreamLastRun>;
  const durationByStage = parseNumericRecord(raw.duration_ms_per_stage);
  const skipped = parseOptionalBoolean(raw.skipped);
  const reason = parseOptionalString(raw.reason);
  const headline = parseOptionalHeadline(raw.headline);
  if (skipped === null || reason === null) return null;
  if (
    typeof raw.timestamp !== "string" ||
    typeof raw.mode !== "string" ||
    typeof raw.pages_compiled !== "number" ||
    typeof raw.contradictions_found !== "number" ||
    typeof raw.backlinks_added !== "number" ||
    typeof raw.duration_ms !== "number" ||
    !durationByStage ||
    !Array.isArray(raw.errors) ||
    typeof raw.partial !== "boolean"
  ) {
    return null;
  }
  return {
    timestamp: raw.timestamp,
    mode: raw.mode,
    pages_compiled: raw.pages_compiled,
    contradictions_found: raw.contradictions_found,
    backlinks_added: raw.backlinks_added,
    duration_ms: raw.duration_ms,
    duration_ms_per_stage: durationByStage,
    errors: raw.errors.map(String),
    partial: raw.partial,
    skipped,
    reason,
    headline: headline ?? undefined,
  };
}

function parseNumericRecord(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    out[key] = raw;
  }
  return out;
}

function parseOptionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

function parseOptionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function parseOptionalHeadline(value: unknown): DreamHeadlineSummary | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<DreamHeadlineSummary>;
  if (
    typeof raw.generatedAt !== "string" ||
    typeof raw.windowStart !== "string" ||
    typeof raw.windowEnd !== "string" ||
    typeof raw.headline !== "string" ||
    typeof raw.newSignals !== "number" ||
    typeof raw.newPapers !== "number" ||
    typeof raw.topicsRecompiled !== "number" ||
    typeof raw.contradictionsFound !== "number" ||
    typeof raw.staleExperiments !== "number" ||
    typeof raw.crossReferencesAdded !== "number" ||
    typeof raw.brokenBacklinksFixed !== "number" ||
    typeof raw.staleTimelinesConsolidated !== "number" ||
    !raw.sourceBreakdown ||
    typeof raw.sourceBreakdown !== "object" ||
    Array.isArray(raw.sourceBreakdown) ||
    !Array.isArray(raw.compiledTopics) ||
    !Array.isArray(raw.signals) ||
    !Array.isArray(raw.staleExperimentDetails)
  ) {
    return null;
  }
  return raw as DreamHeadlineSummary;
}
