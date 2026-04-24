import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  ensureBrainStoreReady,
  getBrainStore,
  type BrainPage,
} from "@/brain/store";
import { isPageFileRef, type GbrainPageFileRef } from "@/brain/gbrain-data-contracts";
import { listGbrainFileRefPages } from "@/lib/gbrain/file-ref-pages";
import { listProjectWorkspaceFileEntriesFast } from "@/lib/gbrain/project-query-fast-path";
import {
  getTargetFolder,
  generateCompanionMd,
  hashContent,
  type FileReference,
  type ReferencesFile,
} from "@/lib/workspace-manager";
import { getImportedWorkspacePath } from "@/lib/import/commit-import";
import {
  computeFileFingerprintSync,
  computeLegacyPathSizeFingerprint,
  LARGE_FILE_FINGERPRINT_THRESHOLD_BYTES,
} from "@/lib/import/file-fingerprint";
import {
  getScienceSwarmOpenClawStateDir,
  getScienceSwarmProjectsRoot,
  getScienceSwarmWorkspaceRoot,
} from "@/lib/scienceswarm-paths";
import { isLocalRequest } from "@/lib/local-guard";
import { readProjectImportSummary, writeProjectImportSummary } from "@/lib/state/project-import-summary";
import { readProjectImportSource } from "@/lib/state/project-import-source";
import { assertSafeProjectSlug, InvalidSlugError } from "@/lib/state/project-manifests";
import { repairLegacyImportedProject } from "@/lib/state/legacy-import-repair";
import { getOpenHandsUrl } from "@/lib/config/ports";
import { createProjectRepository } from "@/lib/projects/project-repository";
import { getWorkspaceRouteFileStore } from "@/lib/testing/workspace-route-overrides";

// ---------------------------------------------------------------------------
// Workspace root — uses the OpenHands sandbox when available, otherwise a
// local fallback under the ScienceSwarm data directory. When a projectId is
// supplied, the workspace is scoped to ~/.scienceswarm/projects/<slug>/ so
// each project has its own file tree, references, and uploads.
// ---------------------------------------------------------------------------

