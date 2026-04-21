import { existsSync, readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveConfiguredPath } from "@/lib/scienceswarm-paths";

import {
  isOpenHandsContextLengthReady,
  resolveConfiguredLocalModel,
  resolveOpenHandsLocalRuntimeConfig,
} from "./model-catalog";

export interface OpenHandsLocalSmokeEvidence {
  schemaVersion: 1;
  checkedAt: string;
  localModel: string;
  openHandsModel: string;
  endpoint: string;
  contextLength: number;
  minimumContext: number;
  localModelVerified: boolean;
  gbrainWritebackVerified: boolean;
  proof?: {
    dockerToOllamaModels?: boolean;
    dockerToOllamaChat?: boolean;
    gbrainWriteback?: boolean;
  };
}

export interface OpenHandsLocalEvidenceSnapshot {
  localModelConfigured: boolean;
  localModelVerified: boolean;
  gbrainWritebackVerified: boolean;
  contextLength: number;
  minimumContext: number;
  evidenceObservedAt?: string;
  evidenceStale?: boolean;
}

const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_RELATIVE_PATH = path.join(
  "runtime",
  "openhands-local-smoke.json",
);

function dataRootFromEnv(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv,
): string {
  return (
    resolveConfiguredPath(env.SCIENCESWARM_DIR) ??
    path.join(os.homedir(), ".scienceswarm")
  );
}

export function getOpenHandsLocalEvidencePath(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): string {
  return (
    resolveConfiguredPath(env.SCIENCESWARM_OPENHANDS_LOCAL_EVIDENCE_PATH) ??
    path.join(dataRootFromEnv(env), EVIDENCE_RELATIVE_PATH)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvidence(value: unknown): OpenHandsLocalSmokeEvidence | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (typeof value.checkedAt !== "string") return null;
  if (typeof value.localModel !== "string") return null;
  if (typeof value.openHandsModel !== "string") return null;
  if (typeof value.endpoint !== "string") return null;
  if (typeof value.contextLength !== "number") return null;
  if (typeof value.minimumContext !== "number") return null;
  if (typeof value.localModelVerified !== "boolean") return null;
  if (typeof value.gbrainWritebackVerified !== "boolean") return null;
  return {
    schemaVersion: 1,
    checkedAt: value.checkedAt,
    localModel: value.localModel,
    openHandsModel: value.openHandsModel,
    endpoint: value.endpoint,
    contextLength: value.contextLength,
    minimumContext: value.minimumContext,
    localModelVerified: value.localModelVerified,
    gbrainWritebackVerified: value.gbrainWritebackVerified,
    proof: isRecord(value.proof)
      ? {
          dockerToOllamaModels:
            typeof value.proof.dockerToOllamaModels === "boolean"
              ? value.proof.dockerToOllamaModels
              : undefined,
          dockerToOllamaChat:
            typeof value.proof.dockerToOllamaChat === "boolean"
              ? value.proof.dockerToOllamaChat
              : undefined,
          gbrainWriteback:
            typeof value.proof.gbrainWriteback === "boolean"
              ? value.proof.gbrainWriteback
              : undefined,
        }
      : undefined,
  };
}

export async function readOpenHandsLocalEvidence(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): Promise<OpenHandsLocalSmokeEvidence | null> {
  if (
    process.env.NODE_ENV === "test"
    && !env.SCIENCESWARM_OPENHANDS_LOCAL_EVIDENCE_PATH
  ) {
    return null;
  }
  try {
    const raw = await fs.readFile(getOpenHandsLocalEvidencePath(env), "utf8");
    return parseEvidence(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readOpenHandsLocalEvidenceSync(
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): OpenHandsLocalSmokeEvidence | null {
  if (
    process.env.NODE_ENV === "test"
    && !env.SCIENCESWARM_OPENHANDS_LOCAL_EVIDENCE_PATH
  ) {
    return null;
  }
  try {
    const filePath = getOpenHandsLocalEvidencePath(env);
    if (!existsSync(filePath)) return null;
    return parseEvidence(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

export async function writeOpenHandsLocalEvidence(
  evidence: OpenHandsLocalSmokeEvidence,
  env: Record<string, string | undefined> | NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const filePath = getOpenHandsLocalEvidencePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return filePath;
}

function isEvidenceStale(evidence: OpenHandsLocalSmokeEvidence): boolean {
  const observed = Date.parse(evidence.checkedAt);
  if (!Number.isFinite(observed)) return true;
  return Date.now() - observed > EVIDENCE_MAX_AGE_MS;
}

export function buildOpenHandsLocalEvidenceSnapshot(
  input: {
    env?: Record<string, string | undefined> | NodeJS.ProcessEnv;
    evidence?: OpenHandsLocalSmokeEvidence | null;
  } = {},
): OpenHandsLocalEvidenceSnapshot {
  const env = input.env ?? process.env;
  const runtime = resolveOpenHandsLocalRuntimeConfig(env);
  const localModel = resolveConfiguredLocalModel(env);
  const contextReady = isOpenHandsContextLengthReady(runtime.contextLength);
  const evidence = input.evidence ?? null;
  const evidenceCurrent = Boolean(evidence
    && !isEvidenceStale(evidence)
    && evidence.localModel === localModel
    && evidence.openHandsModel === runtime.model
    && evidence.endpoint === runtime.baseUrl
    && evidence.contextLength === runtime.contextLength
    && evidence.minimumContext === runtime.minimumContext);

  return {
    localModelConfigured:
      env.LLM_PROVIDER?.trim().toLowerCase() === "local" && contextReady,
    localModelVerified: evidenceCurrent
      ? evidence?.localModelVerified === true
      : false,
    gbrainWritebackVerified: evidenceCurrent
      ? evidence?.gbrainWritebackVerified === true
      : false,
    contextLength: runtime.contextLength,
    minimumContext: runtime.minimumContext,
    evidenceObservedAt: evidence?.checkedAt,
    evidenceStale: evidence ? !evidenceCurrent : undefined,
  };
}
