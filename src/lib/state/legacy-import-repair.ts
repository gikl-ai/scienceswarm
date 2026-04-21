import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import matter from "gray-matter";
import type { ProjectManifest, SourceRef } from "@/brain/types";
import { getImportedWorkspacePath, finalizeImportedProject } from "@/lib/import/commit-import";
import { getScienceSwarmBrainRoot, getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { writeProjectImportSummary, type ProjectImportSummaryRecord } from "@/lib/state/project-import-summary";
import {
  getProjectLocalStateRoot,
  getProjectBrainRootPath,
  getProjectRootPath,
} from "@/lib/state/project-storage";
import { readJsonFile } from "./atomic-json";
import { assertSafeProjectSlug, readProjectManifest } from "./project-manifests";

const ROOT_IGNORED_FILES = new Set(["project.json", ".references.json"]);
const ROOT_IGNORED_DIRS = new Set([".brain"]);
const LEGACY_REPAIR_SENTINEL = "legacy-import-repair-in-progress.json";

export interface LegacyImportRepairResult {
  project: string;
  legacyProject: string;
  importedPages: number;
  recoveredWorkspaceFiles: number;
  skippedWorkspaceFiles: number;
}

interface LegacyImportPageRecord {
  relativePath: string;
  absolutePath: string;
}

interface ParsedLegacyImportPage {
  relativePath: string;
  parsed: matter.GrayMatterFile<string>;
  sourceRef: SourceRef | null;
  importedPath: string | null;
  classification: string;
  recoverableContent: string | null;
}

function normalizeSlugForLegacyMatch(slug: string): string {
  return slug.replace(/-/g, "");
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function getLegacyStateProjectsRoot(legacyBrainRoot: string): string {
  return join(legacyBrainRoot, "state", "projects");
}

function getLegacyImportSummaryPath(projectSlug: string, legacyBrainRoot: string): string {
  return join(getLegacyStateProjectsRoot(legacyBrainRoot), projectSlug, "import-summary.json");
}

function getLegacyManifestPath(projectSlug: string, legacyBrainRoot: string): string {
  return join(getLegacyStateProjectsRoot(legacyBrainRoot), projectSlug, "manifest.json");
}

function getLegacyImportRoots(projectSlug: string, legacyBrainRoot: string): string[] {
  return [
    join(legacyBrainRoot, "wiki", "entities", "artifacts", "imports", projectSlug),
    join(legacyBrainRoot, "wiki", "entities", "papers", "imports", projectSlug),
    join(legacyBrainRoot, "wiki", "resources", "imports", projectSlug),
    join(legacyBrainRoot, "wiki", "resources", "data", "imports", projectSlug),
  ];
}

async function directoryHasVisibleWorkspaceFiles(dir: string, depth = 0): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ROOT_IGNORED_DIRS.has(entry.name)) continue;
      if (await directoryHasVisibleWorkspaceFiles(join(dir, entry.name), depth + 1)) {
        return true;
      }
      continue;
    }

    if (depth === 0 && ROOT_IGNORED_FILES.has(entry.name)) continue;
    return true;
  }

  return false;
}

function getLegacyRepairSentinelPath(projectStateRoot: string): string {
  return join(projectStateRoot, LEGACY_REPAIR_SENTINEL);
}

