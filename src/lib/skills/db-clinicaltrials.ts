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

export interface DbClinicalTrialsFetchArgs {
  id: string;
  project?: string;
}

export interface DbClinicalTrialsSearchArgs {
  query: string;
  page_size?: number;
  page_token?: string;
  project?: string;
}

interface ClinicalTrialsSearchResponse {
  studies?: unknown[];
  totalCount?: number;
  nextPageToken?: string;
}

export async function clinicalTrialsFetch(
  args: DbClinicalTrialsFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchClinicalTrialsEntity(args.id);
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function clinicalTrialsSearch(
  args: DbClinicalTrialsSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = clampPageSize(args.page_size);
  const params = new URLSearchParams({
    "query.term": args.query,
    pageSize: String(pageSize),
  });
  if (args.page_token) params.set("pageToken", args.page_token);
  const response = await fetchExternalJson<ClinicalTrialsSearchResponse>(
    "clinicaltrials",
    `https://clinicaltrials.gov/api/v2/studies?${params}`,
  );
  const fetchedAt = new Date().toISOString();
  const entities = (response.studies ?? [])
    .map((entry) => parseClinicalTrialStudy(readRecord(entry), fetchedAt))
    .filter((entity): entity is DbEntity => Boolean(entity));
  const total = response.totalCount ?? entities.length;
  const cursor = response.nextPageToken;
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "clinicaltrials",
      query: args.query,
      filters: { page_size: pageSize, page_token: args.page_token ?? "" },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchClinicalTrialsEntity(id: string): Promise<DbEntity | null> {
  const nctId = id.trim().toUpperCase();
  const response = await fetchExternalJson<Record<string, unknown>>(
    "clinicaltrials",
    `https://clinicaltrials.gov/api/v2/studies/${encodeURIComponent(nctId)}`,
  );
  return parseClinicalTrialStudy(response, new Date().toISOString());
}

export function parseClinicalTrialStudy(
  raw: Record<string, unknown>,
  fetchedAt: string,
): DbEntity | null {
  const protocol = readRecord(raw.protocolSection);
  const identification = readRecord(protocol.identificationModule);
  const status = readRecord(protocol.statusModule);
  const sponsors = readRecord(protocol.sponsorCollaboratorsModule);
  const design = readRecord(protocol.designModule);
  const conditions = readRecord(protocol.conditionsModule);
  const arms = readRecord(protocol.armsInterventionsModule);
  const nctId = text(identification.nctId, 50)?.toUpperCase();
  if (!nctId) return null;
  const title = text(identification.briefTitle ?? identification.officialTitle, 500) ?? nctId;
  const sponsor = text(readRecord(sponsors.leadSponsor).name, 500) ?? "unknown sponsor";
  const phase = readArray(design.phases).map((entry) => normalizePhase(entry)).join(", ") || "unknown";
  return {
    type: "trial",
    ids: compactRecord({ nct: nctId }),
    primary_id: { scheme: "nct", id: nctId },
    source_db: ["clinicaltrials"],
    source_uri: `https://clinicaltrials.gov/study/${nctId}`,
    fetched_at: fetchedAt,
    raw_summary: text(`${title}\n${sponsor}`, 10_000),
    payload: {
      title,
      sponsor,
      phase,
      status: normalizeTrialStatus(status.overallStatus),
      conditions: readArray(conditions.conditions)
        .map((entry) => text(entry, 200))
        .filter((entry): entry is string => Boolean(entry)),
      interventions: readArray(arms.interventions)
        .map((entry) => text(readRecord(entry).name, 200))
        .filter((entry): entry is string => Boolean(entry)),
    },
  };
}

function normalizeTrialStatus(value: unknown): "recruiting" | "active" | "completed" | "terminated" | "withdrawn" | "unknown" {
  const status = String(value ?? "").toUpperCase();
  if (["RECRUITING", "NOT_YET_RECRUITING", "ENROLLING_BY_INVITATION"].includes(status)) return "recruiting";
  if (status === "ACTIVE_NOT_RECRUITING") return "active";
  if (status === "COMPLETED") return "completed";
  if (status === "TERMINATED" || status === "SUSPENDED") return "terminated";
  if (status === "WITHDRAWN") return "withdrawn";
  return "unknown";
}

function normalizePhase(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "unknown";
  const normalized = raw
    .replace(/_/g, " ")
    .replace(/\bEARLY\s+PHASE\s*1\b/i, "Early Phase 1")
    .replace(/\bPHASE\s*([0-4])\b/gi, "Phase $1")
    .replace(/\bNA\b/i, "N/A")
    .trim();
  return normalized || "unknown";
}
