import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ResearchLandscapeLastRun,
  ResearchLandscapeSource,
} from "./contract";
import {
  DEFAULT_RESEARCH_LANDSCAPE_SOURCES,
  RESEARCH_LANDSCAPE_LAST_RUN_FILENAME,
} from "./contract";

export function researchLandscapeLastRunPath(brainRoot: string): string {
  return join(brainRoot, RESEARCH_LANDSCAPE_LAST_RUN_FILENAME);
}

export async function readResearchLandscapeLastRun(
  brainRoot: string,
): Promise<ResearchLandscapeLastRun | null> {
  try {
    return parseResearchLandscapeLastRun(
      JSON.parse(await readFile(researchLandscapeLastRunPath(brainRoot), "utf-8")),
    );
  } catch {
    return null;
  }
}

export function writeResearchLandscapeLastRun(
  brainRoot: string,
  payload: ResearchLandscapeLastRun,
): string {
  const filePath = researchLandscapeLastRunPath(brainRoot);
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return filePath;
}

function parseResearchLandscapeLastRun(value: unknown): ResearchLandscapeLastRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<ResearchLandscapeLastRun>;
  if (
    typeof raw.timestamp !== "string"
    || typeof raw.status !== "string"
    || typeof raw.query !== "string"
    || typeof raw.packet_slug !== "string"
    || typeof raw.journal_slug !== "string"
    || typeof raw.collected_candidates !== "number"
    || typeof raw.retained_candidates !== "number"
    || typeof raw.duplicates_dropped !== "number"
    || typeof raw.partial !== "boolean"
    || !Array.isArray(raw.source_failures)
  ) {
    return null;
  }

  return {
    timestamp: raw.timestamp,
    status: raw.status,
    query: raw.query,
    exact_title: typeof raw.exact_title === "string" ? raw.exact_title : undefined,
    project: typeof raw.project === "string" ? raw.project : undefined,
    packet_slug: raw.packet_slug,
    journal_slug: raw.journal_slug,
    collected_candidates: raw.collected_candidates,
    retained_candidates: raw.retained_candidates,
    duplicates_dropped: raw.duplicates_dropped,
    partial: raw.partial,
    source_failures: raw.source_failures
      .filter(isSourceFailure)
      .map((failure) => ({
        source: failure.source,
        message: failure.message,
      })),
  };
}

function isSourceFailure(
  value: unknown,
): value is { source: ResearchLandscapeSource; message: string } {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as { source?: unknown }).source === "string"
    && DEFAULT_RESEARCH_LANDSCAPE_SOURCES.includes(
      (value as { source: ResearchLandscapeSource }).source,
    )
    && typeof (value as { message?: unknown }).message === "string",
  );
}