function resolveWorkspaceRoot(
  projectId?: string | null,
  { create = false }: { create?: boolean } = {},
): string {
  const root = projectId
    ? path.join(getScienceSwarmProjectsRoot(), assertSafeProjectSlug(projectId))
    : getScienceSwarmWorkspaceRoot();
  // Only materialise the directory on write paths. Reads must not have the
  // side-effect of creating empty project directories on disk for slugs that
  // don't exist yet — that pollutes ~/.scienceswarm/projects/ with phantom
  // entries every time the dashboard fetches a tree.
  if (create) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

async function isOpenHandsAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${getOpenHandsUrl()}/api/options/config`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// .references.json helpers
// ---------------------------------------------------------------------------

function refsPath(root: string): string {
  return path.join(root, ".references.json");
}

function readRefs(root: string): ReferencesFile {
  const fp = refsPath(root);
  if (fs.existsSync(fp)) {
    try {
      return JSON.parse(fs.readFileSync(fp, "utf-8")) as ReferencesFile;
    } catch {
      /* corrupted — start fresh */
    }
  }
  return { version: 1, files: [] };
}

function writeRefs(root: string, refs: ReferencesFile): void {
  fs.writeFileSync(refsPath(root), JSON.stringify(refs, null, 2));
}

// ---------------------------------------------------------------------------
// File tree builder
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  type: "file" | "directory";
  size?: string;
  hasCompanion?: boolean;
  changed?: boolean;
  children?: TreeNode[];
}

const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024;
const workspaceMutationLocks = new Map<string, Promise<void>>();
const SYNC_SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", "__pycache__", ".venv", "venv",
  ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
  ".next", ".vercel", ".cache", ".eggs",
]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildTree(dir: string, refs: ReferencesFile, root: string): TreeNode[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    if (shouldSkipWorkspaceEntry(entry, entries)) continue;

    const fullPath = path.join(dir, entry.name);
    if (dir === root && entry.name === "project.json") {
      continue;
    }

    if (entry.isDirectory()) {
      const children = buildTree(fullPath, refs, root);
      nodes.push({ name: entry.name, type: "directory", children });
    } else {
      const stat = fs.statSync(fullPath);
      const relPath = path.relative(root, fullPath);
      const ref = refs.files.find(r => r.workspacePath === relPath);
      const companionPath = fullPath + ".md";

      nodes.push({
        name: entry.name,
        type: "file",
        size: formatSize(stat.size),
        hasCompanion: fs.existsSync(companionPath),
        changed: ref?.changed ?? false,
      });
    }
  }

  return nodes;
}

function shouldSkipWorkspaceEntry(entry: fs.Dirent, siblings: fs.Dirent[]): boolean {
  if (entry.name === ".references.json" || entry.name === ".brain") {
    return true;
  }

  if (!entry.name.endsWith(".md")) {
    return false;
  }

  const base = entry.name.slice(0, -3);
  return siblings.some((candidate) => candidate.name === base);
}

async function withWorkspaceMutationLock<T>(
  projectId: string | null,
  task: () => Promise<T> | T,
): Promise<T> {
  const key = projectId ?? "__workspace__";
  const previous = workspaceMutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  workspaceMutationLocks.set(key, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (workspaceMutationLocks.get(key) === queued) {
      workspaceMutationLocks.delete(key);
    }
  }
}

function getScientistWorkspacePathForFlatFile(filename: string): string | null {
  const normalized = normalizeWorkspacePath(filename);
  if (!normalized || normalized.includes("/")) return null;
  if (normalized === "project.json") return null;

  const targetFolder = getTargetFolder(normalized);
  if (targetFolder === "other") return null;
  return `${targetFolder}/${normalized}`;
}

function repairFlatScientistWorkspaceFiles(root: string, refs: ReferencesFile): ReferencesFile {
  let changed = false;
  const nextRefs = refs.files.map((ref) => {
    const targetWorkspacePath = getScientistWorkspacePathForFlatFile(ref.workspacePath);
    if (!targetWorkspacePath) return ref;

    const currentPath = path.join(root, ref.workspacePath);
    const targetPath = path.join(root, targetWorkspacePath);
    if (!fs.existsSync(currentPath)) return ref;

    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.renameSync(currentPath, targetPath);
      changed = true;
      return {
        ...ref,
        workspacePath: targetWorkspacePath,
        type: targetWorkspacePath.split("/")[0],
      };
    }

    try {
      const currentStat = fs.statSync(currentPath);
      const targetStat = fs.statSync(targetPath);
      const currentHash = computeImportFingerprint(currentPath, currentStat.size);
      const targetHash = computeImportFingerprint(targetPath, targetStat.size);
      if (currentHash === targetHash) {
        fs.rmSync(currentPath);
        changed = true;
        return {
          ...ref,
          workspacePath: targetWorkspacePath,
          type: targetWorkspacePath.split("/")[0],
        };
      }
    } catch {
      // Keep the existing ref if we cannot prove the target is identical.
    }

    return ref;
  });

  if (!changed) return refs;

  const repairedRefs = {
    version: refs.version,
    files: nextRefs.sort((left, right) => left.workspacePath.localeCompare(right.workspacePath)),
  };
  writeRefs(root, repairedRefs);
  return repairedRefs;
}

interface WorkspaceWatchState {
  revision: string;
  totalFiles: number;
  lastModified: string | null;
}

interface WorkspaceWatchSnapshot {
  watch: WorkspaceWatchState;
  filePaths: Set<string>;
}

interface GbrainWorkspaceView {
  tree: TreeNode[];
  totalFiles: number;
  watch: WorkspaceWatchState;
  entries: GbrainWorkspaceFileEntry[];
}

interface GbrainWorkspaceFileEntry {
  workspacePath: string;
  pagePath: string;
  pageType: string;
  pageTitle: string;
  pageFrontmatter: Record<string, unknown>;
  ref: GbrainPageFileRef;
  updatedAt: string | null;
}

function gbrainWorkspaceEntryTimestampValue(entry: GbrainWorkspaceFileEntry): string | null {
  const rawTimestamp =
    entry.pageFrontmatter.uploaded_at ??
    entry.updatedAt ??
    entry.pageFrontmatter.updated_at ??
    entry.pageFrontmatter.created_at;
  return typeof rawTimestamp === "string" ? rawTimestamp : null;
}

function gbrainWorkspaceEntryTimestamp(entry: GbrainWorkspaceFileEntry): number {
  const rawTimestamp = gbrainWorkspaceEntryTimestampValue(entry);
  if (!rawTimestamp) return Number.NaN;
  return Date.parse(rawTimestamp);
}

function isFresherGbrainWorkspaceEntry(
  candidate: GbrainWorkspaceFileEntry,
  existing: GbrainWorkspaceFileEntry,
): boolean {
  const candidateTimestamp = gbrainWorkspaceEntryTimestamp(candidate);
  const existingTimestamp = gbrainWorkspaceEntryTimestamp(existing);

  if (!Number.isNaN(candidateTimestamp) || !Number.isNaN(existingTimestamp)) {
    return (
      (Number.isNaN(candidateTimestamp) ? -Infinity : candidateTimestamp) >
      (Number.isNaN(existingTimestamp) ? -Infinity : existingTimestamp)
    );
  }

  return candidate.pagePath.localeCompare(existing.pagePath) > 0;
}

function computeWorkspaceWatchSnapshot(root: string): WorkspaceWatchSnapshot {
  if (!fs.existsSync(root)) {
    return {
      watch: {
        revision: "empty",
        totalFiles: 0,
        lastModified: null,
      },
      filePaths: new Set(),
    };
  }

  const hash = crypto.createHash("sha1");
  const filePaths = new Set<string>();
  let totalFiles = 0;
  let latestMtimeMs = 0;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const visibleEntries = entries
      .filter((entry) => !shouldSkipWorkspaceEntry(entry, entries))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of visibleEntries) {
      const fullPath = path.join(dir, entry.name);
      let stat: fs.Stats;

      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const relativePath = path.relative(root, fullPath);
      const workspacePath = relativePath.split(path.sep).join("/");
      if (dir === root && entry.name === "project.json") {
        continue;
      }

      if (stat.isDirectory()) {
        hash.update(`d:${relativePath}\n`);
        walk(fullPath);
        continue;
      }

      totalFiles += 1;
      filePaths.add(workspacePath);
      latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
      hash.update(`f:${relativePath}:${stat.size}:${stat.mtimeMs}\n`);
    }
  };

  walk(root);

  if (totalFiles === 0) {
    hash.update("empty\n");
  }

  return {
    watch: {
      revision: hash.digest("hex"),
      totalFiles,
      lastModified: latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null,
    },
    filePaths,
  };
}

function computeWorkspaceWatchState(root: string): WorkspaceWatchState {
  return computeWorkspaceWatchSnapshot(root).watch;
}

function countFilesInTree(nodes: TreeNode[], depth = 0): number {
  let total = 0;
  for (const node of nodes) {
    if (node.name === ".brain" && node.type === "directory") {
      continue;
    }
    if (
      depth === 0
      && node.type === "file"
      && node.name === "project.json"
    ) {
      continue;
    }
    if (node.type === "file") {
      total += 1;
      continue;
    }
    total += countFilesInTree(node.children ?? [], depth + 1);
  }
  return total;
}

async function buildGbrainWorkspaceView(
  projectId: string | null,
): Promise<GbrainWorkspaceView | null> {
  const entries = await listGbrainWorkspaceFileEntries(projectId);
  if (entries.length === 0) return null;

  const root: TreeNode[] = [];
  const hash = crypto.createHash("sha1");
  for (const entry of entries) {
    insertGbrainTreeNode(root, entry.workspacePath, entry.ref);
    hash.update(
      `${entry.workspacePath}:${entry.pagePath}:${entry.pageType}:${entry.ref.fileObjectId}:${entry.ref.filename}:${entry.ref.sizeBytes}\n`,
    );
  }

  return {
    tree: root,
    totalFiles: entries.length,
    watch: {
      revision: hash.digest("hex"),
      totalFiles: entries.length,
      lastModified: newestIsoTimestamp(
        entries.map(gbrainWorkspaceEntryTimestampValue),
      ),
    },
    entries,
  };
}

function resolveImportedWorkspacePath(
  projectId: string,
  relativePath: string,
  root: string,
): string {
  const targetPath = getImportedWorkspacePath(projectId, relativePath);
  const relativeToRoot = path.relative(root, targetPath);
  if (
    relativeToRoot === ""
    || relativeToRoot.startsWith("..")
    || path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Imported workspace path must stay inside the project workspace.");
  }
  return targetPath;
}

async function listGbrainWorkspaceFileEntries(
  projectId: string | null,
): Promise<GbrainWorkspaceFileEntry[]> {
  if (!projectId) return [];

  let safeProjectId: string;
  try {
    safeProjectId = assertSafeProjectSlug(projectId);
  } catch {
    return [];
  }

  // The fast path reads from gbrain's `files` table, which does not exist in
  // the embedded pglite schema (the local engine keeps file metadata on page
  // frontmatter). A thrown "undefined_table" here is expected, not fatal —
  // swallow it so the legacy page-scan fallback runs instead of returning [].
  let fastEntries: Awaited<ReturnType<typeof listProjectWorkspaceFileEntriesFast>> = null;
  try {
    fastEntries = await listProjectWorkspaceFileEntriesFast(safeProjectId);
  } catch (error) {
    console.warn(
      "[workspace] fast gbrain metadata query failed; using legacy page scan:",
      error,
    );
  }

  try {
    const sourceEntries =
      fastEntries ??
      (await (async () => {
        await ensureBrainStoreReady();
        const pages = await listWorkspaceFileRefPages();
        const entriesByWorkspacePath = new Map<string, GbrainWorkspaceFileEntry>();
        for (const page of pages) {
          const fm = page.frontmatter ?? {};
          if (
            fm.project !== safeProjectId
            && !(Array.isArray(fm.projects) && fm.projects.includes(safeProjectId))
          ) {
            continue;
          }
          const fileRefs = Array.isArray(fm.file_refs)
            ? fm.file_refs.filter(isPageFileRef)
            : [];
          for (const ref of fileRefs) {
            const workspacePath = getGbrainWorkspacePath(ref.filename);
            if (!workspacePath) continue;
            const entry = {
              workspacePath,
              pagePath: page.path,
              pageType: page.type,
              pageTitle: page.title,
              pageFrontmatter: page.frontmatter ?? {},
              ref,
              updatedAt: null,
            };
            const existing = entriesByWorkspacePath.get(workspacePath);
            if (!existing || isFresherGbrainWorkspaceEntry(entry, existing)) {
              entriesByWorkspacePath.set(workspacePath, entry);
            }
          }
        }
        return Array.from(entriesByWorkspacePath.values());
      })());

    const entriesByWorkspacePath = new Map<string, GbrainWorkspaceFileEntry>();
    for (const rawEntry of sourceEntries) {
      const workspacePath = getGbrainWorkspacePath(rawEntry.ref.filename);
      if (!workspacePath) continue;
      const entry = { ...rawEntry, workspacePath };
      const existing = entriesByWorkspacePath.get(workspacePath);
      if (!existing || isFresherGbrainWorkspaceEntry(entry, existing)) {
        entriesByWorkspacePath.set(workspacePath, entry);
      }
    }
    return Array.from(entriesByWorkspacePath.values()).sort((left, right) =>
      left.workspacePath.localeCompare(right.workspacePath),
    );
  } catch (error) {
    console.error("[workspace] gbrain view failed, falling back to legacy:", error);
    return [];
  }
}

function getGbrainWorkspacePath(filename: string): string | null {
  const normalizedFilename = normalizeWorkspacePath(filename);
  if (!normalizedFilename) return null;
  const isAbsolutePath =
    filename.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(filename);
  if (isAbsolutePath) {
    const baseName = path.posix.basename(normalizedFilename);
    return `${getTargetFolder(baseName)}/${baseName}`;
  }
  // Filenames from OpenHands writeback already carry a relative path (e.g.
  // "figures/plot.png"); applying getTargetFolder on top would double-nest them
  // into "figures/figures/plot.png". Only prepend the target folder for bare
  // filenames that have no directory component.
  if (normalizedFilename.includes("/")) return normalizedFilename;
  return `${getTargetFolder(normalizedFilename)}/${normalizedFilename}`;
}

function normalizeWorkspacePath(input: string): string | null {
  const normalized = path.posix.normalize(input.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }
  return normalized;
}

async function listWorkspaceFileRefPages(): Promise<BrainPage[]> {
  return listGbrainFileRefPages(getBrainStore());
}

function insertGbrainTreeNode(
  root: TreeNode[],
  workspacePath: string,
  ref: GbrainPageFileRef,
): void {
  const parts = workspacePath.split("/").filter(Boolean);
  let level = root;
  for (let index = 0; index < parts.length; index += 1) {
    const name = parts[index];
    const isLeaf = index === parts.length - 1;
    if (isLeaf) {
      const node: TreeNode = {
        name,
        type: "file",
        size: formatSize(ref.sizeBytes),
        hasCompanion: true,
        changed: false,
      };
      const existingIndex = level.findIndex((existing) => existing.name === name);
      if (existingIndex >= 0) {
        level[existingIndex] = node;
      } else {
        level.push(node);
      }
      return;
    }
    let dir = level.find((node) => node.type === "directory" && node.name === name);
    if (!dir) {
      dir = { name, type: "directory", children: [] };
      level.push(dir);
    }
    level = dir.children ?? [];
    dir.children = level;
  }
}

function cloneTreeNode(node: TreeNode): TreeNode {
  return {
    ...node,
    children: node.children?.map(cloneTreeNode),
  };
}

function sortWorkspaceTree(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: node.children ? sortWorkspaceTree(node.children) : undefined,
    }))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

function mergeWorkspaceTreeNodes(
  diskTree: TreeNode[],
  gbrainTree: TreeNode[],
): TreeNode[] {
  const merged = diskTree.map(cloneTreeNode);

  for (const gbrainNode of gbrainTree) {
    const existingIndex = merged.findIndex((node) => node.name === gbrainNode.name);
    if (existingIndex < 0) {
      merged.push(cloneTreeNode(gbrainNode));
      continue;
    }

    const existing = merged[existingIndex];
    if (existing.type === "directory" && gbrainNode.type === "directory") {
      merged[existingIndex] = {
        ...existing,
        children: mergeWorkspaceTreeNodes(
          existing.children ?? [],
          gbrainNode.children ?? [],
        ),
      };
      continue;
    }

    // gbrain metadata is authoritative for exact path conflicts, but it should
    // not hide unrelated source files that still live in the project workspace.
    merged[existingIndex] = cloneTreeNode(gbrainNode);
  }

  return sortWorkspaceTree(merged);
}

function combineWorkspaceWatchState(params: {
  diskWatch: WorkspaceWatchState;
  gbrainWatch: WorkspaceWatchState;
  totalFiles: number;
}): WorkspaceWatchState {
  const hash = crypto.createHash("sha1");
  hash.update(
    `disk:${params.diskWatch.revision}:${params.diskWatch.totalFiles}:${params.diskWatch.lastModified ?? ""}\n`,
  );
  hash.update(
    `gbrain:${params.gbrainWatch.revision}:${params.gbrainWatch.totalFiles}:${params.gbrainWatch.lastModified ?? ""}\n`,
  );

  return {
    revision: hash.digest("hex"),
    totalFiles: params.totalFiles,
    lastModified: newestIsoTimestamp([
      params.diskWatch.lastModified,
      params.gbrainWatch.lastModified,
    ]),
  };
}

function countMergedWorkspaceFilePaths(
  diskFilePaths: ReadonlySet<string>,
  gbrainEntries: readonly GbrainWorkspaceFileEntry[],
): number {
  const gbrainFilePaths = new Set<string>();
  const gbrainAncestorPaths = new Set<string>();
  for (const entry of gbrainEntries) {
    gbrainFilePaths.add(entry.workspacePath);
    addWorkspacePathAncestors(entry.workspacePath, gbrainAncestorPaths);
  }

  let diskTotal = 0;
  for (const diskPath of diskFilePaths) {
    if (
      gbrainFilePaths.has(diskPath)
      || gbrainAncestorPaths.has(diskPath)
      || hasWorkspacePathAncestor(diskPath, gbrainFilePaths)
    ) {
      continue;
    }
    diskTotal += 1;
  }
  return diskTotal + gbrainEntries.length;
}

function addWorkspacePathAncestors(
  workspacePath: string,
  ancestors: Set<string>,
): void {
  let separatorIndex = workspacePath.indexOf("/");
  while (separatorIndex > 0) {
    ancestors.add(workspacePath.slice(0, separatorIndex));
    separatorIndex = workspacePath.indexOf("/", separatorIndex + 1);
  }
}

function hasWorkspacePathAncestor(
  workspacePath: string,
  ancestorPaths: ReadonlySet<string>,
): boolean {
  let separatorIndex = workspacePath.indexOf("/");
  while (separatorIndex > 0) {
    if (ancestorPaths.has(workspacePath.slice(0, separatorIndex))) {
      return true;
    }
    separatorIndex = workspacePath.indexOf("/", separatorIndex + 1);
  }
  return false;
}

function newestIsoTimestamp(values: Array<string | null>): string | null {
  let newest: { value: string; time: number } | null = null;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isNaN(time)) continue;
    if (!newest || time > newest.time) {
      newest = { value, time };
    }
  }
  return newest?.value ?? null;
}

function inferImportedFileType(filename: string): string {
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (extension) return extension;
  return path.basename(filename).toLowerCase();
}

function duplicateNamePenalty(name: string): number {
  return /(?:^|[-_.\s])(copy|duplicate)(?:[-_.\s]|$)|\(\d+\)/i.test(name) ? 1 : 0;
}

function computeImportFingerprint(
  absolutePath: string,
  size: number,
): string {
  return computeFileFingerprintSync(absolutePath, size);
}

interface SyncedWorkspaceChanges {
  changed: FileReference[];
  added: FileReference[];
  updated: FileReference[];
  missing: FileReference[];
  detectedItems: number;
  detectedBytes: number;
  duplicateGroups: number;
}

async function syncProjectWorkspaceFromImportSource(
  projectId: string,
  root: string,
  refs: ReferencesFile,
): Promise<SyncedWorkspaceChanges | null> {
  const source = await readProjectImportSource(projectId);
  if (!source?.folderPath) return null;

  const sourceRoot = source.folderPath;
  let sourceStats: fs.Stats;
  try {
    sourceStats = fs.statSync(sourceRoot);
  } catch {
    return null;
  }

  if (!sourceStats.isDirectory()) {
    return null;
  }

  const now = new Date().toISOString();
  const nextRefs = new Map(refs.files.map((ref) => [ref.workspacePath, ref]));
  const added: FileReference[] = [];
  const updated: FileReference[] = [];
  const missing: FileReference[] = [];
  const seenWorkspacePaths = new Set<string>();
  const duplicatePathsByHash = new Map<string, string[]>();
  let detectedItems = 0;
  let detectedBytes = 0;

  const walk = (dirPath: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
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
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (SYNC_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        detectedItems += 1;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      let fileStat: fs.Stats;
      try {
        fileStat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      detectedItems += 1;
      detectedBytes += fileStat.size;

      const relativePath = path.relative(sourceRoot, fullPath);
      const targetPath = resolveImportedWorkspacePath(projectId, relativePath, root);
      const workspacePath = path.relative(root, targetPath);
      const sourceHash = computeImportFingerprint(fullPath, fileStat.size);
      const duplicateBucket = duplicatePathsByHash.get(sourceHash);
      if (duplicateBucket) {
        duplicateBucket.push(relativePath);
        seenWorkspacePaths.add(workspacePath);
        continue;
      }
      duplicatePathsByHash.set(sourceHash, [relativePath]);

      const existingRef = nextRefs.get(workspacePath);
      const preserveLocalEdit = typeof existingRef?.localEditedAt === "string"
        && existingRef.localEditedAt.trim().length > 0;
      let targetHash: string | null = existingRef?.hash ?? null;
      const targetExists = fs.existsSync(targetPath);
      const legacySourceHash = fileStat.size > LARGE_FILE_FINGERPRINT_THRESHOLD_BYTES
        ? computeLegacyPathSizeFingerprint(relativePath, fileStat.size)
        : null;

      if (targetExists && existingRef?.hash && legacySourceHash && existingRef.hash === legacySourceHash) {
        try {
          targetHash = computeImportFingerprint(targetPath, fs.statSync(targetPath).size);
        } catch {
          targetHash = existingRef.hash;
        }
      } else if (!targetHash && targetExists) {
        try {
          targetHash = computeImportFingerprint(targetPath, fs.statSync(targetPath).size);
        } catch {
          targetHash = null;
        }
      }

      if (!targetExists || (targetHash !== sourceHash && !preserveLocalEdit)) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(fullPath, targetPath);
      }

      const nextRef: FileReference = {
        originalPath: fullPath,
        workspacePath,
        hash: preserveLocalEdit && targetHash ? targetHash : sourceHash,
        type: inferImportedFileType(entry.name),
        size: preserveLocalEdit && targetExists
          ? fs.statSync(targetPath).size
          : fileStat.size,
        importedAt: existingRef?.importedAt ?? now,
        lastChecked: now,
        changed: preserveLocalEdit ? targetHash !== sourceHash : false,
        localEditedAt: preserveLocalEdit ? existingRef?.localEditedAt : undefined,
      };

      nextRefs.set(workspacePath, nextRef);
      seenWorkspacePaths.add(workspacePath);

      if (!targetExists) {
        added.push(nextRef);
      } else if (targetHash !== null && targetHash !== sourceHash) {
        updated.push(nextRef);
      }
    }
  };

  walk(sourceRoot);

  for (const [workspacePath, ref] of nextRefs.entries()) {
    if (seenWorkspacePaths.has(workspacePath)) continue;
    if (!path.isAbsolute(ref.originalPath)) continue;
    const withinSourceRoot = ref.originalPath === sourceRoot || ref.originalPath.startsWith(`${sourceRoot}${path.sep}`);
    if (!withinSourceRoot) continue;
    const nextRef: FileReference = {
      ...ref,
      lastChecked: now,
      changed: true,
    };
    nextRefs.set(workspacePath, nextRef);
    missing.push(nextRef);
  }

  const duplicateGroups = Array.from(duplicatePathsByHash.values())
    .filter((paths) => paths.length > 1)
    .length;
  const changed = updated.concat(missing);
  const nextRefsFile: ReferencesFile = {
    version: 1,
    files: Array.from(nextRefs.values()).sort((left, right) => left.workspacePath.localeCompare(right.workspacePath)),
  };
  writeRefs(root, nextRefsFile);

  if (added.length > 0 || updated.length > 0) {
    const existingSummary = await readProjectImportSummary(projectId);
    const preparedFiles = nextRefsFile.files.filter((ref) => {
      if (!path.isAbsolute(ref.originalPath)) return false;
      return (
        ref.changed !== true
        && (ref.originalPath === sourceRoot || ref.originalPath.startsWith(`${sourceRoot}${path.sep}`))
      );
    }).length;
    await writeProjectImportSummary(projectId, {
      name: existingSummary?.lastImport?.name ?? path.basename(sourceRoot),
      preparedFiles,
      detectedItems,
      detectedBytes,
      duplicateGroups,
      generatedAt: now,
      source: "source-sync",
    });
  }

  return {
    changed,
    added,
    updated,
    missing,
    detectedItems,
    detectedBytes,
    duplicateGroups,
  };
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const contentType = request.headers.get("content-type") || "";

    // Multipart uploads come in via FormData. Async handlers must be awaited
    // here so any rejection (including assertSafeProjectSlug throwing) lands
    // in this try/catch instead of escaping past it.
    if (contentType.includes("multipart/form-data")) {
      return await handleUpload(request);
    }

    // JSON actions
    const body = await request.json();
    const action = body.action as string;
    const projectId = typeof body.projectId === "string" ? body.projectId : null;

    if (action === "check-changes") {
      return await withWorkspaceMutationLock(projectId, () =>
        handleCheckChanges(projectId)
      );
    }
    if (action === "list") return await handleList(projectId);
    if (action === "watch") return await handleWatch(projectId, typeof body.since === "string" ? body.since : null);
    if (action === "update-meta") return handleUpdateMeta(body, projectId);
    if (action === "write-file") {
      return await withWorkspaceMutationLock(projectId, () =>
        Promise.resolve(handleWriteFile(body, projectId))
      );
    }
    if (action === "delete-file") {
      return await withWorkspaceMutationLock(projectId, () =>
        Promise.resolve(handleDeleteFile(body, projectId))
      );
    }

    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Workspace error";
    // InvalidSlugError is a client input error (path traversal, uppercase,
    // dots, etc.), not a server fault — surface it as 400 instead of 500.
    const status = err instanceof InvalidSlugError ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const projectId = searchParams.get("projectId");

    if (action === "tree") return await handleList(projectId);
    if (action === "watch") return await handleWatch(projectId, searchParams.get("since"));

    if (action === "meta") {
      const file = searchParams.get("file");
      if (!file) {
        return Response.json({ error: "file parameter required" }, { status: 400 });
      }
      return await handleGetMeta(file, projectId);
    }

    if (action === "file") {
      const file = searchParams.get("file");
      if (!file) {
        return Response.json({ error: "file parameter required" }, { status: 400 });
      }
      return await handleGetFile(file, projectId);
    }

    if (action === "read") {
      const file = searchParams.get("file");
      if (!file) {
        return Response.json({ error: "file parameter required" }, { status: 400 });
      }
      return await handleRead(file, projectId);
    }

    if (action === "raw") {
      const file = searchParams.get("file");
      if (!file) {
        return new Response("file parameter required", { status: 400 });
      }
      return await handleRaw(file, projectId);
    }

    // Await async handlers so their rejections land in this try/catch,
    // otherwise the validation→400 mapping is bypassed and they surface as 500.
    if (action === "changes") return await handleCheckChanges(projectId);

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Workspace error";
    // InvalidSlugError is a client input error (path traversal, uppercase,
    // dots, etc.), not a server fault — surface it as 400 instead of 500.
    const status = err instanceof InvalidSlugError ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

async function handleUpload(request: Request) {
  const formData = await request.formData();
  const projectId = (formData.get("projectId") as string | null) || null;
  const root = resolveWorkspaceRoot(projectId, { create: true });
  const refs = readRefs(root);
  const results: Array<{ name: string; folder: string; workspacePath: string }> = [];

  const files = formData.getAll("files");
  const originalPath = (formData.get("originalPath") as string) || "";

  // Check OpenHands availability once before the loop to avoid N network probes
  const ohAvailable = await isOpenHandsAvailable();

  for (const entry of files) {
    if (!(entry instanceof File)) continue;

    // Sanitize filename to prevent path traversal
    const safeName = path.basename(entry.name);
    if (!safeName || safeName === "." || safeName === "..") continue;

    const folder = getTargetFolder(safeName);
    const folderPath = path.join(root, folder);
    fs.mkdirSync(folderPath, { recursive: true });

    const filePath = path.join(folderPath, safeName);
    const resolvedFilePath = path.resolve(filePath);
    if (!resolvedFilePath.startsWith(root + path.sep)) continue;

    const buffer = Buffer.from(await entry.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    // Generate companion .md — detect binary content explicitly since
    // buffer.toString("utf-8") never throws (it silently replaces invalid bytes)
    let textContent: string;
    const isText = !buffer.some(
      (b) => b === 0 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d),
    );
    if (isText) {
      textContent = buffer.toString("utf-8");
    } else {
      textContent = `[Binary file: ${safeName}]`;
    }
    const companionContent = generateCompanionMd(safeName, textContent, folder.split("/")[0]);
    fs.writeFileSync(filePath + ".md", companionContent);

    // Update references
    const workspacePath = `${folder}/${safeName}`;
    const hash = hashContent(buffer);
    const existingIdx = refs.files.findIndex(r => r.workspacePath === workspacePath);
    const ref: FileReference = {
      originalPath: originalPath || safeName,
      workspacePath,
      hash,
      type: folder.split("/")[0],
      size: buffer.length,
      importedAt: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      refs.files[existingIdx] = ref;
    } else {
      refs.files.push(ref);
    }

    results.push({ name: safeName, folder, workspacePath });

    // Also upload to OpenHands if available
    if (ohAvailable) {
      const ohForm = new FormData();
      ohForm.append("files", new Blob([buffer]), `${folder}/${safeName}`);
      try {
        await fetch(`${getOpenHandsUrl()}/api/upload-files`, {
          method: "POST",
          body: ohForm,
        });
      } catch {
        // Best effort — local copy is the source of truth
      }
    }
  }

  writeRefs(root, refs);

  return Response.json({ uploaded: results, totalFiles: refs.files.length });
}

async function handleList(projectId: string | null) {
  if (projectId) {
    // Skip legacy repair for archived (soft-deleted) projects — repairing
    // them would resurrect the project record.
    try {
      const repo = createProjectRepository();
      const record = await repo.get(projectId);
      if (record?.status === "archived") {
        return Response.json({ tree: [], totalFiles: 0, watchRevision: "", lastModified: null });
      }
    } catch {
      // Brain store not available — proceed; the project is not known to be archived.
    }

    try {
      await repairLegacyImportedProject(projectId);
    } catch (error) {
      console.warn("Legacy import repair failed during workspace tree read", {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const root = resolveWorkspaceRoot(projectId);
  const refs = repairFlatScientistWorkspaceFiles(root, readRefs(root));
  const legacyTree = buildTree(root, refs, root);
  const legacyTotalFiles = refs.files.length > 0
    ? refs.files.length
    : countFilesInTree(legacyTree);
  const legacyWatch = computeWorkspaceWatchState(root);
  const gbrainView = await buildGbrainWorkspaceView(projectId);
  if (gbrainView) {
    const mergedTree = mergeWorkspaceTreeNodes(legacyTree, gbrainView.tree);
    const totalFiles = countFilesInTree(mergedTree);
    const watch = combineWorkspaceWatchState({
      diskWatch: legacyWatch,
      gbrainWatch: gbrainView.watch,
      totalFiles,
    });
    return Response.json({
      tree: mergedTree,
      totalFiles,
      watchRevision: watch.revision,
      lastModified: watch.lastModified,
    });
  }

  return Response.json({
    tree: legacyTree,
    totalFiles: legacyTotalFiles,
    watchRevision: legacyWatch.revision,
    lastModified: legacyWatch.lastModified,
  });
}

async function handleWatch(projectId: string | null, since: string | null) {
  if (projectId) {
    const gbrainView = await buildGbrainWorkspaceView(projectId);
    const root = resolveWorkspaceRoot(projectId);
    repairFlatScientistWorkspaceFiles(root, readRefs(root));
    const diskSnapshot = computeWorkspaceWatchSnapshot(root);
    const watch = (() => {
      if (!gbrainView) return diskSnapshot.watch;
      return combineWorkspaceWatchState({
        diskWatch: diskSnapshot.watch,
        gbrainWatch: gbrainView.watch,
        totalFiles: countMergedWorkspaceFilePaths(
          diskSnapshot.filePaths,
          gbrainView.entries,
        ),
      });
    })();
    return Response.json({
      revision: watch.revision,
      changed: typeof since === "string" && since.length > 0 ? since !== watch.revision : false,
      totalFiles: watch.totalFiles,
      lastModified: watch.lastModified,
    });
  }
  const root = resolveWorkspaceRoot(projectId);
  const watch = computeWorkspaceWatchState(root);
  return Response.json({
    revision: watch.revision,
    changed: typeof since === "string" && since.length > 0 ? since !== watch.revision : false,
    totalFiles: watch.totalFiles,
    lastModified: watch.lastModified,
  });
}

async function handleCheckChanges(projectId: string | null) {
  // Guard: never re-create directories for archived (soft-deleted) projects.
  if (projectId) {
    try {
      const repo = createProjectRepository();
      const record = await repo.get(projectId);
      if (record?.status === "archived") {
        return Response.json({
          changed: [],
          added: [],
          updated: [],
          missing: [],
          checkedAt: new Date().toISOString(),
        });
      }
    } catch {
      // Brain store not available — proceed; the project is not known to be archived.
    }
  }

  // check-changes writes the refs file back, so the project directory must
  // exist on disk by the time we get here.
  const root = resolveWorkspaceRoot(projectId, { create: true });
  const refs = repairFlatScientistWorkspaceFiles(root, readRefs(root));
  const checkedAt = new Date().toISOString();

  if (projectId) {
    const synced = await syncProjectWorkspaceFromImportSource(projectId, root, refs);
    if (synced) {
      return Response.json({
        ...synced,
        checkedAt,
      });
    }
  }

  const changed: FileReference[] = [];
  const missing: FileReference[] = [];

  for (const ref of refs.files) {
    // Check if original file still exists and compare hashes
    if (ref.originalPath && path.isAbsolute(ref.originalPath)) {
      try {
        const original = fs.readFileSync(ref.originalPath);
        const currentHash = hashContent(original);
        ref.lastChecked = checkedAt;
        if (currentHash !== ref.hash) {
          ref.changed = true;
          changed.push(ref);
        } else {
          ref.changed = false;
        }
      } catch {
        // Original file gone — mark as changed
        ref.changed = true;
        ref.lastChecked = checkedAt;
        missing.push(ref);
      }
    }
  }

  writeRefs(root, refs);
  return Response.json({
    changed: changed.concat(missing),
    added: [],
    updated: changed,
    missing,
    checkedAt,
  });
}

async function handleGetMeta(filePath: string, projectId: string | null) {
  const gbrainEntry = await findGbrainWorkspaceEntry(filePath, projectId);
  if (gbrainEntry) {
    const page = await getBrainStore().getPage(gbrainEntry.pagePath);
    if (!page) {
      return Response.json({ error: "Companion .md not found" }, { status: 404 });
    }
    return Response.json({
      file: filePath,
      companion: matter.stringify(page.content, page.frontmatter ?? gbrainEntry.pageFrontmatter),
      source: "gbrain",
      pagePath: gbrainEntry.pagePath,
    });
  }

  const root = resolveWorkspaceRoot(projectId);
  const resolved = path.resolve(root, filePath + ".md");
  if (!resolved.startsWith(root + path.sep)) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  if (!fs.existsSync(resolved)) {
    return Response.json({ error: "Companion .md not found" }, { status: 404 });
  }

  const realRoot = fs.realpathSync(root);
  const realResolved = fs.realpathSync(resolved);
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  const content = fs.readFileSync(realResolved, "utf-8");
  return Response.json({ file: filePath, companion: content });
}

const MAX_READ_BYTES = 1_000_000;
const MAX_RAW_BYTES = 50 * 1024 * 1024;
const PARSEABLE_EXTENSIONS = new Set(["pdf", "xlsx", "xlsm", "ipynb"]);
const RAW_RENDERABLE_EXTENSIONS = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "html",
  "htm",
  "mp4",
  "webm",
  "mov",
  "m4v",
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "flac",
  "opus",
  "aac",
  "css",
  "js",
  "mjs",
  "cjs",
  "json",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
]);
const SANDBOXED_PREVIEW_EXTENSIONS = new Set(["html", "htm", "svg"]);

const RAW_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  opus: "audio/ogg; codecs=opus",
  aac: "audio/aac",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

const HTML_PREVIEW_SHIM_MARKER = "data-scienceswarm-html-preview-shim";
const HTML_PREVIEW_STORAGE_SHIM = `<script ${HTML_PREVIEW_SHIM_MARKER}>
(() => {
  const createMemoryStorage = () => {
    const store = new Map();
    return {
      getItem(key) {
        const normalizedKey = String(key);
        return store.has(normalizedKey) ? store.get(normalizedKey) : null;
      },
      setItem(key, value) {
        store.set(String(key), String(value));
      },
      removeItem(key) {
        store.delete(String(key));
      },
      clear() {
        store.clear();
      },
      key(index) {
        return Array.from(store.keys())[index] ?? null;
      },
      get length() {
        return store.size;
      },
    };
  };

  const ensureStorage = (name) => {
    try {
      const storage = window[name];
      const probeKey = "__scienceswarm_preview_probe__";
      storage.setItem(probeKey, "1");
      storage.removeItem(probeKey);
    } catch {
      Object.defineProperty(window, name, {
        configurable: true,
        value: createMemoryStorage(),
      });
    }
  };

  ensureStorage("localStorage");
  ensureStorage("sessionStorage");
})();
</script>`;

function buildSandboxedPreviewHeaders(
  ext: string,
  base: Record<string, string>,
): Record<string, string> {
  if (ext === "html" || ext === "htm") {
    return {
      ...base,
      "Content-Security-Policy":
        "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
    };
  }

  if (ext === "svg") {
    return {
      ...base,
      "Content-Security-Policy":
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
    };
  }

  return base;
}

function buildInlineContentDisposition(filename: string): string {
  const encodedName = encodeURIComponent(filename);
  const asciiFallback = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_") || "download";
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`;
}

