import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { getScienceSwarmBrainRoot, getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import type { ProjectManifest } from "@/brain/types";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./atomic-json";
import {
  getLegacyProjectManifestPath,
  getLegacyProjectImportSummaryPath,
  getLegacyProjectStateDir,
  getLegacyProjectWatchConfigPath,
  getProjectAbsoluteWikiPath,
  getProjectLocalManifestPath,
  getProjectLocalStateDir,
  getProjectLocalWatchConfigPath,
  isProjectLocalStateRoot,
  migrateLegacyProjectState,
  migrateLegacyProjectWiki,
} from "./project-storage";

/**
 * Thrown when a value passed to {@link assertSafeProjectSlug} doesn't match
 * the safe-slug regex. Distinct from a generic Error so callers can map this
 * to a 400 (client input) without coupling to the message wording.
 */
export class InvalidSlugError extends Error {
  constructor(message = "Invalid project slug") {
    super(message);
    this.name = "InvalidSlugError";
  }
}

export function assertSafeProjectSlug(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new InvalidSlugError();
  }

  return slug;
}

export function getProjectStateDir(slug: string, root?: string): string {
  const safeSlug = assertSafeProjectSlug(slug);
  if (root) {
    if (isProjectLocalStateRoot(safeSlug, root)) {
      return root;
    }
    return getLegacyProjectStateDir(safeSlug, root);
  }
  return getProjectLocalStateDir(safeSlug);
}

export function getProjectManifestPath(
  slug: string,
  root?: string,
): string {
  const safeSlug = assertSafeProjectSlug(slug);
  if (root) {
    if (isProjectLocalStateRoot(safeSlug, root)) {
      return path.join(root, "manifest.json");
    }
    return getLegacyProjectManifestPath(safeSlug, root);
  }
  return getProjectLocalManifestPath(safeSlug);
}

export function getProjectWatchConfigPath(
  slug: string,
  root?: string,
): string {
  const safeSlug = assertSafeProjectSlug(slug);
  if (root) {
    if (isProjectLocalStateRoot(safeSlug, root)) {
      return path.join(root, "watch-config.json");
    }
    return getLegacyProjectWatchConfigPath(safeSlug, root);
  }
  return getProjectLocalWatchConfigPath(safeSlug);
}

export function getProjectPagePath(slug: string): string {
  return `wiki/projects/${assertSafeProjectSlug(slug)}.md`;
}

function hasLegacyProjectArtifacts(slug: string): boolean {
  const legacyBrainRoot = getScienceSwarmBrainRoot();
  const legacyStateRoot = path.join(legacyBrainRoot, "state");

  return (
    existsSync(getLegacyProjectManifestPath(slug, legacyStateRoot))
    || existsSync(getLegacyProjectWatchConfigPath(slug, legacyStateRoot))
    || existsSync(getLegacyProjectImportSummaryPath(slug, legacyStateRoot))
    || existsSync(path.join(legacyBrainRoot, getProjectPagePath(slug)))
    || existsSync(path.join(legacyBrainRoot, "wiki", "projects", slug))
  );
}

export async function readProjectManifest(
  slug: string,
  root?: string,
): Promise<ProjectManifest | null> {
  const safeSlug = assertSafeProjectSlug(slug);
  if (root) {
    return readJsonFile<ProjectManifest>(getProjectManifestPath(safeSlug, root));
  }

  const canonicalManifest = await readJsonFile<ProjectManifest>(getProjectManifestPath(safeSlug));
  if (canonicalManifest) {
    return canonicalManifest;
  }

  if (!hasLegacyProjectArtifacts(safeSlug)) {
    return readJsonFile<ProjectManifest>(getProjectManifestPath(safeSlug));
  }

  await migrateLegacyProjectState(safeSlug);
  return readJsonFile<ProjectManifest>(getProjectManifestPath(safeSlug));
}

export async function writeProjectManifest(
  manifest: ProjectManifest,
  root?: string,
): Promise<ProjectManifest> {
  const safeSlug = assertSafeProjectSlug(manifest.slug);
  if (!root) {
    await migrateLegacyProjectState(safeSlug);
  }
  await writeJsonFile(getProjectManifestPath(safeSlug, root), manifest);
  return manifest;
}

export async function updateProjectManifest(
  slug: string,
  updater: (current: ProjectManifest | null) => ProjectManifest,
  root?: string,
): Promise<ProjectManifest> {
  const safeSlug = assertSafeProjectSlug(slug);
  if (!root) {
    await migrateLegacyProjectState(safeSlug);
  }
  return updateJsonFile<ProjectManifest>(getProjectManifestPath(safeSlug, root), updater);
}

interface ProjectMetadata {
  name?: string;
  description?: string;
  createdAt?: string;
  lastActive?: string;
  status?: string;
}

