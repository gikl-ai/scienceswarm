import { z } from "zod";

import {
  ProjectSlugSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";
import { buildLibraryCitationGraphContext } from "@/lib/paper-library/library-enrichment";

import { paperLibraryBadRequest, readStudyOrProjectParam, requirePaperLibraryRequest } from "../_shared";

const BooleanQuerySchema = z.preprocess((value) => {
  if (value == null) return false;
  const text = String(value).trim().toLowerCase();
  if (text === "1" || text === "true" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "no") return false;
  return value;
}, z.boolean());

const EnrichmentContextLookupSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().min(1).optional(),
  question: z.string().trim().min(1).optional(),
  refresh: BooleanQuerySchema,
  limit: z.number().int().min(1).max(25).default(8),
});

export async function GET(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = EnrichmentContextLookupSchema.safeParse({
    project: readStudyOrProjectParam(url),
    scanId: url.searchParams.get("scanId") ?? undefined,
    question: url.searchParams.get("question") ?? undefined,
    refresh: url.searchParams.get("refresh") ?? undefined,
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
  });
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const context = await buildLibraryCitationGraphContext({
      project: parsed.data.project,
      scanId: parsed.data.scanId,
      question: parsed.data.question,
      refresh: parsed.data.refresh,
      suggestionLimit: parsed.data.limit,
      brainRoot: guard.brainRoot,
    });
    if (!context) {
      return Response.json(
        paperLibraryError("job_not_found", "Paper library graph context not found."),
        { status: 404 },
      );
    }

    return Response.json({
      ok: true,
      graph: context,
      suggestions: context.suggestions,
      warnings: context.warnings,
    });
  } catch (error) {
    return paperLibraryBadRequest(error);
  }
}
