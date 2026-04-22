import {
  readResearchLandscapeLastRun,
  runResearchLandscape,
} from "@/lib/research-packets";
import { isLocalRequest } from "@/lib/local-guard";
import { getBrainConfig, isErrorResponse } from "../_shared";

export async function GET(): Promise<Response> {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  return Response.json({
    lastRun: await readResearchLandscapeLastRun(configOrError.root),
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await runResearchLandscape({
      query: typeof body.query === "string" ? body.query : "",
      exactTitle: typeof body.exactTitle === "string"
        ? body.exactTitle
        : typeof body.exact_title === "string"
          ? body.exact_title
          : undefined,
      project: typeof body.project === "string" ? body.project : undefined,
      sources: Array.isArray(body.sources)
        ? body.sources.filter((source): source is "pubmed" | "arxiv" | "openalex" | "crossref" =>
          typeof source === "string"
            && ["pubmed", "arxiv", "openalex", "crossref"].includes(source))
        : undefined,
      perSourceLimit: typeof body.perSourceLimit === "number"
        ? body.perSourceLimit
        : typeof body.per_source_limit === "number"
          ? body.per_source_limit
          : undefined,
      retainedLimit: typeof body.retainedLimit === "number"
        ? body.retainedLimit
        : typeof body.retained_limit === "number"
          ? body.retained_limit
          : undefined,
      startYear: typeof body.startYear === "number"
        ? body.startYear
        : typeof body.start_year === "number"
          ? body.start_year
          : undefined,
      endYear: typeof body.endYear === "number"
        ? body.endYear
        : typeof body.end_year === "number"
          ? body.end_year
          : undefined,
      retryCount: typeof body.retryCount === "number"
        ? body.retryCount
        : typeof body.retry_count === "number"
          ? body.retry_count
          : undefined,
    }, {
      brainRoot: config.root,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "research landscape failed";
    const status = /required|startYear|safe bare slug/i.test(message) ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}
