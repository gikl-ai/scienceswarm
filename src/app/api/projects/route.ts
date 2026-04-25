import path from "node:path";

import type { ProjectRecord } from "@/brain/gbrain-data-contracts";
import { isLocalRequest } from "@/lib/local-guard";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import {
  DuplicateProjectError,
  slugifyProjectName,
} from "@/lib/projects/project-repository";
import { listProjectRecordsFromDisk } from "@/lib/projects/project-list-fallback";
import {
  materializeProjectFolder,
} from "@/lib/projects/materialize-project";
import { getProjectsRouteRepository } from "@/lib/testing/projects-route-overrides";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

interface ProjectMeta {
  id: string;
  slug: string;
  name: string;
  description: string;
  createdAt: string;
  lastActive: string;
  status: "active" | "idle" | "paused" | "archived";
  projectPageSlug?: string;
}

const PROJECTS_REPOSITORY_LIST_DEADLINE_MS = 1500;
const REPOSITORY_UNAVAILABLE_CAUSE_DEPTH_LIMIT = 10;
const DISK_FALLBACK_SAVE_ERROR =
  "Project could not be saved to disk while gbrain was unavailable.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRepositoryUnavailableError(error: unknown, depth = 0): boolean {
  if (
    !error
    || typeof error !== "object"
    || depth > REPOSITORY_UNAVAILABLE_CAUSE_DEPTH_LIMIT
  ) {
    return false;
  }

  const candidate = error as Error & { cause?: unknown };
  const message = errorMessage(candidate);
  return candidate.name === "BrainBackendUnavailableError"
    || /brain backend unavailable/i.test(message)
    || /PGLite failed to initialize/i.test(message)
    || (
      candidate.cause !== undefined
      && isRepositoryUnavailableError(candidate.cause, depth + 1)
    );
}

async function createDiskFallbackProject(input: {
  slug: string;
  name: string;
  description?: string;
}): Promise<ProjectRecord> {
  const existing = (await listProjectRecordsFromDisk()).find(
    (record) => record.slug === input.slug && record.status !== "archived",
  );
  if (existing) {
    throw new DuplicateProjectError(input.slug);
  }

  const createdAt = new Date().toISOString();
  return {
    slug: input.slug,
    name: input.name,
    description: input.description?.trim() || "New project",
    createdAt,
    lastActive: createdAt,
    status: "active",
    projectPageSlug: input.slug,
  };
}

function toLegacyProjectMeta(record: {
  slug: string;
  name: string;
  description: string;
  createdAt: string;
  lastActive: string;
  status: "active" | "idle" | "paused" | "archived";
  projectPageSlug: string;
}): ProjectMeta {
  return {
    id: record.slug,
    slug: record.slug,
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    lastActive: record.lastActive,
    status: record.status,
    projectPageSlug: record.projectPageSlug,
  };
}

async function listProjectsWithDeadline(): Promise<ProjectRecord[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("PROJECTS_REPOSITORY_LIST_TIMEOUT"));
    }, PROJECTS_REPOSITORY_LIST_DEADLINE_MS);

    getProjectsRouteRepository()
      .list()
      .then((projects) => {
        clearTimeout(timeout);
        resolve(projects);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

export async function GET() {
  try {
    const projects = (await listProjectsWithDeadline()).map(toLegacyProjectMeta);
    return Response.json({ projects });
  } catch (err) {
    console.warn("[projects] repository list failed; falling back to disk:", err);
    try {
      const projects = (await listProjectRecordsFromDisk()).map(toLegacyProjectMeta);
      return Response.json({ projects });
    } catch (fallbackErr) {
      return Response.json({ error: String(fallbackErr) }, { status: 500 });
    }
  }
}
export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();

    if (body.action === "create") {
      const { name, description } = body;
      if (!name) {
        return Response.json({ error: "name required" }, { status: 400 });
      }

      const trimmedName = String(name).trim();
      const slug = slugifyProjectName(trimmedName);
      if (!slug) {
        return Response.json(
          { error: "name produces empty slug" },
          { status: 400 },
        );
      }

      let createdBy: string;
      try {
        createdBy = getCurrentUserHandle();
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "SCIENCESWARM_USER_HANDLE is not set",
          },
          { status: 500 },
        );
      }

      const trimmedDescription = typeof description === "string"
        ? description
        : undefined;
      let persistence: "gbrain" | "disk-fallback" = "gbrain";
      let persistenceWarning: string | null = null;
      let persistenceRecoveryWarning: string | null = null;
      let project: ProjectRecord;
      try {
        project = await getProjectsRouteRepository().create({
          name: trimmedName,
          description: trimmedDescription,
          createdBy,
        });
      } catch (error) {
        if (!isRepositoryUnavailableError(error)) {
          throw error;
        }
        console.warn("[projects] repository create failed; falling back to disk:", error);
        persistence = "disk-fallback";
        persistenceWarning = errorMessage(error);
        persistenceRecoveryWarning =
          "gbrain was unavailable, so duplicate checks were limited to disk; "
          + "reconcile this slug after gbrain recovers if the project already existed there.";
        try {
          project = await createDiskFallbackProject({
            slug,
            name: trimmedName,
            description: trimmedDescription,
          });
        } catch (fallbackError) {
          if (fallbackError instanceof DuplicateProjectError) {
            throw fallbackError;
          }
          return Response.json(
            {
              error: DISK_FALLBACK_SAVE_ERROR,
              path: path.join(getScienceSwarmProjectsRoot(), slug),
              materialized: false,
              materializationError: errorMessage(fallbackError),
              normalization: {
                requestedName: trimmedName,
                slug,
                changed: trimmedName !== slug,
              },
              persistence,
              persistenceWarning,
              persistenceRecoveryWarning,
            },
            { status: 500 },
          );
        }
      }
      let materializedPath: string | null = null;
      let materializationError: string | null = null;
      try {
        materializedPath = (await materializeProjectFolder(project)).path;
      } catch (error) {
        materializationError =
          error instanceof Error ? error.message : String(error);
      }

      const responseBody = {
        project: toLegacyProjectMeta(project),
        path: materializedPath
          ?? path.join(getScienceSwarmProjectsRoot(), project.slug),
        materialized: materializedPath !== null,
        materializationError,
        normalization: {
          requestedName: trimmedName,
          slug: project.slug,
          changed: trimmedName !== project.slug,
        },
        persistence,
        persistenceWarning,
        persistenceRecoveryWarning,
      };

      if (persistence === "disk-fallback" && materializedPath === null) {
        return Response.json(
          {
            ...responseBody,
            error: DISK_FALLBACK_SAVE_ERROR,
          },
          { status: 500 },
        );
      }

      return Response.json(responseBody);
    }

    if (body.action === "archive" || body.action === "delete") {
      const { projectId } = body;
      if (!projectId) {
        return Response.json(
          { error: "projectId required" },
          { status: 400 },
        );
      }
      const safeProjectId = assertSafeProjectSlug(String(projectId));
      const result = await getProjectsRouteRepository().delete(safeProjectId);
      return Response.json({ ok: true, existed: result.existed });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    if (err instanceof DuplicateProjectError) {
      return Response.json({ error: "Project already exists" }, { status: 409 });
    }
    if (err instanceof InvalidSlugError) {
      return Response.json({ error: "Invalid projectId" }, { status: 400 });
    }
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
