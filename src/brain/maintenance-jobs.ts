import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { BrainConfig } from "./types";
import { generateHealthReportWithGbrain } from "./brain-health";
import { buildScienceSwarmMaintenanceContext } from "./maintenance-context";
import {
  buildBrainMaintenancePlan,
  type BrainMaintenanceRecommendation,
  type MaintenanceActionId,
} from "./maintenance-recommendations";
import {
  ensureBrainStoreReady,
  getBrainStore,
  resolveBrainStorePglitePath,
} from "./store";
import type { GbrainEngineAdapter } from "./stores/gbrain-engine-adapter";
import {
  performRuntimeSync,
  runRuntimeEmbed,
  runRuntimeExtract,
} from "./stores/gbrain-runtime.mjs";
import { enqueueGbrainWrite } from "@/lib/gbrain/write-queue";
import { resolveConfiguredPath } from "@/lib/scienceswarm-paths";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";

export type MaintenanceJobMode = "dry-run" | "start";
export type MaintenanceJobStatus = "queued" | "running" | "completed" | "failed";
export type MaintenanceJobPhase =
  | "preview"
  | "queued"
  | "running"
  | "complete"
  | "failed";

export type MaintenanceJobAction = Exclude<MaintenanceActionId, "no-action">;

export interface MaintenanceJobProgress {
  phase: MaintenanceJobPhase;
  message: string;
}

export interface MaintenanceJobResult {
  summary: string;
  steps: string[];
  warnings: string[];
  metrics?: Record<string, unknown>;
  recommendation?: BrainMaintenanceRecommendation;
}

export interface MaintenanceJobRecord {
  id: string;
  action: MaintenanceJobAction;
  mode: MaintenanceJobMode;
  status: MaintenanceJobStatus;
  createdAt: string;
  updatedAt: string;
  storeId: string;
  previewJobId?: string;
  repoPath?: string;
  progress: MaintenanceJobProgress;
  result: MaintenanceJobResult | null;
  error: string | null;
}

export interface StartMaintenanceJobInput {
  config: BrainConfig;
  action: string;
  mode?: string;
  previewJobId?: string;
  repoPath?: string;
}

export interface MaintenanceJobRuntime {
  executeJob?: (
    job: MaintenanceJobRecord,
    input: StartMaintenanceJobInput,
  ) => Promise<MaintenanceJobResult>;
}

export class MaintenanceJobValidationError extends Error {
  readonly status = 400;
}

export class MaintenanceJobConflictError extends Error {
  readonly status = 409;
}

export class MaintenanceJobNotFoundError extends Error {
  readonly status = 404;
}

const MAINTENANCE_JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

const VALID_ACTIONS = new Set<MaintenanceJobAction>([
  "refresh-embeddings",
  "repair-dead-links",
  "extract-links",
  "extract-timeline",
  "configure-integrations",
  "configure-sync",
  "sync-from-repo",
  "compile-stale-pages",
  "audit-citations",
]);

const RUNNABLE_ACTIONS = new Set<MaintenanceJobAction>([
  "refresh-embeddings",
  "extract-links",
  "extract-timeline",
  "sync-from-repo",
]);

const activeStoreLocks = new Set<string>();

export function isValidMaintenanceJobId(id: string): boolean {
  return MAINTENANCE_JOB_ID_PATTERN.test(id);
}

export async function readMaintenanceJob(
  id: string,
  brainRoot: string,
): Promise<MaintenanceJobRecord | null> {
  if (!isValidMaintenanceJobId(id)) {
    throw new MaintenanceJobValidationError(
      "id is required and must be a valid maintenance job ID",
    );
  }
  return readJsonFile<MaintenanceJobRecord>(getMaintenanceJobPath(id, brainRoot));
}

