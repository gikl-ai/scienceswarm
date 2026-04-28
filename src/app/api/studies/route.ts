import path from "node:path";

import type { StudyRecord } from "@/brain/gbrain-data-contracts";
import { isLocalRequest } from "@/lib/local-guard";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import {
  DuplicateStudyError,
  slugifyStudyName,
} from "@/lib/studies/study-repository";
import { listStudyRecordsFromDisk } from "@/lib/studies/study-list-fallback";
import { materializeStudyCompatibilityShell } from "@/lib/studies/materialize-study";
import { getStudiesRouteRepository } from "@/lib/testing/studies-route-overrides";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import { getCurrentUserHandle } from "@/lib/setup/current-user-handle";
import { studyIdForLegacyProjectSlug } from "@/lib/studies/state";

interface StudyMeta {
  id: string;
  slug: string;
  name: string;
  description: string;
  createdAt: string;
  lastActive: string;
  status: "active" | "idle" | "paused" | "archived";
  studyPageSlug?: string;
  legacyProjectSlug?: string;
}

const STUDIES_REPOSITORY_LIST_DEADLINE_MS = 1500;
const REPOSITORY_UNAVAILABLE_CAUSE_DEPTH_LIMIT = 10;
const DISK_FALLBACK_SAVE_ERROR =
  "Study could not be saved to disk while gbrain was unavailable.";
const DISK_FALLBACK_ARCHIVE_ERROR =
  "Study could not be archived on disk while gbrain was unavailable.";
const DISK_FALLBACK_ARCHIVE_RECOVERY_WARNING =
  "gbrain was unavailable, so only the local Study compatibility manifest was archived; "
  + "reconcile this slug after gbrain recovers if the gbrain record is still active.";

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

async function createDiskFallbackStudy(input: {
  slug: string;
  name: string;
  description?: string;
}): Promise<StudyRecord> {
  const existing = (await listStudyRecordsFromDisk()).find(
    (record) => record.slug === input.slug && record.status !== "archived",
  );
  if (existing) {
    throw new DuplicateStudyError(input.slug);
  }

  const createdAt = new Date().toISOString();
  return {
    slug: input.slug,
    name: input.name,
    description: input.description?.trim() || "New study",
    createdAt,
    lastActive: createdAt,
    status: "active",
    studyPageSlug: input.slug,
    legacyProjectSlug: input.slug,
  };
}

async function archiveDiskFallbackStudy(slug: string): Promise<{
  ok: true;
  existed: boolean;
}> {
  const activeRecords = (await listStudyRecordsFromDisk()).filter(
    (record) => record.slug === slug && record.status !== "archived",
  );
  if (activeRecords.length === 0) return { ok: true, existed: false };

  const archivedAt = new Date().toISOString();
  for (const record of activeRecords) {
    await materializeStudyCompatibilityShell({
      ...record,
      status: "archived",
      lastActive: archivedAt,
    });
  }

  return { ok: true, existed: true };
}

function toStudyMeta(record: StudyRecord): StudyMeta {
  const legacyProjectSlug = record.legacyProjectSlug ?? record.slug;
  return {
    id: studyIdForLegacyProjectSlug(legacyProjectSlug),
    slug: record.slug,
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    lastActive: record.lastActive,
    status: record.status,
    studyPageSlug: record.studyPageSlug,
    legacyProjectSlug,
  };
}