function isHtmlRawExtension(ext: string): boolean {
  return ext === "html" || ext === "htm";
}

function injectHtmlPreviewShim(html: string): string {
  if (html.includes(HTML_PREVIEW_SHIM_MARKER)) {
    return html;
  }

  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (match) => `${match}${HTML_PREVIEW_STORAGE_SHIM}`);
  }

  if (/<body(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<body(?:\s[^>]*)?>/i, (match) => `${match}${HTML_PREVIEW_STORAGE_SHIM}`);
  }

  if (/<!doctype html[^>]*>/i.test(html)) {
    return html.replace(/<!doctype html[^>]*>/i, (match) => `${match}\n${HTML_PREVIEW_STORAGE_SHIM}`);
  }

  return `${HTML_PREVIEW_STORAGE_SHIM}${html}`;
}

function buildBufferedRawPreviewResponse(params: {
  ext: string;
  fileName: string;
  buffer: Buffer;
  contentType: string;
}): Response {
  const body = isHtmlRawExtension(params.ext)
    ? injectHtmlPreviewShim(params.buffer.toString("utf-8"))
    : new Uint8Array(params.buffer);
  const contentLength = typeof body === "string"
    ? Buffer.byteLength(body)
    : params.buffer.byteLength;

  return new Response(body, {
    status: 200,
    headers: buildSandboxedPreviewHeaders(params.ext, {
      "Content-Type": params.contentType,
      "Content-Length": String(contentLength),
      "Cache-Control": "private, max-age=60",
      "Content-Disposition": buildInlineContentDisposition(params.fileName),
    }),
  });
}