export async function startMaintenanceJob(
  input: StartMaintenanceJobInput,
  runtime: MaintenanceJobRuntime = {},
): Promise<MaintenanceJobRecord> {
  const action = parseAction(input.action);
  const mode = parseMode(input.mode);
  const storeId = getStoreId();

  if (mode === "dry-run") {
    const job = makeJob(action, "dry-run", storeId, {
      repoPath: normalizeRepoPath(input.repoPath) ?? undefined,
    });
    await writeJob(input.config.root, job);
    const result = await buildDryRunResult(input.config, action, job.repoPath);
    const completed = {
      ...job,
      status: "completed" as const,
      updatedAt: new Date().toISOString(),
      progress: {
        phase: "complete" as const,
        message: "Dry-run preview completed; no brain writes were performed.",
      },
      result,
    };
    await writeJob(input.config.root, completed);
    return completed;
  }

  if (!RUNNABLE_ACTIONS.has(action)) {
    throw new MaintenanceJobValidationError(
      `${action} is a recommendation-only action; use OpenClaw/OpenHands for the approved manual workflow.`,
    );
  }

  const preview = await validatePreview(input, action, storeId);
  const repoPath = normalizeRepoPath(input.repoPath) ?? preview.repoPath;
  if (action === "sync-from-repo" && !repoPath) {
    throw new MaintenanceJobValidationError(
      "repoPath is required before starting sync-from-repo.",
    );
  }
  const releaseLock = acquireStoreLock(storeId);
  const job = makeJob(action, "start", storeId, {
    previewJobId: preview.id,
    repoPath,
  });
  await writeJob(input.config.root, job);

  void runStartedJob(input, job, releaseLock, runtime).catch(() => {
    releaseLock();
  });

  return job;
}

async function validatePreview(
  input: StartMaintenanceJobInput,
  action: MaintenanceJobAction,
  storeId: string,
): Promise<MaintenanceJobRecord> {
  const previewId = input.previewJobId?.trim();
  if (!previewId) {
    throw new MaintenanceJobConflictError(
      "Run a dry-run preview first and pass previewJobId before starting a maintenance job.",
    );
  }
  const preview = await readMaintenanceJob(previewId, input.config.root);
  if (!preview) {
    throw new MaintenanceJobNotFoundError("Maintenance preview job not found");
  }
  if (
    preview.mode !== "dry-run" ||
    preview.status !== "completed" ||
    preview.action !== action ||
    preview.storeId !== storeId
  ) {
    throw new MaintenanceJobConflictError(
      "previewJobId must reference a completed dry-run for the same action and brain store.",
    );
  }
  if (Date.now() - Date.parse(preview.updatedAt) > PREVIEW_TTL_MS) {
    throw new MaintenanceJobConflictError(
      "Maintenance preview expired; run a fresh dry-run before starting.",
    );
  }
  return preview;
}

function acquireStoreLock(storeId: string): () => void {
  if (activeStoreLocks.has(storeId)) {
    throw new MaintenanceJobConflictError(
      "A maintenance job is already running for this brain store.",
    );
  }
  activeStoreLocks.add(storeId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeStoreLocks.delete(storeId);
  };
}

