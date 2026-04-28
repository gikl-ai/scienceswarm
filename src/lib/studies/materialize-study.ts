import * as fs from "node:fs/promises";
import path from "node:path";

import type { ProjectRecord, StudyRecord } from "@/brain/gbrain-data-contracts";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { writeStudyStateForStudyRecord } from "./state";
import { projectRecordFromStudyRecord, studyRecordFromProjectRecord } from "./study-repository";

export interface MaterializeStudyResult {
  path: string;
  ok: true;
}

export async function materializeStudyCompatibilityShell(
  study: StudyRecord,
  projectsRoot = getScienceSwarmProjectsRoot(),
): Promise<MaterializeStudyResult> {
  const compatibilitySlug = study.legacyProjectSlug ?? study.slug;
  const dir = path.join(projectsRoot, compatibilitySlug);
  await fs.mkdir(dir, { recursive: true });

  const canonicalMeta = {
    id: study.slug,
    slug: study.slug,
    studyId: `study_${compatibilitySlug}`,
    name: study.name,
    description: study.description,
    createdAt: study.createdAt,
    lastActive: study.lastActive,
    status: study.status === "paused" ? "idle" : study.status,
    legacyProjectSlug: compatibilitySlug,
  };

  await fs.writeFile(
    path.join(dir, "study.json"),
    JSON.stringify(canonicalMeta, null, 2),
  );

  await fs.writeFile(
    path.join(dir, "project.json"),
    JSON.stringify(
      {
        id: compatibilitySlug,
        slug: compatibilitySlug,
        name: study.name,
        description: study.description,
        createdAt: study.createdAt,
        lastActive: study.lastActive,
        status: study.status === "paused" ? "idle" : study.status,
        compatibility: {
          canonicalType: "study",
          studySlug: study.slug,
        },
      },
      null,
      2,
    ),
  );

  await writeStudyStateForStudyRecord(study);
  return { path: dir, ok: true };
}

export async function materializeProjectCompatibilityShell(
  project: ProjectRecord,
  projectsRoot = getScienceSwarmProjectsRoot(),
): Promise<MaterializeStudyResult> {
  return materializeStudyCompatibilityShell(
    studyRecordFromProjectRecord(project),
    projectsRoot,
  );
}

export function compatibilityProjectRecordForStudy(study: StudyRecord): ProjectRecord {
  return projectRecordFromStudyRecord(study);
}
