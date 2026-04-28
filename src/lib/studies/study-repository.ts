import matter from "gray-matter";

import type { StudyRecord, StudySlug, ProjectRecord } from "@/brain/gbrain-data-contracts";
import type { BrainPage, BrainStore } from "@/brain/store";
import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import type { GbrainClient } from "@/brain/gbrain-client";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { studyIdForLegacyProjectSlug } from "./state";
// Decision 3A presence-only lint gate: callers pass `createdBy`, which is
// written into study-page frontmatter before `putPage`.
import { getCurrentUserHandle as _requireAttributionImport } from "@/lib/setup/gbrain-installer";
void _requireAttributionImport;

export interface StudyRepository {
  list(): Promise<StudyRecord[]>;
  get(slug: StudySlug): Promise<StudyRecord | null>;
  create(input: {
    name: string;
    slug?: string;
    description?: string;
    createdBy: string;
  }): Promise<StudyRecord>;
  delete(slug: StudySlug): Promise<{ ok: true; existed: boolean }>;
  touch(slug: StudySlug, at?: string): Promise<void>;
}

export interface StudyRepositoryOptions {
  store?: BrainStore;
  client?: GbrainClient;
  now?: () => Date;
}

export class DuplicateStudyError extends Error {
  constructor(slug: string) {
    super(`Study already exists: ${slug}`);
    this.name = "DuplicateStudyError";
  }
}

interface ResolvedStudyCreateIdentity {
  name: string;
  slug: string;
}

const studyCreateTails = new Map<string, Promise<void>>();

async function withStudyCreateLock<T>(
  slug: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = studyCreateTails.get(slug) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  studyCreateTails.set(slug, tail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (studyCreateTails.get(slug) === tail) {
      studyCreateTails.delete(slug);
    }
  }
}

export function createStudyRepository(
  options: StudyRepositoryOptions = {},
): StudyRepository {
  const now = options.now ?? (() => new Date());

  async function store(): Promise<BrainStore> {
    if (options.store) return options.store;
    await ensureBrainStoreReady();
    return getBrainStore();
  }

  function client(): GbrainClient {
    return options.client ?? createInProcessGbrainClient();
  }

  async function putStudy(record: StudyRecord, extra: Record<string, unknown> = {}) {
    const markdown = renderStudyMarkdown(record, extra);
    await client().putPage(record.studyPageSlug, markdown);
  }

  return {
    async list(): Promise<StudyRecord[]> {
      const pages = await listStudyAndLegacyProjectPages(await store());
      const records = pages
        .map(pageToStudyRecord)
        .filter((record): record is StudyRecord => Boolean(record))
        .filter((record) => record.status !== "archived");
      return dedupeStudyRecords(records).sort(compareStudyRecordsByRecency);
    },

    async get(slug: StudySlug): Promise<StudyRecord | null> {
      const safeSlug = assertSafeProjectSlug(slug);
      const brain = await store();
      const page = await brain.getPage(safeSlug);
      const direct = pageToStudyRecord(page);
      if (direct) return direct;
      return findStudyRecordBySlug(brain, safeSlug);
    },

    async create(input): Promise<StudyRecord> {
      const trimmedName = input.name.trim();
      const requestedSlug = input.slug
        ? assertSafeProjectSlug(input.slug)
        : assertSafeProjectSlug(slugifyStudyName(trimmedName));
      return withStudyCreateLock(requestedSlug, async () => {
        const brain = await store();
        const { name, slug } = await resolveStudyCreateIdentity({
          brain,
          explicitSlug: Boolean(input.slug),
          requestedName: trimmedName,
          requestedSlug,
        });

        const existingPage = await brain.getPage(slug);
        const existing = pageToStudyRecord(existingPage);
        if (existing && existing.status !== "archived") {
          throw new DuplicateStudyError(slug);
        }
        if (existingPage && !existing) {
          throw new DuplicateStudyError(slug);
        }
        const existingByStudySlug = await findStudyRecordBySlug(brain, slug);
        if (existingByStudySlug && existingByStudySlug.status !== "archived") {
          throw new DuplicateStudyError(slug);
        }

        const createdAt = now().toISOString();
        const record: StudyRecord = {
          slug,
          name,
          description: input.description?.trim() || "New study",
          createdAt,
          lastActive: createdAt,
          status: "active",
          studyPageSlug: slug,
          legacyProjectSlug: slug,
        };
        await putStudy(record, {
          created_by: input.createdBy,
          updated_by: input.createdBy,
        });
        return record;
      });
    },

    async delete(slug: StudySlug): Promise<{ ok: true; existed: boolean }> {
      const safeSlug = assertSafeProjectSlug(slug);
      const brain = await store();

      const pages = await listStudyAndLegacyProjectPages(brain);
      const matchingRecords = pages
        .map(pageToStudyRecord)
        .filter(
          (record): record is StudyRecord =>
            record !== null && record.slug === safeSlug && record.status !== "archived",
        );

      if (matchingRecords.length === 0) return { ok: true, existed: false };

      const archivedAt = now().toISOString();
      for (const record of matchingRecords) {
        const archived: StudyRecord = {
          ...record,
          status: "archived",
          lastActive: archivedAt,
        };
        await putStudy(archived);
      }

      return { ok: true, existed: true };
    },

    async touch(slug: StudySlug, at?: string): Promise<void> {
      const existing = await this.get(slug);
      if (!existing) return;
      await putStudy({
        ...existing,
        lastActive: at ?? now().toISOString(),
      });
    },
  };
}

