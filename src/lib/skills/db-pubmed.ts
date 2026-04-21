import {
  fetchExternalJson,
  fetchExternalText,
  persistEntity,
  persistSearchResult,
  sanitizeExternalText,
  type DbEntity,
  type PersistOptions,
} from "./db-base";

export interface DbPubmedFetchArgs {
  id: string;
  scheme?: "pmid" | "doi";
  project?: string;
}

export interface DbPubmedSearchArgs {
  query: string;
  page?: number;
  page_size?: number;
  sort?: "relevance" | "date_desc" | "date_asc";
  project?: string;
}

interface AdapterOptions extends PersistOptions {
  persist?: boolean;
}

interface ESearchResponse {
  esearchresult?: {
    count?: string;
    retstart?: string;
    retmax?: string;
    idlist?: string[];
    webenv?: string;
    querykey?: string;
  };
}

interface ESummaryResponse {
  result?: {
    uids?: string[];
    [pmid: string]: unknown;
  };
}

export async function pubmedFetch(
  args: DbPubmedFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchPubmedEntity(args);
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function pubmedSearch(
  args: DbPubmedSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = clampPageSize(args.page_size);
  const retstart = Math.max(0, ((args.page ?? 1) - 1) * pageSize);
  const sort = args.sort === "date_asc"
    ? "pub+date"
    : args.sort === "date_desc"
      ? "pub+date"
      : "relevance";
  const params = new URLSearchParams({
    db: "pubmed",
    term: args.query,
    retmode: "json",
    retmax: String(pageSize),
    retstart: String(retstart),
    sort,
  });
  appendNcbiApiKey(params);
  const search = await fetchExternalJson<ESearchResponse>(
    "pubmed",
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`,
  );
  const ids = search.esearchresult?.idlist ?? [];
  const entities = ids.length > 0 ? await fetchPubmedSummaries(ids) : [];
  const total = Number(search.esearchresult?.count ?? entities.length);
  const cursor = ids.length === pageSize ? String(retstart + pageSize) : undefined;
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "pubmed",
      query: args.query,
      filters: { page: args.page ?? 1, page_size: pageSize, sort },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchPubmedEntity(
  args: DbPubmedFetchArgs,
): Promise<DbEntity | null> {
  const scheme = args.scheme ?? inferScheme(args.id);
  const pmid = scheme === "pmid" ? args.id.trim() : await resolvePmidFromDoi(args.id.trim());
  if (!pmid) return null;
  const params = new URLSearchParams({
    db: "pubmed",
    id: pmid,
    retmode: "xml",
  });
  appendNcbiApiKey(params);
  const result = await fetchExternalText(
    "pubmed",
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${params}`,
  );
  return parsePubmedArticleXml(result.text, {
    sourceUri: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    fetchedAt: new Date().toISOString(),
  });
}

export function parsePubmedArticleXml(
  xml: string,
  context: { sourceUri: string; fetchedAt: string },
): DbEntity | null {
  const article = firstMatch(xml, /<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/i) ?? xml;
  const pmid = tagText(article, "PMID");
  if (!pmid) return null;
  const articleIds = allMatches(article, /<ArticleId\b([^>]*)>([\s\S]*?)<\/ArticleId>/gi);
  const doi = articleIds.find((match) => /IdType=["']doi["']/i.test(match[1]))?.[2]?.trim();
  const title = sanitizeExternalText(tagText(article, "ArticleTitle"), { maxLength: 500 }) ?? `PubMed ${pmid}`;
  const abstract = sanitizeExternalText(
    allTagText(article, "AbstractText").join("\n"),
    { maxLength: 5_000 },
  ) ?? undefined;
  const journal = sanitizeExternalText(tagText(article, "Title"), { maxLength: 500 }) ?? "PubMed";
  const publicationTypes = allTagText(article, "PublicationType").map((value) => value.toLowerCase());
  const retractionStatus = inferRetractionStatus(`${title}\n${publicationTypes.join("\n")}`);
  const ids = compactRecord({
    pmid,
    doi: doi ? normalizeDoi(doi) : undefined,
  });
  const primary = ids.doi
    ? { scheme: "doi", id: ids.doi }
    : { scheme: "pmid", id: pmid };
  return {
    type: "paper",
    ids,
    primary_id: primary,
    source_db: ["pubmed"],
    source_uri: context.sourceUri,
    fetched_at: context.fetchedAt,
    raw_summary: sanitizeExternalText(`${title}\n${abstract ?? ""}`, { maxLength: 10_000 }),
    payload: {
      title,
      authors: parseAuthors(article),
      venue: { name: journal, type: "journal" },
      year: parseYear(article),
      abstract,
      retraction_status: retractionStatus,
    },
  };
}

function parseAuthors(article: string): Array<{ name: string; orcid?: string }> {
  return allMatches(article, /<Author\b[\s\S]*?<\/Author>/gi)
    .map((match) => {
      const block = match[0];
      const collective = tagText(block, "CollectiveName");
      if (collective) return { name: collective };
      const foreName = tagText(block, "ForeName") ?? tagText(block, "Initials") ?? "";
      const lastName = tagText(block, "LastName") ?? "";
      const name = sanitizeExternalText(`${foreName} ${lastName}`.trim(), { maxLength: 200 });
      return name ? { name } : null;
    })
    .filter((author): author is { name: string } => Boolean(author));
}

async function resolvePmidFromDoi(doi: string): Promise<string | null> {
  const params = new URLSearchParams({
    db: "pubmed",
    term: `${normalizeDoi(doi)}[doi]`,
    retmode: "json",
    retmax: "1",
  });
  appendNcbiApiKey(params);
  const result = await fetchExternalJson<ESearchResponse>(
    "pubmed",
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`,
  );
  return result.esearchresult?.idlist?.[0] ?? null;
}

async function fetchPubmedSummaries(ids: string[]): Promise<DbEntity[]> {
  const params = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "json",
  });
  appendNcbiApiKey(params);
  const result = await fetchExternalJson<ESummaryResponse>(
    "pubmed",
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params}`,
  );
  const fetchedAt = new Date().toISOString();
  return (result.result?.uids ?? ids)
    .map((pmid) => summaryToEntity(pmid, readRecord(result.result?.[pmid]), fetchedAt))
    .filter((entity): entity is DbEntity => Boolean(entity));
}

function summaryToEntity(
  pmid: string,
  summary: Record<string, unknown>,
  fetchedAt: string,
): DbEntity | null {
  const title = sanitizeExternalText(summary.title, { maxLength: 500 }) ?? `PubMed ${pmid}`;
  return {
    type: "paper",
    ids: { pmid },
    primary_id: { scheme: "pmid", id: pmid },
    source_db: ["pubmed"],
    source_uri: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    fetched_at: fetchedAt,
    raw_summary: title,
    payload: {
      title,
      authors: readAuthorNames(summary.authors),
      venue: {
        name: sanitizeExternalText(summary.fulljournalname ?? summary.source, { maxLength: 500 }) ?? "PubMed",
        type: "journal",
      },
      year: parseYearFromPubDate(String(summary.pubdate ?? "")),
      abstract: undefined,
      retraction_status: inferRetractionStatus(title),
    },
  };
}

function appendNcbiApiKey(params: URLSearchParams): void {
  const apiKey = process.env.NCBI_API_KEY?.trim();
  if (apiKey) params.set("api_key", apiKey);
}

function inferScheme(id: string): "pmid" | "doi" {
  return /^\d+$/.test(id.trim()) ? "pmid" : "doi";
}

function normalizeDoi(doi: string): string {
  return doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
}

function parseYear(article: string): number | null {
  return parseYearFromPubDate(tagText(article, "Year") ?? tagText(article, "MedlineDate") ?? "");
}

function parseYearFromPubDate(value: string): number | null {
  const match = value.match(/\b(18|19|20|21)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function inferRetractionStatus(value: string): "active" | "retracted" | "concern" | "withdrawn" | null {
  const lower = value.toLowerCase();
  if (lower.includes("retracted publication") || lower.includes("retraction of")) return "retracted";
  if (lower.includes("expression of concern")) return "concern";
  if (lower.includes("withdrawn")) return "withdrawn";
  return "active";
}

function readAuthorNames(value: unknown): Array<{ name: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readRecord(entry).name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => ({ name }));
}

function allTagText(xml: string, tag: string): string[] {
  return allMatches(xml, new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean);
}

function tagText(xml: string, tag: string): string | null {
  return allTagText(xml, tag)[0] ?? null;
}

function firstMatch(value: string, regex: RegExp): string | null {
  return value.match(regex)?.[0] ?? null;
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

function compactRecord(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function clampPageSize(value: number | undefined): number {
  return Math.min(200, Math.max(1, value ?? 25));
}
