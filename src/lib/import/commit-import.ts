import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { GbrainClient } from "@/brain/gbrain-client";
import type {
  GbrainPageFileRef,
  IngestError,
  IngestInputFile,
  IngestSuccess,
} from "@/brain/gbrain-data-contracts";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import {
  createIngestService,
  isSupportedIngestFilename,
  type IngestService,
} from "@/brain/ingest/service";
import { buildPreviewAnalysis, classifyImportFile } from "./preview-core";
import type { ContentType, ImportPreview, SourceRef, ProjectManifest } from "@/brain/types";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import { assertSafeProjectSlug, updateProjectManifest } from "@/lib/state/project-manifests";
import { getLegacyProjectStudyFilePath } from "@/lib/studies/state";
import {
  writeProjectImportSummary,
  type ProjectImportDuplicateGroupRecord,
} from "@/lib/state/project-import-summary";
import { getTargetFolder, hashContent } from "@/lib/workspace-manager";
import {
  getLegacyProjectManifestPath,
  getProjectRootPath,
} from "@/lib/state/project-storage";

export interface ImportedFileRecord {
  path: string;
  name: string;
  type: string;
  size: number;
  content?: string;
  sourcePath?: string;
  hash?: string;
  metadata?: Record<string, unknown>;
}

export interface ImportCommitRequest {
  folder: {
    name: string;
    basePath?: string;
    backend?: string;
    totalFiles: number;
    detectedItems?: number;
    detectedBytes?: number;
    files: ImportedFileRecord[];
    tree?: unknown[];
    analysis?: string;
    projects?: ImportPreview["projects"];
    duplicateGroups?: ImportPreview["duplicateGroups"];
    warnings?: ImportPreview["warnings"];
  };
  preview: ImportPreview;
  projectSlug?: string;
}

export interface ImportCommitResult {
  project: string;
  title: string;
  projectPagePath: string;
  manifestPath: string;
  sourcePagePaths: string[];
  sourceRefs: SourceRef[];
  duplicateGroups: ImportPreview["duplicateGroups"];
  warnings: ImportPreview["warnings"];
}

export interface ImportedFileSummary {
  path: string;
  classification: string;
}

interface ImportedPageDescriptor {
  type: ContentType;
  directory: string;
  tags: string[];
  format?: string;
  importClassification: string;
}

interface ImportedSourceResult {
  sourcePagePath?: string;
  sourceRef?: SourceRef;
  importedFile?: ImportedFileSummary;
  warnings: ImportPreview["warnings"];
  usedSourceFallback: boolean;
  sourceFallbackReason?: SourceFallbackReason;
}

export type SourceFallbackReason = "unsupported" | "recovered";

export interface ImportCommitOptions {
  /**
   * Enables direct gbrain writes. Legacy tests and compatibility callers can
   * omit this and keep disk-only mirrors.
   */
  enableGbrain?: boolean;
  gbrain?: GbrainClient;
  ingestService?: IngestService;
  uploadedBy?: string;
}

export interface ImportGbrainDeps {
  gbrain: GbrainClient;
  ingestService: IngestService;
  uploadedBy: string;
}

