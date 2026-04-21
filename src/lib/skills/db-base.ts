import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

import {
  createInProcessGbrainClient,
  type InProcessGbrainClient,
  type PersistTransactionExistingPage,
  type PersistTransactionLinkInput,
} from "@/brain/in-process-gbrain-client";
import { GbrainWriteQueueFullError } from "@/lib/gbrain/write-queue";
import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

import {
  ENTITY_DIRECTORIES,
  renderEntityCompiledTruth,
  renderEntityTitle,
} from "./page-templates";

export type EntityType =
  | "paper"
  | "trial"
  | "protein"
  | "structure"
  | "compound"
  | "material"
  | "person";

export type WriteStatus = "persisted" | "in_memory_only" | "deferred";

export interface EntityId {
  scheme: string;
  id: string;
}

export interface Author {
  name: string;
  orcid?: string;
}

export interface PaperPayload {
  title: string;
  authors: Author[];
  venue: { name: string; type: string };
  year: number | null;
  abstract?: string;
  retraction_status: "active" | "retracted" | "concern" | "withdrawn" | null;
}

export interface TrialPayload {
  title: string;
  sponsor: string;
  phase: string;
  status: "recruiting" | "active" | "completed" | "terminated" | "withdrawn" | "unknown";
  conditions: string[];
  interventions: string[];
}

export interface ProteinPayload {
  recommended_name: string;
  organism: string;
  reviewed: boolean;
  status: "active" | "deprecated" | "unknown";
  genes: string[];
}

export interface StructurePayload {
  title: string;
  method: string;
  resolution_angstrom: number | null;
  release_date: string | null;
  status: "active" | "obsolete" | "superseded" | "unknown";
  macromolecules: string[];
  superseded_by?: string[];
  source_organisms?: string[];
}

export interface CompoundPayload {
  name: string;
  molecular_formula: string | null;
  inchi_key: string | null;
  status: "active" | "discontinued" | "unknown";
  max_phase: number | null;
}

export interface MaterialPayload {
  material_id: string;
  formula: string;
  crystal_system: string | null;
  band_gap_ev: number | null;
  energy_above_hull_ev: number | null;
  is_stable: boolean | null;
}

export interface PersonPayload {
  name: string;
  orcid?: string;
  affiliations: string[];
  works_count: number | null;
}

export type DbEntity =
  | (EnvelopeFields & { type: "paper"; payload: PaperPayload })
  | (EnvelopeFields & { type: "trial"; payload: TrialPayload })
  | (EnvelopeFields & { type: "protein"; payload: ProteinPayload })
  | (EnvelopeFields & { type: "structure"; payload: StructurePayload })
  | (EnvelopeFields & { type: "compound"; payload: CompoundPayload })
  | (EnvelopeFields & { type: "material"; payload: MaterialPayload })
  | (EnvelopeFields & { type: "person"; payload: PersonPayload });

export interface EnvelopeFields {
  ids: Record<string, string>;
  primary_id: EntityId;
  source_db: string[];
  source_uri: string;
  fetched_at: string;
  raw_summary: string | null;
}

export interface PersistOptions {
  client?: InProcessGbrainClient;
  brainRoot?: string;
  now?: Date;
  project?: string;
  maxQueueWaitMs?: number;
}

export interface ReplayDeferredWritesResult {
  replayed: number;
  remaining: number;
  errors: Array<{ file: string; message: string }>;
}

export interface PersistedEntityResult {
  entity: DbEntity;
  slug: string;
  diskPath: string;
  write_status: WriteStatus;
  correlation_id: string;
  dedup_hit: boolean;
}

export interface SearchPersistInput {
  sourceDb: string;
  query: string;
  filters?: Record<string, string | number | boolean>;
  entities: DbEntity[];
  total: number;
  cursor?: string;
  fetchedAt?: string;
}

export interface SearchPersistResult {
  slug: string;
  diskPath: string;
  write_status: WriteStatus;
  correlation_id: string;
  entities: DbEntity[];
  total: number;
  cursor?: string;
}

export interface DbFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retryBaseMs?: number;
}

interface RateLimitSpec {
  rps: number;
  with_key_rps?: number;
  polite_pool_rps?: number;
  env_key?: string;
  concurrency?: number;
}

const RATE_LIMITS: Record<string, RateLimitSpec> = {
  pubmed: { rps: 3, with_key_rps: 10, env_key: "NCBI_API_KEY" },
  pdb: { rps: 4 },
  materials_project: { rps: 2, with_key_rps: 5, env_key: "MATERIALS_PROJECT_API_KEY" },
  arxiv: { rps: 1 },
  biorxiv: { rps: 2 },
  crossref: { rps: 5, polite_pool_rps: 50, env_key: "CROSSREF_MAILTO" },
  openalex: { rps: 10, polite_pool_rps: 100, env_key: "OPENALEX_MAILTO" },
  semantic_scholar: { rps: 0.33, with_key_rps: 1, env_key: "SEMANTIC_SCHOLAR_API_KEY" },
  chembl: { rps: 5 },
  uniprot: { rps: 5 },
  clinicaltrials: { rps: 5 },
  orcid: { rps: 3 },
};

