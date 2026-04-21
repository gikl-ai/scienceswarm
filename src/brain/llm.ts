/**
 * Second Brain — LLM Abstraction
 *
 * Thin wrapper around the configured model provider for brain operations.
 * Supports model tiering for hosted models and the local Ollama path used by
 * the default ScienceSwarm setup.
 * Mockable for testing via dependency injection.
 */

import type { BrainConfig, IngestCost } from "./types";
import { getOpenAIClient } from "@/lib/openai-client";
import { assertStrictLocalDestinationAllowed } from "@/lib/runtime/strict-local-policy";
import {
  completeLocal,
  getLocalModel,
  isLocalProviderConfigured,
} from "@/lib/local-llm";

export interface LLMCall {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  cost: IngestCost;
}

export interface LLMClient {
  complete(call: LLMCall): Promise<LLMResponse>;
}

/**
 * Production LLM client using the configured ScienceSwarm model path.
 * Tracks token usage for cost reporting.
 */
export function createLLMClient(config: BrainConfig): LLMClient {
  if (isLocalProviderConfigured()) {
    return createLocalLLMClient();
  }
  return createOpenAILLMClient(config);
}

function createLocalLLMClient(): LLMClient {
  return {
    async complete(call: LLMCall): Promise<LLMResponse> {
      const model = getLocalModel();
      assertStrictLocalDestinationAllowed({
        destination: "local-ollama",
        dataClass: "model-prompt",
        feature: "brain LLM completion",
        privacy: "local-network",
      });
      const content = await completeLocal(
        [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
        model,
      );

      return {
        content,
        cost: {
          inputTokens: estimateTokenCount(`${call.system}\n${call.user}`),
          outputTokens: estimateTokenCount(content),
          estimatedUsd: 0,
          model,
        },
      };
    },
  };
}

function createOpenAILLMClient(config: BrainConfig): LLMClient {
  return {
    async complete(call: LLMCall): Promise<LLMResponse> {
      const model = call.model ?? config.synthesisModel;
      assertStrictLocalDestinationAllowed({
        destination: "openai",
        dataClass: "model-prompt",
        feature: "brain LLM completion",
        privacy: "hosted",
      });
      const response = await getOpenAIClient().chat.completions.create({
        model,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
        max_tokens: call.maxTokens,
      });

      const usage = response.usage;
      const inputTokens = usage?.prompt_tokens ?? 0;
      const outputTokens = usage?.completion_tokens ?? 0;

      return {
        content: response.choices[0]?.message?.content ?? "",
        cost: {
          inputTokens,
          outputTokens,
          estimatedUsd: estimateCost(model, inputTokens, outputTokens),
          model,
        },
      };
    },
  };
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate USD cost from token counts and model.
 * Rough pricing — updated as models change.
 */
function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  // Per-million-token pricing (approximate)
  const pricing: Record<string, { input: number; output: number }> = {
    "gpt-4.1": { input: 2.0, output: 8.0 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4 },
    "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
    "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
  };

  const rates = pricing[model] ?? { input: 2.0, output: 8.0 };
  return (
    (inputTokens * rates.input) / 1_000_000 +
    (outputTokens * rates.output) / 1_000_000
  );
}