export async function commitImportedProject(
  request: ImportCommitRequest,
  brainRoot?: string,
  options: ImportCommitOptions = {},
): Promise<ImportCommitResult> {
  const projectSlug = resolveProjectSlug(request);
  const selectedProject = findPreviewProject(request.preview, projectSlug);
  const title = selectedProject?.title || humanizeSlug(projectSlug);
  const skippedDuplicatePaths = buildSkippedDuplicatePaths(request.preview.duplicateGroups);
  const filesToImport = request.folder.files.filter((file) => !skippedDuplicatePaths.has(file.path));
  const gbrainDeps = resolveGbrainDeps(options);

  const importedFiles: ImportedFileSummary[] = [];
  const sourcePagePaths: string[] = [];
  const sourceRefs: SourceRef[] = [];
  const warnings = [...(request.preview.warnings ?? [])];
  const unsupportedSourceFallbackPaths: string[] = [];
  const recoveredSourceFallbackPaths: string[] = [];

  for (const file of filesToImport) {
    const importedSource = await importLocalFileToProject({
      brainRoot,
      projectSlug,
      file,
      gbrainDeps,
    });
    if (!importedSource) continue;
    if (importedSource.importedFile) {
      importedFiles.push(importedSource.importedFile);
    }
    if (importedSource.sourcePagePath) {
      sourcePagePaths.push(importedSource.sourcePagePath);
    }
    if (importedSource.sourceRef) {
      sourceRefs.push(importedSource.sourceRef);
    }
    warnings.push(...importedSource.warnings);
    if (importedSource.usedSourceFallback) {
      if (importedSource.sourceFallbackReason === "recovered") {
        recoveredSourceFallbackPaths.push(file.path);
      } else {
        unsupportedSourceFallbackPaths.push(file.path);
      }
    }
  }

  if (unsupportedSourceFallbackPaths.length > 0) {
    warnings.push(buildSourceFallbackWarning(unsupportedSourceFallbackPaths, "unsupported"));
  }
  if (recoveredSourceFallbackPaths.length > 0) {
    warnings.push(buildSourceFallbackWarning(recoveredSourceFallbackPaths, "recovered"));
  }

  return finalizeImportedProject(
    {
      projectSlug,
      title,
      analysis: request.folder.analysis || buildPreviewAnalysis(request.preview),
      importedFiles,
      sourcePagePaths,
      sourceRefs,
      duplicateGroups: request.preview.duplicateGroups,
      warnings,
      totalFiles: filesToImport.length,
      detectedItems: request.folder.detectedItems,
      detectedBytes: request.folder.detectedBytes,
      source: request.folder.backend?.trim() || request.preview.backend || "local-scan",
    },
    brainRoot,
    gbrainDeps,
  );
}

export async function importLocalFileToProject(input: {
  brainRoot?: string;
  projectSlug: string;
  file: ImportedFileRecord;
  gbrainDeps?: ImportGbrainDeps | null;
}): Promise<ImportedSourceResult | null> {
  if (input.gbrainDeps && isSupportedIngestFilename(input.file.path || input.file.name)) {
    await persistProductionWorkspaceMirror(input);
    return ingestSupportedSourceFileToProject({
      brainRoot: input.brainRoot,
      projectSlug: input.projectSlug,
      file: input.file,
      deps: input.gbrainDeps,
    });
  }

  const fallback = await importSourceFileToProject(input);
  return {
    ...fallback,
    warnings: fallback.warnings ?? [],
    usedSourceFallback: Boolean(input.gbrainDeps),
    sourceFallbackReason: input.gbrainDeps ? "unsupported" : undefined,
  };
}

async function persistProductionWorkspaceMirror(input: {
  brainRoot?: string;
  projectSlug: string;
  file: ImportedFileRecord;
}): Promise<void> {
  if (input.brainRoot) return;
  await persistImportedWorkspaceFile({
    projectSlug: input.projectSlug,
    relativePath: input.file.path,
    sourcePath: input.file.sourcePath,
    content: input.file.content,
  });
}

export function getImportedWorkspacePath(projectSlug: string, relativePath: string): string {
  const safeSlug = assertSafeProjectSlug(projectSlug);
  const normalizedSegments = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]+/g, "-"))
    .filter((segment) => segment && segment !== "." && segment !== "..");

  if (normalizedSegments.length === 0) {
    normalizedSegments.push("source");
  }

  const firstSegment = normalizedSegments[0];
  if (firstSegment === ".brain" || (normalizedSegments.length === 1 && firstSegment === "project.json")) {
    normalizedSegments.unshift("source");
  } else if (normalizedSegments.length === 1) {
    const targetFolder = getTargetFolder(firstSegment);
    if (targetFolder !== "other") {
      normalizedSegments.unshift(targetFolder);
    }
  }

  return join(getProjectRootPath(safeSlug), ...normalizedSegments);
}

export async function persistImportedWorkspaceFile(input: {
  projectSlug: string;
  relativePath: string;
  sourcePath?: string;
  content?: string;
}): Promise<string | null> {
  const targetPath = getImportedWorkspacePath(input.projectSlug, input.relativePath);
  await mkdir(dirname(targetPath), { recursive: true });

  if (input.sourcePath) {
    await copyFile(input.sourcePath, targetPath);
    return targetPath;
  }

  if (input.content !== undefined) {
    await writeFile(targetPath, input.content, "utf-8");
    return targetPath;
  }

  return null;
}

