import { promises as fs } from "fs";
import type { FileHandle } from "fs/promises";
import { join } from "path";
import {
  getScienceSwarmBrainRoot,
  getScienceSwarmDataRoot,
} from "@/lib/scienceswarm-paths";

const FEEDBACK_FILE_NAME = "critique-feedback.jsonl";
const LEGACY_IMPORT_MARKER_NAME = ".critique-feedback-legacy-imported";
const LEGACY_IMPORT_LOCK_NAME = ".critique-feedback-legacy-import.lock";

export interface StructuredCritiqueFeedbackRecord {
  job_id: string;
  finding_id: string;
  useful: boolean;
  would_revise: boolean;
  comment?: string;
  timestamp: string;
  user_id: string;
}

export interface StructuredCritiqueFeedbackSummary {
  total: number;
  useful: number;
  notUseful: number;
  wouldRevise: number;
  wouldNotRevise: number;
  latestTimestamp: string | null;
  unresolvedConcerns: number;
}

export function getStructuredCritiqueFeedbackDir(): string {
  if (process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR) {
    return process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR;
  }
  return join(getScienceSwarmBrainRoot(), "state", "feedback");
}

export function getStructuredCritiqueFeedbackPath(): string {
  return join(getStructuredCritiqueFeedbackDir(), FEEDBACK_FILE_NAME);
}

function getLegacyStructuredCritiqueFeedbackPath(): string | null {
  if (process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR) {
    return null;
  }
  return join(getScienceSwarmDataRoot(), "feedback", FEEDBACK_FILE_NAME);
}

async function migrateLegacyStructuredCritiqueFeedbackIfNeeded(): Promise<void> {
  const legacyPath = getLegacyStructuredCritiqueFeedbackPath();
  if (!legacyPath) return;

  const feedbackDir = getStructuredCritiqueFeedbackDir();
  const feedbackPath = getStructuredCritiqueFeedbackPath();
  if (legacyPath === feedbackPath) return;

  await withLegacyImportLock(feedbackDir, async () => {
    const markerPath = join(feedbackDir, LEGACY_IMPORT_MARKER_NAME);
    if (await fileExists(markerPath)) return;

    const legacyRaw = await readOptionalFile(legacyPath);
    if (!legacyRaw) return;

    const existingRaw = await readOptionalFile(feedbackPath);
    if (existingRaw) {
      const separator =
        legacyRaw.endsWith("\n") || existingRaw.startsWith("\n") ? "" : "\n";
      await fs.writeFile(feedbackPath, legacyRaw + separator + existingRaw, "utf-8");
    } else {
      await fs.writeFile(feedbackPath, legacyRaw, "utf-8");
    }

    await fs.writeFile(markerPath, new Date().toISOString() + "\n", "utf-8");
  });
}

async function withLegacyImportLock<T>(
  feedbackDir: string,
  run: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(feedbackDir, { recursive: true });
  const lockPath = join(feedbackDir, LEGACY_IMPORT_LOCK_NAME);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    let handle: FileHandle | null = null;
    try {
      handle = await fs.open(lockPath, "wx");
      try {
        return await run();
      } finally {
        const acquiredHandle = handle;
        handle = null;
        await acquiredHandle.close();
        await fs.rm(lockPath, { force: true });
      }
    } catch (err) {
      if (!isFileAlreadyExistsError(err)) {
        if (handle) await handle.close();
        throw err;
      }
      await sleep(25);
    }
  }

  throw new Error("Timed out waiting for structured critique feedback migration lock");
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf-8");
  } catch (err) {
    if (isFileNotFoundError(err)) return null;
    throw err;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (err) {
    if (isFileNotFoundError(err)) return false;
    throw err;
  }
}

function isFileNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function isFileAlreadyExistsError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function summarizeStructuredCritiqueFeedback(
  records: StructuredCritiqueFeedbackRecord[],
): StructuredCritiqueFeedbackSummary {
  return {
    total: records.length,
    useful: records.filter((record) => record.useful).length,
    notUseful: records.filter((record) => !record.useful).length,
    wouldRevise: records.filter((record) => record.would_revise).length,
    wouldNotRevise: records.filter((record) => !record.would_revise).length,
    latestTimestamp:
      records
        .map((record) => record.timestamp)
        .sort()
        .at(-1) ?? null,
    unresolvedConcerns: records.filter(
      (record) => !record.useful || record.would_revise,
    ).length,
  };
}

export async function appendStructuredCritiqueFeedback(
  record: StructuredCritiqueFeedbackRecord,
): Promise<void> {
  await migrateLegacyStructuredCritiqueFeedbackIfNeeded();
  const feedbackDir = getStructuredCritiqueFeedbackDir();
  const feedbackPath = getStructuredCritiqueFeedbackPath();
  await fs.mkdir(feedbackDir, { recursive: true });
  await fs.appendFile(feedbackPath, JSON.stringify(record) + "\n", "utf-8");
}

export async function readStructuredCritiqueFeedback(
  filters: {
    jobId?: string | null;
    findingId?: string | null;
  } = {},
): Promise<StructuredCritiqueFeedbackRecord[]> {
  await migrateLegacyStructuredCritiqueFeedbackIfNeeded();
  let raw: string;
  try {
    raw = await fs.readFile(getStructuredCritiqueFeedbackPath(), "utf-8");
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StructuredCritiqueFeedbackRecord)
    .filter((record) => !filters.jobId || record.job_id === filters.jobId)
    .filter((record) => !filters.findingId || record.finding_id === filters.findingId)
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}
