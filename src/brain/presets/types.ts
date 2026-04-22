export const BRAIN_PRESET_IDS = [
  "generic_scientist",
  "scientific_research",
] as const;

export type BrainPresetId = (typeof BRAIN_PRESET_IDS)[number];

export const DEFAULT_BRAIN_PRESET: BrainPresetId = "scientific_research";
export const BRAIN_PRESET_ENV_KEY = "BRAIN_PRESET";

export interface BrainPresetOption {
  id: BrainPresetId;
  label: string;
  description: string;
}

export const BRAIN_PRESET_OPTIONS: readonly BrainPresetOption[] = [
  {
    id: "scientific_research",
    label: "Scientific Research",
    description:
      "Research-first brain with papers, topics, surveys, methods, packets, and journals.",
  },
  {
    id: "generic_scientist",
    label: "Generic Scientist",
    description:
      "Broader scientist default with a more general concept/project schema.",
  },
] as const;

export function isBrainPresetId(value: unknown): value is BrainPresetId {
  return typeof value === "string" && BRAIN_PRESET_IDS.includes(value as BrainPresetId);
}

export function normalizeBrainPreset(value: unknown): BrainPresetId {
  return isBrainPresetId(value) ? value : DEFAULT_BRAIN_PRESET;
}
