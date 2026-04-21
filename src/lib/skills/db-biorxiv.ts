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
  text,
  type AdapterOptions,
} from "./db-utils";

export interface DbBiorxivFetchArgs {
  id: string;
  server?: "biorxiv" | "medrxiv";
  project?: string;
}

export interface DbBiorxivSearchArgs {
  query: string;
  server?: "biorxiv" | "medrxiv";
  page?: number;
  page_size?: number;
  cursor?: string;
  project?: string;
}

interface BioRxivResponse {
  collection?: unknown[];
  messages?: Array<{ total?: string; status?: string }>;
}

export async function biorxivFetch(
  args: DbBiorxivFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchBiorxivEntity(args.id, args.server ?? "biorxiv");
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function biorxivSearch(
  args: DbBiorxivSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = clampPageSize(args.page_size);
  const server = args.server ?? "biorxiv";
  const { from, to, queryText } = parseDateWindow(args.query);
  const apiCursor = readCursor(args.cursor) ?? Math.max(0, ((args.page ?? 1) - 1) * 100);
  const response = await fetchExternalJson<BioRxivResponse>(
    "biorxiv",
    `https://api.biorxiv.org/details/${server}/${from}/${to}/${apiCursor}`,
  );
  const fetchedAt = new Date().toISOString();
  const rawEntities = (response.collection ?? [])
    .map((entry) => parseBiorxivRecord(entry, fetchedAt, server))
    .filter((entity): entity is DbEntity => Boolean(entity));
  const filtered = rawEntities
    .filter((entity) => {
      if (entity.type !== "paper") return false;
      if (!queryText) return true;
      const haystack = `${entity.payload.title} ${entity.payload.abstract ?? ""}`.toLowerCase();
      return haystack.includes(queryText.toLowerCase());
    })
    .slice(0, pageSize);
  const total = queryText ? filtered.length : Number(response.messages?.[0]?.total ?? filtered.length);
  const nextCursor = rawEntities.length >= 100 ? String(apiCursor + 100) : undefined;
  if (options.persist === false) {
    return { entities: filtered, total, cursor: nextCursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: server,
      query: args.query,
      filters: { server, page: args.page ?? 1, page_size: pageSize, from, to, cursor: args.cursor ?? "" },
      entities: filtered,
      total,
      cursor: nextCursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

function readCursor(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function fetchBiorxivEntity(
  doi: string,
  server: "biorxiv" | "medrxiv" = "biorxiv",
): Promise<DbEntity | null> {
  const normalized = normalizeDoi(doi);
  const response = await fetchExternalJson<BioRxivResponse>(
    "biorxiv",
    `https://api.biorxiv.org/details/${server}/${encodeURIComponent(normalized)}/na/json`,
  );
  return parseBiorxivRecord(response.collection?.[0], new Date().toISOString(), server);
}

export function parseBiorxivRecord(
  raw: unknown,
  fetchedAt: string,
  server: "biorxiv" | "medrxiv" = "biorxiv",
): DbEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const doi = text(record.doi, 200)?.toLowerCase();
  if (!doi) return null;
  const title = text(record.title, 500) ?? doi;
  const abstract = text(record.abstract, 5_000) ?? undefined;
  return {
    type: "paper",
    ids: compactRecord({ doi }),
    primary_id: { scheme: "doi", id: doi },
    source_db: [server],
    source_uri: `https://doi.org/${doi}`,
    fetched_at: fetchedAt,
    raw_summary: text(`${title}\n${abstract ?? ""}`, 10_000),
    payload: {
      title,
      authors: parseAuthors(text(record.authors, 2_000) ?? ""),
      venue: { name: server === "medrxiv" ? "medRxiv" : "bioRxiv", type: "preprint" },
      year: parseYear(record.date),
      abstract,
      retraction_status: inferLifecycle(record),
    },
  };
}

function parseDateWindow(query: string): { from: string; to: string; queryText: string } {
  const range = query.match(/(\d{4}-\d{2}-\d{2})\s*(?:\/|to|\.\.)\s*(\d{4}-\d{2}-\d{2})/i);
  if (range) return { from: range[1], to: range[2], queryText: query.replace(range[0], "").trim() };
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    queryText: query.trim(),
  };
}

function parseAuthors(value: string): Array<{ name: string }> {
  return value
    .split(/;|,\s+(?=[A-Z][A-Za-z-]+(?:\s|$))/)
    .map((entry) => text(entry, 200))
    .filter((name): name is string => Boolean(name))
    .map((name) => ({ name }));
}

function inferLifecycle(record: Record<string, unknown>): "active" | "retracted" | "concern" | "withdrawn" | null {
  const combined = `${String(record.title ?? "")} ${String(record.abstract ?? "")} ${String(record.type ?? "")}`.toLowerCase();
  if (combined.includes("withdrawn")) return "withdrawn";
  if (combined.includes("retract")) return "retracted";
  if (combined.includes("concern")) return "concern";
  return "active";
}
