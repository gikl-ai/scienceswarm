import { createHash } from "node:crypto";

import {
  type GbrainCapabilities,
  probeGbrainCapabilities,
} from "@/brain/gbrain-capabilities";
import {
  ensureBrainStoreReady,
  getBrainStore,
  type BrainPage,
  type BrainStore,
} from "@/brain/store";
import type { SearchResult } from "@/brain/types";
import { frontmatterMatchesStudy } from "@/lib/studies/frontmatter";

type QueryResultRow = Record<string, unknown>;

interface QueryableDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
}

export type RuntimeStructuralRetrievalStatus = "ok" | "degraded";

export interface RuntimeStructuralRetrievalInput {
  projectId: string;
  runtimeSessionId: string;
  hostId: string;
  query: string;
  studyId?: string;
  studySlug?: string;
  legacyProjectSlug?: string;
  sourceIds?: string[];
  pageIds?: string[];
  nearSymbol?: string;
  walkDepth?: number;
  limit?: number;
}

export interface RuntimeStructuralRetrievalRecord {
  recordId: string;
  pageId: string;
  title: string;
  type: string;
  chunkId: string | null;
  chunkIndex: number | null;
  sourceId: string | null;
  symbol: {
    name: string | null;
    type: string | null;
    qualifiedName: string | null;
    parentPath: string | null;
  };
  graph: {
    incomingEdges: number | null;
    outgoingEdges: number | null;
    walkDepth: number;
  };
  provenance: {
    engine: "gbrain";
    resultHash: string;
    retrieval: "structural" | "keyword-fallback";
  };
}

export interface RuntimeStructuralRetrievalResult {
  status: RuntimeStructuralRetrievalStatus;
  degraded: boolean;
  records: RuntimeStructuralRetrievalRecord[];
  provenance: {
    engine: "gbrain";
    projectId: string;
    studyId: string | null;
    studySlug: string | null;
    runtimeSessionIdHash: string;
    hostId: string;
    capability: {
      structuralNavigationAvailable: boolean;
      schemaVersion: number | null;
      chunkerVersion: string;
      blockers: string[];
    };
    queryHash: string;
    filters: {
      sourceIds: string[];
      pageIds: string[];
      nearSymbol: string | null;
      walkDepth: number;
      limit: number;
    };
  };
}

export interface RuntimeStructuralRetrievalDeps {
  probeCapabilities?: () => Promise<GbrainCapabilities>;
  ensureReady?: () => Promise<void>;
  getStore?: () => BrainStore;
}

export class RuntimeStructuralRetrievalScopeError extends Error {
  readonly code = "RUNTIME_STRUCTURAL_RETRIEVAL_SCOPE_DENIED";
  readonly status = 403;
  readonly recoverable = true;
  readonly context: Record<string, unknown>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "RuntimeStructuralRetrievalScopeError";
    this.context = context;
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function compactHash(value: unknown): string {
  return stableHash(value).slice(0, 16);
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanStringArray(values: readonly string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(20, Math.trunc(value ?? 8)));
}

function boundedWalkDepth(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(3, Math.trunc(value ?? 1)));
}

function escapedLikePattern(value: string): string {
  const escaped = value.toLowerCase().replace(/[!%_]/g, "!$&");
  return `%${escaped}%`;
}

function assertScope(input: RuntimeStructuralRetrievalInput): void {
  const projectId = input.projectId.trim();
  const studyId = input.studyId?.trim();
  const studySlug = input.studySlug?.trim();
  const legacyProjectSlug = input.legacyProjectSlug?.trim();
  const slugMatches =
    studySlug === projectId || legacyProjectSlug === projectId;

  for (const scope of [
    studySlug ? { label: "studySlug", value: studySlug } : null,
    legacyProjectSlug ? { label: "legacyProjectSlug", value: legacyProjectSlug } : null,
  ].filter((scope): scope is { label: string; value: string } => Boolean(scope))) {
    if (scope.value === projectId) continue;
    throw new RuntimeStructuralRetrievalScopeError(
      "Structural retrieval scope must match the active runtime project.",
      {
        projectId,
        requestedScope: scope.label,
        requestedValue: scope.value,
      },
    );
  }

  if (studyId && studyId !== projectId && !slugMatches) {
    throw new RuntimeStructuralRetrievalScopeError(
      "Structural retrieval Study id requires a matching active Study slug.",
      {
        projectId,
        requestedScope: "studyId",
        requestedValue: studyId,
      },
    );
  }
}

