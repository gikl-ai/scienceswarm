import {
  fetchExternalJson,
  fetchExternalText,
  persistEntity,
  persistSearchResult,
  type DbEntity,
} from "./db-base";
import {
  clampPageSize,
  compactRecord,
  readArray,
  readRecord,
  readString,
  text,
  type AdapterOptions,
} from "./db-utils";

export interface DbUniprotFetchArgs {
  id: string;
  project?: string;
}

export interface DbUniprotSearchArgs {
  query: string;
  page_token?: string;
  page_size?: number;
  project?: string;
}

interface UniprotSearchResponse {
  results?: unknown[];
}

const SEARCH_FIELDS = [
  "accession",
  "id",
  "protein_name",
  "gene_names",
  "organism_name",
  "reviewed",
  "cc_function",
].join(",");

export async function uniprotFetch(
  args: DbUniprotFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchUniprotEntity(args.id);
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function uniprotSearch(
  args: DbUniprotSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = clampPageSize(args.page_size);
  const params = new URLSearchParams({
    query: args.query,
    size: String(pageSize),
    fields: SEARCH_FIELDS,
    format: "json",
  });
  const pageToken = normalizePageToken(args.page_token);
  if (pageToken) params.set("cursor", pageToken);
  const response = await fetchExternalText(
    "uniprot",
    `https://rest.uniprot.org/uniprotkb/search?${params}`,
  );
  const body = JSON.parse(response.text) as UniprotSearchResponse;
  const fetchedAt = new Date().toISOString();
  const entities = (body.results ?? [])
    .map((entry) => parseUniprotRecord(readRecord(entry), fetchedAt))
    .filter((entity): entity is DbEntity => Boolean(entity));
  const total = readUniprotTotal(response.headers) ?? entities.length;
  const cursor = readNextUniprotCursor(response.headers);
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "uniprot",
      query: args.query,
      filters: { page_size: pageSize, page_token: pageToken ?? "" },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchUniprotEntity(id: string): Promise<DbEntity | null> {
  const accession = id.trim();
  const response = await fetchExternalJson<Record<string, unknown>>(
    "uniprot",
    `https://rest.uniprot.org/uniprotkb/${encodeURIComponent(accession)}.json`,
  );
  return parseUniprotRecord(response, new Date().toISOString());
}

function normalizePageToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).searchParams.get("cursor") ?? trimmed;
  } catch {
    return trimmed;
  }
}

function readUniprotTotal(headers: Headers): number | undefined {
  const rawTotal = headers.get("x-total-results");
  if (!rawTotal) return undefined;
  const total = Number(rawTotal);
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}

function readNextUniprotCursor(headers: Headers): string | undefined {
  const link = headers.get("link");
  if (!link) return undefined;
  for (const part of splitLinkHeader(link)) {
    if (!/;\s*rel="?next"?/i.test(part)) continue;
    const urlMatch = part.match(/<([^>]+)>/);
    if (!urlMatch) continue;
    try {
      return new URL(urlMatch[1]).searchParams.get("cursor") ?? undefined;
    } catch {
      const cursorMatch = urlMatch[1].match(/[?&]cursor=([^&]+)/);
      return cursorMatch ? decodeCursor(cursorMatch[1]) : undefined;
    }
  }
  return undefined;
}

function splitLinkHeader(link: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inAngleBrackets = false;
  for (let index = 0; index < link.length; index += 1) {
    const character = link[index];
    if (character === "<") inAngleBrackets = true;
    if (character === ">") inAngleBrackets = false;
    if (character === "," && !inAngleBrackets) {
      parts.push(link.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(link.slice(start).trim());
  return parts.filter(Boolean);
}

function decodeCursor(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseUniprotRecord(
  raw: Record<string, unknown>,
  fetchedAt: string,
): DbEntity | null {
  const accession = text(raw.primaryAccession ?? raw.accession, 100);
  if (!accession) return null;
  const proteinDescription = readRecord(raw.proteinDescription);
  const recommendedName = readRecord(proteinDescription.recommendedName);
  const submittedName = readRecord(readArray(proteinDescription.submissionNames)[0]);
  const name = text(
    readRecord(recommendedName.fullName).value
      ?? readRecord(submittedName.fullName).value
      ?? raw.uniProtkbId
      ?? accession,
    500,
  ) ?? accession;
  const organism = text(readRecord(raw.organism).scientificName, 500) ?? "unknown organism";
  return {
    type: "protein",
    ids: compactRecord({ uniprot: accession }),
    primary_id: { scheme: "uniprot", id: accession },
    source_db: ["uniprot"],
    source_uri: `https://www.uniprot.org/uniprotkb/${accession}/entry`,
    fetched_at: fetchedAt,
    raw_summary: text(`${name}\n${organism}`, 10_000),
    payload: {
      recommended_name: name,
      organism,
      reviewed: isReviewed(raw),
      status: inferUniprotStatus(raw),
      genes: readArray(raw.genes)
        .map((entry) => text(readRecord(readRecord(entry).geneName).value, 200))
        .filter((gene): gene is string => Boolean(gene)),
    },
  };
}

function isReviewed(raw: Record<string, unknown>): boolean {
  const entryType = readString(raw.entryType)?.toLowerCase() ?? "";
  return entryType.includes("reviewed") && !entryType.includes("unreviewed");
}

function inferUniprotStatus(raw: Record<string, unknown>): "active" | "deprecated" | "unknown" {
  if (raw.inactiveReason || String(raw.entryType ?? "").toLowerCase().includes("inactive")) {
    return "deprecated";
  }
  return readString(raw.primaryAccession ?? raw.accession) ? "active" : "unknown";
}
