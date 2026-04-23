/**
 * GET/POST /api/brain/morning-brief
 *
 * Research-aware morning briefing.
 * GET ?project=<slug>  — Returns MorningBrief for a specific project
 * GET (no params)      — Returns MorningBrief across all active projects
 * POST { projects, format? } — Returns formatted brief
 */

import {
  buildMorningBrief,
  formatTelegramBrief,
} from "@/brain/research-briefing";
import { enrichBriefingWithActions } from "@/brain/briefing-actions";
import { isLocalRequest } from "@/lib/local-guard";
import { getBrainConfig, getLLMClient, isErrorResponse } from "../_shared";
import type { LLMClient } from "@/brain/llm";
import type { BrainConfig, MorningBrief } from "@/brain/types";

const MORNING_BRIEF_CACHE_TTL_MS = 5 * 60 * 1000;
const MORNING_BRIEF_STALE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MORNING_BRIEF_TIMEOUT_MS = 25_000;

class MorningBriefTimeoutError extends Error {
  constructor(ms: number) {
    super(`Morning brief generation exceeded ${ms}ms`);
    this.name = "MorningBriefTimeoutError";
  }
}

class MorningBriefLLMProviderError extends Error {
  constructor(err: unknown) {
    super(
      err instanceof Error ? err.message : "LLM provider unavailable.",
      err instanceof Error ? { cause: err } : undefined,
    );
    this.name = "MorningBriefLLMProviderError";
  }
}

interface MorningBriefCacheEntry {
  brief: MorningBrief;
  generatedAtMs: number;
}

type BriefStatus = "generated" | "cached" | "stale" | "degraded";

interface MorningBriefResult {
  brief: MorningBrief;
  status: BriefStatus;
}

const briefCache = new Map<string, MorningBriefCacheEntry>();
const inFlightBriefs = new Map<string, Promise<MorningBrief>>();

function getGenerationTimeoutMs(): number {
  const raw = process.env.SCIENCESWARM_MORNING_BRIEF_TIMEOUT_MS;
  if (!raw) return DEFAULT_MORNING_BRIEF_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MORNING_BRIEF_TIMEOUT_MS;
  }
  return parsed;
}