export async function importSourceFileToProject(input: {
  brainRoot?: string;
  projectSlug: string;
  file: ImportedFileRecord;
  gbrainDeps?: ImportGbrainDeps | null;
  allowMissingGbrainFileRef?: boolean;
  skipWorkspaceMirror?: boolean;
}): Promise<{
  sourcePagePath: string;
  sourceRef: SourceRef;
  importedFile: ImportedFileSummary;
  warnings?: ImportPreview["warnings"];
}> {
  const classification = classifyImportFile(input.file);
  const descriptor = describeImportedPage(input.file, classification);
  const sourcePagePath = buildSourcePagePath(input.projectSlug, input.file.path, descriptor.directory);
  const sourceRef: SourceRef = {
    kind: "import",
    ref: input.file.path,
    hash: input.file.hash,
  };
  const content = input.file.content ?? `[No extracted content for ${input.file.path}]`;
  const pageSlug = slugFromPagePath(sourcePagePath);
  let sourceFileRef: GbrainPageFileRef | undefined;
  const warnings: ImportPreview["warnings"] = [];

  if (input.gbrainDeps) {
    try {
      const attached = await attachImportedSourceFile({
        deps: input.gbrainDeps,
        projectSlug: input.projectSlug,
        file: input.file,
        pageSlug,
      });
      sourceFileRef = attached.pageFileRef;
    } catch {
      if (!input.allowMissingGbrainFileRef) {
        throw new Error(`Failed to attach imported file ${input.file.path}`);
      }
      warnings.push({
        path: input.file.path,
        code: "source-attachment-failed",
        message:
          `Imported ${input.file.path} as a gbrain source page, but could not attach the original bytes. ` +
          "The file remains visible in the import results; retry with a smaller or supported file if byte-level access is required.",
      });
    }
  }

  if (!input.brainRoot) {
    await writeImportPage(join(getScienceSwarmBrainRoot(), sourcePagePath), {
      title: input.file.name,
      project: input.projectSlug,
      sourceRefs: [sourceRef],
      descriptor,
      summary: input.file.metadata ? JSON.stringify(input.file.metadata) : undefined,
      content,
      sourceFileRef,
    });
  } else {
    await writeImportPage(join(input.brainRoot, sourcePagePath), {
      title: input.file.name,
      project: input.projectSlug,
      sourceRefs: [sourceRef],
      descriptor,
      summary: input.file.metadata ? JSON.stringify(input.file.metadata) : undefined,
      content,
      sourceFileRef,
    });
  }

  if (input.gbrainDeps) {
    const pageContent = buildImportPageContent({
      title: input.file.name,
      project: input.projectSlug,
      sourceRefs: [sourceRef],
      descriptor,
      summary: input.file.metadata ? JSON.stringify(input.file.metadata) : undefined,
      content,
      sourceFileRef,
    });
    await input.gbrainDeps.gbrain.putPage(pageSlug, pageContent);
  }

  if (!input.brainRoot && !input.skipWorkspaceMirror) {
    await persistImportedWorkspaceFile({
      projectSlug: input.projectSlug,
      relativePath: input.file.path,
      sourcePath: input.file.sourcePath,
      content: input.file.content,
    });
  }

  return {
    sourcePagePath,
    sourceRef,
    importedFile: {
      path: input.file.path,
      classification,
    },
    warnings,
  };
}

