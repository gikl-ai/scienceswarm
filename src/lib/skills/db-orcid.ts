import {
  fetchExternalJson,
  persistEntity,
  persistSearchResult,
  type DbEntity,
} from "./db-base";
import {
  clampPageSize,
  compactRecord,
  readArray,
  readRecord,
  text,
  type AdapterOptions,
} from "./db-utils";

export interface DbOrcidFetchArgs {
  id: string;
  project?: string;
}

export interface DbOrcidSearchArgs {
  query: string;
  page?: number;
  page_size?: number;
  project?: string;
}

interface OrcidSearchResponse {
  "expanded-result"?: unknown[];
  "num-found"?: number;
}

const ORCID_HEADERS = { accept: "application/json" };

export async function orcidFetch(
  args: DbOrcidFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchOrcidEntity(args.id);
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function orcidSearch(
  args: DbOrcidSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = clampPageSize(args.page_size);
  const start = Math.max(0, ((args.page ?? 1) - 1) * pageSize);
  const params = new URLSearchParams({
    q: args.query,
    start: String(start),
    rows: String(pageSize),
  });
  const response = await fetchExternalJson<OrcidSearchResponse>(
    "orcid",
    `https://pub.orcid.org/v3.0/expanded-search/?${params}`,
    { headers: ORCID_HEADERS },
  );
  const fetchedAt = new Date().toISOString();
  const entities = (response["expanded-result"] ?? [])
    .map((entry) => parseOrcidSearchResult(readRecord(entry), fetchedAt))
    .filter((entity): entity is DbEntity => Boolean(entity));
  const total = response["num-found"] ?? entities.length;
  const cursor = start + entities.length < total ? String(start + pageSize) : undefined;
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "orcid",
      query: args.query,
      filters: { page: args.page ?? 1, page_size: pageSize },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchOrcidEntity(id: string): Promise<DbEntity | null> {
  const orcid = normalizeOrcid(id);
  const response = await fetchExternalJson<Record<string, unknown>>(
    "orcid",
    `https://pub.orcid.org/v3.0/${encodeURIComponent(orcid)}/record`,
    { headers: ORCID_HEADERS },
  );
  return parseOrcidRecord(response, new Date().toISOString());
}

export function parseOrcidRecord(
  raw: Record<string, unknown>,
  fetchedAt: string,
): DbEntity | null {
  const identifier = readRecord(raw["orcid-identifier"]);
  const orcid = normalizeOrcid(text(identifier.path ?? identifier.uri, 100) ?? "");
  const person = readRecord(raw.person);
  const nameRecord = readRecord(person.name);
  const given = text(readRecord(nameRecord["given-names"]).value, 200);
  const family = text(readRecord(nameRecord["family-name"]).value, 200);
  const credit = text(readRecord(nameRecord["credit-name"]).value, 500);
  const name = credit ?? text([given, family].filter(Boolean).join(" "), 500);
  if (!orcid || !name) return null;
  const activities = readRecord(raw["activities-summary"]);
  return personEntity({
    orcid,
    name,
    affiliations: affiliationsFromActivities(activities),
    worksCount: readArray(readRecord(activities.works).group).length || null,
    sourceUri: `https://orcid.org/${orcid}`,
    fetchedAt,
  });
}

export function parseOrcidSearchResult(
  raw: Record<string, unknown>,
  fetchedAt: string,
): DbEntity | null {
  const orcid = normalizeOrcid(text(raw["orcid-id"], 100) ?? "");
  const name = text(
    raw["credit-name"] ?? [raw["given-names"], raw["family-names"]].filter(Boolean).join(" "),
    500,
  );
  if (!orcid || !name) return null;
  return personEntity({
    orcid,
    name,
    affiliations: readArray(raw["institution-name"])
      .map((entry) => text(entry, 500))
      .filter((entry): entry is string => Boolean(entry)),
    worksCount: null,
    sourceUri: `https://orcid.org/${orcid}`,
    fetchedAt,
  });
}

function personEntity(input: {
  orcid: string;
  name: string;
  affiliations: string[];
  worksCount: number | null;
  sourceUri: string;
  fetchedAt: string;
}): DbEntity {
  return {
    type: "person",
    ids: compactRecord({ orcid: input.orcid }),
    primary_id: { scheme: "orcid", id: input.orcid },
    source_db: ["orcid"],
    source_uri: input.sourceUri,
    fetched_at: input.fetchedAt,
    raw_summary: input.name,
    payload: {
      name: input.name,
      orcid: input.orcid,
      affiliations: input.affiliations,
      works_count: input.worksCount,
    },
  };
}

function affiliationsFromActivities(activities: Record<string, unknown>): string[] {
  const employments = readRecord(activities.employments);
  return readArray(employments["affiliation-group"])
    .flatMap((group) => readArray(readRecord(group).summaries))
    .map((summary) => readRecord(readRecord(summary)["employment-summary"]))
    .map((employment) => text(readRecord(employment.organization).name, 500))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeOrcid(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/orcid\.org\//i, "");
}
