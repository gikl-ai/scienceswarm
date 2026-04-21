import { getBrainConfig, isErrorResponse } from "../_shared";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
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
  project?: string;
  config?: ProjectWatchConfig;
}

function normalizeProject(project: string): string {
  return assertSafeProjectSlug(project.trim());
}

function watchErrorResponse(error: unknown): Response {
  if (error instanceof WatchConfigError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

export async function GET(request: Request): Promise<Response> {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  const url = new URL(request.url);
  const projectParam = url.searchParams.get("project");
  if (!projectParam) {
    return Response.json({ error: "Missing project parameter" }, { status: 400 });
  }

  let project: string;
  try {
    project = normalizeProject(projectParam);
  } catch {
    return Response.json({ error: "project must be a safe bare slug" }, { status: 400 });
  }

  const stateRoot = getProjectStateRootForBrainRoot(project, configOrError.root);
  try {
    await ensureWatchProject(project, stateRoot);
  } catch (error) {
    return watchErrorResponse(error);
  }

  const watchConfig = await readProjectWatchConfig(project, stateRoot);
  return Response.json({
    project,
    config: watchConfig ?? createDefaultProjectWatchConfig(),
    saved: Boolean(watchConfig),
  });
}

export async function POST(request: Request): Promise<Response> {
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

  if (typeof body.project !== "string" || !body.project.trim()) {
    return Response.json({ error: "Missing project field" }, { status: 400 });
  }

  let project: string;
  try {
    project = normalizeProject(body.project);
  } catch {
    return Response.json({ error: "project must be a safe bare slug" }, { status: 400 });
  }

  if (!isWatchConfig(body.config)) {
    return Response.json({ error: "Invalid watch config payload" }, { status: 400 });
  }

  try {
    const savedConfig = await saveProjectWatchConfig({
      project,
      config: body.config,
      stateRoot: getProjectStateRootForBrainRoot(project, configOrError.root),
    });
    return Response.json({
      project,
      config: savedConfig,
      saved: true,
    });
  } catch (error) {
    return watchErrorResponse(error);
  }
}
