import { z } from "zod";
import {
  PaperReviewItemStateSchema,
  PaperReviewUpdateRequestSchema,
  ProjectSlugSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";
import { listPaperReviewItems, updatePaperReviewItem } from "@/lib/paper-library/review";
import { normalizeStudyBody, paperLibraryBadRequest, readJsonBody, readStudyOrProjectParam, requirePaperLibraryRequest } from "../_shared";

const ReviewListRequestSchema = z.object({
  project: ProjectSlugSchema,
  scanId: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  filter: PaperReviewItemStateSchema.optional(),
});

export async function GET(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = ReviewListRequestSchema.safeParse({
    project: readStudyOrProjectParam(url),
    scanId: url.searchParams.get("scanId"),
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    filter: url.searchParams.get("filter") ?? undefined,
  });
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const page = await listPaperReviewItems({ ...parsed.data, brainRoot: guard.brainRoot });
    if (!page) {
      return Response.json(paperLibraryError("job_not_found", "Paper library scan not found."), { status: 404 });
    }
    return Response.json({ ok: true, ...page });
  } catch (error) {
    return paperLibraryBadRequest(error);
  }
}

export async function POST(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return paperLibraryBadRequest(error);
  }

  const parsed = PaperReviewUpdateRequestSchema.safeParse(normalizeStudyBody(body));
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const result = await updatePaperReviewItem({ ...parsed.data, brainRoot: guard.brainRoot });
    if (!result) {
      return Response.json(paperLibraryError("job_not_found", "Review item not found."), { status: 404 });
    }
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return paperLibraryBadRequest(error);
  }
}
