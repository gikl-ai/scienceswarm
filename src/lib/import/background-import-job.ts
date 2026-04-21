import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

import type { ImportPreview, SourceRef } from "@/brain/types";
import { parseFile } from "@/lib/file-parser";
import { expandHomeDir } from "@/lib/scienceswarm-paths";
import {
  buildSourceFallbackWarning,
  finalizeImportedProject,
  importLocalFileToProject,
  persistImportedWorkspaceFile,
  type ImportGbrainDeps,
  type ImportedFileRecord,
  type ImportedFileSummary,
} from "@/lib/import/commit-import";
import { inferDuplicateGroupContentType } from "@/lib/import/preview-core";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { createIngestService } from "@/brain/ingest/service";
import {
  computeFileFingerprint,
  computeLegacyPathSizeFingerprint,
  LARGE_FILE_FINGERPRINT_THRESHOLD_BYTES,
} from "@/lib/import/file-fingerprint";
import { writeProjectImportSource } from "@/lib/state/project-import-source";
import { getProjectBrainRootPath } from "@/lib/state/project-storage";
import { readProjectManifest } from "@/lib/state/project-manifests";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import { hashContent } from "@/lib/workspace-manager";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { shouldSkipImportDirectory, shouldSkipImportFile } from "@/lib/import/ignore";

const MAX_FILE_SIZE = LARGE_FILE_FINGERPRINT_THRESHOLD_BYTES;

const TEXT_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".r", ".jl", ".m", ".sh", ".bash",
  ".tex", ".bib", ".sty", ".cls",
  ".md", ".txt", ".rst", ".log",
  ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".html", ".css", ".xml", ".sql",
  ".csv", ".json", ".tsv", ".ipynb", ".do", ".sps",
  ".dockerfile",
]);

const STRUCTURED_EXTENSIONS = new Set([".pdf", ".xlsx", ".xlsm"]);

const IMPORT_JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORPHANED_IMPORT_JOB_GRACE_MS = 15_000;
const runningImportJobs = new Set<string>();
let overrideBackgroundImportGbrainDeps: ImportGbrainDeps | null = null;

export type BackgroundImportJobStatus = "queued" | "running" | "completed" | "failed";
export type BackgroundImportJobPhase = "queued" | "scanning" | "importing" | "finalizing";

export interface BackgroundImportJobProgress {
  phase: BackgroundImportJobPhase;
  detectedFiles: number;
  detectedItems: number;
  detectedBytes: number;
  importedFiles: number;
  skippedDuplicates: number;
  duplicateGroups: number;
  currentPath: string | null;
}

export interface BackgroundImportJobResult {
  project: string;
  title: string;
  importedFiles: number;
  detectedItems: number;
  detectedBytes: number;
  duplicateGroups: number;
  projectPagePath: string;
  sourcePageCount: number;
  generatedAt: string;
  warnings: ImportPreview["warnings"];
}

export interface BackgroundImportJobRecord {
  id: string;
  project: string;
  folderName: string;
  folderPath: string;
  status: BackgroundImportJobStatus;
  createdAt: string;
  updatedAt: string;
  progress: BackgroundImportJobProgress;
  result: BackgroundImportJobResult | null;
  error: string | null;
}

export function __setBackgroundImportGbrainDepsOverride(
  deps: ImportGbrainDeps | null,
): void {
  overrideBackgroundImportGbrainDeps = deps;
}

function getImportJobPath(id: string, brainRoot: string): string {
  return join(brainRoot, "state", "import-jobs", `${id}.json`);
}