async function findGbrainWorkspaceEntry(
  filePath: string,
  projectId: string | null,
): Promise<GbrainWorkspaceFileEntry | null> {
  if (!projectId) return null;
  const requestedPath = normalizeWorkspacePath(filePath);
  if (!requestedPath) return null;
  // Imported gbrain-backed files seed the workspace, but any explicit local
  // edit should become the source of truth for subsequent reads. Without this
  // overlay, the editor appears to save successfully and then "reverts" after
  // a reload because the stale imported object still wins.
  if (!("error" in safeResolveInsideRoot(requestedPath, projectId))) {
    return null;
  }
  const entries = await listGbrainWorkspaceFileEntries(projectId);
  return entries.find((entry) => entry.workspacePath === requestedPath) ?? null;
}

async function openGbrainWorkspaceFile(entry: GbrainWorkspaceFileEntry): Promise<
  | {
      ok: true;
      size: number;
      mime: string;
      stream: ReadableStream<Uint8Array>;
    }
  | { ok: false; response: Response }
> {
  const opened = await getWorkspaceRouteFileStore().openObjectStream(entry.ref.fileObjectId);
  if (!opened) {
    return {
      ok: false,
      response: Response.json(
        {
          error: `File object missing for '${entry.workspacePath}' (fileObjectId=${entry.ref.fileObjectId})`,
        },
        { status: 404 },
      ),
    };
  }
  return {
    ok: true,
    size: opened.metadata.sizeBytes,
    mime: opened.metadata.mime || entry.ref.mime || "application/octet-stream",
    stream: opened.stream,
  };
}