function projectMatchSql(alias: string): string {
  return `(
    ${alias}.frontmatter->>'study_slug' = $1
    OR ${alias}.frontmatter->>'study' = $1
    OR ${alias}.frontmatter->>'legacy_project_slug' = $1
    OR ${alias}.frontmatter->>'project' = $1
    OR ${alias}.frontmatter->>'study_id' = ('study_' || $1)
    OR ${arrayFieldContainsSql(alias, "studies")}
    OR ${arrayFieldContainsSql(alias, "study_slugs")}
    OR ${arrayFieldContainsSql(alias, "legacy_project_slugs")}
    OR ${arrayFieldContainsSql(alias, "projects")}
  )`;
}

function arrayFieldContainsSql(alias: string, field: string): string {
  return `EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(${alias}.frontmatter->'${field}') = 'array'
            THEN ${alias}.frontmatter->'${field}'
          ELSE '[]'::jsonb
        END
      ) AS study_slug(value)
      WHERE study_slug.value = $1
    )`;
}

function getQueryableDb(store: BrainStore): QueryableDb | null {
  const db = (store as unknown as { engine?: { db?: QueryableDb } }).engine?.db;
  return db && typeof db.query === "function" ? db : null;
}

function rowString(row: QueryResultRow, key: string): string | null {
  return cleanString(row[key]);
}

