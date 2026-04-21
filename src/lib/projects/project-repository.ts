import matter from "gray-matter";

import type { ProjectRecord, ProjectSlug } from "@/brain/gbrain-data-contracts";
import type { BrainPage, BrainStore } from "@/brain/store";
import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import type { GbrainClient } from "@/brain/gbrain-client";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
// Decision 3A presence-only lint gate: callers pass `createdBy`, which is
// written into project-page frontmatter before `putPage`.
import { getCurrentUserHandle as _requireAttributionImport } from "@/lib/setup/gbrain-installer";
void _requireAttributionImport;

export interface ProjectRepository {
  list(): Promise<ProjectRecord[]>;
  get(slug: ProjectSlug): Promise<ProjectRecord | null>;
  create(input: {
    name: string;
    slug?: string;
    description?: string;
    createdBy: string;
  }): Promise<ProjectRecord>;
  delete(slug: ProjectSlug): Promise<{ ok: true; existed: boolean }>;
  touch(slug: ProjectSlug, at?: string): Promise<void>;
}

export interface ProjectRepositoryOptions {
  store?: BrainStore;
  client?: GbrainClient;
  now?: () => Date;
}

export class DuplicateProjectError extends Error {
  constructor(slug: string) {
    super(`Project already exists: ${slug}`);
    this.name = "DuplicateProjectError";
  }
}

const projectCreateTails = new Map<string, Promise<void>>();

async function withProjectCreateLock<T>(
  slug: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectCreateTails.get(slug) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  projectCreateTails.set(slug, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (projectCreateTails.get(slug) === tail) {
      projectCreateTails.delete(slug);
    }
  }
}

export function createProjectRepository(
  options: ProjectRepositoryOptions = {},
): ProjectRepository {
  const now = options.now ?? (() => new Date());

  async function store(): Promise<BrainStore> {
    if (options.store) return options.store;
    await ensureBrainStoreReady();
    return getBrainStore();
  }

  function client(): GbrainClient {
    return options.client ?? createInProcessGbrainClient();
  }

  async function putProject(record: ProjectRecord, extra: Record<string, unknown> = {}) {
    const markdown = renderProjectMarkdown(record, extra);
    await client().putPage(record.projectPageSlug, markdown);
  }

  return {
    async list(): Promise<ProjectRecord[]> {
      const pages = await (await store()).listPages({ type: "project", limit: 5000 });
      const records = pages
        .map(pageToProjectRecord)
        .filter((record): record is ProjectRecord => Boolean(record))
        .filter((record) => record.status !== "archived");
      return dedupeProjectRecords(records).sort(compareProjectRecordsByRecency);
    },

    async get(slug: ProjectSlug): Promise<ProjectRecord | null> {
      const safeSlug = assertSafeProjectSlug(slug);
      const page = await (await store()).getPage(safeSlug);
      const direct = pageToProjectRecord(page);
      if (direct) return direct;
      return findProjectRecordBySlug(await store(), safeSlug);
    },

    async create(input): Promise<ProjectRecord> {
      const trimmedName = input.name.trim();
      const slug = input.slug
        ? assertSafeProjectSlug(input.slug)
        : assertSafeProjectSlug(slugifyProjectName(trimmedName));
      return withProjectCreateLock(slug, async () => {
        const brain = await store();
        const existingPage = await brain.getPage(slug);
        const existing = pageToProjectRecord(existingPage);
        if (existing && existing.status !== "archived") {
          throw new DuplicateProjectError(slug);
        }
        if (existingPage && !existing) {
          throw new DuplicateProjectError(slug);
        }
        const existingByProjectSlug = await findProjectRecordBySlug(brain, slug);
        if (existingByProjectSlug && existingByProjectSlug.status !== "archived") {
          throw new DuplicateProjectError(slug);
        }

        const createdAt = now().toISOString();
        const record: ProjectRecord = {
          slug,
          name: trimmedName,
          description: input.description?.trim() || "New project",
          createdAt,
          lastActive: createdAt,
          status: "active",
          projectPageSlug: slug,
        };
        await putProject(record, {
          created_by: input.createdBy,
          updated_by: input.createdBy,
        });
        return record;
      });
    },

    async delete(slug: ProjectSlug): Promise<{ ok: true; existed: boolean }> {
      const safeSlug = assertSafeProjectSlug(slug);
      const brain = await store();

      // Find ALL pages that map to this project slug — there may be
      // duplicates at different paths (e.g. "test2", "projects/test2",
      // "wiki/projects/test2"). Archiving only one leaves the others
      // visible in list().
      const allPages = await brain.listPages({ type: "project", limit: 5000 });
      const matchingRecords = allPages
        .map(pageToProjectRecord)
        .filter(
          (r): r is ProjectRecord =>
            r !== null && r.slug === safeSlug && r.status !== "archived",
        );

      if (matchingRecords.length === 0) return { ok: true, existed: false };

      // Archive every matching page
      const archivedAt = now().toISOString();
      for (const record of matchingRecords) {
        const archived: ProjectRecord = {
          ...record,
          status: "archived",
          lastActive: archivedAt,
        };
        await putProject(archived);
      }

      return { ok: true, existed: true };
    },

    async touch(slug: ProjectSlug, at?: string): Promise<void> {
      const existing = await this.get(slug);
      if (!existing) return;
      await putProject({
        ...existing,
        lastActive: at ?? now().toISOString(),
      });
    },
  };
}