async function listStudiesWithDeadline(): Promise<StudyRecord[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("STUDIES_REPOSITORY_LIST_TIMEOUT"));
    }, STUDIES_REPOSITORY_LIST_DEADLINE_MS);

    getStudiesRouteRepository()
      .list()
      .then((studies) => {
        clearTimeout(timeout);
        resolve(studies);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function studySlugFromMutationBody(body: Record<string, unknown>): string {
  const candidate =
    body.studySlug
    ?? body.studyId
    ?? body.projectId;
  if (!candidate) {
    throw new InvalidSlugError("studyId required");
  }
  const raw = String(candidate);
  const slug = raw.startsWith("study_") ? raw.slice("study_".length) : raw;
  return assertSafeProjectSlug(slug);
}

export async function GET() {
  try {
    const studies = (await listStudiesWithDeadline()).map(toStudyMeta);
    return Response.json({ studies });
  } catch (err) {
    console.warn("[studies] repository list failed; falling back to disk:", err);
    try {
      const studies = (await listStudyRecordsFromDisk()).map(toStudyMeta);
      return Response.json({ studies });
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
    const body = await request.json() as Record<string, unknown>;

    if (body.action === "create") {
      const { name, description } = body;
      if (!name) {
        return Response.json({ error: "name required" }, { status: 400 });
      }

      const trimmedName = String(name).trim();
      const slug = slugifyStudyName(trimmedName);
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
      let study: StudyRecord;
      try {
        study = await getStudiesRouteRepository().create({
          name: trimmedName,
          description: trimmedDescription,
          createdBy,
        });
      } catch (error) {
        if (!isRepositoryUnavailableError(error)) {
          throw error;
        }
        console.warn("[studies] repository create failed; falling back to disk:", error);
        persistence = "disk-fallback";
        persistenceWarning = errorMessage(error);
        persistenceRecoveryWarning =
          "gbrain was unavailable, so duplicate checks were limited to disk; "
          + "reconcile this slug after gbrain recovers if the study already existed there.";
        try {
          study = await createDiskFallbackStudy({
            slug,
            name: trimmedName,
            description: trimmedDescription,
          });
        } catch (fallbackError) {
          if (fallbackError instanceof DuplicateStudyError) {
            throw fallbackError;
          }
          return Response.json(
            {
              error: DISK_FALLBACK_SAVE_ERROR,
              path: path.join(getScienceSwarmProjectsRoot(), slug),
              compatibilityPath: path.join(getScienceSwarmProjectsRoot(), slug),
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
        materializedPath = (await materializeStudyCompatibilityShell(study)).path;
      } catch (error) {
        materializationError =
          error instanceof Error ? error.message : String(error);
      }

      const compatibilityPath = path.join(
        getScienceSwarmProjectsRoot(),
        study.legacyProjectSlug ?? study.slug,
      );
      const responseBody = {
        study: toStudyMeta(study),
        path: materializedPath ?? compatibilityPath,
        compatibilityPath: materializedPath ?? compatibilityPath,
        materialized: materializedPath !== null,
        materializationError,
        normalization: {
          requestedName: trimmedName,
          slug: study.slug,
          changed: trimmedName !== study.slug,
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
      const safeStudySlug = studySlugFromMutationBody(body);
      try {
        const result = await getStudiesRouteRepository().delete(safeStudySlug);
        return Response.json({ ok: true, existed: result.existed });
      } catch (error) {
        if (!isRepositoryUnavailableError(error)) {
          throw error;
        }
        console.warn("[studies] repository archive failed; falling back to disk:", error);
        try {
          const result = await archiveDiskFallbackStudy(safeStudySlug);
          return Response.json({
            ok: true,
            existed: result.existed,
            persistence: "disk-fallback",
            persistenceWarning: errorMessage(error),
            persistenceRecoveryWarning: DISK_FALLBACK_ARCHIVE_RECOVERY_WARNING,
          });
        } catch (fallbackError) {
          return Response.json(
            {
              error: DISK_FALLBACK_ARCHIVE_ERROR,
              materializationError: errorMessage(fallbackError),
              persistence: "disk-fallback",
              persistenceWarning: errorMessage(error),
              persistenceRecoveryWarning: DISK_FALLBACK_ARCHIVE_RECOVERY_WARNING,
            },
            { status: 500 },
          );
        }
      }
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    if (err instanceof DuplicateStudyError) {
      return Response.json({ error: "Study already exists" }, { status: 409 });
    }
    if (err instanceof InvalidSlugError) {
      return Response.json({ error: "Invalid studyId" }, { status: 400 });
    }
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
