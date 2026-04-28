import {
  createStudyRepository,
  type StudyRepository,
} from "@/lib/studies/study-repository";

type GlobalState = typeof globalThis & {
  __scienceswarmStudiesRouteRepositoryOverride?: StudyRepository | null;
};

function globalState(): GlobalState {
  return globalThis as GlobalState;
}

export function __setStudyRepositoryOverride(
  repository: StudyRepository | null,
): void {
  globalState().__scienceswarmStudiesRouteRepositoryOverride = repository;
}

export function getStudiesRouteRepository(): StudyRepository {
  return globalState().__scienceswarmStudiesRouteRepositoryOverride
    ?? createStudyRepository();
}