async function ingestSupportedSourceFileToProject(input: {
  brainRoot?: string;
  projectSlug: string;
  file: ImportedFileRecord;
  deps: ImportGbrainDeps;
}): Promise<ImportedSourceResult | null> {
  const ingestInput = await importedFileToIngestInput({
    projectSlug: input.projectSlug,
    file: input.file,
    uploadedBy: input.deps.uploadedBy,
  });
  const result = await input.deps.ingestService.ingestFiles([ingestInput]);
  const success = result.slugs[0];
  const ingestWarnings = buildIngestWarnings(input.file.path, result.errors);

  if (!success) {
    if (result.errors.some((error) => error.recoverable)) {
      const fallback = await importSourceFileToProject({
        brainRoot: input.brainRoot,
        projectSlug: input.projectSlug,
        file: input.file,
        gbrainDeps: input.deps,
        allowMissingGbrainFileRef: true,
        skipWorkspaceMirror: !input.brainRoot,
      });
      return {
        sourcePagePath: fallback.sourcePagePath,
        sourceRef: fallback.sourceRef,
        importedFile: fallback.importedFile,
        warnings: [...ingestWarnings, ...(fallback.warnings ?? [])],
        usedSourceFallback: true,
        sourceFallbackReason: "recovered",
      };
    }

    return {
      warnings: ingestWarnings.length > 0
        ? ingestWarnings
        : [{
            path: input.file.path,
            code: "ingest-empty",
            message: `Could not import ${input.file.path} through the canonical gbrain ingest path: no page was written.`,
          }],
      usedSourceFallback: false,
    };
  }

  return {
    sourcePagePath: `${success.slug}.md`,
    sourceRef: {
      kind: "import",
      ref: input.file.path,
      hash: success.file.sha256,
    },
    importedFile: {
      path: input.file.path,
      classification: classifyImportFile(input.file),
    },
    warnings: ingestWarnings,
    usedSourceFallback: false,
  };
}

export async function finalizeImportedProject(
  input: {
    projectSlug: string;
    title: string;
    analysis: string;
    importedFiles: ImportedFileSummary[];
    sourcePagePaths: string[];
    sourceRefs: SourceRef[];
    duplicateGroups: ImportPreview["duplicateGroups"];
    warnings: ImportPreview["warnings"];
    totalFiles: number;
    detectedItems?: number;
    detectedBytes?: number;
    source: string;
  },
  brainRoot?: string,
  gbrainDeps?: ImportGbrainDeps | null,
): Promise<ImportCommitResult> {
  const projectPagePath = `wiki/projects/${input.projectSlug}.md`;

  const absoluteProjectPagePath = brainRoot
    ? join(brainRoot, projectPagePath)
    : join(getScienceSwarmBrainRoot(), projectPagePath);

  await mkdir(dirname(absoluteProjectPagePath), { recursive: true });

  const projectPageContent = buildProjectPageContent({
    title: input.title,
    projectSlug: input.projectSlug,
    sourceRefs: input.sourceRefs,
    analysis: input.analysis,
    files: input.importedFiles,
    sourcePagePaths: input.sourcePagePaths,
    duplicateGroups: input.duplicateGroups,
    warnings: input.warnings,
  });
  await writeFile(absoluteProjectPagePath, projectPageContent, "utf-8");
  if (gbrainDeps) {
    await gbrainDeps.gbrain.putPage(
      slugFromPagePath(projectPagePath),
      projectPageContent,
    );
  }

  await updateProjectManifest(
    input.projectSlug,
    (current) => mergeManifest(current, {
      projectSlug: input.projectSlug,
      title: input.title,
      projectPagePath,
      sourceRefs: input.sourceRefs,
      sourcePagePaths: input.sourcePagePaths,
      duplicateGroups: input.duplicateGroups,
      warnings: input.warnings,
      totalFiles: input.totalFiles,
    }),
    brainRoot ? join(brainRoot, "state") : undefined,
  );

  await writeProjectImportSummary(
    input.projectSlug,
    {
      name: input.title,
      preparedFiles: input.totalFiles,
      detectedItems: input.detectedItems,
      detectedBytes: input.detectedBytes,
      duplicateGroups: input.duplicateGroups.length,
      duplicateGroupDetails: buildImportDuplicateGroupRecords(input.duplicateGroups),
      generatedAt: new Date().toISOString(),
      source: input.source,
    },
    brainRoot ? join(brainRoot, "state") : undefined,
  );

  return {
    project: input.projectSlug,
    title: input.title,
    projectPagePath,
    manifestPath: brainRoot
      ? getLegacyProjectManifestPath(input.projectSlug, join(brainRoot, "state"))
      : getLegacyProjectStudyFilePath(input.projectSlug, "manifest.json"),
    sourcePagePaths: input.sourcePagePaths,
    sourceRefs: input.sourceRefs,
    duplicateGroups: input.duplicateGroups,
    warnings: input.warnings,
  };
}

function buildImportDuplicateGroupRecords(
  duplicateGroups: ImportPreview["duplicateGroups"],
): ProjectImportDuplicateGroupRecord[] {
  return duplicateGroups.map((group) => ({
    id: group.id,
    paths: [...group.paths],
    reason: group.reason,
    ...(typeof group.hashPrefix === "string" && group.hashPrefix.length > 0
      ? { hashPrefix: group.hashPrefix }
      : {}),
    ...(typeof group.contentType === "string" && group.contentType.length > 0
      ? { contentType: group.contentType }
      : {}),
  }));
}