export function isValidImportJobId(id: string): boolean {
  return IMPORT_JOB_ID_PATTERN.test(id);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function describeOrphanedImportJob(job: BackgroundImportJobRecord): string {
  const progressBits: string[] = [];

  if (job.progress.detectedItems > 0) {
    progressBits.push(`${job.progress.detectedItems.toLocaleString("en-US")} ${pluralize("item", job.progress.detectedItems)} scanned`);
  }
  if (job.progress.importedFiles > 0) {
    progressBits.push(`${job.progress.importedFiles.toLocaleString("en-US")} unique ${pluralize("file", job.progress.importedFiles)} imported`);
  }
  if (job.progress.skippedDuplicates > 0) {
    progressBits.push(`${job.progress.skippedDuplicates.toLocaleString("en-US")} duplicate ${pluralize("file", job.progress.skippedDuplicates)} skipped`);
  }

  if (progressBits.length === 0) {
    return "Background import worker stopped before completion. Re-scan the local folder to restart it.";
  }

  return `Background import worker stopped before completion after ${progressBits.join(", ")}. Re-scan the local folder to restart it.`;
}

function resolveBackgroundImportGbrainDeps(): ImportGbrainDeps {
  if (overrideBackgroundImportGbrainDeps) {
    return overrideBackgroundImportGbrainDeps;
  }
  const gbrain = createInProcessGbrainClient();
  const uploadedBy = resolveBackgroundImportUploadedBy();
  return {
    gbrain,
    ingestService: createIngestService({ gbrain }),
    uploadedBy,
  };
}

function resolveBackgroundImportUploadedBy(): string {
  try {
    return getCurrentUserHandle();
  } catch {
    throw new Error(
      "Cannot start background folder import because SCIENCESWARM_USER_HANDLE is not configured. " +
        "Set SCIENCESWARM_USER_HANDLE in your .env before importing a local folder.",
    );
  }
}

function inferImportedFileType(filename: string): string {
  const extension = extname(filename).slice(1).toLowerCase();
  if (extension) return extension;
  return basename(filename).toLowerCase();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "imported-project";
}

function humanizeSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function duplicateNamePenalty(name: string): number {
  return /(?:^|[-_.\s])(copy|duplicate)(?:[-_.\s]|$)|\(\d+\)/i.test(name) ? 1 : 0;
}

export async function isPathAllowed(targetPath: string): Promise<boolean> {
  const home = resolve(homedir());
  let resolved = resolve(targetPath);
  try {
    resolved = await realpath(targetPath);
  } catch {
    // Keep the normalized path for the existence check that follows.
  }

  const homeWithSep = home.endsWith(sep) ? home : `${home}${sep}`;
  if (resolved !== home && !resolved.startsWith(homeWithSep)) return false;

  const blockedPrefixes = [
    resolve(join(home, ".ssh")),
    resolve(join(home, ".gnupg")),
    resolve(join(home, ".aws")),
    resolve(join(home, ".config")),
  ];

  for (const blocked of blockedPrefixes) {
    const blockedWithSep = blocked.endsWith(sep) ? blocked : `${blocked}${sep}`;
    if (resolved === blocked || resolved.startsWith(blockedWithSep)) return false;
  }

  return true;
}

async function writeImportJob(job: BackgroundImportJobRecord, brainRoot: string): Promise<void> {
  await writeJsonFile(getImportJobPath(job.id, brainRoot), job);
}

export async function readImportJob(
  id: string,
  brainRoot: string,
): Promise<BackgroundImportJobRecord | null> {
  const job = await readJsonFile<BackgroundImportJobRecord>(getImportJobPath(id, brainRoot));
  if (!job) return null;

  if (
    (job.status === "queued" || job.status === "running")
    && !runningImportJobs.has(id)
  ) {
    const updatedAtMs = Date.parse(job.updatedAt);
    if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= ORPHANED_IMPORT_JOB_GRACE_MS) {
      const failedJob: BackgroundImportJobRecord = {
        ...job,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: describeOrphanedImportJob(job),
      };
      await writeImportJob(failedJob, brainRoot);
      return failedJob;
    }
  }

  return job;
}

async function updateImportJob(
  id: string,
  brainRoot: string,
  updater: (current: BackgroundImportJobRecord) => BackgroundImportJobRecord,
): Promise<BackgroundImportJobRecord> {
  const current = await readImportJob(id, brainRoot);
  if (!current) {
    throw new Error(`Import job ${id} not found`);
  }
  const next = updater(current);
  await writeImportJob(next, brainRoot);
  return next;
}