async function findProjectRecordBySlug(
  store: BrainStore,
  slug: string,
): Promise<ProjectRecord | null> {
  const pages = await store.listPages({ type: "project", limit: 5000 });
  const records = pages
    .map(pageToProjectRecord)
    .filter((record): record is ProjectRecord => Boolean(record))
    .filter((record) => record.slug === slug)
    .sort(compareProjectRecordsByRecency);
  return records[0] ?? null;
}

function dedupeProjectRecords(records: ProjectRecord[]): ProjectRecord[] {
  const bySlug = new Map<string, ProjectRecord>();
  for (const record of records) {
    const existing = bySlug.get(record.slug);
    if (!existing || compareProjectRecordsByRecency(record, existing) < 0) {
      bySlug.set(record.slug, record);
    }
  }
  return Array.from(bySlug.values());
}

function compareProjectRecordsByRecency(
  a: ProjectRecord,
  b: ProjectRecord,
): number {
  const byLastActive = b.lastActive.localeCompare(a.lastActive);
  if (byLastActive !== 0) return byLastActive;
  const aIsCanonical = a.projectPageSlug === a.slug ? 1 : 0;
  const bIsCanonical = b.projectPageSlug === b.slug ? 1 : 0;
  return bIsCanonical - aIsCanonical;
}

export function slugifyProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function pageToProjectRecord(page: BrainPage | null): ProjectRecord | null {
  if (!page) return null;
  const fm = page.frontmatter ?? {};
  const type = typeof fm.type === "string" ? fm.type : page.type;
  if (type !== "project") return null;

  const slugCandidate =
    typeof fm.project === "string" && fm.project.trim().length > 0
      ? fm.project
      : page.path.replace(/\.md$/i, "");
  let slug: string;
  try {
    slug = assertSafeProjectSlug(slugCandidate);
  } catch {
    return null;
  }

  const status = normalizeStatus(fm.status);
  const createdAt = stringOr(fm.created_at, fm.createdAt, fm.date) ?? new Date(0).toISOString();
  const lastActive = stringOr(fm.last_active, fm.lastActive, fm.updated_at, fm.updatedAt) ?? createdAt;
  return {
    slug,
    name: stringOr(fm.name, fm.title) ?? page.title ?? slug,
    description: stringOr(fm.description) ?? extractSummary(page.content) ?? "New project",
    createdAt,
    lastActive,
    status,
    projectPageSlug: page.path.replace(/\.md$/i, ""),
  };
}

function renderProjectMarkdown(
  record: ProjectRecord,
  extra: Record<string, unknown>,
): string {
  const frontmatter = {
    type: "project",
    title: record.name,
    name: record.name,
    project: record.slug,
    project_id: record.slug,
    description: record.description,
    created_at: record.createdAt,
    last_active: record.lastActive,
    status: record.status,
    para: "projects",
    privacy: "cloud-ok",
    ...extra,
  };
  const body = [
    `# ${record.name}`,
    "",
    "## Summary",
    record.description,
    "",
    "## Project Details",
    `- Slug: \`${record.slug}\``,
    `- Created: ${record.createdAt}`,
    `- Last active: ${record.lastActive}`,
    "",
  ].join("\n");
  return matter.stringify(body, frontmatter);
}

function normalizeStatus(value: unknown): ProjectRecord["status"] {
  if (value === "archived") return "archived";
  if (value === "paused") return "paused";
  if (value === "idle") return "idle";
  return "active";
}

function stringOr(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractSummary(content: string): string | null {
  const match = content.match(/## Summary\s+([\s\S]*?)(?:\n## |\s*$)/);
  return match?.[1]?.trim() || null;
}