function mergeManifest(
  current: ProjectManifest | null,
  input: {
    projectSlug: string;
    title: string;
    projectPagePath: string;
    sourceRefs: SourceRef[];
    sourcePagePaths: string[];
    duplicateGroups: ImportPreview["duplicateGroups"];
    warnings: ImportPreview["warnings"];
    totalFiles: number;
  },
): ProjectManifest {
  const now = new Date().toISOString();
  const existingRefs = current?.sourceRefs ?? [];
  const dedupeKeys = new Set(current?.dedupeKeys ?? []);

  for (const ref of input.sourceRefs) {
    const key = `${ref.kind}:${ref.ref}:${ref.hash ?? ""}`;
    dedupeKeys.add(key);
  }

  return {
    version: 1,
    projectId: current?.projectId ?? input.projectSlug,
    slug: input.projectSlug,
    title: input.title,
    privacy: current?.privacy ?? "cloud-ok",
    status: current?.status ?? "active",
    projectPagePath: input.projectPagePath,
    sourceRefs: dedupeSourceRefs(existingRefs.concat(input.sourceRefs)),
    decisionPaths: current?.decisionPaths ?? [],
    taskPaths: current?.taskPaths ?? [],
    artifactPaths: current?.artifactPaths ?? [],
    frontierPaths: current?.frontierPaths ?? [],
    activeThreads: current?.activeThreads ?? [],
    dedupeKeys: Array.from(dedupeKeys),
    lastBriefAt: current?.lastBriefAt,
    updatedAt: now,
  };
}

function dedupeSourceRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const result: SourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.ref}:${ref.hash ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function buildProjectPageContent(input: {
  title: string;
  projectSlug: string;
  sourceRefs: SourceRef[];
  analysis: string;
  files: Array<{ path: string; classification: string }>;
  sourcePagePaths: string[];
  duplicateGroups: ImportPreview["duplicateGroups"];
  warnings: ImportPreview["warnings"];
}): string {
  const today = new Date().toISOString().slice(0, 10);
  const frontmatter = [
    "---",
    `date: ${today}`,
    `title: ${JSON.stringify(input.title)}`,
    "type: project",
    "para: projects",
    `project: ${JSON.stringify(input.projectSlug)}`,
    "tags: [import]",
    `source_refs: ${JSON.stringify(input.sourceRefs)}`,
    "status: active",
    "privacy: cloud-ok",
    "---",
  ].join("\n");

  const sources = input.sourcePagePaths.map((path) => `- [[${path}]]`).join("\n") || "- (none)";
  const duplicates = input.duplicateGroups.length
    ? input.duplicateGroups.map((group) => `- ${group.reason}: ${group.paths.join(", ")}`).join("\n")
    : "- None detected";
  const warnings = input.warnings.length
    ? input.warnings.map((warning) => `- ${warning.code}: ${warning.message}`).join("\n")
    : "- None";
  const fileLines = input.files.map((file) => `- ${file.path} (${file.classification})`).join("\n") || "- (none)";

  return [
    frontmatter,
    "",
    `# ${input.title}`,
    "",
    "## Summary",
    input.analysis,
    "",
    "## Imported Files",
    fileLines,
    "",
    "## Linked Source Pages",
    sources,
    "",
    "## Duplicate Groups",
    duplicates,
    "",
    "## Warnings",
    warnings,
    "",
  ].join("\n");
}

function buildSkippedDuplicatePaths(
  duplicateGroups: ImportPreview["duplicateGroups"],
): Set<string> {
  const skipped = new Set<string>();
  for (const group of duplicateGroups) {
    for (const path of group.paths.slice(1)) {
      skipped.add(path);
    }
  }
  return skipped;
}

export function buildSourceFallbackWarning(
  paths: string[],
  reason: SourceFallbackReason,
): ImportPreview["warnings"][number] {
  const preview = paths.slice(0, 5).join(", ");
  const remaining = paths.length > 5 ? ` and ${paths.length - 5} more` : "";
  if (reason === "recovered") {
    return {
      code: "source-fallback-recovered",
      message:
        `${paths.length.toLocaleString("en-US")} file(s) were saved to the project and linked in gbrain ` +
        `after typed page conversion failed: ${preview}${remaining}.`,
    };
  }
  return {
    code: "source-fallback-unsupported",
    message:
      `${paths.length.toLocaleString("en-US")} file(s) were saved to the project and linked in gbrain, ` +
      `but were not converted into typed paper/dataset/code pages because this importer currently converts ` +
      `PDFs, CSV/TSV files, and source-code files: ${preview}${remaining}.`,
  };
}

function buildIngestWarnings(path: string, errors: IngestError[]): ImportPreview["warnings"] {
  return errors.map((error) => ({
    path,
    code: `ingest-${error.code}`,
    message: `Could not import ${path} through the canonical gbrain ingest path: ${error.message}`,
  }));
}

async function writeImportPage(
  filePath: string,
  input: {
    title: string;
    project: string;
    sourceRefs: SourceRef[];
    descriptor: ImportedPageDescriptor;
    summary?: string;
    content: string;
    sourceFileRef?: GbrainPageFileRef;
  },
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, buildImportPageContent(input), "utf-8");
}

