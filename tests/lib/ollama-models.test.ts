import { describe, expect, it } from "vitest";

import {
  hasRecommendedOllamaModel,
  normalizeInstalledOllamaModels,
  ollamaModelsMatch,
} from "@/lib/ollama-models";

describe("ollama model helpers", () => {
  it("treats only exact and :latest aliases as the same model", () => {
    expect(ollamaModelsMatch("gemma4", "gemma4")).toBe(true);
    expect(ollamaModelsMatch("gemma4", "gemma4:latest")).toBe(true);
    expect(ollamaModelsMatch("gemma4:latest", "gemma4")).toBe(true);
    expect(ollamaModelsMatch("gemma4", "gemma4:26b")).toBe(false);
    expect(ollamaModelsMatch("gemma4:26b", "gemma4")).toBe(false);
  });

  it("only collapses bare models into their :latest alias", () => {
    expect(
      normalizeInstalledOllamaModels([
        "gemma4",
        "gemma4:latest",
        "gemma4:26b",
        "qwen3:4b",
      ]),
    ).toEqual([
      "gemma4:latest",
      "gemma4:26b",
      "qwen3:4b",
    ]);
  });

  it("does not treat gemma4:26b as the recommended default model", () => {
    expect(hasRecommendedOllamaModel(["gemma4:latest"])).toBe(true);
    expect(hasRecommendedOllamaModel(["gemma4:26b"])).toBe(false);
  });
});