async function writeLegacyRepairSentinel(
  projectStateRoot: string,
  input: { project: string; legacyProject: string },
): Promise<void> {
  await mkdir(projectStateRoot, { recursive: true });
  await writeFile(
    getLegacyRepairSentinelPath(projectStateRoot),
    JSON.stringify(
      {
        project: input.project,
        legacyProject: input.legacyProject,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function clearLegacyRepairSentinel(projectStateRoot: string): Promise<void> {
  await rm(getLegacyRepairSentinelPath(projectStateRoot), { force: true });
}

async function listLegacyStateCandidates(projectSlug: string, legacyBrainRoot: string): Promise<string[]> {
  const normalizedTarget = normalizeSlugForLegacyMatch(projectSlug);
  let entries;
  try {
    entries = await readdir(getLegacyStateProjectsRoot(legacyBrainRoot), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((candidate) => candidate !== projectSlug)
    .filter((candidate) => normalizeSlugForLegacyMatch(candidate) === normalizedTarget);
}

async function countLegacyImportPages(projectSlug: string, legacyBrainRoot: string): Promise<number> {
  let count = 0;
  for (const root of getLegacyImportRoots(projectSlug, legacyBrainRoot)) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        count += 1;
      }
    }
  }
  return count;
}

async function chooseLegacyImportCandidate(
  projectSlug: string,
  legacyBrainRoot: string,
): Promise<string | null> {
  const candidates = await listLegacyStateCandidates(projectSlug, legacyBrainRoot);
  if (candidates.length === 0) return null;

  let bestCandidate: string | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const importSummary = await readJsonFile<ProjectImportSummaryRecord>(
      getLegacyImportSummaryPath(candidate, legacyBrainRoot),
    );
    const pageCount = await countLegacyImportPages(candidate, legacyBrainRoot);
    const preparedFiles = importSummary?.lastImport?.preparedFiles ?? 0;
    const detectedItems = importSummary?.lastImport?.detectedItems ?? 0;
    const score = (importSummary?.lastImport ? 1_000_000 : 0) + (detectedItems * 10) + preparedFiles + pageCount;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

async function collectLegacyImportPages(
  legacyProjectSlug: string,
  legacyBrainRoot: string,
): Promise<LegacyImportPageRecord[]> {
  const pages: LegacyImportPageRecord[] = [];

  for (const root of getLegacyImportRoots(legacyProjectSlug, legacyBrainRoot)) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const absolutePath = join(root, entry.name);
      const relativePath = absolutePath.slice(legacyBrainRoot.length + 1);
      pages.push({ absolutePath, relativePath });
    }
  }

  return pages.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function pickImportSourceRef(value: unknown): SourceRef | null {
  if (!Array.isArray(value)) return null;

  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as Partial<SourceRef>;
    if (candidate.kind === "import" && typeof candidate.ref === "string") {
      return {
        kind: "import",
        ref: candidate.ref,
        hash: typeof candidate.hash === "string" ? candidate.hash : undefined,
      };
    }
  }

  return null;
}

function extractImportedContent(markdownBody: string): string | null {
  const marker = "## Imported Content";
  const start = markdownBody.indexOf(marker);
  if (start < 0) return null;

  const afterMarker = markdownBody.slice(start + marker.length).replace(/^\s+/, "");
  const metadataIndex = afterMarker.indexOf("\n## Metadata");
  const content = metadataIndex >= 0 ? afterMarker.slice(0, metadataIndex) : afterMarker;
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecoverableImportedContent(content: string | null): content is string {
  if (!content) return false;
  return !(
    content.startsWith("[No extracted content for ")
    || content.startsWith("[Skipped:")
    || content.startsWith("[Binary file:")
  );
}

function rewriteImportPageProject(
  parsed: matter.GrayMatterFile<string>,
  projectSlug: string,
): string {
  return matter.stringify(parsed.content, {
    ...parsed.data,
    project: projectSlug,
  });
}

async function parseLegacyImportPages(
  projectSlug: string,
  legacyProjectSlug: string,
  legacyBrainRoot: string,
): Promise<ParsedLegacyImportPage[]> {
  const pages = await collectLegacyImportPages(legacyProjectSlug, legacyBrainRoot);
  const parsedPages: ParsedLegacyImportPage[] = [];

  for (const page of pages) {
    const raw = await readFile(page.absolutePath, "utf-8");
    const parsed = matter(raw);
    const sourceRef = pickImportSourceRef(parsed.data.source_refs);
    const importedPath = typeof sourceRef?.ref === "string" ? sourceRef.ref : null;
    const recoverableContent = extractImportedContent(parsed.content);
    const classification = typeof parsed.data.import_classification === "string"
      ? parsed.data.import_classification
      : "artifact";

    const canonicalRelativePath = page.relativePath.replace(
      `${legacyProjectSlug}/`,
      `${projectSlug}/`,
    );

    parsedPages.push({
      relativePath: canonicalRelativePath,
      parsed,
      sourceRef,
      importedPath,
      classification,
      recoverableContent,
    });
  }

  return parsedPages;
}

async function writeCanonicalImportPage(
  canonicalProjectSlug: string,
  canonicalRelativePath: string,
  parsed: matter.GrayMatterFile<string>,
  projectsRoot: string,
): Promise<void> {
  const projectBrainRoot = getProjectBrainRootPath(canonicalProjectSlug, projectsRoot);
  const absolutePath = join(projectBrainRoot, canonicalRelativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, rewriteImportPageProject(parsed, canonicalProjectSlug), "utf-8");
}

async function restoreWorkspaceFile(
  projectSlug: string,
  relativePath: string,
  content: string,
  projectsRoot: string,
): Promise<void> {
  const defaultProjectRoot = getProjectRootPath(projectSlug);
  const targetPath = join(
    getProjectRootPath(projectSlug, projectsRoot),
    relative(defaultProjectRoot, getImportedWorkspacePath(projectSlug, relativePath)),
  );
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf-8");
}

async function readLegacyManifest(
  legacyProjectSlug: string,
  legacyBrainRoot: string,
): Promise<ProjectManifest | null> {
  return readJsonFile<ProjectManifest>(getLegacyManifestPath(legacyProjectSlug, legacyBrainRoot));
}

function buildRepairAnalysis(input: {
  legacyProjectSlug: string;
  recoveredWorkspaceFiles: number;
  importedPages: number;
  skippedWorkspaceFiles: number;
}): string {
  const lines = [
    `Recovered ${input.importedPages} imported source page${input.importedPages === 1 ? "" : "s"} from the local legacy import store for ${input.legacyProjectSlug}.`,
    `${input.recoveredWorkspaceFiles} workspace file${input.recoveredWorkspaceFiles === 1 ? "" : "s"} were restored into the canonical project root.`,
  ];

  if (input.skippedWorkspaceFiles > 0) {
    lines.push(
      `${input.skippedWorkspaceFiles} file${input.skippedWorkspaceFiles === 1 ? "" : "s"} could not be reconstructed as raw workspace files because only derived or placeholder content remained in the local import pages.`,
    );
  }

  return lines.join(" ");
}

export async function repairLegacyImportedProject(projectSlug: string, input?: {
  projectsRoot?: string;
  legacyBrainRoot?: string;
}): Promise<LegacyImportRepairResult | null> {
  const safeSlug = assertSafeProjectSlug(projectSlug);
  const projectsRoot = input?.projectsRoot ?? getScienceSwarmProjectsRoot();
  const legacyBrainRoot = input?.legacyBrainRoot ?? getScienceSwarmBrainRoot();
  const projectRoot = getProjectRootPath(safeSlug, projectsRoot);
  const projectStateRoot = getProjectLocalStateRoot(safeSlug, projectsRoot);
  const projectBrainRoot = getProjectBrainRootPath(safeSlug, projectsRoot);
  const repairInProgress = existsSync(getLegacyRepairSentinelPath(projectStateRoot));

  if (!existsSync(projectRoot)) {
    return null;
  }

  if (!repairInProgress && await directoryHasVisibleWorkspaceFiles(projectRoot)) {
    return null;
  }

  const legacyProjectSlug = await chooseLegacyImportCandidate(safeSlug, legacyBrainRoot);
  if (!legacyProjectSlug) {
    if (repairInProgress) {
      await clearLegacyRepairSentinel(projectStateRoot);
    }
    return null;
  }

  const parsedPages = await parseLegacyImportPages(safeSlug, legacyProjectSlug, legacyBrainRoot);
  if (parsedPages.length === 0) {
    if (repairInProgress) {
      await clearLegacyRepairSentinel(projectStateRoot);
    }
    return null;
  }

  await writeLegacyRepairSentinel(projectStateRoot, {
    project: safeSlug,
    legacyProject: legacyProjectSlug,
  });

  const canonicalManifest = await readProjectManifest(safeSlug, projectStateRoot);
  const legacyManifest = await readLegacyManifest(legacyProjectSlug, legacyBrainRoot);
  const canonicalTitle = canonicalManifest?.title ?? legacyManifest?.title ?? humanizeSlug(safeSlug);
  const legacyImportSummary = await readJsonFile<ProjectImportSummaryRecord>(
    getLegacyImportSummaryPath(legacyProjectSlug, legacyBrainRoot),
  );

  const importedFiles: Array<{ path: string; classification: string }> = [];
  const sourcePagePaths: string[] = [];
  const sourceRefs: SourceRef[] = [];
  const seenWorkspacePaths = new Set<string>();

  let recoveredWorkspaceFiles = 0;
  let skippedWorkspaceFiles = 0;

  for (const page of parsedPages) {
    await writeCanonicalImportPage(safeSlug, page.relativePath, page.parsed, projectsRoot);
    sourcePagePaths.push(page.relativePath);

    if (page.sourceRef) {
      sourceRefs.push(page.sourceRef);
      importedFiles.push({
        path: page.sourceRef.ref,
        classification: page.classification,
      });
    }

    if (!page.importedPath || seenWorkspacePaths.has(page.importedPath)) {
      continue;
    }
    seenWorkspacePaths.add(page.importedPath);

    if (isRecoverableImportedContent(page.recoverableContent)) {
      await restoreWorkspaceFile(safeSlug, page.importedPath, page.recoverableContent, projectsRoot);
      recoveredWorkspaceFiles += 1;
    } else {
      skippedWorkspaceFiles += 1;
    }
  }

  const importedPageCount = sourcePagePaths.length;

  await finalizeImportedProject(
    {
      projectSlug: safeSlug,
      title: canonicalTitle,
      analysis: buildRepairAnalysis({
        legacyProjectSlug,
        recoveredWorkspaceFiles,
        importedPages: importedPageCount,
        skippedWorkspaceFiles,
      }),
      importedFiles,
      sourcePagePaths,
      sourceRefs,
      duplicateGroups: [],
      warnings: [],
      totalFiles: importedFiles.length,
      detectedItems: legacyImportSummary?.lastImport?.detectedItems ?? importedFiles.length,
      detectedBytes: legacyImportSummary?.lastImport?.detectedBytes,
      source: "legacy-import-repair",
    },
    projectBrainRoot,
  );

  await writeProjectImportSummary(
    safeSlug,
    {
      name: canonicalTitle,
      preparedFiles: legacyImportSummary?.lastImport?.preparedFiles ?? importedFiles.length,
      detectedItems: legacyImportSummary?.lastImport?.detectedItems ?? importedFiles.length,
      detectedBytes: legacyImportSummary?.lastImport?.detectedBytes,
      duplicateGroups: legacyImportSummary?.lastImport?.duplicateGroups,
      generatedAt: new Date().toISOString(),
      source: "legacy-import-repair",
    },
    projectStateRoot,
  );

  await clearLegacyRepairSentinel(projectStateRoot);

  return {
    project: safeSlug,
    legacyProject: legacyProjectSlug,
    importedPages: importedPageCount,
    recoveredWorkspaceFiles,
    skippedWorkspaceFiles,
  };
}
