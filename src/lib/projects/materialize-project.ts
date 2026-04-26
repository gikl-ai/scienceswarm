import * as fs from "node:fs/promises";
import path from "node:path";

import type { ProjectRecord } from "@/brain/gbrain-data-contracts";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { writeStudyStateForProjectRecord } from "@/lib/studies";

export interface MaterializeProjectResult {
  path: string;
  ok: true;
}

export async function materializeProjectFolder(
  project: ProjectRecord,
  projectsRoot = getScienceSwarmProjectsRoot(),
): Promise<MaterializeProjectResult> {
  const dir = path.join(projectsRoot, project.slug);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(
    path.join(dir, "project.json"),
    JSON.stringify(
      {
        id: project.slug,
        slug: project.slug,
        name: project.name,
        description: project.description,
        createdAt: project.createdAt,
        lastActive: project.lastActive,
        status: project.status === "paused" ? "idle" : project.status,
      },
      null,
      2,
    ),
  );

  await writeStudyStateForProjectRecord(project);
  return { path: dir, ok: true };
}
