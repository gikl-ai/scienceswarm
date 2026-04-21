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

export async function GET(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;
  const llm = getLLMClient(config);

  const url = new URL(request.url);
  const project = url.searchParams.get("project") ?? undefined;

  try {
    const brief = await buildMorningBrief(config, llm, {
      project,
      includeAllProjects: !project,
    });
    return Response.json(brief);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Morning brief generation failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;
  const llm = getLLMClient(config);

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

  try {
    // Build brief for the first project if specified, or all projects
    const brief = await buildMorningBrief(config, llm, {
      project: projects[0],
      includeAllProjects: projects.length === 0,
    });

    if (format === "telegram") {
      return new Response(formatTelegramBrief(brief), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (format === "telegram-actions") {
      return Response.json(enrichBriefingWithActions(brief));
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
      });
    }

    return Response.json(brief);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Morning brief generation failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