const IN_FLIGHT = new Map<string, Promise<DbHttpResult>>();
const NEXT_REQUEST_AT = new Map<string, number>();
const SESSION_ENTITIES = new Map<string, DbEntity>();

interface DbHttpResult {
  text: string;
  status: number;
  headers: Headers;
  retryCount: number;
}

export function resetDbBaseStateForTests(): void {
  IN_FLIGHT.clear();
  NEXT_REQUEST_AT.clear();
  SESSION_ENTITIES.clear();
}

export function sanitizeExternalText(
  value: unknown,
  options: { maxLength?: number } = {},
): string | null {
  if (value == null) return null;
  const maxLength = options.maxLength ?? 5_000;
  const input = String(value);
  const withoutTags = input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const withoutControls = withoutTags.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  const compact = withoutControls.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  if (!compact) return null;
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength).trimEnd()} [truncated, full content at source_uri]`;
}

export function wrapExternalSource(value: string | null | undefined): string | null {
  if (!value) return null;
  return `<external_source>${value}</external_source>`;
}

export function computeEntitySlug(entity: DbEntity): string {
  return slugifyParts([
    entity.type,
    entity.primary_id.scheme,
    entity.primary_id.id,
  ]);
}

export function identityKey(entity: DbEntity): string {
  return [
    entity.type,
    entity.primary_id.scheme.toLowerCase(),
    normalizeId(entity.primary_id.id),
  ].join(":");
}

export function getRequiredDatabaseKey(envName: string): string {
  const value = process.env[envName]?.trim();
  if (value) return value;
  throw new Error(
    `${envName} is not set. Add ${envName}=... to .env and confirm /api/health reports it before using this database wrapper.`,
  );
}

export async function persistEntity(
  entity: DbEntity,
  options: PersistOptions = {},
): Promise<PersistedEntityResult> {
  const userHandle = getCurrentUserHandle();
  const client = options.client ?? createInProcessGbrainClient();
  const brainRoot = options.brainRoot ?? getScienceSwarmBrainRoot();
  const sanitizedEntity = sanitizeEntity(entity);
  const preferredSlug = computeEntitySlug(sanitizedEntity);
  const aliasSlug = await findExistingEntitySlugByAliases(brainRoot, sanitizedEntity);
  const slug = aliasSlug ?? preferredSlug;
  const relativeDiskPath = path.join(ENTITY_DIRECTORIES[sanitizedEntity.type], `${slug}.md`);
  const diskPath = path.join(brainRoot, relativeDiskPath);
  const correlationId = randomUUID();
  const now = options.now ?? new Date();
  const sessionKeys = identityKeys(sanitizedEntity);
  const dedupHit =
    sessionKeys.some((key) => SESSION_ENTITIES.has(key)) ||
    Boolean(aliasSlug);
  for (const key of sessionKeys) {
    SESSION_ENTITIES.set(key, mergeSessionEntity(SESSION_ENTITIES.get(key), sanitizedEntity));
  }
  let persistedEntity = sanitizedEntity;

  const run = async () => {
    let renderedForDisk: RenderedPage | null = null;
    await client.persistTransaction(slug, async (existing) => {
      const rendered = buildEntityPage({
        entity: sanitizedEntity,
        existing,
        userHandle,
        now,
        correlationId,
        project: options.project,
      });
      renderedForDisk = rendered;
      persistedEntity = rendered.persistedEntity;
      return {
        page: {
          type: contentTypeForEntity(persistedEntity.type),
          title: renderEntityTitle(persistedEntity),
          compiledTruth: rendered.compiledTruth,
          timeline: rendered.timeline,
          frontmatter: rendered.frontmatter,
        },
        links: buildProjectLinks(options.project, slug),
      };
    });

    const rendered = renderedForDisk as RenderedPage | null;
    if (!rendered) {
      throw new Error(`db-base persist did not render page for ${slug}`);
    }
    await writeDiskMirror(brainRoot, relativeDiskPath, {
      type: contentTypeForEntity(persistedEntity.type),
      title: renderEntityTitle(persistedEntity),
      ...rendered.frontmatter,
    }, rendered.compiledTruth, rendered.timeline);
  };

  try {
    await run();
    return { entity: persistedEntity, slug, diskPath, write_status: "persisted", correlation_id: correlationId, dedup_hit: dedupHit };
  } catch (error) {
    if (!isQueueFull(error)) throw error;
    const retried = await retryQueueFull(run, options.maxQueueWaitMs ?? 5_000);
    if (retried) {
      return { entity: persistedEntity, slug, diskPath, write_status: "persisted", correlation_id: correlationId, dedup_hit: dedupHit };
    }
    await writeRetryLog(brainRoot, correlationId, {
      kind: "entity",
      slug,
      entity: sanitizedEntity,
      project: options.project,
      source_db: sanitizedEntity.source_db,
      primary_id: sanitizedEntity.primary_id,
      source_uri: sanitizedEntity.source_uri,
    });
    return { entity: persistedEntity, slug, diskPath, write_status: "deferred", correlation_id: correlationId, dedup_hit: dedupHit };
  }
}

export async function persistSearchResult(
  input: SearchPersistInput,
  options: PersistOptions = {},
): Promise<SearchPersistResult> {
  const userHandle = getCurrentUserHandle();
  const client = options.client ?? createInProcessGbrainClient();
  const brainRoot = options.brainRoot ?? getScienceSwarmBrainRoot();
  const fetchedAt = input.fetchedAt ?? (options.now ?? new Date()).toISOString();
  const entities = dedupeEntities(input.entities);
  const queryHash = createHash("sha256")
    .update(JSON.stringify({
      sourceDb: input.sourceDb,
      query: input.query,
      filters: input.filters ?? {},
    }))
    .digest("hex")
    .slice(0, 16);
  const slug = `searches/${queryHash}`;
  const relativeDiskPath = `${slug}.md`;
  const diskPath = path.join(brainRoot, relativeDiskPath);
  const correlationId = randomUUID();
  const hitIds = entities.map((entity) => ({
    type: entity.type,
    primary_id: entity.primary_id,
    slug: computeEntitySlug(entity),
  }));
  const body = renderSearchResultBody({ ...input, entities }, fetchedAt, hitIds);
  const frontmatter = cleanUndefined({
    entity_type: "search_result",
    type: "search_result",
    source_db: input.sourceDb,
    query: input.query,
    filters: input.filters ?? {},
    hit_ids: hitIds,
    total: input.total,
    cursor: input.cursor,
    fetched_at: fetchedAt,
    created_by: userHandle,
    created_at: fetchedAt,
    correlation_id: correlationId,
  }) as Record<string, unknown>;

  try {
    let mergedFrontmatter: Record<string, unknown> | null = null;
    await client.persistTransaction(slug, async (existing) => {
      mergedFrontmatter = cleanUndefined({
        ...(existing?.frontmatter ?? {}),
        ...frontmatter,
        ...projectFrontmatter(existing?.frontmatter, options.project),
        created_by: existing?.frontmatter.created_by ?? userHandle,
        created_at: existing?.frontmatter.created_at ?? fetchedAt,
        updated_by: userHandle,
        updated_at: fetchedAt,
      }) as Record<string, unknown>;
      return {
        page: {
          type: "note",
          title: `Search: ${input.query}`,
          compiledTruth: body,
          timeline: appendTimeline(existing?.timeline ?? "", {
            sourceDb: input.sourceDb,
            fetchedAt,
            primaryId: { scheme: "query", id: queryHash },
          }),
          frontmatter: mergedFrontmatter,
        },
        links: buildProjectLinks(options.project, slug),
      };
    });
    await writeDiskMirror(brainRoot, relativeDiskPath, {
      type: "note",
      title: `Search: ${input.query}`,
      ...(mergedFrontmatter ?? frontmatter),
    }, body, "");
    return {
      slug,
      diskPath,
      write_status: "persisted",
      correlation_id: correlationId,
      entities,
      total: input.total,
      cursor: input.cursor,
    };
  } catch (error) {
    if (!isQueueFull(error)) throw error;
    return {
      slug,
      diskPath,
      write_status: "in_memory_only",
      correlation_id: correlationId,
      entities,
      total: input.total,
      cursor: input.cursor,
    };
  }
}

export async function replayDeferredDatabaseWrites(
  options: PersistOptions = {},
): Promise<ReplayDeferredWritesResult> {
  const brainRoot = options.brainRoot ?? getScienceSwarmBrainRoot();
  const retryDir = path.join(brainRoot, "db-retry-queue");
  let files: string[] = [];
  try {
    files = (await readdir(retryDir))
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch (error) {
    if (isNotFound(error)) return { replayed: 0, remaining: 0, errors: [] };
    throw error;
  }

  let replayed = 0;
  let remaining = 0;
  const errors: Array<{ file: string; message: string }> = [];
  for (const file of files) {
    const fullPath = path.join(retryDir, file);
    try {
      const payload = JSON.parse(await readFile(fullPath, "utf-8")) as {
        kind?: string;
        entity?: unknown;
        project?: string;
      };
      if (payload.kind !== "entity" || !isDbEntity(payload.entity)) {
        throw new Error("retry file is not a database entity write");
      }
      const result = await persistEntity(payload.entity, {
        ...options,
        brainRoot,
        project: typeof payload.project === "string" ? payload.project : options.project,
      });
      if (result.write_status === "persisted") {
        await unlink(fullPath);
        replayed += 1;
      } else {
        await unlink(fullPath).catch(() => undefined);
        remaining += 1;
      }
    } catch (error) {
      remaining += 1;
      errors.push({
        file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { replayed, remaining, errors };
}

export async function fetchExternalText(
  apiName: string,
  url: string,
  options: DbFetchOptions = {},
): Promise<DbHttpResult> {
  const method = options.method ?? "GET";
  const key = `${apiName}:${method}:${url}:${options.body ?? ""}`;
  const existing = IN_FLIGHT.get(key);
  if (existing) return existing;

  const promise = fetchExternalTextUncached(apiName, url, options)
    .finally(() => IN_FLIGHT.delete(key));
  IN_FLIGHT.set(key, promise);
  return promise;
}

export async function fetchExternalJson<T>(
  apiName: string,
  url: string,
  options: DbFetchOptions = {},
): Promise<T> {
  const result = await fetchExternalText(apiName, url, options);
  try {
    return JSON.parse(result.text) as T;
  } catch (error) {
    throw new Error(
      `Malformed JSON from ${apiName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface RenderedPage {
  compiledTruth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  persistedEntity: DbEntity;
}

function buildEntityPage(input: {
  entity: DbEntity;
  existing: PersistTransactionExistingPage | null;
  userHandle: string;
  now: Date;
  correlationId: string;
  project?: string;
}): RenderedPage {
  const fetchedAt = input.entity.fetched_at || input.now.toISOString();
  const sourceDb = mergeStringArrays(
    readStringArray(input.existing?.frontmatter.source_db),
    input.entity.source_db,
  );
  const existingIds = readRecord(input.existing?.frontmatter.ids);
  const entityWithLifecycle = withStrongestLifecycle(input.entity, input.existing);
  const mergedIds = { ...existingIds, ...entityWithLifecycle.ids } as Record<string, string>;
  const persistedEntity = {
    ...entityWithLifecycle,
    ids: mergedIds,
    source_db: sourceDb,
    primary_id: preferredPrimaryId(entityWithLifecycle.type, mergedIds, entityWithLifecycle.primary_id),
  } as DbEntity;
  const compiledTruth = preserveUserAuthoredSections(
    input.existing?.compiledTruth,
    renderEntityCompiledTruth(persistedEntity),
  );
  const frontmatter = cleanUndefined({
    ...(input.existing?.frontmatter ?? {}),
    entity_type: persistedEntity.type,
    type: persistedEntity.type,
    ...projectFrontmatter(input.existing?.frontmatter, input.project),
    ids: persistedEntity.ids,
    primary_id: persistedEntity.primary_id,
    primary_id_scheme: persistedEntity.primary_id.scheme,
    primary_id_value: persistedEntity.primary_id.id,
    source_db: sourceDb,
    source_uri: persistedEntity.source_uri,
    fetched_at: fetchedAt,
    raw_summary: persistedEntity.raw_summary,
    source_metadata: {
      entity_type: persistedEntity.type,
      payload: persistedEntity.payload,
      ids: persistedEntity.ids,
      source_uri: persistedEntity.source_uri,
    },
    created_by: input.existing?.frontmatter.created_by ?? input.userHandle,
    created_at: input.existing?.frontmatter.created_at ?? fetchedAt,
    updated_by: input.userHandle,
    updated_at: fetchedAt,
    correlation_id: input.correlationId,
  }) as Record<string, unknown>;
  return {
    compiledTruth,
    frontmatter,
    persistedEntity,
    timeline: appendTimeline(input.existing?.timeline ?? "", {
      sourceDb: entityWithLifecycle.source_db[0] ?? "unknown",
      fetchedAt,
      primaryId: persistedEntity.primary_id,
    }),
  };
}

function withStrongestLifecycle(
  entity: DbEntity,
  existing: PersistTransactionExistingPage | null,
): DbEntity {
  const existingPayload = readRecord(readRecord(existing?.frontmatter.source_metadata).payload);
  const existingStatus = lifecycleStatus(existingPayload);
  const nextStatus = lifecycleStatus(entity.payload);
  if (!existingStatus || lifecycleRank(nextStatus) >= lifecycleRank(existingStatus)) {
    return entity;
  }
  return applyLifecycleStatus(entity, existingStatus);
}

type LifecycleField = "retraction_status" | "status";
type LifecycleStatus = { field: LifecycleField; value: string };
const PAPER_LIFECYCLE_STATUSES = ["active", "retracted", "concern", "withdrawn"] as const;
const TRIAL_LIFECYCLE_STATUSES = [
  "recruiting",
  "active",
  "completed",
  "terminated",
  "withdrawn",
  "unknown",
] as const;
const PROTEIN_LIFECYCLE_STATUSES = ["active", "deprecated", "unknown"] as const;
const STRUCTURE_LIFECYCLE_STATUSES = ["active", "obsolete", "superseded", "unknown"] as const;
const COMPOUND_LIFECYCLE_STATUSES = ["active", "discontinued", "unknown"] as const;

function applyLifecycleStatus(entity: DbEntity, status: LifecycleStatus): DbEntity {
  if (status.field === "retraction_status") {
    if (entity.type !== "paper") return entity;
    if (!isOneOf(status.value, PAPER_LIFECYCLE_STATUSES)) return entity;
    return {
      ...entity,
      payload: {
        ...entity.payload,
        retraction_status: status.value,
      },
    };
  }
  switch (entity.type) {
    case "trial":
      if (!isOneOf(status.value, TRIAL_LIFECYCLE_STATUSES)) return entity;
      return { ...entity, payload: { ...entity.payload, status: status.value } };
    case "protein":
      if (!isOneOf(status.value, PROTEIN_LIFECYCLE_STATUSES)) return entity;
      return { ...entity, payload: { ...entity.payload, status: status.value } };
    case "structure":
      if (!isOneOf(status.value, STRUCTURE_LIFECYCLE_STATUSES)) return entity;
      return { ...entity, payload: { ...entity.payload, status: status.value } };
    case "compound":
      if (!isOneOf(status.value, COMPOUND_LIFECYCLE_STATUSES)) return entity;
      return { ...entity, payload: { ...entity.payload, status: status.value } };
    case "paper":
    case "material":
    case "person":
      return entity;
  }
}

function lifecycleStatus(payload: object | null | undefined): LifecycleStatus | null {
  for (const field of [
    "retraction_status",
    "status",
  ] as const) {
    const value: unknown = payload ? Reflect.get(payload, field) : undefined;
    if (typeof value === "string" && value) return { field, value };
  }
  return null;
}

function isOneOf<const T extends readonly string[]>(value: string, allowed: T): value is T[number] {
  return allowed.includes(value);
}

function lifecycleRank(status: Pick<LifecycleStatus, "value"> | null): number {
  switch (status?.value) {
    case "retracted":
    case "withdrawn":
    case "obsolete":
    case "deprecated":
    case "discontinued":
    case "terminated":
      return 4;
    case "concern":
    case "superseded":
      return 3;
    case "active":
    case "recruiting":
    case "completed":
      return 2;
    case "unknown":
      return 1;
    default:
      return 0;
  }
}

function mergeSessionEntity(existing: DbEntity | undefined, next: DbEntity): DbEntity {
  if (!existing) return next;
  const ids = { ...existing.ids, ...next.ids };
  return {
    ...next,
    ids,
    primary_id: preferredPrimaryId(next.type, ids, next.primary_id),
    source_db: mergeStringArrays(existing.source_db, next.source_db),
  } as DbEntity;
}

function sanitizeEntity(entity: DbEntity): DbEntity {
  const rawSummary = sanitizeExternalText(entity.raw_summary, { maxLength: 10_000 });
  switch (entity.type) {
    case "paper":
      return {
        ...entity,
        raw_summary: rawSummary,
        payload: {
          ...entity.payload,
          title: sanitizeExternalText(entity.payload.title, { maxLength: 500 }) ?? entity.primary_id.id,
          abstract: sanitizeExternalText(entity.payload.abstract, { maxLength: 5_000 }) ?? undefined,
          venue: {
            ...entity.payload.venue,
            name: sanitizeExternalText(entity.payload.venue.name, { maxLength: 500 }) ?? entity.payload.venue.name,
            type: sanitizeExternalText(entity.payload.venue.type, { maxLength: 100 }) ?? entity.payload.venue.type,
          },
          authors: entity.payload.authors.map((author) => ({
            ...author,
            name: sanitizeExternalText(author.name, { maxLength: 200 }) ?? author.name,
          })),
          retraction_status: sanitizeLifecycleValue(
            entity.payload.retraction_status,
            PAPER_LIFECYCLE_STATUSES,
            null,
          ),
        },
      };
    case "trial":
      return {
        ...entity,
        raw_summary: rawSummary,
        payload: {
          ...entity.payload,
          title: sanitizeExternalText(entity.payload.title, { maxLength: 500 }) ?? entity.primary_id.id,
          sponsor: sanitizeExternalText(entity.payload.sponsor, { maxLength: 500 }) ?? entity.payload.sponsor,
          phase: sanitizeExternalText(entity.payload.phase, { maxLength: 100 }) ?? entity.payload.phase,
          conditions: entity.payload.conditions
            .map((value) => sanitizeExternalText(value, { maxLength: 200 }))
            .filter((value): value is string => Boolean(value)),
          interventions: entity.payload.interventions
            .map((value) => sanitizeExternalText(value, { maxLength: 200 }))
            .filter((value): value is string => Boolean(value)),
          status: sanitizeLifecycleValue(entity.payload.status, TRIAL_LIFECYCLE_STATUSES, "unknown"),
        },
      };
    case "protein":
      return {
        ...entity,
        raw_summary: rawSummary,
        payload: {
          ...entity.payload,
          recommended_name: sanitizeExternalText(entity.payload.recommended_name, { maxLength: 500 }) ?? entity.primary_id.id,
          organism: sanitizeExternalText(entity.payload.organism, { maxLength: 500 }) ?? entity.payload.organism,
          genes: entity.payload.genes
            .map((value) => sanitizeExternalText(value, { maxLength: 200 }))
            .filter((value): value is string => Boolean(value)),
          status: sanitizeLifecycleValue(entity.payload.status, PROTEIN_LIFECYCLE_STATUSES, "unknown"),
        },
      };
    case "structure":
      return {
        ...entity,
        raw_summary: rawSummary,
        payload: {
          ...entity.payload,
          title: sanitizeExternalText(entity.payload.title, { maxLength: 500 }) ?? entity.primary_id.id,
          method: sanitizeExternalText(entity.payload.method, { maxLength: 200 }) ?? entity.payload.method,
          release_date: sanitizeExternalText(entity.payload.release_date, { maxLength: 100 }) ?? null,
          macromolecules: entity.payload.macromolecules
            .map((value) => sanitizeExternalText(value, { maxLength: 200 }))
            .filter((value): value is string => Boolean(value)),
          superseded_by: entity.payload.superseded_by
            ?.map((value) => sanitizeExternalText(value, { maxLength: 50 }))
            .filter((value): value is string => Boolean(value)),
          source_organisms: entity.payload.source_organisms
            ?.map((value) => sanitizeExternalText(value, { maxLength: 200 }))
            .filter((value): value is string => Boolean(value)),
          status: sanitizeLifecycleValue(entity.payload.status, STRUCTURE_LIFECYCLE_STATUSES, "unknown"),
        },
      };
    case "compound":
      return {
        ...entity,
        raw_summary: rawSummary,
        payload: {
          ...entity.payload,
          name: sanitizeExternalText(entity.payload.name, { maxLength: 500 }) ?? entity.primary_id.id,
          molecular_formula: sanitizeExternalText(entity.payload.molecular_formula, { maxLength: 200 }),
          inchi_key: sanitizeExternalText(entity.payload.inchi_key, { maxLength: 200 }),
          status: sanitizeLifecycleValue(entity.payload.status, COMPOUND_LIFECYCLE_STATUSES, "unknown"),
        },
      };
    case "material":
      return {
        ...entity,
        raw_summary: rawSummary,
        payload: {
          ...entity.payload,
          material_id: sanitizeExternalText(entity.payload.material_id, { maxLength: 100 }) ?? entity.primary_id.id,
          formula: sanitizeExternalText(entity.payload.formula, { maxLength: 200 }) ?? entity.primary_id.id,
          crystal_system: sanitizeExternalText(entity.payload.crystal_system, { maxLength: 100 }),
        },
      };
    case "person":
      return {
        ...entity,
        raw_summary: rawSummary,
        payload: {
          ...entity.payload,
          name: sanitizeExternalText(entity.payload.name, { maxLength: 500 }) ?? entity.primary_id.id,
          orcid: sanitizeExternalText(entity.payload.orcid, { maxLength: 100 }) ?? undefined,
          affiliations: entity.payload.affiliations
            .map((value) => sanitizeExternalText(value, { maxLength: 500 }))
            .filter((value): value is string => Boolean(value)),
        },
      };
  }
}

function sanitizeLifecycleValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number];
function sanitizeLifecycleValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: null,
): T[number] | null;
function sanitizeLifecycleValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number] | null,
): T[number] | null {
  const sanitized = sanitizeExternalText(value, { maxLength: 100 });
  return sanitized && isOneOf(sanitized, allowed) ? sanitized : fallback;
}

