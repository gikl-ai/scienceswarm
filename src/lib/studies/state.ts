import path from "node:path";

import type { ProjectRecord } from "@/brain/gbrain-data-contracts";
import { writeJsonFile } from "@/lib/state/atomic-json";
import {
  StudyIdSchema,
  StudySlugSchema,
  StudyStateSchema,
  type StudyId,
  type StudyState,
} from "./contracts";
import { getStudyStatePath, getStudyStateRoot } from "./paths";

export function studyIdForLegacyProjectSlug(slug: string): StudyId {
  const legacyProjectSlug = StudySlugSchema.parse(slug);
  return StudyIdSchema.parse(`study_${legacyProjectSlug}`);
}

export function getLegacyProjectStudyStateRoot(
  slug: string,
  stateRoot?: string,
): string {
  return getStudyStateRoot(studyIdForLegacyProjectSlug(slug), stateRoot);
}

export function getLegacyProjectStudyFilePath(
  slug: string,
  relativePath: string,
  stateRoot?: string,
): string {
  const safeSlug = StudySlugSchema.parse(slug);
  const normalized = path.posix.normalize(relativePath.trim().replaceAll("\\", "/"));
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
  ) {
    throw new Error("Invalid Study state relative path");
  }
  return path.join(
    getLegacyProjectStudyStateRoot(safeSlug, stateRoot),
    "legacy-project",
    safeSlug,
    ...normalized.split("/"),
  );
}

export function buildStudyStateForProjectRecord(
  project: Pick<ProjectRecord, "slug" | "lastActive">,
): StudyState {
  const legacyProjectSlug = StudySlugSchema.parse(project.slug);
  const studyId = studyIdForLegacyProjectSlug(legacyProjectSlug);
  return StudyStateSchema.parse({
    version: 1,
    studyId,
    legacyProjectSlug,
    workspaceId: `workspace_${studyId.slice("study_".length)}`,
    updatedAt: project.lastActive,
  });
}

export async function writeStudyStateForProjectRecord(
  project: Pick<ProjectRecord, "slug" | "lastActive">,
  stateRoot?: string,
): Promise<StudyState> {
  const state = buildStudyStateForProjectRecord(project);
  await writeJsonFile(getStudyStatePath(state.studyId, stateRoot), state);
  return state;
}
