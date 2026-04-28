import type { ProjectRecord } from "@/brain/gbrain-data-contracts";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { materializeProjectCompatibilityShell } from "@/lib/studies";

export interface MaterializeProjectResult {
  path: string;
  ok: true;
}

export async function materializeProjectFolder(
  project: ProjectRecord,
  projectsRoot = getScienceSwarmProjectsRoot(),
): Promise<MaterializeProjectResult> {
  return materializeProjectCompatibilityShell(project, projectsRoot);
}