function identityKeys(entity: DbEntity): string[] {
  const keys = new Set<string>([identityKey(entity)]);
  for (const [scheme, id] of Object.entries(entity.ids)) {
    keys.add([
      entity.type,
      scheme.toLowerCase(),
      normalizeId(id),
    ].join(":"));
  }
  return [...keys];
}

function dedupeEntities(entities: DbEntity[]): DbEntity[] {
  const byIdentity = new Map<string, DbEntity>();
  for (const entity of entities) {
    const keys = identityKeys(entity);
    const matches = keys
      .map((key) => byIdentity.get(key))
      .filter((candidate): candidate is DbEntity => Boolean(candidate));
    const uniqueMatches = [...new Set(matches)];
    const existing = uniqueMatches.reduce<DbEntity | undefined>(
      (merged, match) => mergeSessionEntity(merged, match),
      undefined,
    );
    const merged = mergeSessionEntity(existing, entity);
    const mergedKeys = new Set([
      ...uniqueMatches.flatMap(identityKeys),
      ...identityKeys(merged),
    ]);
    for (const key of mergedKeys) {
      byIdentity.set(key, merged);
    }
  }
  return [...new Set(byIdentity.values())];
}

function preferredPrimaryId(
  type: EntityType,
  ids: Record<string, unknown>,
  fallback: EntityId,
): EntityId {
  const order: Record<EntityType, string[]> = {
    paper: ["doi", "pmid", "arxiv", "semantic_scholar", "openalex"],
    trial: ["nct"],
    protein: ["uniprot"],
    structure: ["pdb"],
    compound: ["chembl", "inchi_key"],
    material: ["mp", "materials_project"],
    person: ["orcid", "openalex_author"],
  };
  for (const scheme of order[type]) {
    const id = ids[scheme];
    if (typeof id === "string" && id.trim()) {
      return { scheme, id };
    }
  }
  return fallback;
}

