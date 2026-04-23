import { describe, expect, it } from "vitest";

import {
  buildLocalOpenClawAllowedModels,
  normalizeOpenClawModel,
} from "@/lib/openclaw/model-config";

describe("OpenClaw model config", () => {
  it("normalizes saved local models to the Ollama provider", () => {
    expect(normalizeOpenClawModel("gemma4:latest", "local")).toBe("ollama/gemma4:latest");
    expect(normalizeOpenClawModel("openai/gemma4:latest", "local")).toBe(
      "ollama/gemma4:latest",
    );
  });

  it("limits local allowed models to Ollama aliases so subagents cannot drift to OpenAI", () => {
    expect(buildLocalOpenClawAllowedModels("ollama/gemma4:latest")).toEqual({
      "ollama/gemma4:latest": {},
      "ollama/gemma4": {},
    });
  });
});
