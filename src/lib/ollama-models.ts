import { OLLAMA_RECOMMENDED_MODEL_ALIASES } from "@/lib/ollama-constants";

function stripProviderPrefix(model: string): string {
  return model.trim().replace(/^(openai|ollama)\//, "");
}

function hasExplicitTag(model: string): boolean {
  return stripProviderPrefix(model).includes(":");
}

function isLatestAliasPair(left: string, right: string): boolean {
  return (
    (!hasExplicitTag(left) && right === `${left}:latest`)
    || (!hasExplicitTag(right) && left === `${right}:latest`)
  );
}

export function normalizeOllamaModelName(model: string): string {
  return stripProviderPrefix(model);
}

export function ollamaModelsMatch(
  configuredModel: string,
  availableModel: string,
): boolean {
  const configured = normalizeOllamaModelName(configuredModel);
  const available = normalizeOllamaModelName(availableModel);
  if (!configured || !available) return false;
  return configured === available || isLatestAliasPair(configured, available);
}

export function normalizeInstalledOllamaModels(models: string[]): string[] {
  const normalized: string[] = [];

  for (const rawModel of models) {
    const model = normalizeOllamaModelName(rawModel);
    if (!model) continue;
    if (normalized.includes(model)) continue;

    if (!hasExplicitTag(model)) {
      if (normalized.includes(`${model}:latest`)) {
        continue;
      }
      normalized.push(model);
      continue;
    }

    if (model.endsWith(":latest")) {
      const baseModel = model.slice(0, -":latest".length);
      const baseOnlyIndex = normalized.findIndex((existing) => existing === baseModel);
      if (baseOnlyIndex >= 0) {
        normalized.splice(baseOnlyIndex, 1, model);
        continue;
      }
    }

    normalized.push(model);
  }

  return normalized;
}

export function hasRecommendedOllamaModel(models: string[]): boolean {
  return models.some((model) =>
    OLLAMA_RECOMMENDED_MODEL_ALIASES.some((recommendedModel) =>
      ollamaModelsMatch(recommendedModel, model),
    ),
  );
}
