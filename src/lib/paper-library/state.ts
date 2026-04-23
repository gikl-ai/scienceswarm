import path from "node:path";
import { z } from "zod";
import {
  PAPER_LIBRARY_STATE_VERSION,
  ProjectSlugSchema,
  RepairableStateSchema,
  type RepairableState,
} from "./contracts";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import { assertSafeProjectSlug, getProjectStateDir } from "@/lib/state/project-manifests";

export const PAPER_LIBRARY_STATE_DIR = "paper-library";

export interface ParsePersistedStateResult<T> {
  ok: true;
  data: T;
}

export interface ParsePersistedStateRepairable {
  ok: false;
  repairable: RepairableState;
}

export function getPaperLibraryStateDir(project: string, stateRoot?: string): string {
  const safeProject = assertSafeProjectSlug(project);
  return path.join(getProjectStateDir(safeProject, stateRoot), PAPER_LIBRARY_STATE_DIR);
}

export function getPaperLibraryScanPath(project: string, scanId: string, stateRoot?: string): string {
  return path.join(getPaperLibraryStateDir(project, stateRoot), "scans", `${encodeURIComponent(scanId)}.json`);
}

export function getPaperLibraryReviewShardPath(
  project: string,
  scanId: string,
  shardId: string,
  stateRoot?: string,
): string {
  return path.join(
    getPaperLibraryStateDir(project, stateRoot),
    "reviews",
    encodeURIComponent(scanId),
    `${encodeURIComponent(shardId)}.json`,
  );
}

export function getPaperLibraryApplyPlanPath(project: string, applyPlanId: string, stateRoot?: string): string {
  return path.join(getPaperLibraryStateDir(project, stateRoot), "apply-plans", `${encodeURIComponent(applyPlanId)}.json`);
}

export function getPaperLibraryApplyOperationShardPath(
  project: string,
  applyPlanId: string,
  shardId: string,
  stateRoot?: string,
): string {
  return path.join(
    getPaperLibraryStateDir(project, stateRoot),
    "apply-plans",
    encodeURIComponent(applyPlanId),
    `${encodeURIComponent(shardId)}.json`,
  );
}

export function getPaperLibraryManifestPath(project: string, manifestId: string, stateRoot?: string): string {
  return path.join(getPaperLibraryStateDir(project, stateRoot), "manifests", `${encodeURIComponent(manifestId)}.json`);
}

export function getPaperLibraryManifestOperationShardPath(
  project: string,
  manifestId: string,
  shardId: string,
  stateRoot?: string,
): string {
  return path.join(
    getPaperLibraryStateDir(project, stateRoot),
    "manifests",
    encodeURIComponent(manifestId),
    `${encodeURIComponent(shardId)}.json`,
  );
}

export function getPaperLibraryIdempotencyPath(project: string, idempotencyKey: string, stateRoot?: string): string {
  return path.join(getPaperLibraryStateDir(project, stateRoot), "idempotency", `${encodeURIComponent(idempotencyKey)}.json`);
}

export function getPaperLibraryApplyIdempotencyPath(project: string, idempotencyKey: string, stateRoot?: string): string {
  return path.join(getPaperLibraryStateDir(project, stateRoot), "apply-idempotency", `${encodeURIComponent(idempotencyKey)}.json`);
}

export function getPaperLibraryEnrichmentCachePath(project: string, stateRoot?: string): string {
  return path.join(getPaperLibraryStateDir(project, stateRoot), "enrichment-cache.json");
}

export function getPaperLibraryGraphPath(project: string, scanId: string, stateRoot?: string): string {
  return path.join(getPaperLibraryStateDir(project, stateRoot), "graphs", `${encodeURIComponent(scanId)}.json`);
}

export function parsePersistedState<T>(
  value: unknown,
  schema: z.ZodType<T>,
  options: { path?: string; kind: string },
): ParsePersistedStateResult<T> | ParsePersistedStateRepairable {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };

  const version = typeof value === "object" && value !== null && "version" in value
    ? (value as { version?: unknown }).version
    : undefined;
  const code = version !== undefined && version !== PAPER_LIBRARY_STATE_VERSION
    ? "unsupported_version"
    : "malformed";

  return {
    ok: false,
    repairable: RepairableStateSchema.parse({
      ok: false,
      code,
      path: options.path,
      message: `${options.kind} state is ${code === "malformed" ? "malformed" : "from an unsupported version"}.`,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    }),
  };
}

export async function readPersistedState<T>(
  filePath: string,
  schema: z.ZodType<T>,
  kind: string,
): Promise<ParsePersistedStateResult<T> | ParsePersistedStateRepairable> {
  const value = await readJsonFile<unknown>(filePath);
  if (value === null) {
    return {
      ok: false,
      repairable: {
        ok: false,
        code: "missing",
        path: filePath,
        message: `${kind} state is missing.`,
        issues: [],
      },
    };
  }
  return parsePersistedState(value, schema, { path: filePath, kind });
}

export async function writePersistedState<T>(
  filePath: string,
  schema: z.ZodType<T>,
  value: T,
): Promise<T> {
  const parsed = schema.parse(value);
  await writeJsonFile(filePath, parsed);
  return parsed;
}

export function assertPaperLibraryProject(project: string): string {
  return ProjectSlugSchema.parse(project);
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
  totalCount: number;
  filteredCount: number;
}

export function readCursorWindow<T>(
  items: T[],
  options: { cursor?: string; limit?: number },
): CursorPage<T> {
  const limit = Math.max(1, Math.min(250, options.limit ?? 50));
  const start = options.cursor ? Number(Buffer.from(options.cursor, "base64url").toString("utf-8")) : 0;
  if (!Number.isInteger(start) || start < 0) {
    throw new Error("invalid_cursor");
  }
  const window = items.slice(start, start + limit);
  const nextIndex = start + window.length;
  return {
    items: window,
    nextCursor: nextIndex < items.length ? Buffer.from(String(nextIndex), "utf-8").toString("base64url") : undefined,
    totalCount: items.length,
    filteredCount: items.length,
  };
}
