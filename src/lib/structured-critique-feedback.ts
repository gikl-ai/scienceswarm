import { promises as fs } from "fs";
import { join } from "path";
import {
  getScienceSwarmBrainRoot,
  getScienceSwarmDataRoot,
} from "@/lib/scienceswarm-paths";

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
  return join(getStructuredCritiqueFeedbackDir(), "critique-feedback.jsonl");
}

function getLegacyStructuredCritiqueFeedbackPath(): string | null {
  if (process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR) {
    return null;
  }
  return join(getScienceSwarmDataRoot(), "feedback", "critique-feedback.jsonl");
}

async function migrateLegacyStructuredCritiqueFeedbackIfNeeded(): Promise<void> {
  const legacyPath = getLegacyStructuredCritiqueFeedbackPath();
  if (!legacyPath) return;

  const feedbackPath = getStructuredCritiqueFeedbackPath();
  if (legacyPath === feedbackPath) return;

  try {
    await fs.access(feedbackPath);
    return;
  } catch (err) {
    if (!(typeof err === "object" && err && "code" in err && err.code === "ENOENT")) {
      throw err;
    }
  }

  try {
    await fs.access(legacyPath);
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && err.code === "ENOENT") {
      return;
    }
    throw err;
  }

  await fs.mkdir(getStructuredCritiqueFeedbackDir(), { recursive: true });
  await fs.copyFile(legacyPath, feedbackPath);
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
