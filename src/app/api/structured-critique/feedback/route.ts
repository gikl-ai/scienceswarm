import { isLocalRequest } from "@/lib/local-guard";
import {
  appendStructuredCritiqueFeedback,
  readStructuredCritiqueFeedback,
  summarizeStructuredCritiqueFeedback,
  type StructuredCritiqueFeedbackRecord,
} from "@/lib/structured-critique-feedback";

type FeedbackRequest = {
  job_id: unknown;
  finding_id: unknown;
  useful: unknown;
  would_revise: unknown;
  comment?: unknown;
};

function validateBody(
  body: FeedbackRequest,
): { ok: true } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  if (typeof body.job_id !== "string" || body.job_id.trim().length === 0) {
    return { ok: false, error: "job_id is required and must be a non-empty string" };
  }
  if (typeof body.finding_id !== "string" || body.finding_id.trim().length === 0) {
    return { ok: false, error: "finding_id is required and must be a non-empty string" };
  }
  if (typeof body.useful !== "boolean") {
    return { ok: false, error: "useful is required and must be a boolean" };
  }
  if (typeof body.would_revise !== "boolean") {
    return { ok: false, error: "would_revise is required and must be a boolean" };
  }
  if (body.comment !== undefined && typeof body.comment !== "string") {
    return { ok: false, error: "comment must be a string if provided" };
  }
  return { ok: true };
}

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: FeedbackRequest;
  try {
    body = (await request.json()) as FeedbackRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const jobId = body.job_id as string;
  const findingId = body.finding_id as string;
  const useful = body.useful as boolean;
  const wouldRevise = body.would_revise as boolean;
  const comment = typeof body.comment === "string" ? body.comment : undefined;
  const record = {
    job_id: jobId,
    finding_id: findingId,
    useful,
    would_revise: wouldRevise,
    ...(comment !== undefined ? { comment } : {}),
    timestamp: new Date().toISOString(),
    user_id: "anonymous",
  } satisfies StructuredCritiqueFeedbackRecord;

  try {
    await appendStructuredCritiqueFeedback(record);
  } catch (err) {
    console.error("Failed to save feedback:", err);
    return Response.json({ error: "Failed to save feedback" }, { status: 500 });
  }

  const records = await readStructuredCritiqueFeedback({
    jobId: record.job_id,
    findingId: record.finding_id,
  });
  const recordsWithCurrent = records.some(
    (candidate) =>
      candidate.job_id === record.job_id &&
      candidate.finding_id === record.finding_id &&
      candidate.timestamp === record.timestamp,
  )
    ? records
    : [record, ...records];

  return Response.json({
    ok: true,
    record,
    records: recordsWithCurrent,
    summary: summarizeStructuredCritiqueFeedback(recordsWithCurrent),
  });
}

export async function GET(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const jobId = url.searchParams.get("job_id");
  const findingId = url.searchParams.get("finding_id");

  try {
    const records = await readStructuredCritiqueFeedback({
      jobId,
      findingId,
    });
    return Response.json({
      records,
      summary: summarizeStructuredCritiqueFeedback(records),
    });
  } catch (err) {
    console.error("Failed to read feedback:", err);
    return Response.json({ error: "Failed to read feedback" }, { status: 500 });
  }
}
