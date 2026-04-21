import { isLocalRequest } from "@/lib/local-guard";
import {
  isValidImportJobId,
  readImportJob,
  startBackgroundImportJob,
} from "@/lib/import/background-import-job";
import {
  InvalidSlugError,
  assertSafeProjectSlug,
} from "@/lib/state/project-manifests";
import { getBrainConfig, isErrorResponse } from "../_shared";

export async function GET(request: Request) {
  if (!(await isLocalRequest())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id")?.trim();
  if (!id || !isValidImportJobId(id)) {
    return Response.json({ error: "id is required and must be a valid job ID" }, { status: 400 });
  }

  const job = await readImportJob(id, config.root);
  if (!job) {
    return Response.json({ error: "Import job not found" }, { status: 404 });
  }

  return Response.json(job);
}

export async function POST(request: Request) {
  if (!(await isLocalRequest())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: {
    action?: string;
    path?: string;
    projectSlug?: string;
  };

  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action !== "start") {
    return Response.json({ error: "Unknown action" }, { status: 400 });
  }

  const targetPath = body.path?.trim();
  if (!targetPath) {
    return Response.json({ error: "path is required" }, { status: 400 });
  }

  let safeProjectSlug: string | undefined;
  if (body.projectSlug?.trim()) {
    try {
      safeProjectSlug = assertSafeProjectSlug(body.projectSlug.trim());
    } catch (error) {
      if (error instanceof InvalidSlugError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  try {
    const job = await startBackgroundImportJob({
      brainRoot: config.root,
      path: targetPath,
      projectSlug: safeProjectSlug,
    });
    return Response.json({ ok: true, job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start background import";
    const status = /not found/i.test(message)
      ? 404
      : /not allowed|not a directory|required/i.test(message)
        ? 400
        : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
}
