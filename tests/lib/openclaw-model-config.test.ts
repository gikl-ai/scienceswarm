import { describe, expect, it } from "vitest";

import {
  buildLocalOpenClawAllowedModels,
  normalizeOpenClawModel,
} from "@/lib/openclaw/model-config";

describe("OpenClaw model config", () => {
  it("normalizes saved local models to the Ollama provider", () => {
    expect(normalizeOpenClawModel("gemma4:e4b", "local")).toBe("ollama/gemma4:e4b");
    expect(normalizeOpenClawModel("openai/gemma4:e4b", "local")).toBe(
      "ollama/gemma4:e4b",
    );
  });

  it("limits local allowed models to Ollama aliases so subagents cannot drift to OpenAI", () => {
    expect(buildLocalOpenClawAllowedModels("ollama/gemma4:e4b")).toEqual({
      "ollama/gemma4:e4b": {},
      "ollama/gemma4": {},
      "ollama/gemma4:latest": {},
    });
  });
});
