import {
  createProjectRepository,
  type ProjectRepository,
} from "@/lib/projects/project-repository";

type GlobalState = typeof globalThis & {
  __scienceswarmProjectsRouteRepositoryOverride?: ProjectRepository | null;
};

function globalState(): GlobalState {
  return globalThis as GlobalState;
}

export function __setProjectRepositoryOverride(
  repository: ProjectRepository | null,
): void {
  globalState().__scienceswarmProjectsRouteRepositoryOverride = repository;
}

export function getProjectsRouteRepository(): ProjectRepository {
  return globalState().__scienceswarmProjectsRouteRepositoryOverride
    ?? createProjectRepository();
}
