import { z } from "zod";
import {
  ApplyPlanCreateRequestSchema,
  ProjectSlugSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";
import {
  createApplyPlan,
  readApplyOperations,
  readApplyPlan,
  windowApplyOperations,
} from "@/lib/paper-library/apply";
import { normalizeStudyBody, paperLibraryBadRequest, readJsonBody, readStudyOrProjectParam, requirePaperLibraryRequest } from "../_shared";

const ApplyPlanLookupRequestSchema = z.object({
  project: ProjectSlugSchema,
  id: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
});

export async function GET(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = ApplyPlanLookupRequestSchema.safeParse({
    project: readStudyOrProjectParam(url),
    id: url.searchParams.get("id"),
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const plan = await readApplyPlan(parsed.data.project, parsed.data.id, guard.brainRoot);
    if (!plan) {
      return Response.json(paperLibraryError("job_not_found", "Apply plan not found."), { status: 404 });
    }
    const operations = await readApplyOperations(parsed.data.project, parsed.data.id, guard.brainRoot);
    const page = windowApplyOperations(operations, parsed.data);
    return Response.json({ ok: true, plan, operations: page.items, ...page });
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

  const parsed = ApplyPlanCreateRequestSchema.safeParse(normalizeStudyBody(body));
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const result = await createApplyPlan({ ...parsed.data, brainRoot: guard.brainRoot });
    if (!result) {
      return Response.json(paperLibraryError("job_not_found", "Paper library scan not found."), { status: 404 });
    }
    return Response.json({
      ok: true,
      applyPlanId: result.plan.id,
      plan: result.plan,
      operationCount: result.plan.operationCount,
      conflictCount: result.plan.conflictCount,
      status: result.plan.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/root/i.test(message)) {
      return Response.json(paperLibraryError("invalid_root", message), { status: 400 });
    }
    return paperLibraryBadRequest(error);
  }
}
