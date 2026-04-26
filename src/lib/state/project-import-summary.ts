import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./atomic-json";
import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import {
  getLegacyProjectStudyFilePath,
  writeStudyStateForProjectRecord,
} from "@/lib/studies/state";
import { assertSafeProjectSlug } from "./project-manifests";
import {
  getLegacyProjectImportSummaryPath,
  getProjectLocalImportSummaryPath,
  isProjectLocalStateRoot,
} from "./project-storage";

export interface ProjectImportDuplicateGroupRecord {
  id: string;
  paths: string[];
  reason: string;
  hashPrefix?: string;
  contentType?: string;
}

export interface ProjectImportSummary {
  name: string;
  preparedFiles: number;
  detectedItems?: number;
  detectedBytes?: number;
  duplicateGroups?: number;
  duplicateGroupDetails?: ProjectImportDuplicateGroupRecord[];
  generatedAt: string;
  source: string;
}

export interface ProjectImportSummaryRecord {
  project: string;
  lastImport: ProjectImportSummary | null;
}

export function getProjectImportSummaryPath(
  slug: string,
  root?: string,
): string {
  const safeSlug = assertSafeProjectSlug(slug);
  if (root) {
    if (isProjectLocalStateRoot(safeSlug, root)) {
      return join(root, "import-summary.json");
    }
    return getLegacyProjectImportSummaryPath(safeSlug, root);
  }
  return getProjectLocalImportSummaryPath(safeSlug);
}

function isProjectImportSummary(value: unknown): value is ProjectImportSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectImportSummary>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.preparedFiles === "number" &&
    (candidate.detectedItems === undefined || typeof candidate.detectedItems === "number") &&
    (candidate.detectedBytes === undefined || typeof candidate.detectedBytes === "number") &&
    (candidate.duplicateGroups === undefined || typeof candidate.duplicateGroups === "number") &&
    (
      candidate.duplicateGroupDetails === undefined
      || (
        Array.isArray(candidate.duplicateGroupDetails)
        && candidate.duplicateGroupDetails.every(isProjectImportDuplicateGroupRecord)
      )
    ) &&
    typeof candidate.generatedAt === "string" &&
    typeof candidate.source === "string"
  );
}

function isProjectImportDuplicateGroupRecord(
  value: unknown,
): value is ProjectImportDuplicateGroupRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ProjectImportDuplicateGroupRecord>;
  return (
    typeof candidate.id === "string"
    && Array.isArray(candidate.paths)
    && candidate.paths.every((entry) => typeof entry === "string")
    && typeof candidate.reason === "string"
    && (candidate.hashPrefix === undefined || typeof candidate.hashPrefix === "string")
    && (candidate.contentType === undefined || typeof candidate.contentType === "string")
  );
}

function isProjectImportSummaryRecord(value: unknown): value is ProjectImportSummaryRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProjectImportSummaryRecord>;
  return (
    typeof candidate.project === "string" &&
    (candidate.lastImport === null || isProjectImportSummary(candidate.lastImport))
  );
}

export async function readProjectImportSummary(
  slug: string,
  root?: string,
): Promise<ProjectImportSummaryRecord | null> {
  const safeSlug = assertSafeProjectSlug(slug);
  const raw = root
    ? await readJsonFile<unknown>(getProjectImportSummaryPath(safeSlug, root))
    : await readDefaultProjectImportSummary(safeSlug);
  if (!raw || !isProjectImportSummaryRecord(raw)) {
    return null;
  }

  if (raw.project !== safeSlug) {
    return null;
  }

  return raw;
}

export async function writeProjectImportSummary(
  slug: string,
  lastImport: ProjectImportSummary | null,
  root?: string,
): Promise<ProjectImportSummaryRecord> {
  const project = assertSafeProjectSlug(slug);
  const record: ProjectImportSummaryRecord = {
    project,
    lastImport,
  };
  if (root) {
    await writeJsonFile(getProjectImportSummaryPath(project, root), record);
  } else {
    await writeStudyStateForProjectRecord({
      slug: project,
      lastActive: lastImport?.generatedAt ?? new Date().toISOString(),
    });
    await writeJsonFile(getLegacyProjectStudyFilePath(project, "import-summary.json"), record);
  }
  return record;
}

async function readDefaultProjectImportSummary(
  project: string,
): Promise<unknown | null> {
  return await readJsonFile<unknown>(getLegacyProjectStudyFilePath(project, "import-summary.json"))
    ?? await readJsonFile<unknown>(getProjectLocalImportSummaryPath(project))
    ?? await readJsonFile<unknown>(
      getLegacyProjectImportSummaryPath(project, join(getScienceSwarmBrainRoot(), "state")),
    );
}