function briefCacheKey(config: BrainConfig, project?: string): string {
  return `${config.root}::${project ?? "__all__"}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MorningBriefTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function getCachedBrief(
  key: string,
  maxAgeMs: number,
): MorningBriefCacheEntry | null {
  const cached = briefCache.get(key);
  if (!cached) return null;
  const ageMs = Date.now() - cached.generatedAtMs;
  if (ageMs > MORNING_BRIEF_STALE_TTL_MS) {
    briefCache.delete(key);
    return null;
  }
  if (ageMs > maxAgeMs) return null;
  return cached;
}

function startBriefGeneration(
  key: string,
  config: BrainConfig,
  llm: LLMClient,
  project: string | undefined,
): Promise<MorningBrief> {
  const existing = inFlightBriefs.get(key);
  if (existing) return existing;

  const generation = buildMorningBrief(config, llm, {
    project,
    includeAllProjects: !project,
  })
    .then((brief) => {
      briefCache.set(key, { brief, generatedAtMs: Date.now() });
      return brief;
    })
    .finally(() => {
      inFlightBriefs.delete(key);
    });

  // If the route returns a degraded response before the background
  // generation settles, keep late failures from becoming unhandled rejections.
  generation.catch(() => undefined);
  inFlightBriefs.set(key, generation);
  return generation;
}

function withLLMProviderErrorContext(llm: LLMClient): LLMClient {
  return {
    async complete(call) {
      try {
        return await llm.complete(call);
      } catch (err) {
        throw new MorningBriefLLMProviderError(err);
      }
    },
  };
}

function buildDegradedBrief(project?: string): MorningBrief {
  const now = new Date();
  const projectNote = project ? ` for ${project}` : "";
  return {
    generatedAt: now.toISOString(),
    greeting: `Good ${now.getHours() < 12 ? "morning" : now.getHours() < 17 ? "afternoon" : "evening"}. Your full research briefing${projectNote} is still warming up.`,
    topMatters: [
      {
        summary: "Full morning brief is still being generated",
        whyItMatters:
          "ScienceSwarm is keeping the dashboard responsive while the heavier synthesis finishes in the background.",
        evidence: [],
        urgency: "awareness",
      },
    ],
    contradictions: [],
    frontier: [],
    staleThreads: [],
    openQuestions: [],
    nextMove: {
      recommendation:
        "Check the project workspace now, then refresh the morning brief shortly for the synthesized version.",
      reasoning:
        "The route hit its latency budget before the full multi-step brief completed.",
      assumptions: ["The research brain configuration is available."],
      missingEvidence: ["Full contradiction scan", "Full synthesis pass"],
    },
    stats: {
      brainPages: 0,
      newPagesYesterday: 0,
      capturesYesterday: 0,
      enrichmentsYesterday: 0,
    },
  };
}

async function resolveMorningBrief(
  config: BrainConfig,
  llm: LLMClient,
  project: string | undefined,
): Promise<MorningBriefResult> {
  const key = briefCacheKey(config, project);
  const fresh = getCachedBrief(key, MORNING_BRIEF_CACHE_TTL_MS);
  if (fresh) {
    return { brief: fresh.brief, status: "cached" };
  }

  const generation = startBriefGeneration(
    key,
    config,
    withLLMProviderErrorContext(llm),
    project,
  );

  try {
    const brief = await withTimeout(generation, getGenerationTimeoutMs());
    return { brief, status: "generated" };
  } catch (err) {
    const stale = getCachedBrief(key, MORNING_BRIEF_STALE_TTL_MS);
    if (stale) {
      return { brief: stale.brief, status: "stale" };
    }
    if (!(err instanceof MorningBriefTimeoutError)) {
      throw err;
    }
    return { brief: buildDegradedBrief(project), status: "degraded" };
  }
}

function jsonBrief({ brief, status }: MorningBriefResult): Response {
  return Response.json(brief, {
    headers: {
      "Cache-Control": "no-store",
      "X-ScienceSwarm-Brief-Status": status,
    },
  });
}

function llmUnavailableResponse(err: unknown): Response {
  const cause = err instanceof Error ? err.message : "LLM provider unavailable.";
  return Response.json(
    {
      error: "Morning brief generation requires a configured LLM provider.",
      code: "llm_unavailable",
      cause,
      nextAction:
        "Open /setup to configure the local model path or add a supported hosted provider key.",
    },
    { status: 503 },
  );
}

function isLLMProviderError(message: string): boolean {
  const normalized = message.toLowerCase();
  const providerCredential =
    /\b(?:openai|anthropic|gemini|ollama)[_ -]?api[_ -]?key\b/.test(
      normalized,
    );
  const providerAuthOrQuota =
    /\b(?:openai|anthropic|gemini)\s+(?:api\s+)?(?:quota|rate[_ -]?limit)\b/.test(
      normalized,
    );
  const localProviderFailure =
    /\bollama\s+(?:chat|stream|pull|request)\s+failed\b/.test(normalized) ||
    /\bollama\b.{0,80}\b(?:model host|no response body|connection refused|unavailable)\b/.test(
      normalized,
    );

  return (
    normalized.includes("llm provider") ||
    normalized.includes("model provider") ||
    normalized.includes("model host") ||
    providerCredential ||
    providerAuthOrQuota ||
    localProviderFailure
  );
}

function generationFailedResponse(err: unknown): Response {
  const message =
    err instanceof Error ? err.message : "Morning brief generation failed";
  if (err instanceof MorningBriefLLMProviderError || isLLMProviderError(message)) {
    return llmUnavailableResponse(err);
  }
  return Response.json({ error: message }, { status: 500 });
}

export async function GET(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;
  let llm: LLMClient;
  try {
    llm = getLLMClient(config);
  } catch (err) {
    return llmUnavailableResponse(err);
  }

  const url = new URL(request.url);
  const project = url.searchParams.get("project") ?? undefined;

  try {
    return jsonBrief(await resolveMorningBrief(config, llm, project));
  } catch (err) {
    return generationFailedResponse(err);
  }
}

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;
  let llm: LLMClient;
  try {
    llm = getLLMClient(config);
  } catch (err) {
    return llmUnavailableResponse(err);
  }

  let body: {
    projects?: string[];
    format?: "full" | "standup" | "telegram" | "telegram-actions";
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const format = body.format ?? "full";
  const projects = body.projects ?? [];

  let result: MorningBriefResult;
  try {
    result = await resolveMorningBrief(config, llm, projects[0]);
  } catch (err) {
    return generationFailedResponse(err);
  }
  const brief = result.brief;

  if (format === "telegram") {
    return new Response(formatTelegramBrief(brief), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-ScienceSwarm-Brief-Status": result.status,
      },
    });
  }

  if (format === "telegram-actions") {
    return Response.json(enrichBriefingWithActions(brief), {
      headers: {
        "Cache-Control": "no-store",
        "X-ScienceSwarm-Brief-Status": result.status,
      },
    });
  }

  if (format === "standup") {
    // Standup format: compact JSON with only the essentials
    return Response.json({
      generatedAt: brief.generatedAt,
      topMatters: brief.topMatters.map((m) => ({
        summary: m.summary,
        urgency: m.urgency,
      })),
      contradictions: brief.contradictions.length,
      frontier: brief.frontier.length,
      nextMove: brief.nextMove.recommendation,
      stats: brief.stats,
    }, {
      headers: {
        "Cache-Control": "no-store",
        "X-ScienceSwarm-Brief-Status": result.status,
      },
    });
  }

  return jsonBrief(result);
}
