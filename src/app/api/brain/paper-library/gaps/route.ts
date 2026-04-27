import { z } from "zod";
import {
  GapSuggestionStateSchema,
  PaperLibraryGapActionRequestSchema,
  ProjectSlugSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";
import {
  getOrBuildPaperLibraryGaps,
  updatePaperLibraryGapSuggestion,
  windowPaperLibraryGaps,
} from "@/lib/paper-library/gaps";
import {
  paperLibraryBadRequest,
  normalizeStudyBody,
  readJsonBody,
  readStudyOrProjectParam,
  requirePaperLibraryRequest,
} from "../_shared";

const BooleanQuerySchema = z.preprocess((value) => {
  if (value == null) return false;
  const text = String(value).trim().toLowerCase();
  if (text === "1" || text === "true" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "no") return false;
  return value;
}, z.boolean());

const GapsLookupRequestSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  state: GapSuggestionStateSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  refresh: BooleanQuerySchema,
});

export async function GET(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = GapsLookupRequestSchema.safeParse({
    project: readStudyOrProjectParam(url),
    scanId: url.searchParams.get("scanId"),
    state: url.searchParams.get("state") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    refresh: url.searchParams.get("refresh") ?? undefined,
  });
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const gaps = await getOrBuildPaperLibraryGaps({
      project: parsed.data.project,
      scanId: parsed.data.scanId,
      brainRoot: guard.brainRoot,
      refresh: parsed.data.refresh,
    });
    if (!gaps) {
      return Response.json(paperLibraryError("job_not_found", "Paper library scan not found."), { status: 404 });
    }
    return Response.json({
      ok: true,
      ...windowPaperLibraryGaps(gaps, {
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
        state: parsed.data.state,
      }),
    });
  } catch (error) {
    return paperLibraryBadRequest(error);
  }
}

export async function POST(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  try {
    const parsed = PaperLibraryGapActionRequestSchema.parse(normalizeStudyBody(await readJsonBody(request)));
    const suggestion = await updatePaperLibraryGapSuggestion({
      project: parsed.project,
      scanId: parsed.scanId,
      brainRoot: guard.brainRoot,
      suggestionId: parsed.suggestionId,
      action: parsed.action,
    });
    if (!suggestion) {
      return Response.json(paperLibraryError("suggestion_not_found", "Gap suggestion not found."), { status: 404 });
    }
    return Response.json({ ok: true, suggestion });
  } catch (error) {
    return paperLibraryBadRequest(error);
  }
}