async function readStreamToBufferCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("stream exceeded preview cap");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function safeResolveInsideRoot(
  filePath: string,
  projectId: string | null,
): { realFile: string; stat: fs.Stats } | { error: string; status: number } {
  const root = resolveWorkspaceRoot(projectId);
  return safeResolveInsideDirectory(root, filePath);
}

function safeResolveInsideDirectory(
  root: string,
  filePath: string,
): { realFile: string; stat: fs.Stats } | { error: string; status: number } {
  if (!fs.existsSync(root)) {
    return { error: "Workspace root not found", status: 404 };
  }

  const resolvedRoot = fs.realpathSync(root);
  const resolved = path.resolve(resolvedRoot, filePath);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    return { error: "Invalid file path", status: 400 };
  }

  let realFile: string;
  try {
    realFile = fs.realpathSync(resolved);
  } catch {
    return { error: "File not found", status: 404 };
  }

  if (!realFile.startsWith(resolvedRoot + path.sep) && realFile !== resolvedRoot) {
    return { error: "Access denied", status: 403 };
  }

  const stat = fs.statSync(realFile);
  if (!stat.isFile()) {
    return { error: "Not a file", status: 400 };
  }

  return { realFile, stat };
}

function safeResolveOpenClawCanvasPath(
  filePath: string,
): { realFile: string; stat: fs.Stats } | { error: string; status: number } | null {
  const normalized = filePath.replaceAll("\\", "/");
  const prefix = "__openclaw__/canvas/";
  if (!normalized.startsWith(prefix)) {
    return null;
  }

  const canvasRoot = path.join(getScienceSwarmOpenClawStateDir(), "canvas");
  const relativeCanvasPath = normalized.slice(prefix.length);
  return safeResolveInsideDirectory(canvasRoot, relativeCanvasPath);
}

