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

export interface DbCrossrefFetchArgs {
  id: string;
  project?: string;
}

export interface DbCrossrefSearchArgs {
  query: string;
  page?: number;
  page_size?: number;
  sort?: "relevance" | "date_desc" | "date_asc";
  project?: string;
}

interface CrossrefResponse {
  message?: Record<string, unknown>;
}

export async function crossrefFetch(
  args: DbCrossrefFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchCrossrefEntity(args.id);
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function crossrefSearch(
  args: DbCrossrefSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = clampPageSize(args.page_size);
  const page = Math.max(1, args.page ?? 1);
  const params = new URLSearchParams({
    query: args.query,
    rows: String(pageSize),
    offset: String((page - 1) * pageSize),
  });
  if (args.sort === "date_desc" || args.sort === "date_asc") {
    params.set("sort", "published");
    params.set("order", args.sort === "date_asc" ? "asc" : "desc");
  }
  appendMailto(params);
  const response = await fetchExternalJson<CrossrefResponse>(
    "crossref",
    `https://api.crossref.org/works?${params}`,
  );
  const fetchedAt = new Date().toISOString();
  const message = readRecord(response.message);
  const entities = readArray(message.items)
    .map((item) => parseCrossrefWork(readRecord(item), fetchedAt))
    .filter((entity): entity is DbEntity => Boolean(entity));
  const total = typeof message["total-results"] === "number"
    ? message["total-results"]
    : entities.length;
  const cursor = entities.length === pageSize ? String(page + 1) : undefined;
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "crossref",
      query: args.query,
      filters: { page, page_size: pageSize, sort: args.sort ?? "relevance" },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchCrossrefEntity(doi: string): Promise<DbEntity | null> {
  const normalized = normalizeDoi(doi);
  const params = new URLSearchParams();
  appendMailto(params);
  const suffix = params.size > 0 ? `?${params}` : "";
  const response = await fetchExternalJson<CrossrefResponse>(
    "crossref",
    `https://api.crossref.org/works/${encodeURIComponent(normalized)}${suffix}`,
  );
  return parseCrossrefWork(readRecord(response.message), new Date().toISOString());
}

export function parseCrossrefWork(work: Record<string, unknown>, fetchedAt: string): DbEntity | null {
  const doi = text(work.DOI, 200)?.toLowerCase();
  if (!doi) return null;
  const title = text(readArray(work.title)[0], 500) ?? doi;
  const abstract = text(work.abstract, 5_000) ?? undefined;
  return {
    type: "paper",
    ids: compactRecord({ doi }),
    primary_id: { scheme: "doi", id: doi },
    source_db: ["crossref"],
    source_uri: readString(work.URL) ?? `https://doi.org/${doi}`,
    fetched_at: fetchedAt,
    raw_summary: text(`${title}\n${abstract ?? ""}`, 10_000),
    payload: {
      title,
      authors: readArray(work.author)
        .map((entry) => {
          const author = readRecord(entry);
          const name = text(
            [author.given, author.family].filter(Boolean).join(" ") || author.name,
            200,
          );
          return name ? { name } : null;
        })
        .filter((author): author is { name: string } => Boolean(author)),
      venue: {
        name: text(readArray(work["container-title"])[0], 500) ?? "Crossref",
        type: readString(work.type) ?? "publication",
      },
      year: parseCrossrefYear(work),
      abstract,
      retraction_status: inferCrossrefLifecycle(work),
    },
  };
}

function appendMailto(params: URLSearchParams): void {
  const mailto = process.env.CROSSREF_MAILTO?.trim();
  if (mailto) params.set("mailto", mailto);
}

function parseCrossrefYear(work: Record<string, unknown>): number | null {
  for (const key of ["published-print", "published-online", "published", "created"]) {
    const dateParts = readArray(readRecord(work[key])["date-parts"])[0];
    const year = Array.isArray(dateParts) ? parseYear(dateParts[0]) : null;
    if (year) return year;
  }
  return null;
}

function inferCrossrefLifecycle(work: Record<string, unknown>): "active" | "retracted" | "concern" | "withdrawn" | null {
  const subtype = String(work.subtype ?? work.type ?? "").toLowerCase();
  const title = String(readArray(work.title)[0] ?? "").toLowerCase();
  if (subtype.includes("retraction") || title.includes("retraction")) return "retracted";
  if (title.includes("withdrawn")) return "withdrawn";
  if (title.includes("expression of concern")) return "concern";
  return "active";
}
