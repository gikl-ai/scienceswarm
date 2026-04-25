import { z } from "zod";
import {
  PaperLibraryAcquisitionRequestSchema,
  ProjectSlugSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";
import {
  createAcquisitionPlan,
  executeAcquisitionPlan,
  readAcquisitionPlan,
} from "@/lib/paper-library/acquisition";
import { paperLibraryBadRequest, readJsonBody, requirePaperLibraryRequest } from "../_shared";

const AcquisitionLookupRequestSchema = z.object({
  project: ProjectSlugSchema,
  id: z.string().min(1),
});

export async function GET(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = AcquisitionLookupRequestSchema.safeParse({
    project: url.searchParams.get("project"),
    id: url.searchParams.get("id"),
  });
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const plan = await readAcquisitionPlan(parsed.data.project, parsed.data.id, guard.brainRoot);
    if (!plan) {
      return Response.json(paperLibraryError("job_not_found", "Acquisition plan not found."), { status: 404 });
    }
    return Response.json({ ok: true, plan });
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

  const parsed = PaperLibraryAcquisitionRequestSchema.safeParse(body);
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    if (parsed.data.action === "create") {
      const plan = await createAcquisitionPlan({ ...parsed.data, brainRoot: guard.brainRoot });
      if (!plan) {
        return Response.json(paperLibraryError("job_not_found", "Paper library scan not found."), { status: 404 });
      }
      return Response.json({
        ok: true,
        acquisitionPlanId: plan.id,
        plan,
        status: plan.status,
        itemCount: plan.itemCount,
        downloadableCount: plan.downloadableCount,
      });
    }

    const plan = await executeAcquisitionPlan({
      project: parsed.data.project,
      acquisitionPlanId: parsed.data.acquisitionPlanId,
      brainRoot: guard.brainRoot,
    });
    if (!plan) {
      return Response.json(paperLibraryError("job_not_found", "Acquisition plan not found."), { status: 404 });
    }
    return Response.json({
      ok: true,
      acquisitionPlanId: plan.id,
      plan,
      status: plan.status,
      acquiredCount: plan.acquiredCount,
      failedCount: plan.failedCount,
    });
  } catch (error) {
    if (parsed.data.action === "execute" && error instanceof Error && /already running/i.test(error.message)) {
      return Response.json(
        paperLibraryError("job_already_running", "Acquisition plan is already running."),
        { status: 409 },
      );
    }
    if (parsed.data.action === "execute" && error instanceof Error && /already been executed/i.test(error.message)) {
      return Response.json(
        paperLibraryError("invalid_state", error.message),
        { status: 409 },
      );
    }
    return paperLibraryBadRequest(error);
  }
}
