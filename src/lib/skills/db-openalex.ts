import {
  fetchExternalJson,
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

export interface DbOpenAlexFetchArgs {
  id: string;
  entity_type?: "paper" | "person";
  project?: string;
}

export interface DbOpenAlexSearchArgs {
  query: string;
  entity_type?: "paper" | "person";
  page?: number;
  page_size?: number;
  project?: string;
}

interface OpenAlexListResponse {
  results?: unknown[];
  meta?: { count?: number; next_cursor?: string };
}

export async function openalexFetch(
  args: DbOpenAlexFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchOpenAlexEntity(args.id, args.entity_type ?? inferEntityType(args.id));
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function openalexSearch(
  args: DbOpenAlexSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = clampPageSize(args.page_size);
  const page = Math.max(1, args.page ?? 1);
  const entityType = args.entity_type ?? "paper";
  const endpoint = entityType === "person" ? "authors" : "works";
  const params = new URLSearchParams({
    search: args.query,
    "per-page": String(pageSize),
    page: String(page),
  });
  appendMailto(params);
  const response = await fetchExternalJson<OpenAlexListResponse>(
    "openalex",
    `https://api.openalex.org/${endpoint}?${params}`,
  );
  const fetchedAt = new Date().toISOString();
  const entities = (response.results ?? [])
    .map((entry) => entityType === "person"
      ? parseOpenAlexAuthor(readRecord(entry), fetchedAt)
      : parseOpenAlexWork(readRecord(entry), fetchedAt))
    .filter((entity): entity is DbEntity => Boolean(entity));
  const total = response.meta?.count ?? entities.length;
  const cursor = page * pageSize < total ? String(page + 1) : undefined;
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "openalex",
      query: args.query,
      filters: { entity_type: entityType, page, page_size: pageSize },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchOpenAlexEntity(id: string, entityType: "paper" | "person" = "paper"): Promise<DbEntity | null> {
  const endpoint = entityType === "person" ? "authors" : "works";
  const params = new URLSearchParams();
  appendMailto(params);
  const suffix = params.size > 0 ? `?${params}` : "";
  const response = await fetchExternalJson<Record<string, unknown>>(
    "openalex",
    `https://api.openalex.org/${endpoint}/${encodeURIComponent(openAlexApiId(id))}${suffix}`,
  );
  return entityType === "person"
    ? parseOpenAlexAuthor(response, new Date().toISOString())
    : parseOpenAlexWork(response, new Date().toISOString());
}

export function parseOpenAlexWork(work: Record<string, unknown>, fetchedAt: string): DbEntity | null {
  const openAlexId = readString(work.id);
  if (!openAlexId) return null;
  const doi = readString(work.doi)?.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
  const title = text(work.display_name ?? work.title, 500) ?? openAlexId;
  const abstract = text(abstractFromInvertedIndex(readRecord(work.abstract_inverted_index)), 5_000) ?? undefined;
  const primaryLocation = readRecord(work.primary_location);
  const source = readRecord(primaryLocation.source);
  const hostVenue = readRecord(work.host_venue);
  return {
    type: "paper",
    ids: compactRecord({
      openalex: openAlexId,
      doi: doi ? normalizeDoi(doi) : undefined,
    }),
    primary_id: doi
      ? { scheme: "doi", id: normalizeDoi(doi) }
      : { scheme: "openalex", id: openAlexId },
    source_db: ["openalex"],
    source_uri: openAlexId,
    fetched_at: fetchedAt,
    raw_summary: text(`${title}\n${abstract ?? ""}`, 10_000),
    payload: {
      title,
      authors: readArray(work.authorships)
        .map((entry) => {
          const author = readRecord(readRecord(entry).author);
          const name = text(author.display_name, 200);
          const orcid = readString(author.orcid)?.replace(/^https?:\/\/orcid\.org\//i, "");
          return name ? (orcid ? { name, orcid } : { name }) : null;
        })
        .filter((author): author is { name: string; orcid?: string } => Boolean(author)),
      venue: {
        name: text(source.display_name ?? hostVenue.display_name, 500) ?? "OpenAlex",
        type: readString(work.type) ?? "work",
      },
      year: parseYear(work.publication_year),
      abstract,
      retraction_status: work.is_retracted === true ? "retracted" : "active",
    },
  };
}

export function parseOpenAlexAuthor(author: Record<string, unknown>, fetchedAt: string): DbEntity | null {
  const openAlexId = readString(author.id);
  const name = text(author.display_name, 500);
  if (!openAlexId || !name) return null;
  const orcid = readString(author.orcid)?.replace(/^https?:\/\/orcid\.org\//i, "");
  return {
    type: "person",
    ids: compactRecord({ openalex_author: openAlexId, orcid }),
    primary_id: orcid
      ? { scheme: "orcid", id: orcid }
      : { scheme: "openalex_author", id: openAlexId },
    source_db: ["openalex"],
    source_uri: openAlexId,
    fetched_at: fetchedAt,
    raw_summary: name,
    payload: {
      name,
      orcid: orcid ?? undefined,
      affiliations: readArray(author.last_known_institutions)
        .map((entry) => text(readRecord(entry).display_name, 500))
        .filter((entry): entry is string => Boolean(entry)),
      works_count: typeof author.works_count === "number" ? author.works_count : null,
    },
  };
}

function appendMailto(params: URLSearchParams): void {
  const mailto = process.env.OPENALEX_MAILTO?.trim();
  if (mailto) params.set("mailto", mailto);
}

function inferEntityType(id: string): "paper" | "person" {
  return /\/authors\/|openalex\.org\/A\d+|^A\d+/i.test(id) ? "person" : "paper";
}

function openAlexApiId(id: string): string {
  const trimmed = id.trim();
  const match = trimmed.match(/(?:api\.)?openalex\.org\/(?:works\/|authors\/)?([WA]\d+)/i)
    ?? trimmed.match(/^\/?(?:works|authors)\/([WA]\d+)/i);
  return match?.[1] ?? trimmed;
}

function abstractFromInvertedIndex(index: Record<string, unknown>): string | null {
  const entries: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === "number") entries.push([position, word]);
    }
  }
  if (entries.length === 0) return null;
  return entries.sort((a, b) => a[0] - b[0]).map((entry) => entry[1]).join(" ");
}