function safeResolveOpenClawMediaPath(
  filePath: string,
): { realFile: string; stat: fs.Stats } | { error: string; status: number } | null {
  const normalized = filePath.replaceAll("\\", "/");
  const prefix = "__openclaw__/media/";
  if (!normalized.startsWith(prefix)) {
    return null;
  }

  const mediaRoot = path.join(getScienceSwarmOpenClawStateDir(), "media");
  const relativeMediaPath = normalized.slice(prefix.length);
  return safeResolveInsideDirectory(mediaRoot, relativeMediaPath);
}

async function handleRead(filePath: string, projectId: string | null) {
  const gbrainEntry = await findGbrainWorkspaceEntry(filePath, projectId);
  if (gbrainEntry) {
    const ext = path.extname(gbrainEntry.workspacePath).slice(1).toLowerCase();
    const opened = await openGbrainWorkspaceFile(gbrainEntry);
    if (!opened.ok) return opened.response;

    if (PARSEABLE_EXTENSIONS.has(ext)) {
      if (opened.size > MAX_RAW_BYTES) {
        await opened.stream.cancel().catch(() => {});
        return Response.json({
          file: filePath,
          tooLarge: true,
          size: opened.size,
          maxBytes: MAX_RAW_BYTES,
        });
      }

      try {
        const buf = await readStreamToBufferCapped(opened.stream, MAX_RAW_BYTES);
        const { parseFile } = await import("@/lib/file-parser");
        const parsed = await parseFile(buf, path.posix.basename(gbrainEntry.ref.filename));
        return Response.json({
          file: filePath,
          content: parsed.text,
          size: opened.size,
          parsed: true,
          format: ext,
          pages: parsed.pages,
          rawAvailable: ext === "pdf",
          source: "gbrain",
        });
      } catch (error) {
        console.error("Workspace gbrain preview parse failed", {
          file: filePath,
          projectId,
          fileObjectId: gbrainEntry.ref.fileObjectId,
          error: error instanceof Error ? error.message : String(error),
        });
        return Response.json({ error: "File preview parse failed" }, { status: 500 });
      }
    }

    if (opened.size > MAX_READ_BYTES) {
      await opened.stream.cancel().catch(() => {});
      return Response.json({
        file: filePath,
        tooLarge: true,
        size: opened.size,
        maxBytes: MAX_READ_BYTES,
      });
    }

    const buf = await readStreamToBufferCapped(opened.stream, MAX_READ_BYTES);
    const probe = buf.subarray(0, Math.min(8192, buf.length));
    if (probe.includes(0)) {
      return Response.json({
        file: filePath,
        binary: true,
        size: opened.size,
        rawAvailable:
          RAW_RENDERABLE_EXTENSIONS.has(ext) ||
          SANDBOXED_PREVIEW_EXTENSIONS.has(ext),
        source: "gbrain",
      });
    }

    return Response.json({
      file: filePath,
      content: buf.toString("utf-8"),
      size: opened.size,
      source: "gbrain",
    });
  }

  const resolved = safeResolveInsideRoot(filePath, projectId);
  if ("error" in resolved) {
    return Response.json({ error: resolved.error }, { status: resolved.status });
  }
  const { realFile, stat } = resolved;

  const ext = path.extname(realFile).slice(1).toLowerCase();

  if (PARSEABLE_EXTENSIONS.has(ext)) {
    if (stat.size > MAX_RAW_BYTES) {
      return Response.json({
        file: filePath,
        tooLarge: true,
        size: stat.size,
        maxBytes: MAX_RAW_BYTES,
      });
    }

    try {
      const buf = await fs.promises.readFile(realFile);
      const { parseFile } = await import("@/lib/file-parser");
      const parsed = await parseFile(buf, path.basename(realFile));
      return Response.json({
        file: filePath,
        content: parsed.text,
        size: stat.size,
        parsed: true,
        format: ext,
        pages: parsed.pages,
        rawAvailable: ext === "pdf",
      });
    } catch (error) {
      console.error("Workspace preview parse failed", {
        file: filePath,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json({ error: "File preview parse failed" }, { status: 500 });
    }
  }

  if (stat.size > MAX_READ_BYTES) {
    return Response.json({
      file: filePath,
      tooLarge: true,
      size: stat.size,
      maxBytes: MAX_READ_BYTES,
    });
  }

  const buf = await fs.promises.readFile(realFile);
  const probe = buf.subarray(0, Math.min(8192, buf.length));
  if (probe.includes(0)) {
    return Response.json({
      file: filePath,
      binary: true,
      size: stat.size,
      rawAvailable:
        RAW_RENDERABLE_EXTENSIONS.has(ext) ||
        SANDBOXED_PREVIEW_EXTENSIONS.has(ext),
    });
  }

  return Response.json({
    file: filePath,
    content: buf.toString("utf-8"),
    size: stat.size,
  });
}

async function handleRaw(filePath: string, projectId: string | null) {
  const openClawCanvasResolved = safeResolveOpenClawCanvasPath(filePath);
  if (openClawCanvasResolved) {
    if ("error" in openClawCanvasResolved) {
      return new Response(openClawCanvasResolved.error, { status: openClawCanvasResolved.status });
    }

    const { realFile, stat } = openClawCanvasResolved;
    const ext = path.extname(realFile).slice(1).toLowerCase();
    if (
      !RAW_RENDERABLE_EXTENSIONS.has(ext) &&
      !SANDBOXED_PREVIEW_EXTENSIONS.has(ext)
    ) {
      return new Response("File type not allowed for raw preview", { status: 415 });
    }

    if (stat.size > MAX_RAW_BYTES) {
      return new Response("File too large for raw preview", { status: 413 });
    }

    const buf = await fs.promises.readFile(realFile);
    const contentType = RAW_CONTENT_TYPES[ext] || "application/octet-stream";
    return buildBufferedRawPreviewResponse({
      ext,
      fileName: path.basename(realFile),
      buffer: buf,
      contentType,
    });
  }

  const openClawMediaResolved = safeResolveOpenClawMediaPath(filePath);
  if (openClawMediaResolved) {
    if ("error" in openClawMediaResolved) {
      return new Response(openClawMediaResolved.error, { status: openClawMediaResolved.status });
    }

    const { realFile, stat } = openClawMediaResolved;
    const ext = path.extname(realFile).slice(1).toLowerCase();
    if (
      !RAW_RENDERABLE_EXTENSIONS.has(ext) &&
      !SANDBOXED_PREVIEW_EXTENSIONS.has(ext)
    ) {
      return new Response("File type not allowed for raw preview", { status: 415 });
    }

    if (stat.size > MAX_RAW_BYTES) {
      return new Response("File too large for raw preview", { status: 413 });
    }

    const buf = await fs.promises.readFile(realFile);
    const contentType = RAW_CONTENT_TYPES[ext] || "application/octet-stream";
    return buildBufferedRawPreviewResponse({
      ext,
      fileName: path.basename(realFile),
      buffer: buf,
      contentType,
    });
  }

  const gbrainEntry = await findGbrainWorkspaceEntry(filePath, projectId);
  if (gbrainEntry) {
    const ext = path.extname(gbrainEntry.workspacePath).slice(1).toLowerCase();
    if (
      !RAW_RENDERABLE_EXTENSIONS.has(ext) &&
      !SANDBOXED_PREVIEW_EXTENSIONS.has(ext)
    ) {
      return new Response("File type not allowed for raw preview", { status: 415 });
    }

    const opened = await openGbrainWorkspaceFile(gbrainEntry);
    if (!opened.ok) {
      return new Response(await opened.response.text(), { status: opened.response.status });
    }

    if (opened.size > MAX_RAW_BYTES) {
      await opened.stream.cancel().catch(() => {});
      return new Response("File too large for raw preview", { status: 413 });
    }

    const contentType = RAW_CONTENT_TYPES[ext] || opened.mime || "application/octet-stream";
    if (isHtmlRawExtension(ext)) {
      const buf = await readStreamToBufferCapped(opened.stream, MAX_RAW_BYTES);
      return buildBufferedRawPreviewResponse({
        ext,
        fileName: path.posix.basename(gbrainEntry.ref.filename),
        buffer: buf,
        contentType,
      });
    }

    return new Response(opened.stream, {
      status: 200,
      headers: buildSandboxedPreviewHeaders(ext, {
        "Content-Type": contentType,
        "Content-Length": String(opened.size),
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": buildInlineContentDisposition(path.posix.basename(gbrainEntry.ref.filename)),
      }),
    });
  }

  const resolved = safeResolveInsideRoot(filePath, projectId);
  if ("error" in resolved) {
    return new Response(resolved.error, { status: resolved.status });
  }
  const { realFile, stat } = resolved;

  const ext = path.extname(realFile).slice(1).toLowerCase();
  if (
    !RAW_RENDERABLE_EXTENSIONS.has(ext) &&
    !SANDBOXED_PREVIEW_EXTENSIONS.has(ext)
  ) {
    return new Response("File type not allowed for raw preview", { status: 415 });
  }

  if (stat.size > MAX_RAW_BYTES) {
    return new Response("File too large for raw preview", { status: 413 });
  }

  const buf = await fs.promises.readFile(realFile);
  const contentType = RAW_CONTENT_TYPES[ext] || "application/octet-stream";
  return buildBufferedRawPreviewResponse({
    ext,
    fileName: path.basename(realFile),
    buffer: buf,
    contentType,
  });
}

async function handleGetFile(filePath: string, projectId: string | null) {
  const gbrainEntry = await findGbrainWorkspaceEntry(filePath, projectId);
  if (gbrainEntry) {
    const opened = await openGbrainWorkspaceFile(gbrainEntry);
    if (!opened.ok) return opened.response;

    if (opened.size > MAX_TEXT_PREVIEW_BYTES) {
      await opened.stream.cancel().catch(() => {});
      return Response.json({ error: "File too large for text preview" }, { status: 413 });
    }

    const buffer = await readStreamToBufferCapped(opened.stream, MAX_TEXT_PREVIEW_BYTES);
    const isText = !buffer.some(
      (b) => b === 0 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x1b),
    );
    if (!isText) {
      return Response.json({ error: "Binary file preview is not supported" }, { status: 415 });
    }

    return Response.json({
      file: filePath,
      content: buffer.toString("utf-8"),
      source: "gbrain",
    });
  }

  const root = resolveWorkspaceRoot(projectId);
  const resolved = path.resolve(root, filePath);
  if (!resolved.startsWith(root + path.sep)) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  if (!fs.existsSync(resolved)) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  const realRoot = fs.realpathSync(root);
  const realResolved = fs.realpathSync(resolved);
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  const stats = fs.statSync(realResolved);
  if (stats.isDirectory()) {
    return Response.json({ error: "Cannot read a directory" }, { status: 400 });
  }
  if (stats.size > MAX_TEXT_PREVIEW_BYTES) {
    return Response.json({ error: "File too large for text preview" }, { status: 413 });
  }

  const buffer = fs.readFileSync(realResolved);
  const isText = !buffer.some(
    (b) => b === 0 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x1b),
  );
  if (!isText) {
    return Response.json({ error: "Binary file preview is not supported" }, { status: 415 });
  }

  return Response.json({
    file: filePath,
    content: buffer.toString("utf-8"),
  });
}