function buildImportPageContent(input: {
  title: string;
  project: string;
  sourceRefs: SourceRef[];
  descriptor: ImportedPageDescriptor;
  summary?: string;
  content: string;
  sourceFileRef?: GbrainPageFileRef;
}): string {
  const today = new Date().toISOString().slice(0, 10);
  const frontmatter = [
    "---",
    `date: ${today}`,
    `title: ${JSON.stringify(input.title)}`,
    `type: ${input.descriptor.type}`,
    "para: resources",
    `tags: ${JSON.stringify(input.descriptor.tags)}`,
    `project: ${JSON.stringify(input.project)}`,
    `source_refs: ${JSON.stringify(input.sourceRefs)}`,
    "status: active",
    `import_classification: ${JSON.stringify(input.descriptor.importClassification)}`,
  ];
  if (input.descriptor.format) {
    frontmatter.push(`format: ${JSON.stringify(input.descriptor.format)}`);
  }
  if (input.sourceFileRef) {
    frontmatter.push(
      `file_object_id: ${JSON.stringify(input.sourceFileRef.fileObjectId)}`,
      `source_file_object_id: ${JSON.stringify(input.sourceFileRef.fileObjectId)}`,
      `file_refs: ${JSON.stringify([input.sourceFileRef])}`,
    );
  }
  frontmatter.push("---");

  const body = [
    frontmatter.join("\n"),
    "",
    `# ${input.title}`,
    "",
    "## Imported Content",
    "",
    input.content.trim(),
  ];

  if (input.summary) {
    body.push("", "## Metadata", "", input.summary);
  }

  return body.join("\n");
}

function resolveGbrainDeps(options: ImportCommitOptions): ImportGbrainDeps | null {
  if (!options.enableGbrain && !options.gbrain && !options.ingestService) {
    return null;
  }
  const gbrain = options.gbrain ?? createInProcessGbrainClient();
  return {
    gbrain,
    ingestService: options.ingestService ?? createIngestService({ gbrain }),
    uploadedBy: options.uploadedBy ?? resolveImportUploadedBy(),
  };
}

function resolveImportUploadedBy(): string {
  try {
    return getCurrentUserHandle();
  } catch {
    throw new Error("uploadedBy is required when gbrain is enabled");
  }
}

async function attachImportedSourceFile(input: {
  deps: ImportGbrainDeps;
  projectSlug: string;
  file: ImportedFileRecord;
  pageSlug: string;
}): Promise<IngestSuccess> {
  const ingestInput = await importedFileToIngestInput({
    projectSlug: input.projectSlug,
    file: input.file,
    uploadedBy: input.deps.uploadedBy,
  });
  const result = await input.deps.ingestService.attachSourceFile({
    ...ingestInput,
    pageSlug: input.pageSlug,
  });
  if ("code" in result) {
    throw new Error(`Failed to attach imported file ${input.file.path}`);
  }
  return result;
}