async function loadImportedFile(fullPath: string, basePath: string, fileSize: number): Promise<ImportedFileRecord> {
  const relativePath = relative(basePath, fullPath);
  const name = basename(fullPath);
  const ext = extname(name).toLowerCase();
  const fileType = inferImportedFileType(name);

  if (fileSize > MAX_FILE_SIZE) {
    let fingerprint: string;
    try {
      fingerprint = await computeFileFingerprint(fullPath, fileSize);
    } catch {
      fingerprint = computeLegacyPathSizeFingerprint(relativePath, fileSize);
    }

    return {
      path: relativePath,
      name,
      type: fileType,
      size: fileSize,
      sourcePath: fullPath,
      hash: fingerprint,
      content: `[Skipped: file too large (${formatSize(fileSize)})]`,
    };
  }

  const importedFile: ImportedFileRecord = {
    path: relativePath,
    name,
    type: fileType,
    size: fileSize,
    sourcePath: fullPath,
  };

  if (STRUCTURED_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext) || fileType === "dockerfile") {
    try {
      const buffer = await readFile(fullPath);
      importedFile.hash = hashContent(buffer);
      const parsed = await parseFile(buffer, name);
      importedFile.content = parsed.text;
      const metadata: Record<string, unknown> = {};
      if (parsed.pages) metadata.pages = parsed.pages;
      if (parsed.metadata) Object.assign(metadata, parsed.metadata);

      if (ext === ".csv" || ext === ".tsv") {
        const separator = ext === ".tsv" ? "\t" : ",";
        const lines = parsed.text.split("\n");
        Object.assign(metadata, {
          rows: Math.max(0, lines.length - 1),
          columns: lines[0]?.split(separator).length || 0,
        });
      } else if (ext === ".json") {
        try {
          const json = JSON.parse(parsed.text);
          if (Array.isArray(json)) {
            Object.assign(metadata, { items: json.length });
          }
        } catch {
          // Ignore invalid JSON metadata extraction.
        }
      }

      if (Object.keys(metadata).length > 0) {
        importedFile.metadata = metadata;
      }
      return importedFile;
    } catch {
      importedFile.hash = hashContent(`${relativePath}:${fileSize}`);
      importedFile.content = ext === ".pdf"
        ? "[Could not parse PDF]"
        : `[Could not parse ${fileType || "file"}]`;
      return importedFile;
    }
  }

  try {
    const buffer = await readFile(fullPath);
    importedFile.hash = hashContent(buffer);
  } catch {
    importedFile.hash = hashContent(`${relativePath}:${fileSize}`);
  }
  importedFile.content = `[Binary file: ${formatSize(fileSize)}]`;
  return importedFile;
}

function buildDuplicateGroups(duplicatePathsByHash: Map<string, string[]>): ImportPreview["duplicateGroups"] {
  let index = 0;
  return Array.from(duplicatePathsByHash.entries())
    .filter(([, paths]) => paths.length > 1)
    .map(([hash, paths]) => {
      index += 1;
      return {
        id: `dup-${index}-${hash.slice(0, 8)}`,
        paths,
        reason: `Identical content hash ${hash.slice(0, 12)}`,
        hashPrefix: hash.slice(0, 12),
        contentType: inferDuplicateGroupContentType(paths),
      };
    });
}