function handleUpdateMeta(
  body: {
    file?: string;
    summary?: string;
    conclusions?: string;
    references?: string[];
  },
  projectId: string | null,
) {
  const { file, summary, conclusions, references } = body;
  if (!file) {
    return Response.json({ error: "file required" }, { status: 400 });
  }

  const root = resolveWorkspaceRoot(projectId);
  const companionPath = path.resolve(root, file + ".md");
  if (!companionPath.startsWith(root + path.sep)) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  if (!fs.existsSync(companionPath)) {
    return Response.json({ error: "Companion .md not found" }, { status: 404 });
  }

  let content = fs.readFileSync(companionPath, "utf-8");

  if (summary) {
    content = content.replace(
      /## Summary\n\*\(Auto-generated on next AI analysis\)\*/,
      `## Summary\n${summary}`,
    );
  }
  if (conclusions) {
    content = content.replace(
      /## Key Findings\n\*\(Updated when AI analyzes this file\)\*/,
      `## Key Findings\n${conclusions}`,
    );
  }
  if (references && references.length > 0) {
    content = content.replace(
      /## References\n\*\(Links to related files in this project\)\*/,
      `## References\n${references.map(r => `- ${r}`).join("\n")}`,
    );
  }

  // Append to change log
  const logEntry = `- ${new Date().toISOString().split("T")[0]}: Metadata updated`;
  content = content.replace(/## Change Log\n/, `## Change Log\n${logEntry}\n`);

  fs.writeFileSync(companionPath, content);

  return Response.json({ updated: true, file });
}

function handleWriteFile(
  body: {
    file?: string;
    content?: string;
  },
  projectId: string | null,
) {
  const { file, content } = body;
  if (typeof file !== "string" || file.trim().length === 0 || typeof content !== "string") {
    return Response.json({ error: "file and content required" }, { status: 400 });
  }

  const root = resolveWorkspaceRoot(projectId, { create: true });
  const realRoot = fs.realpathSync(root);
  const requestedPath = file.replace(/^\/+/, "");
  const resolvedTarget = path.resolve(realRoot, requestedPath);
  if (!resolvedTarget.startsWith(realRoot + path.sep) && resolvedTarget !== realRoot) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  const parentDir = path.dirname(resolvedTarget);
  fs.mkdirSync(parentDir, { recursive: true });
  const realParent = fs.realpathSync(parentDir);
  if (!realParent.startsWith(realRoot + path.sep) && realParent !== realRoot) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  const writePath = fs.existsSync(resolvedTarget)
    ? fs.realpathSync(resolvedTarget)
    : path.join(realParent, path.basename(resolvedTarget));
  if (!writePath.startsWith(realRoot + path.sep) && writePath !== realRoot) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }

  const buffer = Buffer.from(content, "utf-8");
  fs.writeFileSync(writePath, buffer);

  const refs = readRefs(root);
  const workspacePath = path.relative(realRoot, writePath).replaceAll(path.sep, "/");
  const now = new Date().toISOString();
  const nextRef: FileReference = {
    originalPath: workspacePath,
    workspacePath,
    hash: hashContent(buffer),
    type: inferImportedFileType(path.basename(workspacePath)),
    size: buffer.length,
    importedAt: refs.files.find((ref) => ref.workspacePath === workspacePath)?.importedAt ?? now,
    lastChecked: now,
    changed: false,
    localEditedAt: path.isAbsolute(
      refs.files.find((ref) => ref.workspacePath === workspacePath)?.originalPath ?? "",
    )
      ? now
      : refs.files.find((ref) => ref.workspacePath === workspacePath)?.localEditedAt,
  };
  const existingIndex = refs.files.findIndex((ref) => ref.workspacePath === workspacePath);
  if (existingIndex >= 0) {
    refs.files[existingIndex] = {
      ...refs.files[existingIndex],
      ...nextRef,
    };
  } else {
    refs.files.push(nextRef);
  }
  writeRefs(root, refs);

  return Response.json({
    written: true,
    file: workspacePath,
    size: buffer.length,
  });
}