function rowNumber(row: QueryResultRow, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function buildRecord(input: {
  pageId: string;
  title: string;
  type: string;
  chunkId: string | null;
  chunkIndex: number | null;
  sourceId: string | null;
  symbolName: string | null;
  symbolType: string | null;
  qualifiedName: string | null;
  parentPath: string | null;
  incomingEdges: number | null;
  outgoingEdges: number | null;
  walkDepth: number;
  retrieval: "structural" | "keyword-fallback";
}): RuntimeStructuralRetrievalRecord {
  const stableIdentity = {
    pageId: input.pageId,
    chunkId: input.chunkId,
    chunkIndex: input.chunkIndex,
    sourceId: input.sourceId,
    qualifiedName: input.qualifiedName,
  };
  return {
    recordId: `retrieval_${compactHash(stableIdentity)}`,
    pageId: input.pageId,
    title: input.title,
    type: input.type,
    chunkId: input.chunkId,
    chunkIndex: input.chunkIndex,
    sourceId: input.sourceId,
    symbol: {
      name: input.symbolName,
      type: input.symbolType,
      qualifiedName: input.qualifiedName,
      parentPath: input.parentPath,
    },
    graph: {
      incomingEdges: input.incomingEdges,
      outgoingEdges: input.outgoingEdges,
      walkDepth: input.walkDepth,
    },
    provenance: {
      engine: "gbrain",
      resultHash: stableHash(stableIdentity),
      retrieval: input.retrieval,
    },
  };
}

function recordFromSearchResult(
  result: SearchResult,
  walkDepth: number,
): RuntimeStructuralRetrievalRecord {
  return buildRecord({
    pageId: result.path,
    title: result.title,
    type: result.type,
    chunkId: result.chunkId === undefined ? null : String(result.chunkId),
    chunkIndex: result.chunkIndex ?? null,
    sourceId: result.sourceId ?? null,
    symbolName: null,
    symbolType: null,
    qualifiedName: null,
    parentPath: null,
    incomingEdges: null,
    outgoingEdges: null,
    walkDepth,
    retrieval: "keyword-fallback",
  });
}

function pageMatchesProject(page: BrainPage | null, projectId: string): boolean {
  return Boolean(page && frontmatterMatchesStudy(page.frontmatter, projectId));
}

async function filterSearchResultsByRuntimeScope(input: {
  store: BrainStore;
  results: SearchResult[];
  projectId: string;
  pageIds: string[];
  sourceIds: string[];
}): Promise<SearchResult[]> {
  const scoped: SearchResult[] = [];
  for (const result of input.results) {
    if (input.pageIds.length > 0 && !input.pageIds.includes(result.path)) continue;
    if (
      input.sourceIds.length > 0
      && (!result.sourceId || !input.sourceIds.includes(result.sourceId))
    ) {
      continue;
    }
    const page = await input.store.getPage(result.path);
    if (!pageMatchesProject(page, input.projectId)) continue;
    scoped.push(result);
  }
  return scoped;
}

function resultEnvelope(input: {
  params: RuntimeStructuralRetrievalInput;
  capabilities: GbrainCapabilities;
  records: RuntimeStructuralRetrievalRecord[];
  degraded: boolean;
  limit: number;
  walkDepth: number;
  sourceIds: string[];
  pageIds: string[];
  nearSymbol: string | null;
}): RuntimeStructuralRetrievalResult {
  return {
    status: input.degraded ? "degraded" : "ok",
    degraded: input.degraded,
    records: input.records,
    provenance: {
      engine: "gbrain",
      projectId: input.params.projectId,
      studyId: input.params.studyId ?? null,
      studySlug: input.params.studySlug ?? input.params.legacyProjectSlug ?? null,
      runtimeSessionIdHash: compactHash(input.params.runtimeSessionId),
      hostId: input.params.hostId,
      capability: {
        structuralNavigationAvailable:
          input.capabilities.structuralNavigationAvailable,
        schemaVersion: input.capabilities.schema.observedVersion,
        chunkerVersion: input.capabilities.chunker.requiredVersion,
        blockers: [...input.capabilities.blockers],
      },
      queryHash: stableHash(input.params.query),
      filters: {
        sourceIds: input.sourceIds,
        pageIds: input.pageIds,
        nearSymbol: input.nearSymbol,
        walkDepth: input.walkDepth,
        limit: input.limit,
      },
    },
  };
}

async function queryStructuralRows(input: {
  db: QueryableDb;
  params: RuntimeStructuralRetrievalInput;
  sourceIds: string[];
  pageIds: string[];
  nearSymbol: string | null;
  limit: number;
  walkDepth: number;
}): Promise<RuntimeStructuralRetrievalRecord[]> {
  const queryPattern = escapedLikePattern(input.params.query);
  const rows = await input.db.query(
    `SELECT
       p.slug AS page_id,
       p.title AS page_title,
       p.type AS page_type,
       c.id AS chunk_id,
       c.chunk_index AS chunk_index,
       c.source_id AS source_id,
       c.symbol_name AS symbol_name,
       c.symbol_type AS symbol_type,
       c.symbol_name_qualified AS symbol_name_qualified,
       c.parent_symbol_path AS parent_symbol_path,
       COALESCE(in_edges.edge_count, 0) AS incoming_edges,
       COALESCE(out_edges.edge_count, 0) AS outgoing_edges
     FROM content_chunks c
     JOIN pages p ON p.id = c.page_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS edge_count
       FROM code_edges_chunk
       WHERE to_chunk_id = c.id
     ) in_edges ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS edge_count
       FROM code_edges_chunk
       WHERE from_chunk_id = c.id
     ) out_edges ON TRUE
     WHERE ${projectMatchSql("p")}
       AND (
         LOWER(p.title) LIKE $2 ESCAPE '!'
         OR LOWER(c.symbol_name) LIKE $2 ESCAPE '!'
         OR LOWER(c.symbol_name_qualified) LIKE $2 ESCAPE '!'
         OR LOWER(c.parent_symbol_path) LIKE $2 ESCAPE '!'
       )
       AND ($3::text[] IS NULL OR c.source_id = ANY($3::text[]))
       AND ($4::text[] IS NULL OR p.slug = ANY($4::text[]))
       AND ($5::text IS NULL OR c.symbol_name_qualified = $5 OR c.symbol_name = $5)
     ORDER BY
       CASE WHEN $5::text IS NOT NULL AND c.symbol_name_qualified = $5 THEN 0 ELSE 1 END,
       COALESCE(out_edges.edge_count, 0) DESC,
       p.slug ASC,
       c.chunk_index ASC
     LIMIT $6`,
    [
      input.params.projectId,
      queryPattern,
      input.sourceIds.length > 0 ? input.sourceIds : null,
      input.pageIds.length > 0 ? input.pageIds : null,
      input.nearSymbol,
      input.limit,
    ],
  );

  return rows.rows.map((row) => {
    const chunkId = rowNumber(row, "chunk_id");
    return buildRecord({
      pageId: rowString(row, "page_id") ?? "",
      title: rowString(row, "page_title") ?? "",
      type: rowString(row, "page_type") ?? "concept",
      chunkId: chunkId === null ? null : String(chunkId),
      chunkIndex: rowNumber(row, "chunk_index"),
      sourceId: rowString(row, "source_id"),
      symbolName: rowString(row, "symbol_name"),
      symbolType: rowString(row, "symbol_type"),
      qualifiedName: rowString(row, "symbol_name_qualified"),
      parentPath: rowString(row, "parent_symbol_path"),
      incomingEdges: rowNumber(row, "incoming_edges"),
      outgoingEdges: rowNumber(row, "outgoing_edges"),
      walkDepth: input.walkDepth,
      retrieval: "structural",
    });
  });
}

export function createRuntimeStructuralRetrievalHandler(
  deps: RuntimeStructuralRetrievalDeps = {},
) {
  return async function runtimeStructuralRetrieval(
    params: RuntimeStructuralRetrievalInput,
  ): Promise<RuntimeStructuralRetrievalResult> {
    assertScope(params);

    const limit = boundedLimit(params.limit);
    const walkDepth = boundedWalkDepth(params.walkDepth);
    const sourceIds = cleanStringArray(params.sourceIds);
    const pageIds = cleanStringArray(params.pageIds);
    const nearSymbol = cleanString(params.nearSymbol);
    const capabilities = await (deps.probeCapabilities ?? probeGbrainCapabilities)();
    const query = cleanString(params.query);

    if (!capabilities.structuralNavigationAvailable) {
      return resultEnvelope({
        params,
        capabilities,
        records: [],
        degraded: true,
        limit,
        walkDepth,
        sourceIds,
        pageIds,
        nearSymbol,
      });
    }

    if (!query) {
      return resultEnvelope({
        params,
        capabilities,
        records: [],
        degraded: false,
        limit,
        walkDepth,
        sourceIds,
        pageIds,
        nearSymbol,
      });
    }

    await (deps.ensureReady ?? ensureBrainStoreReady)();
    const store = (deps.getStore ?? getBrainStore)();
    const db = getQueryableDb(store);

    let records: RuntimeStructuralRetrievalRecord[] = [];
    if (db) {
      records = await queryStructuralRows({
        db,
        params: { ...params, query },
        sourceIds,
        pageIds,
        nearSymbol,
        limit,
        walkDepth,
      });
    }

    if (records.length === 0) {
      const fallback = await store.search({
        query,
        limit: limit * 4,
        detail: "low",
      });
      const scopedFallback = await filterSearchResultsByRuntimeScope({
        store,
        results: fallback,
        projectId: params.projectId,
        pageIds,
        sourceIds,
      });
      records = scopedFallback
        .map((record) => recordFromSearchResult(record, walkDepth));
    }

    return resultEnvelope({
      params,
      capabilities,
      records: records.slice(0, limit),
      degraded: false,
      limit,
      walkDepth,
      sourceIds,
      pageIds,
      nearSymbol,
    });
  };
}

export const runtimeStructuralRetrieval =
  createRuntimeStructuralRetrievalHandler();
