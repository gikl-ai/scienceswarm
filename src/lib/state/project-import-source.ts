import { readdir } from "node:fs/promises";
import path from "node:path";
import { getScienceSwarmBrainRoot, resolveConfiguredPath } from "@/lib/scienceswarm-paths";
import { getLegacyProjectStudyFilePath } from "@/lib/studies/state";
import { readJsonFile, writeJsonFile } from "./atomic-json";
import { assertSafeProjectSlug } from "./project-manifests";
import { getProjectLocalStateRoot } from "./project-storage";

export interface ProjectImportSourceRecord {
  version: 1;
  project: string;
  folderPath: string;
  source: string;
  updatedAt: string;
  lastJobId?: string;
}

interface ImportJobCandidate {
  id?: unknown;
  project?: unknown;
  folderPath?: unknown;
  source?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
}

function getProjectImportSourcePath(project: string): string {
  return getLegacyProjectStudyFilePath(assertSafeProjectSlug(project), "import-source.json");
}

function getLegacyProjectImportSourcePath(project: string): string {
  return path.join(getProjectLocalStateRoot(assertSafeProjectSlug(project)), "import-source.json");
}

function getConfiguredBrainRoot(): string {
  return resolveConfiguredPath(process.env.BRAIN_ROOT) ?? getScienceSwarmBrainRoot();
}

function isProjectImportSourceRecord(value: unknown): value is ProjectImportSourceRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectImportSourceRecord>;
  return (
    candidate.version === 1
    && typeof candidate.project === "string"
    && typeof candidate.folderPath === "string"
    && typeof candidate.source === "string"
    && typeof candidate.updatedAt === "string"
    && (candidate.lastJobId === undefined || typeof candidate.lastJobId === "string")
  );
}

function normalizeJobSource(candidate: ImportJobCandidate): ProjectImportSourceRecord | null {
  if (
    typeof candidate.project !== "string"
    || typeof candidate.folderPath !== "string"
    || candidate.folderPath.trim().length === 0
  ) {
    return null;
  }

  const updatedAt = typeof candidate.updatedAt === "string"
    ? candidate.updatedAt
    : typeof candidate.createdAt === "string"
      ? candidate.createdAt
      : new Date().toISOString();

  return {
    version: 1,
    project: candidate.project,
    folderPath: candidate.folderPath,
    source: typeof candidate.source === "string" && candidate.source.trim().length > 0
      ? candidate.source
      : "background-local-import",
    updatedAt,
    ...(typeof candidate.id === "string" ? { lastJobId: candidate.id } : {}),
  };
}

async function inferProjectImportSourceFromJobs(
  project: string,
): Promise<ProjectImportSourceRecord | null> {
  const jobsRoot = path.join(getConfiguredBrainRoot(), "state", "import-jobs");
  let jobNames: string[];
  try {
    jobNames = await readdir(jobsRoot);
  } catch {
    return null;
  }

  let best: ProjectImportSourceRecord | null = null;
  let bestTs = Number.NEGATIVE_INFINITY;

  for (const jobName of jobNames) {
    if (!jobName.endsWith(".json")) continue;
    let raw: ImportJobCandidate | null;
    try {
      raw = await readJsonFile<ImportJobCandidate>(path.join(jobsRoot, jobName));
    } catch {
      continue;
    }
    if (!raw) continue;
    const normalized = normalizeJobSource(raw);
    if (!normalized || normalized.project !== project) continue;
    const timestamp = Date.parse(normalized.updatedAt);
    const score = Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
    if (!best || score > bestTs) {
      best = normalized;
      bestTs = score;
    }
  }

  return best;
}

export async function readProjectImportSource(
  project: string,
): Promise<ProjectImportSourceRecord | null> {
  const safeProject = assertSafeProjectSlug(project);
  let record: unknown = null;
  try {
    record = await readJsonFile<unknown>(getProjectImportSourcePath(safeProject));
  } catch {
    record = null;
  }
  if (isProjectImportSourceRecord(record) && record.project === safeProject) {
    return record;
  }

  try {
    record = await readJsonFile<unknown>(getLegacyProjectImportSourcePath(safeProject));
  } catch {
    record = null;
  }
  if (isProjectImportSourceRecord(record) && record.project === safeProject) {
    return record;
  }

  const inferred = await inferProjectImportSourceFromJobs(safeProject);
  if (!inferred) return null;

  try {
    await writeJsonFile(getProjectImportSourcePath(safeProject), inferred);
  } catch {
    // Best effort: callers can still use the inferred record for this request.
  }

  return inferred;
}

export async function writeProjectImportSource(
  project: string,
  input: Omit<ProjectImportSourceRecord, "version" | "project">,
): Promise<ProjectImportSourceRecord> {
  const safeProject = assertSafeProjectSlug(project);
  const record: ProjectImportSourceRecord = {
    version: 1,
    project: safeProject,
    folderPath: input.folderPath,
    source: input.source,
    updatedAt: input.updatedAt,
    ...(input.lastJobId ? { lastJobId: input.lastJobId } : {}),
  };
  await writeJsonFile(getProjectImportSourcePath(safeProject), record);
  return record;
}
