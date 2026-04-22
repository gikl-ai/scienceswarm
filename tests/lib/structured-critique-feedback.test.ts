import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendStructuredCritiqueFeedback,
  getStructuredCritiqueFeedbackDir,
  getStructuredCritiqueFeedbackPath,
  readStructuredCritiqueFeedback,
  type StructuredCritiqueFeedbackRecord,
} from "@/lib/structured-critique-feedback";

const ORIGINAL_BRAIN_ROOT = process.env.BRAIN_ROOT;
const ORIGINAL_FEEDBACK_DIR = process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR;
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const TEMP_DIRS: string[] = [];

afterEach(async () => {
  restoreEnv("BRAIN_ROOT", ORIGINAL_BRAIN_ROOT);
  restoreEnv("STRUCTURED_CRITIQUE_FEEDBACK_DIR", ORIGINAL_FEEDBACK_DIR);
  restoreEnv("SCIENCESWARM_DIR", ORIGINAL_SCIENCESWARM_DIR);
  await Promise.all(
    TEMP_DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("getStructuredCritiqueFeedbackDir", () => {
  it("stores feedback under gbrain state by default", () => {
    delete process.env.BRAIN_ROOT;
    delete process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR;
    process.env.SCIENCESWARM_DIR = "/tmp/scienceswarm-feedback";

    expect(getStructuredCritiqueFeedbackDir()).toBe(
      path.join("/tmp/scienceswarm-feedback", "brain", "state", "feedback"),
    );
  });

  it("preserves explicit feedback directory overrides", () => {
    process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR = "/tmp/feedback-override";

    expect(getStructuredCritiqueFeedbackDir()).toBe("/tmp/feedback-override");
  });

  it("imports legacy default feedback before reading from the new gbrain state path", async () => {
    const root = await makeTempScienceSwarmDir();
    const legacyRecord = makeFeedbackRecord("legacy-job", "finding-a");

    await writeLegacyFeedback(root, [legacyRecord]);

    await expect(readStructuredCritiqueFeedback()).resolves.toEqual([
      legacyRecord,
    ]);
    await expect(fs.readFile(getStructuredCritiqueFeedbackPath(), "utf-8")).resolves.toBe(
      JSON.stringify(legacyRecord) + "\n",
    );
  });

  it("migrates legacy feedback before appending new default-path records", async () => {
    const root = await makeTempScienceSwarmDir();
    const legacyRecord = makeFeedbackRecord("legacy-job", "finding-a");
    const newRecord = makeFeedbackRecord("new-job", "finding-b");

    await writeLegacyFeedback(root, [legacyRecord]);
    await appendStructuredCritiqueFeedback(newRecord);

    await expect(readStructuredCritiqueFeedback()).resolves.toEqual([
      newRecord,
      legacyRecord,
    ]);
  });

  it("preserves existing new-path feedback when importing legacy records", async () => {
    const root = await makeTempScienceSwarmDir();
    const legacyRecord = makeFeedbackRecord("legacy-job", "finding-a");
    const existingRecord = makeFeedbackRecord("existing-job", "finding-b");

    await writeLegacyFeedback(root, [legacyRecord]);
    await writeNewFeedback([existingRecord]);

    await expect(readStructuredCritiqueFeedback()).resolves.toEqual([
      existingRecord,
      legacyRecord,
    ]);
  });

  it("serializes first-run legacy imports across concurrent appends", async () => {
    const root = await makeTempScienceSwarmDir();
    const legacyRecord = makeFeedbackRecord("legacy-job", "finding-a");
    const firstRecord = makeFeedbackRecord("new-job", "finding-b");
    const secondRecord = makeFeedbackRecord("second-job", "finding-c");

    await writeLegacyFeedback(root, [legacyRecord]);
    await Promise.all([
      appendStructuredCritiqueFeedback(firstRecord),
      appendStructuredCritiqueFeedback(secondRecord),
    ]);

    await expect(readStructuredCritiqueFeedback()).resolves.toEqual([
      secondRecord,
      firstRecord,
      legacyRecord,
    ]);
  });

  it("does not duplicate legacy records after the first import", async () => {
    const root = await makeTempScienceSwarmDir();
    const legacyRecord = makeFeedbackRecord("legacy-job", "finding-a");

    await writeLegacyFeedback(root, [legacyRecord]);
    await readStructuredCritiqueFeedback();
    await readStructuredCritiqueFeedback();

    await expect(readStructuredCritiqueFeedback()).resolves.toEqual([
      legacyRecord,
    ]);
  });

  it("does not import legacy defaults when an explicit feedback directory is configured", async () => {
    const root = await makeTempScienceSwarmDir();
    process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR = path.join(
      root,
      "custom-feedback",
    );
    const legacyRecord = makeFeedbackRecord("legacy-job", "finding-a");

    await writeLegacyFeedback(root, [legacyRecord]);

    await expect(readStructuredCritiqueFeedback()).resolves.toEqual([]);
  });
});

async function makeTempScienceSwarmDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceswarm-feedback-"));
  TEMP_DIRS.push(root);
  delete process.env.BRAIN_ROOT;
  delete process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR;
  process.env.SCIENCESWARM_DIR = root;
  return root;
}

async function writeLegacyFeedback(
  root: string,
  records: StructuredCritiqueFeedbackRecord[],
): Promise<void> {
  const legacyDir = path.join(root, "feedback");
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(
    path.join(legacyDir, "critique-feedback.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf-8",
  );
}

async function writeNewFeedback(
  records: StructuredCritiqueFeedbackRecord[],
): Promise<void> {
  await fs.mkdir(getStructuredCritiqueFeedbackDir(), { recursive: true });
  await fs.writeFile(
    getStructuredCritiqueFeedbackPath(),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf-8",
  );
}

function makeFeedbackRecord(
  jobId: string,
  findingId: string,
): StructuredCritiqueFeedbackRecord {
  const timestamps: Record<string, string> = {
    "legacy-job": "2026-04-22T21:00:00.000Z",
    "existing-job": "2026-04-22T21:04:00.000Z",
    "new-job": "2026-04-22T21:05:00.000Z",
    "second-job": "2026-04-22T21:06:00.000Z",
  };

  return {
    job_id: jobId,
    finding_id: findingId,
    useful: true,
    would_revise: false,
    timestamp: timestamps[jobId] ?? "2026-04-22T21:03:00.000Z",
    user_id: "local-user",
  };
}
