import {
  fetchExternalJson,
  getRequiredDatabaseKey,
  persistEntity,
  persistSearchResult,
  type DbEntity,
} from "./db-base";
import {
  clampPageSize,
  compactRecord,
  normalizeDoi,
  parseYear,
  readArray,
  readRecord,
  readString,
  text,
  type AdapterOptions,
} from "./db-utils";

export interface DbSemanticScholarFetchArgs {
  id: string;
  project?: string;
}

export interface DbSemanticScholarSearchArgs {
  query: string;
  page?: number;
  page_size?: number;
  project?: string;
}

interface SemanticScholarSearchResponse {
  total?: number;
  token?: string;
  next?: number;
  data?: unknown[];
}

const FIELDS = [
  "paperId",
  "externalIds",
  "url",
  "title",
  "abstract",
  "year",
  "venue",
  "publicationTypes",
  "isOpenAccess",
  "authors",
].join(",");

export async function semanticScholarFetch(
  args: DbSemanticScholarFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchSemanticScholarEntity(args.id);
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function semanticScholarSearch(
  args: DbSemanticScholarSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = clampPageSize(args.page_size);
  const params = new URLSearchParams({
    query: args.query,
    limit: String(pageSize),
    offset: String(Math.max(0, ((args.page ?? 1) - 1) * pageSize)),
    fields: FIELDS,
  });
  const response = await fetchExternalJson<SemanticScholarSearchResponse>(
    "semantic_scholar",
    `https://api.semanticscholar.org/graph/v1/paper/search?${params}`,
    { headers: authHeaders() },
  );
  const fetchedAt = new Date().toISOString();
  const entities = (response.data ?? [])
    .map((entry) => parseSemanticScholarPaper(readRecord(entry), fetchedAt))
    .filter((entity): entity is DbEntity => Boolean(entity));
  const total = response.total ?? entities.length;
  const cursor = response.next != null ? String(response.next) : undefined;
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "semantic_scholar",
      query: args.query,
      filters: { page: args.page ?? 1, page_size: pageSize },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchSemanticScholarEntity(id: string): Promise<DbEntity | null> {
  const params = new URLSearchParams({ fields: FIELDS });
  const response = await fetchExternalJson<Record<string, unknown>>(
    "semantic_scholar",
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?${params}`,
    { headers: authHeaders() },
  );
  return parseSemanticScholarPaper(response, new Date().toISOString());
}

export function parseSemanticScholarPaper(raw: Record<string, unknown>, fetchedAt: string): DbEntity | null {
  const paperId = readString(raw.paperId);
  if (!paperId) return null;
  const externalIds = readRecord(raw.externalIds);
  const doi = readString(externalIds.DOI)?.toLowerCase();
  const arxiv = readString(externalIds.ArXiv);
  const pmid = readString(externalIds.PubMed);
  const title = text(raw.title, 500) ?? paperId;
  const abstract = text(raw.abstract, 5_000) ?? undefined;
  return {
    type: "paper",
    ids: compactRecord({
      semantic_scholar: paperId,
      doi: doi ? normalizeDoi(doi) : undefined,
      arxiv,
      pmid,
    }),
    primary_id: doi
      ? { scheme: "doi", id: normalizeDoi(doi) }
      : { scheme: "semantic_scholar", id: paperId },
    source_db: ["semantic_scholar"],
    source_uri: readString(raw.url) ?? `https://www.semanticscholar.org/paper/${paperId}`,
    fetched_at: fetchedAt,
    raw_summary: text(`${title}\n${abstract ?? ""}`, 10_000),
    payload: {
      title,
      authors: readArray(raw.authors)
        .map((entry) => {
          const author = readRecord(entry);
          const name = text(author.name, 200);
          return name ? { name } : null;
        })
        .filter((author): author is { name: string } => Boolean(author)),
      venue: { name: text(raw.venue, 500) ?? "Semantic Scholar", type: "scholarly" },
      year: parseYear(raw.year),
      abstract,
      retraction_status: inferLifecycle(raw),
    },
  };
}

function authHeaders(): Record<string, string> {
  return { "x-api-key": getRequiredDatabaseKey("SEMANTIC_SCHOLAR_API_KEY") };
}

function inferLifecycle(raw: Record<string, unknown>): "active" | "retracted" | "concern" | "withdrawn" | null {
  const combined = `${String(raw.title ?? "")} ${readStringArrayish(raw.publicationTypes).join(" ")}`.toLowerCase();
  if (combined.includes("retract")) return "retracted";
  if (combined.includes("withdrawn")) return "withdrawn";
  if (combined.includes("concern")) return "concern";
  return "active";
}

function readStringArrayish(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
