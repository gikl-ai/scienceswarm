/**
 * Second Brain — Dream Cycle State
 *
 * Tracks dream cycle state so it knows what's been processed.
 * State persisted at {brain.root}/state/dream-state.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { BrainConfig } from "./types";

// ── Types ─────────────────────────────────────────────

export interface EnrichmentTarget {
  type: "paper" | "author" | "concept" | "method";
  identifier: string; // title, name, DOI, arXiv ID
  brainPath?: string; // existing brain page if known
  priority: "high" | "medium" | "low";
}

export interface DreamState {
  lastFullRun: string | null; // ISO timestamp
  lastCitationGraphUpdate: string | null;
  lastClusteringRun: string | null; // ISO timestamp for original clustering
  processedEventIds: string[]; // Event timestamps already swept
  enrichmentQueue: EnrichmentTarget[]; // Targets queued for next run
}

// ── Default State ─────────────────────────────────────

function defaultState(): DreamState {
  return {
    lastFullRun: null,
    lastCitationGraphUpdate: null,
    lastClusteringRun: null,
    processedEventIds: [],
    enrichmentQueue: [],
  };
}

// ── Persistence ───────────────────────────────────────

function statePath(config: BrainConfig): string {
  return join(config.root, "state", "dream-state.json");
}

/**
 * Read dream cycle state from disk. Returns default state if not found.
 */
export function readDreamState(config: BrainConfig): DreamState {
  const path = statePath(config);
  if (!existsSync(path)) return defaultState();

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DreamState>;
    return {
      lastFullRun: parsed.lastFullRun ?? null,
      lastCitationGraphUpdate: parsed.lastCitationGraphUpdate ?? null,
      lastClusteringRun: parsed.lastClusteringRun ?? null,
      processedEventIds: parsed.processedEventIds ?? [],
      enrichmentQueue: parsed.enrichmentQueue ?? [],
    };
  } catch {
    return defaultState();
  }
}

/**
 * Write dream cycle state to disk.
 */
export function writeDreamState(
  config: BrainConfig,
  state: DreamState,
): void {
  const path = statePath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Add targets to the enrichment queue (deduplicating by identifier).
 */
export function enqueueTargets(
  state: DreamState,
  targets: EnrichmentTarget[],
): DreamState {
  const existing = new Set(state.enrichmentQueue.map((t) => t.identifier));
  const newTargets = targets.filter((t) => !existing.has(t.identifier));
  return {
    ...state,
    enrichmentQueue: [...state.enrichmentQueue, ...newTargets],
  };
}

/**
 * Mark event timestamps as processed.
 */
export function markEventsProcessed(
  state: DreamState,
  eventTimestamps: string[],
): DreamState {
  const existing = new Set(state.processedEventIds);
  for (const ts of eventTimestamps) {
    existing.add(ts);
  }
  // Keep only the most recent 500 event IDs to avoid unbounded growth
  const all = Array.from(existing);
  const trimmed = all.length > 500 ? all.slice(all.length - 500) : all;
  return { ...state, processedEventIds: trimmed };
}
