import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";

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

  const record = {
    job_id: body.job_id,
    finding_id: body.finding_id,
    useful: body.useful,
    would_revise: body.would_revise,
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
    timestamp: new Date().toISOString(),
    user_id: "anonymous",
  };

  const feedbackDir = join(homedir(), ".scienceswarm", "feedback");
  const feedbackPath = join(feedbackDir, "critique-feedback.jsonl");

  try {
    await fs.mkdir(feedbackDir, { recursive: true });
    await fs.appendFile(feedbackPath, JSON.stringify(record) + "\n", "utf-8");
  } catch (err) {
    console.error("Failed to save feedback:", err);
    return Response.json({ error: "Failed to save feedback" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