async function findExistingEntitySlugByAliases(
  brainRoot: string,
  entity: DbEntity,
): Promise<string | null> {
  const dir = path.join(brainRoot, ENTITY_DIRECTORIES[entity.type]);
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  for (const file of files.sort()) {
    if (!file.endsWith(".md")) continue;
    const fullPath = path.join(dir, file);
    try {
      const parsed = matter(await readFile(fullPath, "utf-8"));
      if (parsed.data.entity_type !== entity.type) continue;
      const existingIds = {
        ...readRecord(parsed.data.ids),
        ...aliasesFromPayload(readRecord(readRecord(parsed.data.source_metadata).payload)),
      };
      if (hasSharedAlias(existingIds, entity.ids)) {
        return file.slice(0, -".md".length);
      }
    } catch {
      // Ignore unrelated or user-corrupted markdown pages; gbrain remains the
      // persistence authority and this disk scan is only an alias accelerator.
    }
  }
  return null;
}

function hasSharedAlias(
  existingIds: Record<string, unknown>,
  nextIds: Record<string, string>,
): boolean {
  for (const [scheme, id] of Object.entries(nextIds)) {
    const aliases = aliasSchemes(scheme);
    for (const alias of aliases) {
      const existing = existingIds[alias];
      if (typeof existing !== "string") continue;
      if (normalizeId(existing) === normalizeId(id)) return true;
    }
  }
  return false;
}

