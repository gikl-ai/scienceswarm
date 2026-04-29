import { z } from "zod";

import { ProjectSlugSchema } from "@/lib/paper-library/contracts";
import { readPaperCorpusImportStatus } from "@/lib/paper-library/corpus/status";
import { writePaperCorpusManifestForScan } from "@/lib/paper-library/corpus/pipeline";
import { readAllPaperReviewItems } from "@/lib/paper-library/review";
import { paperLibraryBadRequest, readStudyOrProjectParam, requirePaperLibraryRequest } from "../_shared";

const CorpusStatusLookupRequestSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().trim().min(1),
});

const CorpusStatusRetryRequestSchema = z.object({
  action: z.literal("retry"),
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

export async function POST(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return paperLibraryBadRequest(new Error("Invalid JSON body."));
  }

  const parsed = CorpusStatusRetryRequestSchema.safeParse(body);
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const reviewState = await readAllPaperReviewItems(parsed.data.project, parsed.data.scanId, guard.brainRoot);
    if (!reviewState) {
      return Response.json({ error: { code: "job_not_found", message: "Paper library scan not found." } }, { status: 404 });
    }
    await writePaperCorpusManifestForScan({
      project: parsed.data.project,
      scanId: parsed.data.scanId,
      rootRealpath: reviewState.scan.rootRealpath ?? reviewState.scan.rootPath,
      createdAt: reviewState.scan.createdAt,
      updatedAt: new Date().toISOString(),
      items: reviewState.items,
      stateRoot: reviewState.stateRoot,
    });
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
