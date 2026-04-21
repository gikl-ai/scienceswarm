import path from "node:path";
import { getScienceSwarmStateRoot } from "@/lib/scienceswarm-paths";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./atomic-json";

export interface ScheduleStoreState {
  version: 1;
  jobs: Record<string, unknown>;
  pipelines: Record<string, unknown>;
  updatedAt: string;
}

export function getScheduleStorePath(root = getScienceSwarmStateRoot()): string {
  return path.join(root, "schedules", "jobs.json");
}

export async function readScheduleStore(
  root = getScienceSwarmStateRoot(),
): Promise<ScheduleStoreState | null> {
  return readJsonFile<ScheduleStoreState>(getScheduleStorePath(root));
}

export async function writeScheduleStore(
  store: ScheduleStoreState,
  root = getScienceSwarmStateRoot(),
): Promise<ScheduleStoreState> {
  await writeJsonFile(getScheduleStorePath(root), store);
  return store;
}

export async function updateScheduleStore(
  updater: (current: ScheduleStoreState | null) => ScheduleStoreState,
  root = getScienceSwarmStateRoot(),
): Promise<ScheduleStoreState> {
  return updateJsonFile<ScheduleStoreState>(getScheduleStorePath(root), updater);
}
