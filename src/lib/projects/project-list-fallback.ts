import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { ProjectRecord } from "@/brain/gbrain-data-contracts";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { readJsonFile } from "@/lib/state/atomic-json";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";

interface DiskProjectMeta {
  slug?: string;
  name?: string;
  description?: string;
  createdAt?: string;
  lastActive?: string;
  status?: string;
}

export async function listProjectRecordsFromDisk(
  projectsRoot = getScienceSwarmProjectsRoot(),
): Promise<ProjectRecord[]> {
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readProjectRecordFromDisk(entry.name, projectsRoot)),
  );

  return records
    .filter((record): record is ProjectRecord => Boolean(record))
    .sort(compareProjectRecordsByRecency);
}

async function readProjectRecordFromDisk(
  candidateSlug: string,
  projectsRoot: string,
): Promise<ProjectRecord | null> {
  let slug: string;
  try {
    slug = assertSafeProjectSlug(candidateSlug);
  } catch {
    return null;
  }

  const projectRoot = path.join(projectsRoot, slug);
  const [meta, rootStats, manifestStats] = await Promise.all([
    readJsonFile<DiskProjectMeta>(path.join(projectRoot, "project.json")),
    stat(projectRoot).catch(() => null),
    stat(path.join(projectRoot, ".brain", "state", "manifest.json")).catch(() => null),
  ]);

  if (!meta && !manifestStats) {
    return null;
  }

  const fallbackTimestamp =
    manifestStats?.mtime.toISOString()
    ?? rootStats?.mtime.toISOString()
    ?? new Date(0).toISOString();

  return {
    slug,
    name: readNonEmptyString(meta?.name) ?? humanizeSlug(slug),
    description: readNonEmptyString(meta?.description) ?? "",
    createdAt: readNonEmptyString(meta?.createdAt) ?? fallbackTimestamp,
    lastActive: readNonEmptyString(meta?.lastActive) ?? fallbackTimestamp,
    status: normalizeProjectStatus(meta?.status),
    projectPageSlug: slug,
  };
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizeProjectStatus(value: unknown): ProjectRecord["status"] {
  if (value === "archived") return "archived";
  if (value === "paused") return "paused";
  if (value === "idle") return "idle";
  return "active";
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function compareProjectRecordsByRecency(
  left: ProjectRecord,
  right: ProjectRecord,
): number {
  const byLastActive = right.lastActive.localeCompare(left.lastActive);
  if (byLastActive !== 0) return byLastActive;
  return left.slug.localeCompare(right.slug);
}
