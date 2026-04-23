import { UndoStartRequestSchema, paperLibraryError } from "@/lib/paper-library/contracts";
import { undoApplyManifest } from "@/lib/paper-library/apply";
import { paperLibraryBadRequest, readJsonBody, requirePaperLibraryRequest } from "../_shared";

export async function POST(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return paperLibraryBadRequest(error);
  }

  const parsed = UndoStartRequestSchema.safeParse(body);
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const result = await undoApplyManifest({ ...parsed.data, brainRoot: guard.brainRoot });
    if (!result) {
      return Response.json(paperLibraryError("job_not_found", "Apply manifest not found."), { status: 404 });
    }
    return Response.json({
      ok: true,
      manifest: result.manifest,
      status: result.manifest.status,
      undoneCount: result.manifest.undoneCount,
      failedCount: result.manifest.failedCount,
    });
  } catch (error) {
    return Response.json(
      paperLibraryError("manifest_not_repairable", error instanceof Error ? error.message : "Undo failed."),
      { status: 409 },
    );
  }
}