async function resolveStudyCreateIdentity({
  brain,
  explicitSlug,
  requestedName,
  requestedSlug,
}: {
  brain: BrainStore;
  explicitSlug: boolean;
  requestedName: string;
  requestedSlug: string;
}): Promise<ResolvedStudyCreateIdentity> {
  if (explicitSlug) {
    return { name: requestedName, slug: requestedSlug };
  }

  const requestedUse = await getStudySlugUse(brain, requestedSlug);
  if (!requestedUse.used) {
    return { name: requestedName, slug: requestedSlug };
  }
  if (!requestedUse.onlyArchivedStudyRecords) {
    throw new DuplicateStudyError(requestedSlug);
  }

  const versioned = await resolveArchivedStudyVersionedSlug(brain, requestedSlug);
  return {
    name: `${requestedName}-${versioned.version}`,
    slug: versioned.slug,
  };
}

async function resolveArchivedStudyVersionedSlug(
  brain: BrainStore,
  baseSlug: string,
): Promise<{ slug: string; version: number }> {
  for (let version = 2; version < Number.MAX_SAFE_INTEGER; version += 1) {
    const slug = assertSafeProjectSlug(`${baseSlug}-${version}`);
    const use = await getStudySlugUse(brain, slug);
    if (!use.used) {
      return { slug, version };
    }
  }

  throw new Error(`Unable to allocate versioned study slug for ${baseSlug}`);
}

async function getStudySlugUse(
  brain: BrainStore,
  slug: string,
): Promise<{ onlyArchivedStudyRecords: boolean; used: boolean }> {
  const exactPage = await brain.getPage(slug);
  const exactRecord = pageToStudyRecord(exactPage);
  if (exactPage && !exactRecord) {
    return { onlyArchivedStudyRecords: false, used: true };
  }
  if (exactRecord && exactRecord.status !== "archived") {
    return { onlyArchivedStudyRecords: false, used: true };
  }

  const matchingRecords = await findStudyRecordsBySlug(brain, slug);
  if (matchingRecords.some((record) => record.status !== "archived")) {
    return { onlyArchivedStudyRecords: false, used: true };
  }

  const used = Boolean(exactRecord) || matchingRecords.length > 0;
  return { onlyArchivedStudyRecords: used, used };
}

async function listStudyAndLegacyProjectPages(store: BrainStore): Promise<BrainPage[]> {
  const [studyPages, legacyProjectPages] = await Promise.all([
    store.listPages({ type: "study", limit: 5000 }),
    store.listPages({ type: "project", limit: 5000 }),
  ]);
  return [...studyPages, ...legacyProjectPages];
}

async function findStudyRecordBySlug(
  store: BrainStore,
  slug: string,
): Promise<StudyRecord | null> {
  const records = await findStudyRecordsBySlug(store, slug);
  return records[0] ?? null;
}

