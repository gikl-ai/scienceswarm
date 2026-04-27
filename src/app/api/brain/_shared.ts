/**
 * Second Brain API — Shared Utilities
 *
 * Common helpers for all /api/brain/* routes.
 * Loads config, creates LLM client, validates brain exists.
 */

import { loadBrainConfig } from "@/brain/config";
import { createLLMClient } from "@/brain/llm";
import type { BrainConfig } from "@/brain/types";
import type { LLMClient } from "@/brain/llm";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getScienceSwarmBrainRoot,
  resolveConfiguredPath,
} from "@/lib/scienceswarm-paths";

export interface ApiErrorBody {
  error: string;
  code: string;
  cause?: string;
  nextAction?: string;
  docUrl?: string;
  details?: Record<string, unknown>;
}

export function apiError(
  status: number,
  body: ApiErrorBody,
): Response {
  return Response.json(body, { status });
}

function expectedBrainRoot(): string {
  return resolveConfiguredPath(process.env.BRAIN_ROOT) ?? getScienceSwarmBrainRoot();
}

function brainNotInitializedCause(
  rootExists: boolean,
  brainMdExists: boolean,
): string {
  if (!rootExists) {
    return "The configured brain root does not exist.";
  }
  if (!brainMdExists) {
    return "The configured brain root exists but BRAIN.md is not present.";
  }
  return "The brain root and BRAIN.md exist, but the configuration could not be loaded.";
}

function brainNotInitializedResponse(): Response {
  const brainRoot = expectedBrainRoot();
  const rootExists = existsSync(brainRoot);
  const brainMdPath = join(brainRoot, "BRAIN.md");
  const brainMdExists = existsSync(brainMdPath);

  return apiError(503, {
    error: "No research brain is initialized yet.",
    code: "brain_not_initialized",
    cause: brainNotInitializedCause(rootExists, brainMdExists),
    nextAction:
      "Open /setup to connect OpenClaw and initialize the local store, then import your first corpus from /dashboard/study.",
    docUrl: "/setup",
    details: {
      rootExists,
      brainMdExists,
    },
  });
}

/**
 * Load brain config or return a 503 error response.
 * Every brain route should call this first.
 */
export function getBrainConfig(): BrainConfig | Response {
  const config = loadBrainConfig();
  if (!config) {
    return brainNotInitializedResponse();
  }
  return config;
}

/**
 * Create an LLM client from a brain config.
 */
export function getLLMClient(config: BrainConfig): LLMClient {
  return createLLMClient(config);
}

/**
 * Type guard: check whether getBrainConfig() returned an error Response.
 */
export function isErrorResponse(
  result: BrainConfig | Response
): result is Response {
  return result instanceof Response;
}
