import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectManifest } from "@/brain/types";
import {
  getScienceSwarmBrainRoot,
  getScienceSwarmProjectsRoot,
  isDefaultScienceSwarmBrainRoot,
} from "@/lib/scienceswarm-paths";
import { readJsonFile } from "./atomic-json";

const PROJECT_SLUG_PATTERN = /^[a-z0-9-]+$/;

function assertProjectSlug(slug: string): string {
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid project slug: ${slug}`);
  }
  return slug;
}

export function getProjectRootPath(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return join(projectsRoot, assertProjectSlug(slug));
}

/**
 * @deprecated Legacy Project compatibility path. New Study-aware code should
 * use `src/lib/studies` Knowledge/State path helpers.
 */
export function getProjectBrainRootPath(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return join(getProjectRootPath(slug, projectsRoot), ".brain");
}

/**
 * @deprecated Legacy Project compatibility path. New Study-aware code should
 * keep operational state under the canonical Study State root.
 */
export function getProjectLocalStateRoot(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return join(getProjectBrainRootPath(slug, projectsRoot), "state");
}

/**
 * @deprecated Legacy Project compatibility path. New Study-aware code should
 * use the canonical Knowledge root instead of project-local `.brain`.
 */
export function getProjectLocalWikiRoot(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return join(getProjectBrainRootPath(slug, projectsRoot), "wiki");
}

export function getProjectLocalStateDir(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return getProjectLocalStateRoot(slug, projectsRoot);
}

function isProjectLocalStateRootPath(slug: string, stateRoot: string): boolean {
  const resolved = resolve(stateRoot);
  const safeSlug = assertProjectSlug(slug);
  return resolved === resolve(getProjectLocalStateRoot(safeSlug))
    || (
      basename(resolved) === "state"
      && basename(dirname(resolved)) === ".brain"
      && basename(dirname(dirname(resolved))) === safeSlug
    );
}

export function getProjectLocalManifestPath(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return join(getProjectLocalStateRoot(slug, projectsRoot), "manifest.json");
}

export function getProjectLocalWatchConfigPath(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return join(getProjectLocalStateRoot(slug, projectsRoot), "watch-config.json");
}

export function getProjectLocalImportSummaryPath(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return join(getProjectLocalStateRoot(slug, projectsRoot), "import-summary.json");
}

export function getProjectLocalChatPath(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return join(getProjectLocalStateRoot(slug, projectsRoot), "chat.json");
}

export function getProjectAbsoluteWikiPath(
  slug: string,
  relativePath: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return join(getProjectBrainRootPath(slug, projectsRoot), relativePath);
}

export function getProjectBrainPagePath(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return getProjectAbsoluteWikiPath(slug, `wiki/projects/${assertProjectSlug(slug)}.md`, projectsRoot);
}

export function getProjectBrainWikiDir(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string {
  return getProjectAbsoluteWikiPath(slug, `wiki/projects/${assertProjectSlug(slug)}`, projectsRoot);
}

export function getProjectImportSourceWikiDirs(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): string[] {
  const safeSlug = assertProjectSlug(slug);
  return [
    join(getProjectLocalWikiRoot(safeSlug, projectsRoot), "entities", "artifacts", "imports", safeSlug),
    join(getProjectLocalWikiRoot(safeSlug, projectsRoot), "entities", "papers", "imports", safeSlug),
    join(getProjectLocalWikiRoot(safeSlug, projectsRoot), "resources", "imports", safeSlug),
    join(getProjectLocalWikiRoot(safeSlug, projectsRoot), "resources", "data", "imports", safeSlug),
  ];
}

export function getLegacyProjectStateDir(slug: string, stateRoot: string): string {
  if (isProjectLocalStateRootPath(slug, stateRoot)) {
    return stateRoot;
  }
  return join(stateRoot, "projects", assertProjectSlug(slug));
}

export function getLegacyProjectManifestPath(slug: string, stateRoot: string): string {
  return join(getLegacyProjectStateDir(slug, stateRoot), "manifest.json");
}

export function getLegacyProjectWatchConfigPath(slug: string, stateRoot: string): string {
  return join(getLegacyProjectStateDir(slug, stateRoot), "watch-config.json");
}

export function getLegacyProjectImportSummaryPath(slug: string, stateRoot: string): string {
  return join(getLegacyProjectStateDir(slug, stateRoot), "import-summary.json");
}

export function getLegacyProjectChatPath(slug: string, stateRoot: string): string {
  return join(stateRoot, "chat", `${encodeURIComponent(assertProjectSlug(slug))}.json`);
}

export function isDefaultGlobalBrainRoot(brainRoot: string): boolean {
  return isDefaultScienceSwarmBrainRoot(brainRoot);
}

export function isDefaultGlobalStateRoot(stateRoot: string): boolean {
  return resolve(stateRoot) === resolve(getLegacyStateRoot());
}

export function getProjectStateRootForBrainRoot(slug: string, brainRoot: string): string {
  if (isDefaultGlobalBrainRoot(brainRoot)) {
    const canonicalStateRoot = getProjectLocalStateRoot(slug);
    if (existsSync(getProjectLocalManifestPath(slug)) || existsSync(getProjectLocalWatchConfigPath(slug))) {
      return canonicalStateRoot;
    }
    const legacyStateRoot = join(brainRoot, "state");
    if (
      existsSync(getLegacyProjectManifestPath(slug, legacyStateRoot))
      || existsSync(getLegacyProjectWatchConfigPath(slug, legacyStateRoot))
      || existsSync(getLegacyProjectImportSummaryPath(slug, legacyStateRoot))
    ) {
      return legacyStateRoot;
    }
    return getProjectLocalStateRoot(slug);
  }
  return join(brainRoot, "state");
}

export function isProjectLocalStateRoot(slug: string, stateRoot: string): boolean {
  return isProjectLocalStateRootPath(slug, stateRoot);
}

export function getProjectBrainRootForBrainRoot(slug: string, brainRoot: string): string {
  if (isDefaultGlobalBrainRoot(brainRoot)) {
    const canonicalBrainRoot = getProjectBrainRootPath(slug);
    if (
      existsSync(getProjectBrainPagePath(slug))
      || existsSync(getProjectBrainWikiDir(slug))
      || getProjectImportSourceWikiDirs(slug).some((dir) => existsSync(dir))
    ) {
      return canonicalBrainRoot;
    }
    if (
      existsSync(getLegacyProjectPageAbsolutePath(slug, brainRoot))
      || existsSync(getLegacyProjectWikiDir(slug, brainRoot))
      || getLegacyImportRoots(slug, brainRoot).some((dir) => existsSync(dir))
    ) {
      return brainRoot;
    }
    return getProjectBrainRootPath(slug);
  }
  return brainRoot;
}

function getLegacyProjectPageAbsolutePath(
  slug: string,
  legacyBrainRoot = getScienceSwarmBrainRoot(),
): string {
  return join(legacyBrainRoot, "wiki", "projects", `${assertProjectSlug(slug)}.md`);
}

function getLegacyProjectWikiDir(
  slug: string,
  legacyBrainRoot = getScienceSwarmBrainRoot(),
): string {
  return join(legacyBrainRoot, "wiki", "projects", assertProjectSlug(slug));
}

function getLegacyImportRoots(
  slug: string,
  legacyBrainRoot = getScienceSwarmBrainRoot(),
): string[] {
  const safeSlug = assertProjectSlug(slug);
  return [
    join(legacyBrainRoot, "wiki", "entities", "artifacts", "imports", safeSlug),
    join(legacyBrainRoot, "wiki", "entities", "papers", "imports", safeSlug),
    join(legacyBrainRoot, "wiki", "resources", "imports", safeSlug),
    join(legacyBrainRoot, "wiki", "resources", "data", "imports", safeSlug),
  ];
}

function getLegacyStateRoot(legacyBrainRoot = getScienceSwarmBrainRoot()): string {
  return join(legacyBrainRoot, "state");
}

async function pathStats(targetPath: string) {
  try {
    return await stat(targetPath);
  } catch {
    return null;
  }
}

async function relocatePath(sourcePath: string, targetPath: string): Promise<boolean> {
  const sourceStats = await pathStats(sourcePath);
  if (!sourceStats) return false;

  const targetStats = await pathStats(targetPath);
  await mkdir(dirname(targetPath), { recursive: true });

  if (!targetStats) {
    try {
      await rename(sourcePath, targetPath);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return false;
      }
      if (code !== "EXDEV") {
        throw error;
      }
    }
  }

  // Destination wins here on overlap. If a stale legacy write recreates a file
  // after the canonical copy already exists, we keep the canonical version and
  // only remove the recreated legacy path so migration stays idempotent.
  await cp(sourcePath, targetPath, {
    recursive: sourceStats.isDirectory(),
    force: false,
    errorOnExist: false,
  });
  await rm(sourcePath, { recursive: true, force: true });
  return true;
}

async function readMigratedManifest(
  slug: string,
  stateRoot: string,
): Promise<ProjectManifest | null> {
  return readJsonFile<ProjectManifest>(getLegacyProjectManifestPath(slug, stateRoot));
}

async function relocateManifestLinkedPages(
  slug: string,
  manifest: ProjectManifest | null,
  legacyBrainRoot: string,
  projectBrainRoot: string,
): Promise<void> {
  const relativePaths = new Set<string>();

  if (manifest?.projectPagePath) {
    relativePaths.add(manifest.projectPagePath);
  }

  for (const pagePath of manifest?.taskPaths ?? []) relativePaths.add(pagePath);
  for (const pagePath of manifest?.decisionPaths ?? []) relativePaths.add(pagePath);
  for (const pagePath of manifest?.artifactPaths ?? []) relativePaths.add(pagePath);
  for (const pagePath of manifest?.frontierPaths ?? []) relativePaths.add(pagePath);

  for (const relativePath of relativePaths) {
    await relocatePath(join(legacyBrainRoot, relativePath), join(projectBrainRoot, relativePath));
  }

  await relocatePath(
    getLegacyProjectPageAbsolutePath(slug, legacyBrainRoot),
    join(projectBrainRoot, "wiki", "projects", `${slug}.md`),
  );
  await relocatePath(
    getLegacyProjectWikiDir(slug, legacyBrainRoot),
    join(projectBrainRoot, "wiki", "projects", slug),
  );

  for (const legacyRoot of getLegacyImportRoots(slug, legacyBrainRoot)) {
    const relativeImportRoot = legacyRoot.slice(legacyBrainRoot.length + 1);
    await relocatePath(legacyRoot, join(projectBrainRoot, relativeImportRoot));
  }
}

async function ensureProjectLocalBrainStorage(
  slug: string,
  input?: {
    projectsRoot?: string;
    legacyBrainRoot?: string;
  },
): Promise<{
  projectRoot: string;
  brainRoot: string;
  stateRoot: string;
  wikiRoot: string;
}> {
  const safeSlug = assertProjectSlug(slug);
  const projectsRoot = input?.projectsRoot ?? getScienceSwarmProjectsRoot();
  const legacyBrainRoot = input?.legacyBrainRoot ?? getScienceSwarmBrainRoot();
  const legacyStateRoot = getLegacyStateRoot(legacyBrainRoot);

  const projectRoot = getProjectRootPath(safeSlug, projectsRoot);
  const brainRoot = getProjectBrainRootPath(safeSlug, projectsRoot);
  const stateRoot = getProjectLocalStateRoot(safeSlug, projectsRoot);
  const wikiRoot = getProjectLocalWikiRoot(safeSlug, projectsRoot);

  await mkdir(projectRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await mkdir(wikiRoot, { recursive: true });

  await relocatePath(
    getLegacyProjectManifestPath(safeSlug, legacyStateRoot),
    getProjectLocalManifestPath(safeSlug, projectsRoot),
  );
  await relocatePath(
    getLegacyProjectWatchConfigPath(safeSlug, legacyStateRoot),
    getProjectLocalWatchConfigPath(safeSlug, projectsRoot),
  );
  await relocatePath(
    getLegacyProjectImportSummaryPath(safeSlug, legacyStateRoot),
    getProjectLocalImportSummaryPath(safeSlug, projectsRoot),
  );

  const manifest = await readMigratedManifest(safeSlug, stateRoot);
  await relocateManifestLinkedPages(safeSlug, manifest, legacyBrainRoot, brainRoot);

  return { projectRoot, brainRoot, stateRoot, wikiRoot };
}

export async function migrateLegacyProjectState(
  slug: string,
  input?: {
    projectsRoot?: string;
    legacyBrainRoot?: string;
  },
): Promise<void> {
  // State and wiki migration intentionally share the same atomic relocation
  // path so callers can request either phase without leaving split storage.
  await ensureProjectLocalBrainStorage(slug, input);
}

export async function migrateLegacyProjectWiki(
  slug: string,
  input?: {
    projectsRoot?: string;
    legacyBrainRoot?: string;
  },
): Promise<void> {
  // Keep this equivalent to migrateLegacyProjectState; the project-local move
  // is holistic and must stay in sync for state and wiki paths.
  await ensureProjectLocalBrainStorage(slug, input);
}

export async function migrateLegacyProjectChat(
  slug: string,
  input?: {
    projectsRoot?: string;
    legacyBrainRoot?: string;
  },
): Promise<void> {
  const safeSlug = assertProjectSlug(slug);
  const projectsRoot = input?.projectsRoot ?? getScienceSwarmProjectsRoot();
  const legacyBrainRoot = input?.legacyBrainRoot ?? getScienceSwarmBrainRoot();
  await mkdir(dirname(getProjectLocalChatPath(safeSlug, projectsRoot)), { recursive: true });
  await relocatePath(
    getLegacyProjectChatPath(safeSlug, getLegacyStateRoot(legacyBrainRoot)),
    getProjectLocalChatPath(safeSlug, projectsRoot),
  );
}
