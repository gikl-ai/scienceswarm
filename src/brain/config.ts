/**
 * Second Brain — Configuration
 *
 * Discovers brain root from BRAIN_ROOT env var or the default ScienceSwarm
 * data directory.
 * Reads BRAIN.md for researcher preferences.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getScienceSwarmBrainRoot, resolveConfiguredPath } from "@/lib/scienceswarm-paths";
import { type BrainConfig, DEFAULT_BRAIN_CONFIG } from "./types";

/**
 * Resolve the brain root directory from BRAIN_ROOT env var, falling back to
 * ~/.scienceswarm/brain (or SCIENCESWARM_DIR/brain).
 * Returns null if not configured (brain features disabled).
 */
export function resolveBrainRoot(): string | null {
  const root = resolveConfiguredPath(process.env.BRAIN_ROOT) ?? getScienceSwarmBrainRoot();
  if (!existsSync(root)) return null;
  return root;
}

/**
 * Load brain configuration from BRAIN_ROOT env + BRAIN.md preferences.
 * Returns null if no brain is configured.
 */
export function loadBrainConfig(): BrainConfig | null {
  const root = resolveBrainRoot();
  if (!root) return null;

  const config: BrainConfig = { root, ...DEFAULT_BRAIN_CONFIG };

  const brainMdPath = join(root, "BRAIN.md");
  if (!existsSync(brainMdPath)) return config;

  try {
    const content = readFileSync(brainMdPath, "utf-8");
    const preferences = parsePreferences(content);

    if (preferences.serendipity_rate !== undefined) {
      config.serendipityRate = preferences.serendipity_rate;
    }
    if (preferences.paper_watch_budget !== undefined) {
      config.paperWatchBudget = preferences.paper_watch_budget;
    }
    if (preferences.ripple_cap !== undefined) {
      config.rippleCap = preferences.ripple_cap;
    }
    if (preferences.extraction_model) {
      config.extractionModel = preferences.extraction_model;
    }
    if (preferences.synthesis_model) {
      config.synthesisModel = preferences.synthesis_model;
    }
  } catch {
    // BRAIN.md exists but can't be parsed — use defaults
  }

  return config;
}

/**
 * Check whether a brain exists at the configured root.
 */
export function brainExists(): boolean {
  const root = resolveBrainRoot();
  if (!root) return false;
  return existsSync(join(root, "BRAIN.md"));
}

// ── Internal ───────────────────────────────────────────

interface BrainPreferences {
  serendipity_rate?: number;
  paper_watch_budget?: number;
  ripple_cap?: number;
  extraction_model?: string;
  synthesis_model?: string;
}

/**
 * Parse the ## Preferences section from BRAIN.md.
 * Looks for key: value lines in a simple YAML-like format.
 */
function parsePreferences(content: string): BrainPreferences {
  const prefs: BrainPreferences = {};
  const prefSection = content.match(
    /## Preferences\n([\s\S]*?)(?=\n## |\n---|$)/
  );
  if (!prefSection) return prefs;

  const lines = prefSection[1].split("\n");
  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+?)(?:\s*#.*)?$/);
    if (!match) continue;
    const [, key, value] = match;
    const trimmed = value.trim();

    switch (key) {
      case "serendipity_rate": {
        const rate = parseFloat(trimmed);
        if (!Number.isNaN(rate)) prefs.serendipity_rate = rate;
        break;
      }
      case "paper_watch_budget": {
        const budget = parseFloat(trimmed);
        if (!Number.isNaN(budget)) prefs.paper_watch_budget = budget;
        break;
      }
      case "ripple_cap": {
        const cap = parseInt(trimmed, 10);
        if (!Number.isNaN(cap)) prefs.ripple_cap = cap;
        break;
      }
      case "extraction_model":
        prefs.extraction_model = trimmed;
        break;
      case "synthesis_model":
        prefs.synthesis_model = trimmed;
        break;
    }
  }

  return prefs;
}