function handleDeleteFile(
  body: { file?: string },
  projectId: string | null,
) {
  const { file } = body;
  if (typeof file !== "string" || file.trim().length === 0) {
    return Response.json({ error: "file required" }, { status: 400 });
  }

  const root = resolveWorkspaceRoot(projectId, { create: false });
  if (!fs.existsSync(root)) {
    return Response.json({ error: "Project folder not found" }, { status: 404 });
  }
  const realRoot = fs.realpathSync(root);
  const requestedPath = file.replace(/^\/+/, "");
  const resolvedTarget = path.resolve(realRoot, requestedPath);
  if (!resolvedTarget.startsWith(realRoot + path.sep) && resolvedTarget !== realRoot) {
    return Response.json({ error: "Invalid file path" }, { status: 400 });
  }
  if (resolvedTarget === realRoot) {
    return Response.json({ error: "Refusing to delete project root" }, { status: 400 });
  }
  if (!fs.existsSync(resolvedTarget)) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  const stat = fs.statSync(resolvedTarget);
  if (stat.isDirectory()) {
    fs.rmSync(resolvedTarget, { recursive: true, force: true });
  } else {
    fs.unlinkSync(resolvedTarget);
  }

  const workspacePath = path.relative(realRoot, resolvedTarget).replaceAll(path.sep, "/");
  const refs = readRefs(root);
  const prefix = `${workspacePath}/`;
  refs.files = refs.files.filter((ref) =>
    ref.workspacePath !== workspacePath && !ref.workspacePath.startsWith(prefix),
  );
  writeRefs(root, refs);

  return Response.json({
    deleted: true,
    file: workspacePath,
    wasDirectory: stat.isDirectory(),
  });
}
