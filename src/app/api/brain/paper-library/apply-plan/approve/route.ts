import {
  ApplyPlanApproveRequestSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";
import { approveApplyPlan } from "@/lib/paper-library/apply";
import { normalizeStudyBody, paperLibraryBadRequest, readJsonBody, requirePaperLibraryRequest } from "../../_shared";

export async function POST(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return paperLibraryBadRequest(error);
  }

  const parsed = ApplyPlanApproveRequestSchema.safeParse(normalizeStudyBody(body));
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const result = await approveApplyPlan({ ...parsed.data, brainRoot: guard.brainRoot });
    if (!result) {
      return Response.json(paperLibraryError("job_not_found", "Apply plan not found."), { status: 404 });
    }
    return Response.json({
      ok: true,
      plan: result.plan,
      approvalToken: result.approvalToken,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    return Response.json(
      paperLibraryError("apply_blocked_conflicts", error instanceof Error ? error.message : "Apply plan cannot be approved."),
      { status: 409 },
    );
  }
}
