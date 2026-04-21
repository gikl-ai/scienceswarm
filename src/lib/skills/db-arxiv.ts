import {
  fetchExternalText,
  persistEntity,
  persistSearchResult,
  type DbEntity,
} from "./db-base";
import {
  clampPageSize,
  compactRecord,
  parseYear,
  text,
  type AdapterOptions,
} from "./db-utils";

export interface DbArxivFetchArgs {
  id: string;
  project?: string;
}

export interface DbArxivSearchArgs {
  query: string;
  page?: number;
  page_size?: number;
  sort?: "relevance" | "date_desc" | "date_asc";
  project?: string;
}

export async function arxivFetch(
  args: DbArxivFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchArxivEntity(args.id);
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function arxivSearch(
  args: DbArxivSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = clampPageSize(args.page_size);
  const start = Math.max(0, ((args.page ?? 1) - 1) * pageSize);
  const sortBy = args.sort === "date_asc" || args.sort === "date_desc" ? "submittedDate" : "relevance";
  const sortOrder = args.sort === "date_asc" ? "ascending" : "descending";
  const params = new URLSearchParams({
    search_query: `all:${args.query}`,
    start: String(start),
    max_results: String(pageSize),
    sortBy,
    sortOrder,
  });
  const response = await fetchExternalText("arxiv", `https://export.arxiv.org/api/query?${params}`);
  const entities = parseArxivFeedXml(response.text, new Date().toISOString());
  const total = Number(firstTagText(response.text, "opensearch:totalResults") ?? entities.length);
  const cursor = entities.length === pageSize ? String(start + pageSize) : undefined;
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "arxiv",
      query: args.query,
      filters: { page: args.page ?? 1, page_size: pageSize, sort: args.sort ?? "relevance" },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchArxivEntity(id: string): Promise<DbEntity | null> {
  const arxivId = normalizeArxivId(id);
  const params = new URLSearchParams({ id_list: arxivId, max_results: "1" });
  const response = await fetchExternalText("arxiv", `https://export.arxiv.org/api/query?${params}`);
  return parseArxivFeedXml(response.text, new Date().toISOString())[0] ?? null;
}

export function parseArxivFeedXml(xml: string, fetchedAt: string): DbEntity[] {
  return allMatches(xml, /<entry\b[\s\S]*?<\/entry>/gi)
    .map((match) => parseArxivEntryXml(match[0], fetchedAt))
    .filter((entity): entity is DbEntity => Boolean(entity));
}

export function parseArxivEntryXml(entry: string, fetchedAt: string): DbEntity | null {
  const idUri = firstTagText(entry, "id");
  const arxivId = normalizeArxivId(idUri ?? "");
  if (!arxivId) return null;
  const title = text(firstTagText(entry, "title"), 500) ?? `arXiv ${arxivId}`;
  const abstract = text(firstTagText(entry, "summary"), 5_000) ?? undefined;
  const doi = text(firstTagText(entry, "arxiv:doi"), 200)?.toLowerCase();
  const ids = compactRecord({ arxiv: arxivId, doi });
  return {
    type: "paper",
    ids,
    primary_id: ids.doi
      ? { scheme: "doi", id: ids.doi }
      : { scheme: "arxiv", id: arxivId },
    source_db: ["arxiv"],
    source_uri: `https://arxiv.org/abs/${arxivId}`,
    fetched_at: fetchedAt,
    raw_summary: text(`${title}\n${abstract ?? ""}`, 10_000),
    payload: {
      title,
      authors: allMatches(entry, /<author\b[\s\S]*?<\/author>/gi)
        .map((match) => text(firstTagText(match[0], "name"), 200))
        .filter((name): name is string => Boolean(name))
        .map((name) => ({ name })),
      venue: { name: "arXiv", type: "preprint" },
      year: parseYear(firstTagText(entry, "published")),
      abstract,
      retraction_status: "active",
    },
  };
}

function normalizeArxivId(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/abs\//i, "")
    .replace(/^arxiv:/i, "");
}

function firstTagText(xml: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? decodeXml(match[1]).trim() : null;
}

function allMatches(value: string, regex: RegExp): RegExpMatchArray[] {
  return Array.from(value.matchAll(regex));
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