export async function startBackgroundImportJob(input: {
  brainRoot: string;
  path: string;
  projectSlug?: string;
}): Promise<BackgroundImportJobRecord> {
  const folderPath = expandHomeDir(input.path.trim());
  if (!folderPath) {
    throw new Error("Path is required");
  }

  if (!(await isPathAllowed(folderPath))) {
    throw new Error("Path not allowed. Must be under your home directory and not in sensitive directories.");
  }

  const pathStat = await stat(folderPath);
  if (!pathStat.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const folderName = basename(folderPath);
  const project = input.projectSlug?.trim() || slugify(folderName);
  if (!overrideBackgroundImportGbrainDeps) {
    resolveBackgroundImportUploadedBy();
  }
  const now = new Date().toISOString();
  const job: BackgroundImportJobRecord = {
    id: randomUUID(),
    project,
    folderName,
    folderPath,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    progress: {
      phase: "queued",
      detectedFiles: 0,
      detectedItems: 0,
      detectedBytes: 0,
      importedFiles: 0,
      skippedDuplicates: 0,
      duplicateGroups: 0,
      currentPath: null,
    },
    result: null,
    error: null,
  };

  await writeProjectImportSource(project, {
    folderPath,
    source: "background-local-import",
    updatedAt: now,
    lastJobId: job.id,
  });
  await writeImportJob(job, input.brainRoot);
  setTimeout(() => {
    void runBackgroundImportJob(job.id, input.brainRoot);
  }, 0);

  return job;
}

export async function runBackgroundImportJob(jobId: string, brainRoot: string): Promise<void> {
  if (runningImportJobs.has(jobId)) return;
  runningImportJobs.add(jobId);

  try {
    const initialJob = await readImportJob(jobId, brainRoot);
    if (!initialJob) {
      throw new Error(`Import job ${jobId} not found`);
    }

    const existingManifest = await readProjectManifest(initialJob.project);
    const title = existingManifest?.title || humanizeSlug(initialJob.project);
    const gbrainDeps = resolveBackgroundImportGbrainDeps();

    const duplicatePathsByHash = new Map<string, string[]>();
    const sourcePagePaths: string[] = [];
    const sourceRefs: SourceRef[] = [];
    const importedFiles: ImportedFileSummary[] = [];
    const importWarnings: ImportPreview["warnings"] = [];
    const unsupportedSourceFallbackPaths: string[] = [];
    const recoveredSourceFallbackPaths: string[] = [];

    let detectedFiles = 0;
    let detectedItems = 0;
    let detectedBytes = 0;
    let skippedDuplicates = 0;
    let lastProgressWrite = 0;

    const writeProgress = async (
      phase: BackgroundImportJobPhase,
      currentPath: string | null,
      force = false,
    ) => {
      const now = Date.now();
      if (!force && now - lastProgressWrite < 250 && detectedItems > 0) {
        return;
      }
      lastProgressWrite = now;
      const duplicateGroups = Array.from(duplicatePathsByHash.values()).filter((paths) => paths.length > 1).length;
      await updateImportJob(jobId, brainRoot, (current) => ({
        ...current,
        status: "running",
        updatedAt: new Date().toISOString(),
        progress: {
          phase,
          detectedFiles,
          detectedItems,
          detectedBytes,
          importedFiles: importedFiles.length,
          skippedDuplicates,
          duplicateGroups,
          currentPath,
        },
      }));
    };

    const walkDirectory = async (dirPath: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dirPath, { withFileTypes: true });
      } catch {
        return;
      }

      entries.sort((left, right) => {
        if (left.isDirectory() && !right.isDirectory()) return -1;
        if (!left.isDirectory() && right.isDirectory()) return 1;
        const penaltyDelta = duplicateNamePenalty(left.name) - duplicateNamePenalty(right.name);
        if (penaltyDelta !== 0) return penaltyDelta;
        return left.name.localeCompare(right.name);
      });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          if (shouldSkipImportDirectory(entry.name)) continue;
          detectedItems += 1;
          await writeProgress("scanning", relative(initialJob.folderPath, fullPath) || entry.name);
          await walkDirectory(fullPath);
          continue;
        }

        if (!entry.isFile()) continue;
        if (shouldSkipImportFile(entry.name)) continue;

        let fileStat;
        try {
          fileStat = await stat(fullPath);
        } catch {
          continue;
        }

        detectedFiles += 1;
        detectedItems += 1;
        detectedBytes += fileStat.size;

        const importedFile = await loadImportedFile(fullPath, initialJob.folderPath, fileStat.size);
        const duplicateBucket = duplicatePathsByHash.get(importedFile.hash || "");
        if (duplicateBucket) {
          duplicateBucket.push(importedFile.path);
          skippedDuplicates += 1;
          await writeProgress("scanning", importedFile.path);
          continue;
        }

        if (importedFile.hash) {
          duplicatePathsByHash.set(importedFile.hash, [importedFile.path]);
        }

        await writeProgress("importing", importedFile.path);
        await persistImportedWorkspaceFile({
          projectSlug: initialJob.project,
          relativePath: importedFile.path,
          sourcePath: fullPath,
        });
        const importedSource = await importLocalFileToProject({
          brainRoot: getProjectBrainRootPath(initialJob.project),
          projectSlug: initialJob.project,
          file: importedFile,
          gbrainDeps,
        });
        if (importedSource?.sourcePagePath) {
          sourcePagePaths.push(importedSource.sourcePagePath);
        }
        if (importedSource?.sourceRef) {
          sourceRefs.push(importedSource.sourceRef);
        }
        if (importedSource?.importedFile) {
          importedFiles.push(importedSource.importedFile);
        }
        if (importedSource) {
          importWarnings.push(...importedSource.warnings);
          if (importedSource.usedSourceFallback) {
            if (importedSource.sourceFallbackReason === "recovered") {
              recoveredSourceFallbackPaths.push(importedFile.path);
            } else {
              unsupportedSourceFallbackPaths.push(importedFile.path);
            }
          }
        }
      }
    };

    await writeProgress("scanning", null, true);
    await walkDirectory(initialJob.folderPath);

    const duplicateGroups = buildDuplicateGroups(duplicatePathsByHash);
    const warnings: ImportPreview["warnings"] = [];
    if (duplicateGroups.length > 0) {
      warnings.push({
        code: "duplicates",
        message: `${duplicateGroups.length} duplicate group(s) were detected and skipped during background import.`,
      });
    }
    warnings.push(...importWarnings);
    if (unsupportedSourceFallbackPaths.length > 0) {
      warnings.push(buildSourceFallbackWarning(unsupportedSourceFallbackPaths, "unsupported"));
    }
    if (recoveredSourceFallbackPaths.length > 0) {
      warnings.push(buildSourceFallbackWarning(recoveredSourceFallbackPaths, "recovered"));
    }
    if (importedFiles.length === 0) {
      warnings.push({
        code: "empty-import",
        message: "No importable files were found in the selected local folder.",
      });
    }

    await writeProgress("finalizing", null, true);
    const finalized = await finalizeImportedProject(
      {
        projectSlug: initialJob.project,
        title,
        analysis: `Background import: ${title} (${importedFiles.length.toLocaleString("en-US")} files imported from ${detectedItems.toLocaleString("en-US")} detected items)`,
        importedFiles,
        sourcePagePaths,
        sourceRefs,
        duplicateGroups,
        warnings,
        totalFiles: importedFiles.length,
        detectedItems,
        detectedBytes,
        source: "background-local-import",
      },
      undefined,
      gbrainDeps,
    );

    const result: BackgroundImportJobResult = {
      project: finalized.project,
      title: finalized.title,
      importedFiles: importedFiles.length,
      detectedItems,
      detectedBytes,
      duplicateGroups: duplicateGroups.length,
      projectPagePath: finalized.projectPagePath,
      sourcePageCount: finalized.sourcePagePaths.length,
      generatedAt: new Date().toISOString(),
      warnings,
    };

    await updateImportJob(jobId, brainRoot, (current) => ({
      ...current,
      status: "completed",
      updatedAt: new Date().toISOString(),
      result,
      error: null,
      progress: {
        phase: "finalizing",
        detectedFiles,
        detectedItems,
        detectedBytes,
        importedFiles: importedFiles.length,
        skippedDuplicates,
        duplicateGroups: duplicateGroups.length,
        currentPath: null,
      },
    }));
  } catch (error) {
    const current = await readImportJob(jobId, brainRoot);
    if (current) {
      await writeImportJob(
        {
          ...current,
          status: "failed",
          updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "Background import failed",
        },
        brainRoot,
      );
    }
  } finally {
    runningImportJobs.delete(jobId);
  }
}
