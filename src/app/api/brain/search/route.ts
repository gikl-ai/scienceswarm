/**
 * GET /api/brain/search
 *
 * Search the brain wiki.
 * Query params: ?query=...&mode=grep|index|list|qmd&limit=10&detail=low|medium|high
 */

import { search } from "@/brain/search";
import {
  BrainSearchTimeoutError,
  isBrainBackendUnavailableError,
} from "@/brain/store";
import type { SearchDetail, SearchMode } from "@/brain/types";
import { toPublicBrainSlug } from "@/brain/public-slug";
import { apiError, getBrainConfig, isErrorResponse } from "../_shared";

const VALID_MODES = new Set(["grep", "index", "list", "qmd"]);
const VALID_DETAILS = new Set(["low", "medium", "high"]);

export async function GET(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? "";
  const modeParam = url.searchParams.get("mode") ?? "grep";
  const limitParam = url.searchParams.get("limit") ?? "10";
  const detailParam = url.searchParams.get("detail");

  if (!query && modeParam !== "list") {
    return Response.json(
      { error: "Missing required query parameter: query" },
      { status: 400 }
    );
  }

  if (!VALID_MODES.has(modeParam)) {
    return Response.json(
      { error: `Invalid mode: ${modeParam}. Must be one of: grep, index, list, qmd` },
      { status: 400 }
    );
  }

  if (detailParam !== null && !VALID_DETAILS.has(detailParam)) {
    return Response.json(
      { error: `Invalid detail: ${detailParam}. Must be one of: low, medium, high` },
      { status: 400 },
    );
  }

  const limit = Math.max(1, Math.min(100, parseInt(limitParam, 10) || 10));

  try {
    const results = await search(config, {
      query,
      mode: modeParam as SearchMode,
      limit,
      detail: detailParam as SearchDetail | undefined,
    });
    return Response.json(results.map(toPublicSearchResult));
  } catch (err) {
    if (err instanceof BrainSearchTimeoutError) {
      return apiError(503, {
        error: "Brain search timed out",
        code: "brain_search_timeout",
        cause: "The local gbrain search backend did not respond before the request deadline.",
        nextAction:
          "Retry once. If this repeats, run `npm run doctor` and check whether the local brain store is healthy.",
        docUrl: "/dashboard/settings",
      });
    }

    if (isBrainBackendUnavailableError(err)) {
      return apiError(503, {
        error: "Brain backend unavailable",
        code: "brain_backend_unavailable",
        cause: err instanceof Error ? err.message : undefined,
        nextAction:
          "Run `npm run doctor`, then reopen /dashboard/project to retry the local brain connection.",
        docUrl: "/dashboard/settings",
      });
    }

    const message = err instanceof Error ? err.message : "Search failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

type SearchApiResult = Awaited<ReturnType<typeof search>>[number];

function toPublicSearchResult(result: SearchApiResult): SearchApiResult {
  return {
    ...result,
    path: toPublicBrainSlug(result.path),
    compiledView: result.compiledView
      ? {
          ...result.compiledView,
          pagePath: toPublicBrainSlug(result.compiledView.pagePath),
        }
      : undefined,
  };
}
