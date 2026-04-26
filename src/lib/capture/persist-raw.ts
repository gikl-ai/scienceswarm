import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, updateJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import type { CaptureEnvelope, CaptureKind, PrivacyMode, SourceRef } from "@/brain/types";

export interface PersistRawInput {
  brainRoot: string;
  captureId: string;
  channel: CaptureEnvelope["channel"];
  userId: string;
  kind: CaptureKind;
  project: string | null;
  privacy: PrivacyMode;
  content: string;
  transcript?: string;
  attachmentPaths?: string[];
  sourceRefs?: SourceRef[];
  requiresClarification?: boolean;
  clarificationQuestion?: string;
}

export interface PersistedRawCapture extends CaptureEnvelope {
  content: string;
  createdAt: string;
  materializedPath?: string;
}

async function findCaptureFile(
  baseDir: string,
  captureId: string,
): Promise<string | null> {
  let entries: Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
  }>;
  try {
    entries = (await readdir(baseDir, { withFileTypes: true, encoding: "utf8" })) as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }

  for (const entry of entries) {
    const candidate = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findCaptureFile(candidate, captureId);
      if (nested) return nested;
      continue;
    }

    if (entry.isFile() && entry.name === `${captureId}.json`) {
      return candidate;
    }
  }

  return null;
}

function isSafeRawPath(rawPath: string, channel: CaptureEnvelope["channel"]): boolean {
  const normalized = rawPath.replaceAll("\\", "/");
  if (!normalized.startsWith(`raw/captures/${channel}/`)) return false;
  if (!normalized.endsWith(".json")) return false;
  if (normalized.includes("..")) return false;
  return true;
}

function rawPathMatchesCaptureId(rawPath: string, captureId: string): boolean {
  const normalized = rawPath.replaceAll("\\", "/");
  return normalized.endsWith(`/${captureId}.json`);
}

async function resolveCapturePath(
  brainRoot: string,
  channel: CaptureEnvelope["channel"],
  captureId: string,
  rawPath?: string,
): Promise<string | null> {
  if (
    rawPath
    && isSafeRawPath(rawPath, channel)
    && rawPathMatchesCaptureId(rawPath, captureId)
  ) {
    const fastPath = join(brainRoot, rawPath);
    try {
      await access(fastPath);
      return fastPath;
    } catch {
      // Fall through to legacy recursive scan for backward compatibility.
    }
  }

  return findCaptureFile(join(brainRoot, "raw", "captures", channel), captureId);
}

export async function persistRawCapture(input: PersistRawInput): Promise<PersistedRawCapture> {
  const createdAt = new Date().toISOString();
  const dateFolder = createdAt.slice(0, 10);
  const rawPath = join(
    "raw",
    "captures",
    input.channel,
    dateFolder,
    `${input.captureId}.json`,
  ).replaceAll("\\", "/");

  const record: PersistedRawCapture = {
    captureId: input.captureId,
    channel: input.channel,
    userId: input.userId,
    kind: input.kind,
    study: input.project,
    project: input.project,
    privacy: input.privacy,
    sourceRefs: input.sourceRefs ?? [],
    rawPath,
    attachmentPaths: input.attachmentPaths ?? [],
    transcript: input.transcript,
    requiresClarification: input.requiresClarification ?? false,
    clarificationQuestion: input.clarificationQuestion,
    content: input.content,
    createdAt,
  };

  await writeJsonFile(join(input.brainRoot, rawPath), record);
  return record;
}

export async function readPersistedRawCapture(
  brainRoot: string,
  channel: CaptureEnvelope["channel"],
  captureId: string,
  rawPath?: string,
): Promise<PersistedRawCapture | null> {
  const capturePath = await resolveCapturePath(brainRoot, channel, captureId, rawPath);
  if (!capturePath) {
    return null;
  }

  return readJsonFile<PersistedRawCapture>(capturePath);
}

export async function updatePersistedRawCapture(
  brainRoot: string,
  channel: CaptureEnvelope["channel"],
  captureId: string,
  updater: (current: PersistedRawCapture) => PersistedRawCapture,
  rawPath?: string,
): Promise<PersistedRawCapture> {
  const capturePath = await resolveCapturePath(brainRoot, channel, captureId, rawPath);
  if (!capturePath) {
    throw new Error(`Capture ${captureId} not found`);
  }

  return updateJsonFile<PersistedRawCapture>(capturePath, (current) => {
    if (!current) {
      throw new Error(`Capture ${captureId} not found`);
    }
    return updater(current);
  });
}