async function runStartedJob(
  input: StartMaintenanceJobInput,
  job: MaintenanceJobRecord,
  releaseLock: () => void,
  runtime: MaintenanceJobRuntime,
): Promise<void> {
  const executeJob = runtime.executeJob ?? executeMaintenanceJob;
  try {
    await writeJob(input.config.root, {
      ...job,
      status: "running",
      updatedAt: new Date().toISOString(),
      progress: {
        phase: "running",
        message: "Maintenance job is running under the ScienceSwarm host process.",
      },
    });

    const result = await executeJob(job, input);
    await writeJob(input.config.root, {
      ...job,
      status: "completed",
      updatedAt: new Date().toISOString(),
      progress: {
        phase: "complete",
        message: "Maintenance job completed.",
      },
      result,
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJob(input.config.root, {
      ...job,
      status: "failed",
      updatedAt: new Date().toISOString(),
      progress: {
        phase: "failed",
        message: "Maintenance job failed.",
      },
      error: message,
    });
  } finally {
    releaseLock();
  }
}

async function executeMaintenanceJob(
  job: MaintenanceJobRecord,
  input: StartMaintenanceJobInput,
): Promise<MaintenanceJobResult> {
  await ensureBrainStoreReady();
  const adapter = getBrainStore() as GbrainEngineAdapter;
  const engine = adapter.engine;
  const before = await adapter.health();

  if (job.action === "extract-links") {
    assertBrainRootExists(input.config.root);
    await enqueueGbrainWrite(async () => {
      await runRuntimeExtract(engine, ["links", "--dir", input.config.root, "--json"]);
    });
    const after = await adapter.health();
    return {
      summary: "Link extraction completed through ScienceSwarm's maintenance runner.",
      steps: ["Scanned markdown pages", "Deduplicated existing links", "Inserted new gbrain link rows"],
      warnings: [],
      metrics: {
        linksBefore: before.linkCount,
        linksAfter: after.linkCount,
      },
    };
  }

  if (job.action === "extract-timeline") {
    assertBrainRootExists(input.config.root);
    await enqueueGbrainWrite(async () => {
      await runRuntimeExtract(engine, ["timeline", "--dir", input.config.root, "--json"]);
    });
    const after = await adapter.health();
    return {
      summary: "Timeline extraction completed through ScienceSwarm's maintenance runner.",
      steps: ["Scanned markdown pages", "Deduplicated existing timeline entries", "Inserted structured timeline rows"],
      warnings: [],
      metrics: {
        timelineEntriesBefore: before.timelineEntryCount,
        timelineEntriesAfter: after.timelineEntryCount,
      },
    };
  }

  if (job.action === "refresh-embeddings") {
    await enqueueGbrainWrite(async () => {
      await runRuntimeEmbed(engine, ["--stale"]);
    });
    const after = await adapter.health();
    return {
      summary: "Stale embedding refresh completed through ScienceSwarm's maintenance runner.",
      steps: ["Found chunks without embeddings", "Requested embeddings", "Updated gbrain chunks"],
      warnings: [],
      metrics: {
        missingEmbeddingsBefore: before.missingEmbeddings,
        missingEmbeddingsAfter: after.missingEmbeddings,
        embedCoverageBefore: before.embedCoverage,
        embedCoverageAfter: after.embedCoverage,
      },
    };
  }

  if (job.action === "sync-from-repo") {
    const repoPath = normalizeRepoPath(job.repoPath);
    if (!repoPath) {
      throw new Error("repoPath is required for sync-from-repo");
    }
    const result = await enqueueGbrainWrite(async () =>
      performRuntimeSync(engine, {
        repoPath,
        dryRun: false,
        noPull: true,
        noEmbed: true,
      }),
    );
    return {
      summary: "Git-backed brain sync completed with embedding refresh deferred.",
      steps: ["Read git diff without pulling remotes", "Imported syncable markdown", "Ran cheap link/timeline extraction"],
      warnings: [
        "Embeddings were not refreshed during sync. Run refresh-embeddings after reviewing the sync result.",
      ],
      metrics: result as Record<string, unknown>,
    };
  }

  throw new Error(`${job.action} is not runnable`);
}

async function buildDryRunResult(
  config: BrainConfig,
  action: MaintenanceJobAction,
  repoPath?: string,
): Promise<MaintenanceJobResult> {
  const report = await generateHealthReportWithGbrain(config);
  const plan = buildBrainMaintenancePlan(
    report,
    buildScienceSwarmMaintenanceContext(report),
  );
  const recommendation = plan.recommendations.find((item) => item.id === action);

  if (action === "extract-links") {
    const preview = previewMarkdownExtraction(config.root);
    return {
      summary: `Dry run would scan ${preview.pages} page(s) and found ${preview.linkCandidates} link candidate(s).`,
      steps: ["Scan markdown files", "Extract internal markdown links", "Insert only missing gbrain links after approval"],
      warnings: preview.warnings,
      metrics: preview,
      recommendation,
    };
  }

  if (action === "extract-timeline") {
    const preview = previewMarkdownExtraction(config.root);
    return {
      summary: `Dry run would scan ${preview.pages} page(s) and found ${preview.timelineCandidates} timeline candidate(s).`,
      steps: ["Scan markdown files", "Extract dated timeline entries", "Insert only missing gbrain timeline rows after approval"],
      warnings: preview.warnings,
      metrics: preview,
      recommendation,
    };
  }

  if (action === "refresh-embeddings") {
    return {
      summary: `Dry run found ${report.issueCounts?.missingEmbeddings ?? report.embeddingGaps} missing embedding(s).`,
      steps: ["Find chunks without embeddings", "Request embeddings only after approval", "Update chunk embedding rows in gbrain"],
      warnings: process.env.GBRAIN_OPENAI_KEY || process.env.OPENAI_API_KEY
        ? []
        : ["No GBRAIN_OPENAI_KEY or OPENAI_API_KEY is configured; a started job will fail until embeddings are configured."],
      metrics: {
        missingEmbeddings: report.issueCounts?.missingEmbeddings ?? report.embeddingGaps,
        embedCoverage: report.embedCoverage,
      },
      recommendation,
    };
  }

  if (action === "sync-from-repo") {
    const resolvedRepo = normalizeRepoPath(repoPath) ?? normalizeRepoPath(report.stats?.syncRepoPath);
    if (!resolvedRepo) {
      return {
        summary: "Dry run cannot inspect sync because no repoPath or gbrain sync repo is configured.",
        steps: ["Choose a git-backed research folder", "Run sync-from-repo dry-run with repoPath", "Start sync only after reviewing changed pages"],
        warnings: ["repoPath is required before ScienceSwarm can preview sync."],
        recommendation,
      };
    }
    await ensureBrainStoreReady();
    const adapter = getBrainStore() as GbrainEngineAdapter;
    const result = await previewSyncFromRepo(adapter.engine, resolvedRepo);
    return {
      summary: "Dry-run sync completed without writing to gbrain.",
      steps: ["Read git history without pulling remotes", "Computed syncable markdown changes", "Deferred all writes until explicit start"],
      warnings: [],
      metrics: result as Record<string, unknown>,
      recommendation,
    };
  }

  return {
    summary: `${action} is recommendation-only; no automatic maintenance runner is available for it.`,
    steps: ["Review the recommendation", "Delegate manual work through OpenClaw/OpenHands if the user approves"],
    warnings: ["ScienceSwarm did not write to gbrain."],
    recommendation,
  };
}

function previewMarkdownExtraction(brainRoot: string): Record<string, unknown> & {
  pages: number;
  linkCandidates: number;
  timelineCandidates: number;
  warnings: string[];
} {
  const scanRoot = existsSync(join(brainRoot, "wiki"))
    ? join(brainRoot, "wiki")
    : brainRoot;
  const warnings: string[] = [];
  if (!existsSync(scanRoot)) {
    return { pages: 0, linkCandidates: 0, timelineCandidates: 0, warnings: ["Brain markdown root does not exist."] };
  }

  const files = walkMarkdownFiles(scanRoot);
  let linkCandidates = 0;
  let timelineCandidates = 0;
  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      linkCandidates += countMarkdownLinks(content);
      timelineCandidates += countTimelineEntries(content);
    } catch (error) {
      const rel = relative(scanRoot, filePath);
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Skipped ${rel}: ${message}`);
    }
  }
  return {
    pages: files.length,
    linkCandidates,
    timelineCandidates,
    warnings,
  };
}

function walkMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  const rootRealPath = realpathSync(root);
  const stack = [root];
  const visitedDirectories = new Set<string>();
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirRealPath: string;
    try {
      dirRealPath = realpathSync(dir);
    } catch {
      continue;
    }
    if (!isPathInside(rootRealPath, dirRealPath)) {
      continue;
    }
    if (visitedDirectories.has(dirRealPath)) {
      continue;
    }
    visitedDirectories.add(dirRealPath);
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      if (entry === "node_modules" || entry === "brain.pglite" || entry === "state") {
        continue;
      }
      const full = join(dir, entry);
      let realPath: string;
      try {
        realPath = realpathSync(full);
      } catch {
        continue;
      }
      if (!isPathInside(rootRealPath, realPath)) {
        continue;
      }
      const stat = statSync(realPath);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (/\.mdx?$/i.test(entry)) {
        files.push(full);
      }
    }
  }
  return files;
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function countMarkdownLinks(content: string): number {
  const matches = content.match(/\[[^\]]+\]\((?![a-z]+:\/\/)[^)]+\.md\)/gi);
  return matches?.length ?? 0;
}

function countTimelineEntries(content: string): number {
  const bulletMatches =
    content.match(/^\s*-\s+\*\*\d{4}-\d{2}-\d{2}\*\*\s*\|.+$/gm)?.length ?? 0;
  const headerMatches =
    content.match(/^###\s+\d{4}-\d{2}-\d{2}\s*[–-].+$/gm)?.length ?? 0;
  return bulletMatches + headerMatches;
}

export async function previewSyncFromRepo(
  engine: GbrainEngineAdapter["engine"],
  repoPath: string,
): Promise<Record<string, unknown>> {
  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  const headCommit = git(repoPath, "rev-parse", "HEAD");
  const lastCommit = await engine.getConfig("sync.last_commit");
  if (!lastCommit) {
    const files = walkMarkdownFiles(repoPath)
      .map((filePath) => relative(repoPath, filePath).replace(/\\/g, "/"))
      .filter(isSyncableMarkdownPath)
      .sort();
    return {
      status: "dry_run",
      fullImport: true,
      fromCommit: null,
      toCommit: headCommit,
      added: files.length,
      modified: 0,
      deleted: 0,
      renamed: 0,
      chunksCreated: 0,
      pagesAffected: files.slice(0, 100),
    };
  }

  if (lastCommit === headCommit) {
    return {
      status: "dry_run",
      fullImport: false,
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      chunksCreated: 0,
      pagesAffected: [],
    };
  }

  const diffOutput = git(repoPath, "diff", "--name-status", "-M", `${lastCommit}..${headCommit}`);
  const counts = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
  };
  const pagesAffected: string[] = [];

  for (const line of diffOutput.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(/\t/);
    const status = parts[0] ?? "";
    const targetPath = status.startsWith("R") ? parts[2] : parts[1];
    if (!targetPath || !isSyncableMarkdownPath(targetPath)) continue;
    pagesAffected.push(targetPath);
    if (status === "A") counts.added += 1;
    else if (status === "M") counts.modified += 1;
    else if (status === "D") counts.deleted += 1;
    else if (status.startsWith("R")) counts.renamed += 1;
  }

  return {
    status: "dry_run",
    fullImport: false,
    fromCommit: lastCommit,
    toCommit: headCommit,
    ...counts,
    chunksCreated: 0,
    pagesAffected,
  };
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

function isSyncableMarkdownPath(filePath: string): boolean {
  return /\.mdx?$/i.test(filePath) && !filePath.split("/").some((part) => part.startsWith("."));
}

function assertBrainRootExists(brainRoot: string): void {
  if (!existsSync(brainRoot)) {
    throw new Error(`Brain root does not exist: ${brainRoot}`);
  }
}

function parseAction(action: string): MaintenanceJobAction {
  const normalized = action.trim() as MaintenanceJobAction;
  if (!VALID_ACTIONS.has(normalized)) {
    throw new MaintenanceJobValidationError("Unknown maintenance action");
  }
  return normalized;
}

function parseMode(mode?: string): MaintenanceJobMode {
  const normalized = mode?.trim() || "dry-run";
  if (normalized !== "dry-run" && normalized !== "start") {
    throw new MaintenanceJobValidationError("mode must be dry-run or start");
  }
  return normalized;
}

function normalizeRepoPath(repoPath?: string | null): string | undefined {
  const resolved = resolveConfiguredPath(repoPath);
  return resolved ? resolve(resolved) : undefined;
}

function makeJob(
  action: MaintenanceJobAction,
  mode: MaintenanceJobMode,
  storeId: string,
  options: { previewJobId?: string; repoPath?: string } = {},
): MaintenanceJobRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    action,
    mode,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    storeId,
    previewJobId: options.previewJobId,
    repoPath: options.repoPath,
    progress: {
      phase: mode === "dry-run" ? "preview" : "queued",
      message:
        mode === "dry-run"
          ? "Maintenance dry-run preview is queued."
          : "Maintenance job is queued.",
    },
    result: null,
    error: null,
  };
}

function getMaintenanceJobPath(id: string, brainRoot: string): string {
  return join(brainRoot, "state", "maintenance-jobs", `${id}.json`);
}

function getStoreId(): string {
  return createHash("sha256")
    .update(resolveBrainStorePglitePath())
    .digest("hex")
    .slice(0, 16);
}

async function writeJob(
  brainRoot: string,
  job: MaintenanceJobRecord,
): Promise<void> {
  await writeJsonFile(getMaintenanceJobPath(job.id, brainRoot), job);
}
