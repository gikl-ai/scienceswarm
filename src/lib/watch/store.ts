import { getProjectWatchConfigPath } from "@/lib/state/project-manifests";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import type { ProjectWatchConfig } from "./types";

export function createDefaultProjectWatchConfig(): ProjectWatchConfig {
  return {
    version: 1,
    keywords: [],
    promotionThreshold: 5,
    stagingThreshold: 2,
    schedule: {
      enabled: false,
      cadence: "daily",
      time: "08:00",
      timezone: "local",
    },
    sources: [],
  };
}

export async function readProjectWatchConfig(
  projectSlug: string,
  stateRoot: string,
): Promise<ProjectWatchConfig | null> {
  return readJsonFile<ProjectWatchConfig>(getProjectWatchConfigPath(projectSlug, stateRoot));
}

export async function writeProjectWatchConfig(
  projectSlug: string,
  config: ProjectWatchConfig,
  stateRoot: string,
): Promise<ProjectWatchConfig> {
  await writeJsonFile(getProjectWatchConfigPath(projectSlug, stateRoot), config);
  return config;
}