function aliasesFromPayload(payload: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    [
      ["inchi_key", payload.inchi_key],
      ["orcid", payload.orcid],
      ["material_id", payload.material_id],
    ].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0),
  );
}

function aliasSchemes(scheme: string): string[] {
  switch (scheme) {
    case "mp":
    case "materials_project":
    case "material_id":
      return ["mp", "materials_project", "material_id"];
    default:
      return [scheme];
  }
}

function preserveUserAuthoredSections(
  existingCompiledTruth: string | undefined,
  nextCompiledTruth: string,
): string {
  if (!existingCompiledTruth?.trim()) return nextCompiledTruth;
  const preserved = extractUserSections(existingCompiledTruth);
  if (preserved.length === 0) return nextCompiledTruth;
  const next = nextCompiledTruth.trimEnd();
  const missing = preserved.filter((section) => !next.includes(section.trim()));
  return [next, ...missing.map((section) => section.trim())].filter(Boolean).join("\n\n");
}

function extractUserSections(compiledTruth: string): string[] {
  const sourceOwnedSections = new Set([
    "source metadata",
    "bibliography",
    "abstract",
    "trial",
    "protein",
    "structure",
    "compound",
    "material",
    "person",
  ]);
  const matches = [...compiledTruth.matchAll(/^##\s+(.+)$/gm)];
  const sections: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const title = match[1].trim().toLowerCase();
    if (sourceOwnedSections.has(title)) continue;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? compiledTruth.length;
    const section = compiledTruth.slice(start, end).trim();
    if (section) sections.push(section);
  }
  return sections;
}

function contentTypeForEntity(type: EntityType): "paper" | "person" {
  return type === "person" ? "person" : "paper";
}

function buildProjectLinks(
  project: string | undefined,
  slug: string,
): PersistTransactionLinkInput[] {
  if (!project?.trim()) return [];
  return [{
    from: project.trim(),
    to: slug,
    context: "fetched_via",
    linkType: "supports",
  }];
}

function projectFrontmatter(
  existing: Record<string, unknown> | undefined,
  project: string | undefined,
): { project?: string; projects?: string[] } {
  const existingProject = typeof existing?.project === "string"
    ? existing.project.trim()
    : "";
  const nextProject = project?.trim() ?? "";
  const projects = mergeStringArrays(
    readStringArray(existing?.projects),
    [existingProject, nextProject].filter(Boolean),
  );

  return cleanUndefined({
    project: nextProject || existingProject || undefined,
    projects: projects.length > 0 ? projects : undefined,
  }) as { project?: string; projects?: string[] };
}

function appendTimeline(
  existingTimeline: string,
  input: { sourceDb: string; fetchedAt: string; primaryId: EntityId },
): string {
  const fetchedMinute = input.fetchedAt.slice(0, 16);
  const key = `${input.sourceDb}:${fetchedMinute}:${input.primaryId.scheme}:${input.primaryId.id}`;
  if (existingTimeline.includes(`dedup_key: ${key}`)) return existingTimeline;
  const entry = [
    `- ${fetchedMinute} fetched via ${input.sourceDb}`,
    `  - primary_id: ${input.primaryId.scheme}:${input.primaryId.id}`,
    `  - dedup_key: ${key}`,
  ].join("\n");
  return [existingTimeline.trim(), entry].filter(Boolean).join("\n");
}

function renderSearchResultBody(
  input: SearchPersistInput,
  fetchedAt: string,
  hitIds: Array<{ type: EntityType; primary_id: EntityId; slug: string }>,
): string {
  const lines = [
    `# Search: ${input.query}`,
    "",
    `Source database: ${input.sourceDb}`,
    `Fetched at: ${fetchedAt}`,
    `Total hits: ${input.total}`,
    "",
    "## Hits",
  ];
  if (hitIds.length === 0) {
    lines.push("", "No results.");
  } else {
    for (const hit of hitIds) {
      lines.push(`- ${hit.type} ${hit.primary_id.scheme}:${hit.primary_id.id} -> ${hit.slug}`);
    }
  }
  return lines.join("\n");
}

async function writeDiskMirror(
  brainRoot: string,
  relativePath: string,
  frontmatter: Record<string, unknown>,
  compiledTruth: string,
  timeline: string,
): Promise<void> {
  const absolutePath = path.join(brainRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const body = timeline.trim()
    ? `${compiledTruth.trim()}\n\n---\n\n${timeline.trim()}\n`
    : `${compiledTruth.trim()}\n`;
  await writeFile(
    absolutePath,
    matter.stringify(body, cleanUndefined(frontmatter) as Record<string, unknown>),
    "utf-8",
  );
}

function cleanUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cleanUndefined).filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      cleaned[key] = cleanUndefined(entry);
    }
    return cleaned;
  }
  return value;
}

