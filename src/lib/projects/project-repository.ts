import type { ProjectRecord, ProjectSlug } from "@/brain/gbrain-data-contracts";
import type { BrainStore } from "@/brain/store";
import type { GbrainClient } from "@/brain/gbrain-client";
import {
  createStudyRepository,
  DuplicateStudyError,
  projectRecordFromStudyRecord,
  slugifyStudyName,
  type StudyRepository,
} from "@/lib/studies/study-repository";

export interface ProjectRepository {
  list(): Promise<ProjectRecord[]>;
  get(slug: ProjectSlug): Promise<ProjectRecord | null>;
  create(input: {
    name: string;
    slug?: string;
    description?: string;
    createdBy: string;
  }): Promise<ProjectRecord>;
  delete(slug: ProjectSlug): Promise<{ ok: true; existed: boolean }>;
  touch(slug: ProjectSlug, at?: string): Promise<void>;
}

export interface ProjectRepositoryOptions {
  store?: BrainStore;
  client?: GbrainClient;
  now?: () => Date;
}

export class DuplicateProjectError extends Error {
  constructor(slug: string) {
    super(`Project already exists: ${slug}`);
    this.name = "DuplicateProjectError";
  }
}

export function createProjectRepository(
  options: ProjectRepositoryOptions = {},
): ProjectRepository {
  const studies = createStudyRepository(options);
  return projectRepositoryFromStudyRepository(studies);
}

export function projectRepositoryFromStudyRepository(
  studies: StudyRepository,
): ProjectRepository {
  return {
    async list(): Promise<ProjectRecord[]> {
      return (await studies.list()).map(projectRecordFromStudyRecord);
    },

    async get(slug: ProjectSlug): Promise<ProjectRecord | null> {
      const study = await studies.get(slug);
      return study ? projectRecordFromStudyRecord(study) : null;
    },

    async create(input): Promise<ProjectRecord> {
      try {
        return projectRecordFromStudyRecord(await studies.create(input));
      } catch (error) {
        if (error instanceof DuplicateStudyError) {
          throw new DuplicateProjectError(input.slug ?? slugifyStudyName(input.name));
        }
        throw error;
      }
    },

    async delete(slug: ProjectSlug): Promise<{ ok: true; existed: boolean }> {
      return studies.delete(slug);
    },

    async touch(slug: ProjectSlug, at?: string): Promise<void> {
      await studies.touch(slug, at);
    },
  };
}

export { slugifyStudyName as slugifyProjectName };
