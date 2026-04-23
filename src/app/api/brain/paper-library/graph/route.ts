import { z } from "zod";
import {
  ProjectSlugSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";
import {
  getOrBuildPaperLibraryGraph,
  windowPaperLibraryGraph,
} from "@/lib/paper-library/graph";
import { paperLibraryBadRequest, requirePaperLibraryRequest } from "../_shared";

const BooleanQuerySchema = z.preprocess((value) => {
  if (value == null) return false;
  const text = String(value).trim().toLowerCase();
  if (text === "1" || text === "true" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "no") return false;
  return value;
}, z.boolean());

const GraphLookupRequestSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  focus: z.string().trim().min(1).optional(),
  refresh: BooleanQuerySchema,
});

export async function GET(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = GraphLookupRequestSchema.safeParse({
    project: url.searchParams.get("project"),
    scanId: url.searchParams.get("scanId"),
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    focus: url.searchParams.get("focus") ?? undefined,
    refresh: url.searchParams.get("refresh") ?? undefined,
  });
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const graph = await getOrBuildPaperLibraryGraph({
      project: parsed.data.project,
      scanId: parsed.data.scanId,
      brainRoot: guard.brainRoot,
      refresh: parsed.data.refresh,
    });
    if (!graph) {
      return Response.json(paperLibraryError("job_not_found", "Paper library scan not found."), { status: 404 });
    }
    return Response.json({
      ok: true,
      ...windowPaperLibraryGraph(graph, {
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
        focusNodeId: parsed.data.focus,
      }),
    });
  } catch (error) {
    return paperLibraryBadRequest(error);
  }
}