async function findStudyRecordsBySlug(
  store: BrainStore,
  slug: string,
): Promise<StudyRecord[]> {
  const pages = await listStudyAndLegacyProjectPages(store);
  return pages
    .map(pageToStudyRecord)
    .filter((record): record is StudyRecord => Boolean(record))
    .filter((record) => record.slug === slug)
    .sort(compareStudyRecordsByRecency);
}

function dedupeStudyRecords(records: StudyRecord[]): StudyRecord[] {
  const bySlug = new Map<string, StudyRecord>();
  for (const record of records) {
    const existing = bySlug.get(record.slug);
    if (!existing || compareStudyRecordsByRecency(record, existing) < 0) {
      bySlug.set(record.slug, record);
    }
  }
  return Array.from(bySlug.values());
}

function compareStudyRecordsByRecency(
  a: StudyRecord,
  b: StudyRecord,
): number {
  const byLastActive = b.lastActive.localeCompare(a.lastActive);
  if (byLastActive !== 0) return byLastActive;
  const aIsStudy = a.studyPageSlug === a.slug ? 1 : 0;
  const bIsStudy = b.studyPageSlug === b.slug ? 1 : 0;
  return bIsStudy - aIsStudy;
}

export function slugifyStudyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function pageToStudyRecord(page: BrainPage | null): StudyRecord | null {
  if (!page) return null;
  const fm = page.frontmatter ?? {};
  const type = typeof fm.type === "string" ? fm.type : page.type;
  if (type !== "study" && type !== "project") return null;

  const slugCandidate = type === "study"
    ? stringOr(fm.study_slug, fm.study, fm.legacy_project_slug, fm.project)
      ?? page.path.replace(/\.md$/i, "")
    : stringOr(fm.project) ?? page.path.replace(/\.md$/i, "");

  let slug: string;
  try {
    slug = assertSafeProjectSlug(slugCandidate);
  } catch {
    return null;
  }

  const legacyProjectSlug = safeLegacyProjectSlug(
    stringOr(fm.legacy_project_slug, fm.project) ?? (type === "project" ? slug : null),
  );
  const status = normalizeStatus(fm.status);
  const createdAt = stringOr(fm.created_at, fm.createdAt, fm.date) ?? new Date(0).toISOString();
  const lastActive = stringOr(fm.last_active, fm.lastActive, fm.updated_at, fm.updatedAt) ?? createdAt;
  return {
    slug,
    name: stringOr(fm.name, fm.title) ?? page.title ?? slug,
    description: stringOr(fm.description) ?? extractSummary(page.content) ?? "New study",
    createdAt,
    lastActive,
    status,
    studyPageSlug: page.path.replace(/\.md$/i, ""),
    legacyProjectSlug: legacyProjectSlug ?? undefined,
  };
}

function renderStudyMarkdown(
  record: StudyRecord,
  extra: Record<string, unknown>,
): string {
  const studyId = studyIdForLegacyProjectSlug(record.legacyProjectSlug ?? record.slug);
  const frontmatter = {
    type: "study",
    title: record.name,
    name: record.name,
    study: record.slug,
    study_slug: record.slug,
    study_id: studyId,
    legacy_project_slug: record.legacyProjectSlug ?? record.slug,
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
    "## Study Details",
    `- Slug: \`${record.slug}\``,
    `- Study ID: \`${studyId}\``,
    `- Created: ${record.createdAt}`,
    `- Last active: ${record.lastActive}`,
    "",
  ].join("\n");
  return matter.stringify(body, frontmatter);
}

function safeLegacyProjectSlug(value: string | null): string | null {
  if (!value) return null;
  try {
    return assertSafeProjectSlug(value);
  } catch {
    return null;
  }
}

function normalizeStatus(value: unknown): StudyRecord["status"] {
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

export function projectRecordFromStudyRecord(record: StudyRecord): ProjectRecord {
  return {
    slug: record.legacyProjectSlug ?? record.slug,
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    lastActive: record.lastActive,
    status: record.status,
    projectPageSlug: record.studyPageSlug,
  };
}

export function studyRecordFromProjectRecord(record: ProjectRecord): StudyRecord {
  return {
    slug: record.slug,
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    lastActive: record.lastActive,
    status: record.status,
    studyPageSlug: record.projectPageSlug,
    legacyProjectSlug: record.slug,
  };
}
