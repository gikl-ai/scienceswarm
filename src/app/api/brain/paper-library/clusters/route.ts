import { z } from "zod";
import {
  ProjectSlugSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";
import {
  getOrBuildPaperLibraryClusters,
  windowPaperLibraryClusters,
} from "@/lib/paper-library/clustering";
import { paperLibraryBadRequest, readStudyOrProjectParam, requirePaperLibraryRequest } from "../_shared";

const BooleanQuerySchema = z.preprocess((value) => {
  if (value == null) return false;
  const text = String(value).trim().toLowerCase();
  if (text === "1" || text === "true" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "no") return false;
  return value;
}, z.boolean());

const ClustersLookupRequestSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  refresh: BooleanQuerySchema,
});

export async function GET(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = ClustersLookupRequestSchema.safeParse({
    project: readStudyOrProjectParam(url),
    scanId: url.searchParams.get("scanId"),
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    refresh: url.searchParams.get("refresh") ?? undefined,
  });
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const clusters = await getOrBuildPaperLibraryClusters({
      project: parsed.data.project,
      scanId: parsed.data.scanId,
      brainRoot: guard.brainRoot,
      refresh: parsed.data.refresh,
    });
    if (!clusters) {
      return Response.json(paperLibraryError("job_not_found", "Paper library scan not found."), { status: 404 });
    }
    return Response.json({
      ok: true,
      ...windowPaperLibraryClusters(clusters, {
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      }),
    });
  } catch (error) {
    return paperLibraryBadRequest(error);
  }
}
