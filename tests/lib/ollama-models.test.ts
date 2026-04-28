import { describe, expect, it } from "vitest";

import { OLLAMA_LOCAL_MODEL_OPTIONS } from "@/lib/ollama-constants";
import {
  hasRecommendedOllamaModel,
  normalizeInstalledOllamaModels,
  ollamaModelsMatch,
} from "@/lib/ollama-models";

describe("ollama model helpers", () => {
  it("treats only exact and :latest aliases as the same model", () => {
    expect(ollamaModelsMatch("gemma4", "gemma4")).toBe(true);
    expect(ollamaModelsMatch("gemma4", "gemma4:latest")).toBe(true);
    expect(ollamaModelsMatch("gemma4", "gemma4:e4b")).toBe(false);
    expect(ollamaModelsMatch("gemma4:e4b", "gemma4")).toBe(false);
    expect(ollamaModelsMatch("gemma4", "gemma4:26b")).toBe(false);
    expect(ollamaModelsMatch("gemma4:26b", "gemma4")).toBe(false);
  });

  it("only collapses bare models into their :latest alias", () => {
    expect(
      normalizeInstalledOllamaModels([
        "gemma4",
        "gemma4:e4b",
        "gemma4:26b",
        "qwen3:4b",
      ]),
    ).toEqual([
      "gemma4",
      "gemma4:e4b",
      "gemma4:26b",
      "qwen3:4b",
    ]);
  });

  it("does not treat gemma4:26b as the recommended default model", () => {
    expect(hasRecommendedOllamaModel(["gemma4:e4b"])).toBe(true);
    expect(hasRecommendedOllamaModel(["gemma4:e2b"])).toBe(true);
    expect(hasRecommendedOllamaModel(["gemma4:latest"])).toBe(true);
    expect(hasRecommendedOllamaModel(["gemma4:26b"])).toBe(false);
  });

  it("keeps download size guidance on selectable local models", () => {
    expect(
      OLLAMA_LOCAL_MODEL_OPTIONS.map(({ value, downloadSizeLabel }) => [
        value,
        downloadSizeLabel,
      ]),
    ).toEqual([
      ["gemma4:e4b", "9.6GB"],
      ["gemma4:e2b", "7.2GB"],
      ["gemma4:26b", "18GB"],
    ]);
  });
});
