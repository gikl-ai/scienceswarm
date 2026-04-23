import { z, ZodError } from "zod";
import {
  PaperLibraryScanStartRequestSchema,
  ProjectSlugSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";
import {
  cancelPaperLibraryScan,
  findLatestPaperLibraryScan,
  reconcileStalePaperLibraryScan,
  startPaperLibraryScan,
} from "@/lib/paper-library/jobs";
import { isLocalRequest } from "@/lib/local-guard";
import { getBrainConfig, isErrorResponse } from "../../_shared";

const ScanLookupRequestSchema = z.object({
  project: ProjectSlugSchema,
  id: z.string().trim().min(1),
});

const ScanCancelRequestSchema = z.object({
  action: z.literal("cancel"),
  project: ProjectSlugSchema,
  scanId: z.string().trim().min(1),
});

function badRequest(error: unknown): Response {
  if (error instanceof ZodError) {
    return Response.json(
      paperLibraryError("invalid_state", "Invalid paper-library scan request.", error.issues),
      { status: 400 },
    );
  }
  const message = error instanceof Error ? error.message : "Invalid paper-library request.";
  return Response.json(paperLibraryError("invalid_state", message), { status: 400 });
}

export async function GET(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json(paperLibraryError("unsafe_path", "Forbidden."), { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  const url = new URL(request.url);
  const latestParam = url.searchParams.get("latest");
  const wantsLatest = latestParam === "1" || latestParam === "true";

  if (wantsLatest) {
    const project = ProjectSlugSchema.safeParse(url.searchParams.get("project"));
    if (!project.success) return badRequest(project.error);

    const scan = await findLatestPaperLibraryScan(project.data, configOrError.root);
    if (!scan) {
      return Response.json(paperLibraryError("job_not_found", "Paper library scan not found."), { status: 404 });
    }

    return Response.json({ ok: true, scan });
  }

  const lookup = ScanLookupRequestSchema.safeParse({
    project: url.searchParams.get("project"),
    id: url.searchParams.get("id"),
  });
  if (!lookup.success) return badRequest(lookup.error);

  const scan = await reconcileStalePaperLibraryScan(lookup.data.project, lookup.data.id, configOrError.root);
  if (!scan) {
    return Response.json(paperLibraryError("job_not_found", "Paper library scan not found."), { status: 404 });
  }

  return Response.json({ ok: true, scan });
}

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json(paperLibraryError("unsafe_path", "Forbidden."), { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(paperLibraryError("invalid_state", "Invalid JSON body."), { status: 400 });
  }

  const action = typeof body === "object" && body !== null && "action" in body
    ? String((body as { action?: unknown }).action)
    : "start";

  if (action === "cancel") {
    const cancel = ScanCancelRequestSchema.safeParse(body);
    if (!cancel.success) return badRequest(cancel.error);
    const scan = await cancelPaperLibraryScan(cancel.data.project, cancel.data.scanId, configOrError.root);
    if (!scan) {
      return Response.json(paperLibraryError("job_not_found", "Paper library scan not found."), { status: 404 });
    }
    return Response.json({ ok: true, scan });
  }

  if (action !== "start") {
    return Response.json(paperLibraryError("invalid_state", "Unknown action."), { status: 400 });
  }

  try {
    const input = PaperLibraryScanStartRequestSchema.parse(body);
    const scan = await startPaperLibraryScan({
      project: input.project,
      rootPath: input.rootPath,
      brainRoot: configOrError.root,
      idempotencyKey: input.idempotencyKey,
    });
    return Response.json({
      ok: true,
      scanId: scan.id,
      status: scan.status,
      counters: scan.counters,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/not allowed|not a directory|required/i.test(message)) {
      return Response.json(paperLibraryError("invalid_root", message), { status: 400 });
    }
    return badRequest(error);
  }
}
