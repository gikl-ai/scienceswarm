import { z } from "zod";

import { ProjectSlugSchema } from "@/lib/paper-library/contracts";
import { readPaperCorpusImportStatus } from "@/lib/paper-library/corpus/status";
import { paperLibraryBadRequest, readStudyOrProjectParam, requirePaperLibraryRequest } from "../_shared";

const CorpusStatusLookupRequestSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().trim().min(1),
});

export async function GET(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = CorpusStatusLookupRequestSchema.safeParse({
    project: readStudyOrProjectParam(url),
    scanId: url.searchParams.get("scanId"),
  });
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const status = await readPaperCorpusImportStatus({
      project: parsed.data.project,
      scanId: parsed.data.scanId,
      brainRoot: guard.brainRoot,
    });
    return Response.json({ ok: true, status });
  } catch (error) {
    return paperLibraryBadRequest(error);
  }
}
