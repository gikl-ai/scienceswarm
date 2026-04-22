import { readFileSync } from "node:fs";

import { resolveBrainFile } from "../template-paths";
import {
  type BrainPresetId,
  normalizeBrainPreset,
} from "./types";

export interface BrainPresetDefinition {
  id: BrainPresetId;
  brainTemplate: string;
  resolverTemplate: string;
  directories: string[];
}

const PRESET_ASSET_DIRECTORY: Record<BrainPresetId, string> = {
  generic_scientist: "generic-scientist",
  scientific_research: "scientific-research",
};

const PRESET_DIRECTORIES: Record<BrainPresetId, string[]> = {
  generic_scientist: [
    "people",
    "projects",
    "concepts",
    "papers",
    "experiments",
    "hypotheses",
    "protocols",
    "datasets",
    "conferences",
    "presentations",
    "meetings",
    "labs",
    "funders",
    "instruments",
    "ideas",
    "writing",
    "originals",
    "inbox",
    "sources",
    "archive",
  ],
  scientific_research: [
    "papers",
    "topics",
    "surveys",
    "methods",
    "hypotheses",
    "originals",
    "projects",
    "packets",
    "journals",
    "datasets",
    "people",
    "sources",
    "inbox",
    "archive",
  ],
};

function readPresetAsset(
  presetId: BrainPresetId,
  fileName: "BRAIN.md" | "RESOLVER.md",
): string {
  return readFileSync(
    resolveBrainFile("presets", PRESET_ASSET_DIRECTORY[presetId], fileName),
    "utf-8",
  );
}

export function loadBrainPreset(presetId: unknown): BrainPresetDefinition {
  const normalized = normalizeBrainPreset(presetId);
  return {
    id: normalized,
    brainTemplate: readPresetAsset(normalized, "BRAIN.md"),
    resolverTemplate: readPresetAsset(normalized, "RESOLVER.md"),
    directories: [...PRESET_DIRECTORIES[normalized]],
  };
}
