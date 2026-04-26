import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { getScienceSwarmBrainRoot, getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { writeJsonFile } from "@/lib/state/atomic-json";
import {
  getLegacyProjectChatPath,
  getLegacyProjectImportSummaryPath,
  getLegacyProjectManifestPath,
  getLegacyProjectStateDir,
  getLegacyProjectWatchConfigPath,
  getProjectBrainRootPath,
  getProjectLocalChatPath,
  getProjectLocalImportSummaryPath,
  getProjectLocalManifestPath,
  getProjectLocalStateRoot,
  getProjectLocalWatchConfigPath,
} from "@/lib/state/project-storage";
import { StudyIdSchema, StudySlugSchema, ThreadIdSchema, type StudyId, type StudySlug, type ThreadId } from "./contracts";
import { getStudyStateRoot, getThreadMessagesPath } from "./paths";

export type StudyMigrationClassification =
  | "project-manifest"
  | "watch-config"
  | "import-summary"
  | "chat-history"
  | "linked-wiki-payload"
  | "paper-library-inventory";

export type StudyMigrationAction = "copy" | "inventory-only";
export type StudyMigrationPlanStatus = "ready" | "missing" | "already-canonical" | "conflict";
export type StudyMigrationExecutionStatus =
  | "copied"
  | "already-canonical"
  | "inventory-only"
  | "missing"
  | "conflict"
  | "checkpointed"
  | "failed";

export interface StudyMigrationManifestEntry {
  id: string;
  classification: StudyMigrationClassification;
  action: StudyMigrationAction;
  sourcePath: string | null;
  destinationPath: string | null;
  relativePath: string;
  byteCount: number | null;
  sha256: string | null;
  destinationSha256?: string;
  status: StudyMigrationPlanStatus;
  reason?: string;
}

export interface StudyMigrationPlan {
  version: 1;
  legacyProjectSlug: StudySlug;
  studyId: StudyId;
  threadId: ThreadId;
  generatedAt: string;
  stateRoot: string;
  brainRoot: string;
  entries: StudyMigrationManifestEntry[];
  summary: {
    total: number;
    copy: number;
    inventoryOnly: number;
    missing: number;
    alreadyCanonical: number;
    conflicts: number;
    bytesToCopy: number;
    bytesInventoried: number;
  };
}

export interface PlanStudyMigrationInput {
  legacyProjectSlug: string;
  studyId: string;
  threadId?: string;
  projectsRoot?: string;
  brainRoot?: string;
  stateRoot?: string;
  generatedAt?: string;
  maxFilesPerTree?: number;
}

export interface ExecuteStudyMigrationOptions {
  concurrency?: number;
  checkpointPath?: string;
  reportPath?: string;
  signal?: AbortSignal;
  onProgress?: (entry: StudyMigrationExecutionEntry) => void | Promise<void>;
}

export interface StudyMigrationExecutionEntry {
  id: string;
  status: StudyMigrationExecutionStatus;
  sourcePath: string | null;
  destinationPath: string | null;
  byteCount: number | null;
  sha256: string | null;
  error?: string;
}

export interface StudyMigrationExecutionReport {
  version: 1;
  legacyProjectSlug: StudySlug;
  studyId: StudyId;
  threadId: ThreadId;
  startedAt: string;
  completedAt: string;
  state: "completed" | "cancelled" | "failed";
  checkpointPath: string;
  reportPath: string;
  entries: StudyMigrationExecutionEntry[];
  summary: {
    copied: number;
    alreadyCanonical: number;
    inventoryOnly: number;
    missing: number;
    conflicts: number;
    failed: number;
    bytesCopied: number;
  };
}

interface CandidateFile {
  classification: StudyMigrationClassification;
  action: StudyMigrationAction;
  sourcePath: string | null;
  destinationPath: string | null;
  relativePath: string;
  missingReason?: string;
}

interface SourceCandidate {
  filePath: string;
  allowedRoot: string;
}

interface Checkpoint {
  version: 1;
  completedEntryIds: string[];
  updatedAt: string;
}

const DEFAULT_MAX_MIGRATION_FILES_PER_TREE = 5_000;

function normalizeMaxFilesPerTree(maxFiles: number | undefined): number {
  if (maxFiles === undefined) return DEFAULT_MAX_MIGRATION_FILES_PER_TREE;
  if (!Number.isFinite(maxFiles) || maxFiles < 1) {
    throw new Error("Invalid Study migration file limit");
  }
  return Math.trunc(maxFiles);
}

function assertStudyMigrationInput(input: PlanStudyMigrationInput): {
  legacyProjectSlug: StudySlug;
  studyId: StudyId;
  threadId: ThreadId;
} {
  const legacyProjectSlug = StudySlugSchema.parse(input.legacyProjectSlug);
  const studyId = StudyIdSchema.parse(input.studyId);
  const fallbackThreadId = `thread_${studyId.slice("study_".length).replace(/[^a-z0-9_]/g, "_")}`;
  const threadId = ThreadIdSchema.parse(input.threadId ?? fallbackThreadId);
  return { legacyProjectSlug, studyId, threadId };
}

function dedupeKey(candidate: Pick<CandidateFile, "classification" | "sourcePath" | "destinationPath" | "relativePath">): string {
  return [
    candidate.classification,
    candidate.sourcePath ?? "<missing>",
    candidate.destinationPath ?? "<none>",
    candidate.relativePath,
  ].join("\0");
}

async function pathStats(filePath: string | null): Promise<{ size: number; isFile: boolean; isDirectory: boolean } | null> {
  if (!filePath) return null;
  try {
    const stats = await stat(filePath);
    return {
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  const stats = await pathStats(filePath);
  return stats?.isFile ?? false;
}

async function directoryExists(filePath: string): Promise<boolean> {
  const stats = await pathStats(filePath);
  return stats?.isDirectory ?? false;
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function isExistingPathInsideAllowedRoots(filePath: string, allowedRoots: string[]): Promise<boolean> {
  let targetRealPath: string;
  try {
    targetRealPath = await realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  for (const root of allowedRoots) {
    let rootRealPath: string;
    try {
      rootRealPath = await realpath(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (isPathInside(rootRealPath, targetRealPath)) return true;
  }

  return false;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function readJsonIfPresent(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonOrJsonlIfPresent(filePath: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function listFilesRecursive(
  root: string,
  maxFiles: number,
  allowedRoot = root,
): Promise<string[]> {
  const limit = normalizeMaxFilesPerTree(maxFiles);
  if (!(await isExistingPathInsideAllowedRoots(root, [allowedRoot]))) {
    return [];
  }
  let visitedFiles = 0;

  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });

    const files: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walk(absolute));
      } else if (entry.isFile()) {
        visitedFiles += 1;
        if (visitedFiles > limit) {
          throw new Error(`Legacy migration tree file limit exceeded for ${root}.`);
        }
        files.push(absolute);
      }
    }
    return files;
  }

  return walk(root);
}

function relativePortable(fromRoot: string, filePath: string): string {
  return path.relative(fromRoot, filePath).split(path.sep).join("/");
}

function normalizeSafeRelativePath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.trim().replaceAll("\\", "/"));
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe relative migration path: ${relativePath}`);
  }
  return normalized;
}

function relativeDestination(base: string, relativePath: string): string {
  return path.join(base, ...normalizeSafeRelativePath(relativePath).split("/"));
}

async function firstExistingFile(candidates: SourceCandidate[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (
      await fileExists(candidate.filePath)
      && await isExistingPathInsideAllowedRoots(candidate.filePath, [candidate.allowedRoot])
    ) {
      return candidate.filePath;
    }
  }
  return null;
}

async function addSingleCandidate(
  candidates: CandidateFile[],
  input: {
    classification: StudyMigrationClassification;
    sourceCandidates: SourceCandidate[];
    destinationPath: string;
    relativePath: string;
    missingReason: string;
  },
): Promise<string | null> {
  const sourcePath = await firstExistingFile(input.sourceCandidates);
  candidates.push({
    classification: input.classification,
    action: "copy",
    sourcePath,
    destinationPath: input.destinationPath,
    relativePath: input.relativePath,
    missingReason: sourcePath ? undefined : input.missingReason,
  });
  return sourcePath;
}

function referencedWikiPaths(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const candidate = manifest as Record<string, unknown>;
  const paths = new Set<string>();
  const maybeAdd = (value: unknown) => {
    if (typeof value !== "string") return;
    let normalized: string;
    try {
      normalized = normalizeSafeRelativePath(value);
    } catch {
      return;
    }
    if (normalized.startsWith("wiki/")) paths.add(normalized);
  };

  maybeAdd(candidate.projectPagePath);
  for (const key of ["taskPaths", "decisionPaths", "artifactPaths", "frontierPaths"] as const) {
    const values = candidate[key];
    if (Array.isArray(values)) {
      for (const value of values) maybeAdd(value);
    }
  }
  const sourceRefs = candidate.sourceRefs;
  if (Array.isArray(sourceRefs)) {
    for (const value of sourceRefs) {
      if (value && typeof value === "object") {
        maybeAdd((value as { ref?: unknown }).ref);
      }
    }
  }

  return [...paths].sort((left, right) => left.localeCompare(right));
}

async function addWikiCandidates(input: {
  candidates: CandidateFile[];
  wikiPaths: string[];
  sourceRoots: string[];
  destinationRoot: string;
  maxFilesPerTree: number;
}): Promise<void> {
  for (const relativePath of input.wikiPaths) {
    let found = false;
    for (const sourceRoot of input.sourceRoots) {
      const sourcePath = relativeDestination(sourceRoot, relativePath);
      const sourceStats = await pathStats(sourcePath);
      if (!sourceStats) continue;
      if (!(await isExistingPathInsideAllowedRoots(sourcePath, [sourceRoot]))) continue;
      found = true;
      if (sourceStats.isFile) {
        input.candidates.push({
          classification: "linked-wiki-payload",
          action: "copy",
          sourcePath,
          destinationPath: relativeDestination(input.destinationRoot, relativePath),
          relativePath,
        });
        break;
      }
      if (sourceStats.isDirectory) {
        const files = await listFilesRecursive(sourcePath, input.maxFilesPerTree, sourceRoot);
        for (const filePath of files) {
          const childRelative = `${relativePath}/${relativePortable(sourcePath, filePath)}`;
          input.candidates.push({
            classification: "linked-wiki-payload",
            action: "copy",
            sourcePath: filePath,
            destinationPath: relativeDestination(input.destinationRoot, childRelative),
            relativePath: childRelative,
          });
        }
        break;
      }
    }
    if (!found) {
      input.candidates.push({
        classification: "linked-wiki-payload",
        action: "copy",
        sourcePath: null,
        destinationPath: relativeDestination(input.destinationRoot, relativePath),
        relativePath,
        missingReason: "Referenced wiki payload was not found in legacy wiki roots.",
      });
    }
  }
}

async function addPaperLibraryInventory(input: {
  candidates: CandidateFile[];
  roots: Array<{ root: string; allowedRoot: string }>;
  maxFilesPerTree: number;
}): Promise<void> {
  const seenRoots = new Set<string>();
  for (const { root, allowedRoot } of input.roots) {
    const resolved = path.resolve(root);
    if (
      seenRoots.has(resolved)
      || !(await directoryExists(root))
      || !(await isExistingPathInsideAllowedRoots(root, [allowedRoot]))
    ) continue;
    seenRoots.add(resolved);
    const files = await listFilesRecursive(root, input.maxFilesPerTree, allowedRoot);
    for (const sourcePath of files) {
      input.candidates.push({
        classification: "paper-library-inventory",
        action: "inventory-only",
        sourcePath,
        destinationPath: null,
        relativePath: `paper-library/${relativePortable(root, sourcePath)}`,
      });
    }
  }
}

async function candidateToEntry(candidate: CandidateFile, index: number): Promise<StudyMigrationManifestEntry> {
  const id = `entry_${String(index + 1).padStart(4, "0")}`;
  if (!candidate.sourcePath) {
    return {
      id,
      classification: candidate.classification,
      action: candidate.action,
      sourcePath: null,
      destinationPath: candidate.destinationPath,
      relativePath: candidate.relativePath,
      byteCount: null,
      sha256: null,
      status: "missing",
      reason: candidate.missingReason ?? "Source file is missing.",
    };
  }

  const sourceStats = await pathStats(candidate.sourcePath);
  if (!sourceStats?.isFile) {
    return {
      id,
      classification: candidate.classification,
      action: candidate.action,
      sourcePath: candidate.sourcePath,
      destinationPath: candidate.destinationPath,
      relativePath: candidate.relativePath,
      byteCount: null,
      sha256: null,
      status: "missing",
      reason: "Source path is not a regular file.",
    };
  }

  const sha256 = await sha256File(candidate.sourcePath);
  let status: StudyMigrationPlanStatus = "ready";
  let destinationSha256: string | undefined;
  if (candidate.action === "inventory-only") {
    status = "ready";
  } else if (candidate.destinationPath) {
    const destinationStats = await pathStats(candidate.destinationPath);
    if (destinationStats?.isFile) {
      destinationSha256 = await sha256File(candidate.destinationPath);
      status = destinationSha256 === sha256 ? "already-canonical" : "conflict";
    } else if (destinationStats) {
      status = "conflict";
    }
  }

  return {
    id,
    classification: candidate.classification,
    action: candidate.action,
    sourcePath: candidate.sourcePath,
    destinationPath: candidate.destinationPath,
    relativePath: candidate.relativePath,
    byteCount: sourceStats.size,
    sha256,
    destinationSha256,
    status,
  };
}

function summarizePlan(entries: StudyMigrationManifestEntry[]): StudyMigrationPlan["summary"] {
  return {
    total: entries.length,
    copy: entries.filter((entry) => entry.action === "copy").length,
    inventoryOnly: entries.filter((entry) => entry.action === "inventory-only").length,
    missing: entries.filter((entry) => entry.status === "missing").length,
    alreadyCanonical: entries.filter((entry) => entry.status === "already-canonical").length,
    conflicts: entries.filter((entry) => entry.status === "conflict").length,
    bytesToCopy: entries
      .filter((entry) => entry.action === "copy" && entry.status === "ready")
      .reduce((sum, entry) => sum + (entry.byteCount ?? 0), 0),
    bytesInventoried: entries
      .filter((entry) => entry.action === "inventory-only")
      .reduce((sum, entry) => sum + (entry.byteCount ?? 0), 0),
  };
}

export async function planLegacyProjectStateMigration(input: PlanStudyMigrationInput): Promise<StudyMigrationPlan> {
  const { legacyProjectSlug, studyId, threadId } = assertStudyMigrationInput(input);
  const projectsRoot = input.projectsRoot ?? getScienceSwarmProjectsRoot();
  const brainRoot = input.brainRoot ?? getScienceSwarmBrainRoot();
  const stateRoot = input.stateRoot;
  const maxFilesPerTree = normalizeMaxFilesPerTree(input.maxFilesPerTree);
  const studyRoot = getStudyStateRoot(studyId, stateRoot);
  const legacyCopyRoot = path.join(studyRoot, "legacy-project", legacyProjectSlug);
  const legacyGlobalStateRoot = path.join(brainRoot, "state");
  const localProjectStateRoot = getProjectLocalStateRoot(legacyProjectSlug, projectsRoot);

  const candidates: CandidateFile[] = [];
  const localManifestPath = getProjectLocalManifestPath(legacyProjectSlug, projectsRoot);
  const globalManifestPath = getLegacyProjectManifestPath(legacyProjectSlug, legacyGlobalStateRoot);
  const manifestSource = await addSingleCandidate(candidates, {
    classification: "project-manifest",
    sourceCandidates: [
      { filePath: localManifestPath, allowedRoot: localProjectStateRoot },
      { filePath: globalManifestPath, allowedRoot: legacyGlobalStateRoot },
    ],
    destinationPath: path.join(legacyCopyRoot, "manifest.json"),
    relativePath: "legacy-project/manifest.json",
    missingReason: "No legacy project manifest was found.",
  });
  await addSingleCandidate(candidates, {
    classification: "watch-config",
    sourceCandidates: [
      {
        filePath: getProjectLocalWatchConfigPath(legacyProjectSlug, projectsRoot),
        allowedRoot: localProjectStateRoot,
      },
      {
        filePath: getLegacyProjectWatchConfigPath(legacyProjectSlug, legacyGlobalStateRoot),
        allowedRoot: legacyGlobalStateRoot,
      },
    ],
    destinationPath: path.join(legacyCopyRoot, "watch-config.json"),
    relativePath: "legacy-project/watch-config.json",
    missingReason: "No legacy watch config was found.",
  });
  await addSingleCandidate(candidates, {
    classification: "import-summary",
    sourceCandidates: [
      {
        filePath: getProjectLocalImportSummaryPath(legacyProjectSlug, projectsRoot),
        allowedRoot: localProjectStateRoot,
      },
      {
        filePath: getLegacyProjectImportSummaryPath(legacyProjectSlug, legacyGlobalStateRoot),
        allowedRoot: legacyGlobalStateRoot,
      },
    ],
    destinationPath: path.join(legacyCopyRoot, "import-summary.json"),
    relativePath: "legacy-project/import-summary.json",
    missingReason: "No legacy import summary was found.",
  });
  await addSingleCandidate(candidates, {
    classification: "chat-history",
    sourceCandidates: [
      {
        filePath: getProjectLocalChatPath(legacyProjectSlug, projectsRoot),
        allowedRoot: localProjectStateRoot,
      },
      {
        filePath: getLegacyProjectChatPath(legacyProjectSlug, legacyGlobalStateRoot),
        allowedRoot: legacyGlobalStateRoot,
      },
    ],
    destinationPath: getThreadMessagesPath(threadId, stateRoot),
    relativePath: `threads/${threadId}/messages.jsonl`,
    missingReason: "No legacy chat history was found.",
  });

  const manifest = manifestSource ? await readJsonIfPresent(manifestSource) : null;
  await addWikiCandidates({
    candidates,
    wikiPaths: referencedWikiPaths(manifest),
    sourceRoots: [getProjectBrainRootPath(legacyProjectSlug, projectsRoot), brainRoot],
    destinationRoot: legacyCopyRoot,
    maxFilesPerTree,
  });

  await addPaperLibraryInventory({
    candidates,
    roots: [
      {
        root: path.join(localProjectStateRoot, "paper-library"),
        allowedRoot: localProjectStateRoot,
      },
      {
        root: path.join(getLegacyProjectStateDir(legacyProjectSlug, legacyGlobalStateRoot), "paper-library"),
        allowedRoot: legacyGlobalStateRoot,
      },
      {
        root: path.join(legacyGlobalStateRoot, "paper-library"),
        allowedRoot: legacyGlobalStateRoot,
      },
    ],
    maxFilesPerTree,
  });

  const uniqueCandidates = [...new Map(candidates.map((candidate) => [dedupeKey(candidate), candidate])).values()]
    .sort((left, right) => [
      left.action,
      left.classification,
      left.relativePath,
      left.sourcePath ?? "",
    ].join("\0").localeCompare([
      right.action,
      right.classification,
      right.relativePath,
      right.sourcePath ?? "",
    ].join("\0")));
  const entries = await Promise.all(uniqueCandidates.map(candidateToEntry));

  return {
    version: 1,
    legacyProjectSlug,
    studyId,
    threadId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    stateRoot: path.resolve(stateRoot ?? path.join(studyRoot, "..", "..")),
    brainRoot: path.resolve(brainRoot),
    entries,
    summary: summarizePlan(entries),
  };
}

async function copyFileWithSha256Verification(entry: StudyMigrationManifestEntry): Promise<void> {
  if (!entry.sourcePath || !entry.destinationPath || !entry.sha256) {
    throw new Error("Copy entry is missing source, destination, or checksum.");
  }
  await mkdir(path.dirname(entry.destinationPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(entry.destinationPath),
    `.${path.basename(entry.destinationPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const hash = createHash("sha256");

  try {
    await new Promise<void>((resolve, reject) => {
      const input = createReadStream(entry.sourcePath as string);
      const output = createWriteStream(tempPath, { flags: "wx" });
      input.on("data", (chunk) => hash.update(chunk));
      input.on("error", reject);
      output.on("error", reject);
      output.on("finish", () => resolve());
      input.pipe(output);
    });

    const streamedHash = hash.digest("hex");
    if (streamedHash !== entry.sha256) {
      throw new Error(`Source checksum changed during copy for ${entry.relativePath}.`);
    }
    const destinationHash = await sha256File(tempPath);
    if (destinationHash !== entry.sha256) {
      throw new Error(`Destination checksum mismatch for ${entry.relativePath}.`);
    }
    const destinationStats = await pathStats(entry.destinationPath);
    if (destinationStats) {
      if (destinationStats.isFile && await sha256File(entry.destinationPath) === entry.sha256) {
        await rm(tempPath, { force: true });
        return;
      }
      throw new Error(`Destination already exists for ${entry.relativePath}.`);
    }
    await rename(tempPath, entry.destinationPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function readCheckpoint(filePath: string): Promise<Checkpoint> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    if (
      raw
      && typeof raw === "object"
      && (raw as { version?: unknown }).version === 1
      && Array.isArray((raw as { completedEntryIds?: unknown }).completedEntryIds)
    ) {
      return raw as Checkpoint;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  return { version: 1, completedEntryIds: [], updatedAt: new Date().toISOString() };
}

async function writeCheckpoint(filePath: string, completed: Set<string>): Promise<void> {
  const checkpoint: Checkpoint = {
    version: 1,
    completedEntryIds: [...completed].sort((left, right) => left.localeCompare(right)),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(filePath, checkpoint);
}

function summarizeExecution(entries: StudyMigrationExecutionEntry[]): StudyMigrationExecutionReport["summary"] {
  return {
    copied: entries.filter((entry) => entry.status === "copied").length,
    alreadyCanonical: entries.filter((entry) => entry.status === "already-canonical").length,
    inventoryOnly: entries.filter((entry) => entry.status === "inventory-only").length,
    missing: entries.filter((entry) => entry.status === "missing").length,
    conflicts: entries.filter((entry) => entry.status === "conflict").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    bytesCopied: entries
      .filter((entry) => entry.status === "copied")
      .reduce((sum, entry) => sum + (entry.byteCount ?? 0), 0),
  };
}

function executionEntry(
  entry: StudyMigrationManifestEntry,
  status: StudyMigrationExecutionStatus,
  error?: string,
): StudyMigrationExecutionEntry {
  return {
    id: entry.id,
    status,
    sourcePath: entry.sourcePath,
    destinationPath: entry.destinationPath,
    byteCount: entry.byteCount,
    sha256: entry.sha256,
    error,
  };
}

export async function executeLegacyProjectStateMigration(
  plan: StudyMigrationPlan,
  options: ExecuteStudyMigrationOptions = {},
): Promise<StudyMigrationExecutionReport> {
  const startedAt = new Date().toISOString();
  const checkpointPath = options.checkpointPath
    ?? path.join(getStudyStateRoot(plan.studyId, plan.stateRoot), "migration-checkpoint.json");
  const reportPath = options.reportPath
    ?? path.join(getStudyStateRoot(plan.studyId, plan.stateRoot), "migration-reports", `${startedAt.replaceAll(":", "-")}.json`);
  const checkpoint = await readCheckpoint(checkpointPath);
  const completed = new Set(checkpoint.completedEntryIds);
  const results: StudyMigrationExecutionEntry[] = [];
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 4));
  let nextIndex = 0;
  let state: StudyMigrationExecutionReport["state"] = "completed";

  async function runEntry(entry: StudyMigrationManifestEntry): Promise<void> {
    if (completed.has(entry.id)) {
      const result = executionEntry(entry, "checkpointed");
      results.push(result);
      await options.onProgress?.(result);
      return;
    }
    if (options.signal?.aborted) {
      state = "cancelled";
      return;
    }
    if (entry.action === "inventory-only") {
      const result = executionEntry(entry, "inventory-only");
      results.push(result);
      completed.add(entry.id);
      await writeCheckpoint(checkpointPath, completed);
      await options.onProgress?.(result);
      return;
    }
    if (entry.status === "missing") {
      const result = executionEntry(entry, "missing", entry.reason);
      results.push(result);
      completed.add(entry.id);
      await writeCheckpoint(checkpointPath, completed);
      await options.onProgress?.(result);
      return;
    }
    if (entry.status === "conflict") {
      const result = executionEntry(entry, "conflict", "Destination exists with different content.");
      results.push(result);
      completed.add(entry.id);
      await writeCheckpoint(checkpointPath, completed);
      await options.onProgress?.(result);
      return;
    }
    if (entry.status === "already-canonical") {
      const result = executionEntry(entry, "already-canonical");
      results.push(result);
      completed.add(entry.id);
      await writeCheckpoint(checkpointPath, completed);
      await options.onProgress?.(result);
      return;
    }
    try {
      await copyFileWithSha256Verification(entry);
      const result = executionEntry(entry, "copied");
      results.push(result);
      completed.add(entry.id);
      await writeCheckpoint(checkpointPath, completed);
      await options.onProgress?.(result);
    } catch (error) {
      state = "failed";
      const result = executionEntry(entry, "failed", error instanceof Error ? error.message : String(error));
      results.push(result);
      await writeCheckpoint(checkpointPath, completed);
      await options.onProgress?.(result);
    }
  }

  async function worker(): Promise<void> {
    while (nextIndex < plan.entries.length && state === "completed" && !options.signal?.aborted) {
      const entry = plan.entries[nextIndex++];
      if (!entry) break;
      await runEntry(entry);
    }
    if (options.signal?.aborted && state === "completed") {
      state = "cancelled";
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const report: StudyMigrationExecutionReport = {
    version: 1,
    legacyProjectSlug: plan.legacyProjectSlug,
    studyId: plan.studyId,
    threadId: plan.threadId,
    startedAt,
    completedAt: new Date().toISOString(),
    state,
    checkpointPath,
    reportPath,
    entries: results.sort((left, right) => left.id.localeCompare(right.id)),
    summary: summarizeExecution(results),
  };
  await writeJsonFile(reportPath, report);
  return report;
}

export async function readMigratedOrLegacyProjectFile(input: {
  plan: StudyMigrationPlan;
  classification: Extract<StudyMigrationClassification, "project-manifest" | "watch-config" | "import-summary" | "chat-history">;
}): Promise<unknown | null> {
  const entry = input.plan.entries.find((candidate) => candidate.classification === input.classification);
  if (!entry) return null;
  if (input.classification === "chat-history") {
    if (entry.destinationPath && await fileExists(entry.destinationPath)) {
      return readJsonOrJsonlIfPresent(entry.destinationPath);
    }
    if (entry.sourcePath && await fileExists(entry.sourcePath)) {
      return readJsonOrJsonlIfPresent(entry.sourcePath);
    }
    return null;
  }
  if (entry.destinationPath && await fileExists(entry.destinationPath)) {
    return readJsonIfPresent(entry.destinationPath);
  }
  if (entry.sourcePath && await fileExists(entry.sourcePath)) {
    return readJsonIfPresent(entry.sourcePath);
  }
  return null;
}