function humanizeProjectSlug(slug: string): string {
  return slug
    .split("-")
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizeManifestStatus(status?: string): ProjectManifest["status"] {
  if (status === "archived") return "archived";
  if (status === "paused" || status === "idle") return "paused";
  return "active";
}

function getBrainRootFromStateRoot(stateRoot: string): string {
  return path.dirname(path.resolve(stateRoot));
}

function buildProjectPageContent(input: {
  slug: string;
  title: string;
  description?: string;
  status: ProjectManifest["status"];
  createdAt?: string;
  updatedAt: string;
}): string {
  const summary = input.description?.trim() || "Project created in the ScienceSwarm workspace.";
  const details = [`- Slug: \`${input.slug}\``];
  if (input.createdAt?.trim()) {
    details.push(`- Created: ${input.createdAt.trim()}`);
  }

  return [
    "---",
    `date: ${input.updatedAt.slice(0, 10)}`,
    `title: ${JSON.stringify(input.title)}`,
    "type: project",
    "para: projects",
    `project: ${JSON.stringify(input.slug)}`,
    `status: ${input.status}`,
    "privacy: cloud-ok",
    "---",
    "",
    `# ${input.title}`,
    "",
    "## Summary",
    summary,
    "",
    "## Project Details",
    ...details,
    "",
  ].join("\n");
}

async function readProjectMetadata(
  slug: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): Promise<ProjectMetadata | null> {
  return readJsonFile<ProjectMetadata>(
    path.join(projectsRoot, assertSafeProjectSlug(slug), "project.json"),
  );
}

async function ensureProjectPage(input: {
  slug: string;
  title: string;
  description?: string;
  status: ProjectManifest["status"];
  createdAt?: string;
  updatedAt: string;
  brainRoot?: string;
}): Promise<void> {
  const projectPagePath = input.brainRoot
    ? path.join(input.brainRoot, getProjectPagePath(input.slug))
    : getProjectAbsoluteWikiPath(input.slug, getProjectPagePath(input.slug));
  try {
    await fs.access(projectPagePath);
    return;
  } catch {
    // Create the minimal page lazily when a manifest exists but the wiki page does not.
  }

  await fs.mkdir(path.dirname(projectPagePath), { recursive: true });
  await fs.writeFile(
    projectPagePath,
    buildProjectPageContent({
      slug: input.slug,
      title: input.title,
      description: input.description,
      status: input.status,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    }),
    "utf-8",
  );
}

export async function ensureProjectManifest(
  slug: string,
  stateRoot?: string,
  projectsRoot = getScienceSwarmProjectsRoot(),
): Promise<ProjectManifest | null> {
  const safeSlug = assertSafeProjectSlug(slug);
  const brainRoot = stateRoot ? getBrainRootFromStateRoot(stateRoot) : undefined;

  const existing = await readProjectManifest(safeSlug, stateRoot);

  if (existing) {
    await ensureProjectPage({
      slug: safeSlug,
      title: existing.title,
      status: existing.status,
      updatedAt: existing.updatedAt,
      brainRoot,
    });
    return existing;
  }

  const metadata = await readProjectMetadata(safeSlug, projectsRoot);
  if (!metadata) {
    return null;
  }

  if (!stateRoot) {
    await migrateLegacyProjectState(safeSlug);
    await migrateLegacyProjectWiki(safeSlug);
  }

  const updatedAt = metadata.lastActive?.trim() || metadata.createdAt?.trim() || new Date().toISOString();
  const manifest: ProjectManifest = {
    version: 1,
    projectId: safeSlug,
    slug: safeSlug,
    title: metadata.name?.trim() || humanizeProjectSlug(safeSlug),
    privacy: "cloud-ok",
    status: normalizeManifestStatus(metadata.status),
    projectPagePath: getProjectPagePath(safeSlug),
    sourceRefs: [],
    decisionPaths: [],
    taskPaths: [],
    artifactPaths: [],
    frontierPaths: [],
    activeThreads: [],
    dedupeKeys: [],
    updatedAt,
  };

  await ensureProjectPage({
    slug: safeSlug,
    title: manifest.title,
    description: metadata.description,
    status: manifest.status,
    createdAt: metadata.createdAt,
    updatedAt,
    brainRoot,
  });

  await writeProjectManifest(manifest, stateRoot);
  return manifest;
}

export async function listProjectManifests(
  projectsRoot = getScienceSwarmProjectsRoot(),
): Promise<ProjectManifest[]> {
  let entries;
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          assertSafeProjectSlug(entry.name);
          return await ensureProjectManifest(entry.name, undefined, projectsRoot);
        } catch (error) {
          if (error instanceof InvalidSlugError) {
            return null;
          }
          throw error;
        }
      }),
  );

  return manifests.filter((manifest): manifest is ProjectManifest => Boolean(manifest));
}
