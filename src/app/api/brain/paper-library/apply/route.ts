import { ApplyStartRequestSchema, paperLibraryError } from "@/lib/paper-library/contracts";
import { applyApprovedPlan } from "@/lib/paper-library/apply";
import { persistAppliedPaperLocations } from "@/lib/paper-library/gbrain-writer";
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

  const parsed = ApplyStartRequestSchema.safeParse(body);
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const result = await applyApprovedPlan({
      ...parsed.data,
      brainRoot: guard.brainRoot,
      persistLocations: persistAppliedPaperLocations,
    });
    if (!result) {
      return Response.json(paperLibraryError("job_not_found", "Apply plan not found."), { status: 404 });
    }
    return Response.json({
      ok: true,
      manifestId: result.manifest.id,
      manifest: result.manifest,
      appliedCount: result.manifest.appliedCount,
      failedCount: result.manifest.failedCount,
      status: result.manifest.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Apply failed.";
    if (/expired/i.test(message)) {
      return Response.json(paperLibraryError("approval_token_expired", message), { status: 409 });
    }
    if (/conflict|approved|token/i.test(message)) {
      return Response.json(paperLibraryError("apply_blocked_conflicts", message), { status: 409 });
    }
    if (/changed|source/i.test(message)) {
      return Response.json(paperLibraryError("source_changed_since_approval", message), { status: 409 });
    }
    return paperLibraryBadRequest(error);
  }
}