async function writeRetryLog(
  brainRoot: string,
  correlationId: string,
  payload: unknown,
): Promise<void> {
  const retryDir = path.join(brainRoot, "db-retry-queue");
  await mkdir(retryDir, { recursive: true });
  await writeFile(
    path.join(retryDir, `${correlationId}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8",
  );
}

async function retryQueueFull(
  operation: () => Promise<void>,
  maxWaitMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    await sleep(100);
    try {
      await operation();
      return true;
    } catch (error) {
      if (!isQueueFull(error)) throw error;
    }
  }
  return false;
}

function isQueueFull(error: unknown): boolean {
  return error instanceof GbrainWriteQueueFullError;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isDbEntity(value: unknown): value is DbEntity {
  const record = readRecord(value);
  const primaryId = readRecord(record.primary_id);
  const payload = record.payload;
  return (
    isEntityType(record.type) &&
    typeof primaryId.scheme === "string" &&
    typeof primaryId.id === "string" &&
    Array.isArray(record.source_db) &&
    typeof record.source_uri === "string" &&
    Boolean(payload) &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  );
}

function isEntityType(value: unknown): value is EntityType {
  switch (value) {
    case "paper":
    case "trial":
    case "protein":
    case "structure":
    case "compound":
    case "material":
    case "person":
      return true;
    default:
      return false;
  }
}

async function fetchExternalTextUncached(
  apiName: string,
  url: string,
  options: DbFetchOptions,
): Promise<DbHttpResult> {
  const retryBaseMs = options.retryBaseMs ?? 250;
  let retryCount = 0;
  for (;;) {
    await waitForRateLimit(apiName);
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    if (response.ok) {
      return { text, status: response.status, headers: response.headers, retryCount };
    }
    if (response.status === 429 && retryCount < 3) {
      retryCount += 1;
      await sleep(retryAfterMs(response.headers) ?? retryBaseMs * retryCount);
      continue;
    }
    if (response.status >= 500 && retryCount < 3) {
      retryCount += 1;
      await sleep(retryBaseMs * (2 ** (retryCount - 1)) + Math.floor(Math.random() * 25));
      continue;
    }
    throw new Error(`External database ${apiName} returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function waitForRateLimit(apiName: string): Promise<void> {
  const spec = RATE_LIMITS[apiName] ?? { rps: 1 };
  const rps = effectiveRps(spec);
  const gapMs = Math.ceil(1000 / Math.max(0.1, rps));
  const now = Date.now();
  const nextAt = NEXT_REQUEST_AT.get(apiName) ?? 0;
  if (nextAt > now) {
    await sleep(nextAt - now);
  }
  NEXT_REQUEST_AT.set(apiName, Math.max(now, nextAt) + gapMs);
}

function effectiveRps(spec: RateLimitSpec): number {
  if (spec.env_key && process.env[spec.env_key]?.trim()) {
    return spec.with_key_rps ?? spec.polite_pool_rps ?? spec.rps;
  }
  return spec.rps;
}

function retryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function slugifyParts(parts: string[]): string {
  return parts
    .join("-")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function mergeStringArrays(...arrays: Array<readonly string[]>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const array of arrays) {
    for (const value of array) {
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(value);
    }
  }
  return merged;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
