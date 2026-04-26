import { getBrainConfig, isErrorResponse } from "../_shared";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { isLocalRequest } from "@/lib/local-guard";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";
import {
  ensureWatchProject,
  isWatchConfig,
  saveProjectWatchConfig,
  WatchConfigError,
} from "@/lib/watch/config-service";
import {
  createDefaultProjectWatchConfig,
  readProjectWatchConfig,
} from "@/lib/watch/store";
import type { ProjectWatchConfig } from "@/lib/watch/types";

interface WatchConfigBody {
  study?: string;
  project?: string;
  config?: ProjectWatchConfig;
}

function normalizeStudy(study: string): string {
  return assertSafeProjectSlug(study.trim());
}

function watchErrorResponse(error: unknown): Response {
  if (error instanceof WatchConfigError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

export async function GET(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  const url = new URL(request.url);
  const studyParam = url.searchParams.get("study") ?? url.searchParams.get("project");
  if (!studyParam) {
    return Response.json({ error: "Missing study parameter" }, { status: 400 });
  }

  let study: string;
  try {
    study = normalizeStudy(studyParam);
  } catch {
    return Response.json({ error: "study must be a safe bare slug" }, { status: 400 });
  }

  const stateRoot = getProjectStateRootForBrainRoot(study, configOrError.root);
  try {
    await ensureWatchProject(study, stateRoot);
  } catch (error) {
    return watchErrorResponse(error);
  }

  const watchConfig = await readProjectWatchConfig(study, stateRoot);
  return Response.json({
    study,
    project: study,
    config: watchConfig ?? createDefaultProjectWatchConfig(),
    saved: Boolean(watchConfig),
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  let body: WatchConfigBody;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as WatchConfigBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const requestedStudy = body.study ?? body.project;
  if (typeof requestedStudy !== "string" || !requestedStudy.trim()) {
    return Response.json({ error: "Missing study field" }, { status: 400 });
  }

  let study: string;
  try {
    study = normalizeStudy(requestedStudy);
  } catch {
    return Response.json({ error: "study must be a safe bare slug" }, { status: 400 });
  }

  if (!isWatchConfig(body.config)) {
    return Response.json({ error: "Invalid watch config payload" }, { status: 400 });
  }

  try {
    const savedConfig = await saveProjectWatchConfig({
      project: study,
      config: body.config,
      stateRoot: getProjectStateRootForBrainRoot(study, configOrError.root),
    });
    return Response.json({
      study,
      project: study,
      config: savedConfig,
      saved: true,
    });
  } catch (error) {
    return watchErrorResponse(error);
  }
}