async function importedFileToIngestInput(input: {
  projectSlug: string;
  file: ImportedFileRecord;
  uploadedBy: string;
}): Promise<IngestInputFile> {
  if (input.file.sourcePath) {
    const fileStat = await stat(input.file.sourcePath);
    return {
      project: input.projectSlug,
      filename: input.file.name || basename(input.file.path),
      relativePath: input.file.path,
      mime: mimeFromImportedFile(input.file),
      sizeBytes: fileStat.size,
      stream: Readable.toWeb(createReadStream(input.file.sourcePath)) as ReadableStream<Uint8Array>,
      uploadedBy: input.uploadedBy,
      source: { kind: "commit_import", sourcePath: input.file.path },
    };
  }

  const bytes = new TextEncoder().encode(
    input.file.content ?? `[No extracted content for ${input.file.path}]`,
  );
  return {
    project: input.projectSlug,
    filename: input.file.name || basename(input.file.path),
    relativePath: input.file.path,
    mime: mimeFromImportedFile(input.file),
    sizeBytes: bytes.byteLength,
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    uploadedBy: input.uploadedBy,
    source: { kind: "commit_import", sourcePath: input.file.path },
  };
}

function mimeFromImportedFile(file: ImportedFileRecord): string {
  const type = file.type.toLowerCase();
  if (type === "md" || type === "markdown") return "text/markdown";
  if (type === "csv") return "text/csv";
  if (type === "tsv") return "text/tab-separated-values";
  if (type === "pdf") return "application/pdf";
  if (type === "json") return "application/json";
  if (type === "ipynb") return "application/x-ipynb+json";
  if (["py", "r", "jl", "ts", "tsx", "js", "jsx"].includes(type)) {
    return "text/plain";
  }
  return "application/octet-stream";
}

function slugFromPagePath(pagePath: string): string {
  return pagePath
    .replace(/\\/g, "/")
    .replace(/^wiki\//, "")
    .replace(/\.md$/i, "");
}

function buildSourcePagePath(projectSlug: string, sourcePath: string, directory: string): string {
  const safeName = sourcePath
    .split(/[\\/]/)
    .filter(Boolean)
    .join("-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/\.md$/i, "");
  const base = basename(sourcePath).replace(/\.[^.]+$/, "");
  const finalName = safeName || slugify(base) || "source";
  const uniqueSuffix = shortHash(sourcePath);
  return `${directory}/${projectSlug}/${finalName}-${uniqueSuffix}.md`;
}

function resolveProjectSlug(request: ImportCommitRequest): string {
  if (request.projectSlug) {
    return assertSafeProjectSlug(request.projectSlug);
  }

  const previewSlug = request.preview.projects[0]?.slug;
  if (previewSlug) {
    return assertSafeProjectSlug(previewSlug);
  }

  return slugify(request.folder.name);
}

function findPreviewProject(preview: ImportPreview, projectSlug: string) {
  return preview.projects.find((project) => project.slug === projectSlug);
}

function describeImportedPage(
  file: ImportedFileRecord,
  classification?: string,
): ImportedPageDescriptor {
  const normalizedClassification = normalizeImportClassification(classification);
  const tags = ["import", toTag(normalizedClassification)];

  if (normalizedClassification === "paper") {
    return {
      type: "paper",
      directory: "wiki/entities/papers/imports",
      tags,
      format: file.type || "pdf",
      importClassification: normalizedClassification,
    };
  }

  if (normalizedClassification === "data" || normalizedClassification === "spreadsheet") {
    return {
      type: "data",
      directory: "wiki/resources/data/imports",
      tags,
      format: file.type || normalizedClassification,
      importClassification: normalizedClassification,
    };
  }

  if (["notebook", "stats", "code", "protocol", "draft"].includes(normalizedClassification)) {
    return {
      type: "artifact",
      directory: "wiki/entities/artifacts/imports",
      tags,
      format: file.type || normalizedClassification,
      importClassification: normalizedClassification,
    };
  }

  return {
    type: "note",
    directory: "wiki/resources/imports",
    tags,
    format: file.type || undefined,
    importClassification: normalizedClassification,
  };
}

function normalizeImportClassification(classification?: string): string {
  if (!classification || classification === "text" || classification === "other") {
    return "note";
  }

  return classification;
}

function toTag(value: string): string {
  return value.toLowerCase().replace(/_/g, "-");
}

function shortHash(value: string): string {
  return hashContent(value).slice(0, 8);
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
