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
  readNumber,
  readRecord,
  readString,
  text,
  type AdapterOptions,
} from "./db-utils";

export interface DbChemblFetchArgs {
  id: string;
  project?: string;
}

export interface DbChemblSearchArgs {
  query: string;
  page?: number;
  page_size?: number;
  project?: string;
}

interface ChemblListResponse {
  molecules?: unknown[];
  page_meta?: {
    total_count?: number;
  };
}

export async function chemblFetch(
  args: DbChemblFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchChemblEntity(args.id);
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function chemblSearch(
  args: DbChemblSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = clampPageSize(args.page_size);
  const offset = Math.max(0, ((args.page ?? 1) - 1) * pageSize);
  const params = new URLSearchParams({
    q: args.query,
    limit: String(pageSize),
    offset: String(offset),
  });
  const response = await fetchExternalJson<ChemblListResponse>(
    "chembl",
    `https://www.ebi.ac.uk/chembl/api/data/molecule/search.json?${params}`,
  );
  const fetchedAt = new Date().toISOString();
  const entities = (response.molecules ?? [])
    .map((entry) => parseChemblMolecule(readRecord(entry), fetchedAt))
    .filter((entity): entity is DbEntity => Boolean(entity));
  const total = response.page_meta?.total_count ?? entities.length;
  const cursor = offset + entities.length < total ? String(offset + pageSize) : undefined;
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "chembl",
      query: args.query,
      filters: { page: args.page ?? 1, page_size: pageSize },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchChemblEntity(id: string): Promise<DbEntity | null> {
  const chemblId = id.trim().toUpperCase();
  const response = await fetchExternalJson<Record<string, unknown>>(
    "chembl",
    `https://www.ebi.ac.uk/chembl/api/data/molecule/${encodeURIComponent(chemblId)}.json`,
  );
  return parseChemblMolecule(response, new Date().toISOString());
}

export function parseChemblMolecule(
  raw: Record<string, unknown>,
  fetchedAt: string,
): DbEntity | null {
  const chemblId = text(raw.molecule_chembl_id ?? raw.chembl_id, 100)?.toUpperCase();
  if (!chemblId) return null;
  const properties = readRecord(raw.molecule_properties);
  const structures = readRecord(raw.molecule_structures);
  const synonymName = readArray(raw.molecule_synonyms)
    .map((entry) => text(readRecord(entry).molecule_synonym, 500))
    .find(Boolean);
  const name = text(raw.pref_name, 500) ?? synonymName ?? chemblId;
  const inchiKey = text(structures.standard_inchi_key ?? raw.standard_inchi_key, 200);
  const formula = text(
    properties.full_molformula ?? properties.molecular_formula,
    200,
  );
  return {
    type: "compound",
    ids: compactRecord({ chembl: chemblId, inchi_key: inchiKey }),
    primary_id: { scheme: "chembl", id: chemblId },
    source_db: ["chembl"],
    source_uri: `https://www.ebi.ac.uk/chembl/compound_report_card/${chemblId}/`,
    fetched_at: fetchedAt,
    raw_summary: text(`${name}\n${formula ?? ""}`, 10_000),
    payload: {
      name,
      molecular_formula: formula,
      inchi_key: inchiKey,
      status: inferChemblStatus(raw),
      max_phase: readNumeric(raw.max_phase),
    },
  };
}

function inferChemblStatus(raw: Record<string, unknown>): "active" | "discontinued" | "unknown" {
  if (raw.withdrawn_flag === true || readString(raw.withdrawn_reason)) return "discontinued";
  if (readString(raw.molecule_chembl_id ?? raw.chembl_id)) return "active";
  return "unknown";
}

function readNumeric(value: unknown): number | null {
  const numeric = readNumber(value);
  if (numeric != null) return numeric;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
