/**
 * Second Brain — Cost Tracking
 *
 * Tracks per-ingest and monthly token costs.
 * Writes to events.jsonl and surfaces in home.md/guide output.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { BrainConfig, IngestCost, BrainEvent } from "./types";

/**
 * Aggregate cost across multiple LLM calls in a single operation.
 */
export function aggregateCosts(costs: IngestCost[]): IngestCost {
  const total: IngestCost = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
    model: costs.length > 0 ? costs[0].model : "unknown",
  };

  for (const c of costs) {
    total.inputTokens += c.inputTokens;
    total.outputTokens += c.outputTokens;
    total.estimatedUsd += c.estimatedUsd;
  }

  // Use the most expensive model as the label
  if (costs.length > 1) {
    total.model = "mixed";
  }

  return total;
}

/**
 * Get the total cost for the current month from events.jsonl.
 */
export function getMonthCost(config: BrainConfig): number {
  const eventsPath = join(config.root, "wiki/events.jsonl");
  if (!existsSync(eventsPath)) return 0;

  const now = new Date();
  const monthPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  const content = readFileSync(eventsPath, "utf-8").trim();
  if (!content) return 0;

  let total = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event: BrainEvent = JSON.parse(line);
      if (event.ts.startsWith(monthPrefix) && event.cost) {
        total += event.cost.estimatedUsd;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return Math.round(total * 100) / 100;
}

/**
 * Check if the monthly budget has been exceeded.
 */
export function isBudgetExceeded(config: BrainConfig): boolean {
  return getMonthCost(config) >= config.paperWatchBudget;
}

/**
 * Append a brain event to events.jsonl.
 */
export function logEvent(config: BrainConfig, event: BrainEvent): void {
  const eventsDir = join(config.root, "wiki");
  if (!existsSync(eventsDir)) {
    mkdirSync(eventsDir, { recursive: true });
  }
  const eventsPath = join(eventsDir, "events.jsonl");
  appendFileSync(eventsPath, JSON.stringify(event) + "\n");
}

/**
 * Get recent events (for morning briefing).
 */
export function getRecentEvents(
  config: BrainConfig,
  since?: Date,
  limit = 20
): BrainEvent[] {
  const eventsPath = join(config.root, "wiki/events.jsonl");
  if (!existsSync(eventsPath)) return [];

  const content = readFileSync(eventsPath, "utf-8").trim();
  if (!content) return [];

  const sinceStr = since?.toISOString() ?? "";
  const events: BrainEvent[] = [];

  const lines = content.split("\n");
  // Read from end for recency
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const event: BrainEvent = JSON.parse(line);
      if (!sinceStr || event.ts >= sinceStr) {
        events.push(event);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}
