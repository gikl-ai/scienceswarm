export interface OpenAIModelOption {
  id: string;
  label: string;
  helper: string;
}

export const DEFAULT_OPENAI_MODEL = "gpt-5.4";

export const SUPPORTED_OPENAI_MODEL_OPTIONS: OpenAIModelOption[] = [
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    helper: "Highest-quality default for complex reasoning and OpenClaw work.",
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    helper: "Faster, lower-cost GPT-5.4-series option for lighter workloads.",
  },
];

export function stripOpenAIPrefix(model: string | null | undefined): string {
  const trimmed = model?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.startsWith("openai/") ? trimmed.slice("openai/".length) : trimmed;
}

export function resolveOpenAIModel(model: string | null | undefined): string {
  return stripOpenAIPrefix(model) || DEFAULT_OPENAI_MODEL;
}

export function isSupportedOpenAIModel(model: string | null | undefined): boolean {
  const normalized = stripOpenAIPrefix(model);
  return SUPPORTED_OPENAI_MODEL_OPTIONS.some((option) => option.id === normalized);
}

export function getSelectableOpenAIModelOptions(
  currentModel: string | null | undefined,
): OpenAIModelOption[] {
  const normalized = stripOpenAIPrefix(currentModel);
  if (!normalized || isSupportedOpenAIModel(normalized)) {
    return SUPPORTED_OPENAI_MODEL_OPTIONS;
  }

  return [
    {
      id: normalized,
      label: `${normalized} (current custom model)`,
      helper: "Saved custom or legacy value. Switch to a supported model below if needed.",
    },
    ...SUPPORTED_OPENAI_MODEL_OPTIONS,
  ];
}
