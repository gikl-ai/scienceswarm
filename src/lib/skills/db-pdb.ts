import {
  fetchExternalJson,
  persistEntity,
  persistSearchResult,
  sanitizeExternalText,
  type DbEntity,
  type PersistOptions,
} from "./db-base";

export interface DbPdbFetchArgs {
  id: string;
  project?: string;
}

export interface DbPdbSearchArgs {
  query: string;
  page?: number;
  page_size?: number;
  project?: string;
}

interface AdapterOptions extends PersistOptions {
  persist?: boolean;
}

interface RcsbSearchResponse {
  total_count?: number;
  result_set?: Array<{ identifier?: string; score?: number }>;
}

export async function pdbFetch(
  args: DbPdbFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchPdbEntity(args.id);
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function pdbSearch(
  args: DbPdbSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = Math.min(200, Math.max(1, args.page_size ?? 25));
  const page = Math.max(1, args.page ?? 1);
  const response = await fetchExternalJson<RcsbSearchResponse>(
    "pdb",
    "https://search.rcsb.org/rcsbsearch/v2/query",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: {
          type: "terminal",
          service: "full_text",
          parameters: { value: args.query },
        },
        return_type: "entry",
        request_options: {
          paginate: {
            start: (page - 1) * pageSize,
            rows: pageSize,
          },
        },
      }),
    },
  );
  const fetchedAt = new Date().toISOString();
  const identifiers = (response.result_set ?? [])
    .map((hit) => hit.identifier)
    .filter((id): id is string => Boolean(id));
  const entities: DbEntity[] = [];
  for (const id of identifiers) {
    try {
      entities.push(await fetchPdbEntity(id) ?? minimalPdbEntity(id, fetchedAt));
    } catch {
      entities.push(minimalPdbEntity(id, fetchedAt));
    }
  }
  const total = response.total_count ?? entities.length;
  const cursor = identifiers.length === pageSize ? String(page + 1) : undefined;
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "pdb",
      query: args.query,
      filters: { page, page_size: pageSize },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchPdbEntity(id: string): Promise<DbEntity | null> {
  const pdbId = id.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(pdbId)) {
    throw new Error("PDB ID must be a four-character RCSB entry identifier.");
  }
  const raw = await fetchExternalJson<Record<string, unknown>>(
    "pdb",
    `https://data.rcsb.org/rest/v1/core/entry/${encodeURIComponent(pdbId)}`,
  );
  const polymerEntities = await fetchPdbPolymerEntities(pdbId, raw);
  return parsePdbEntry({ ...raw, polymer_entities: polymerEntities }, new Date().toISOString());
}

export function parsePdbEntry(raw: Record<string, unknown>, fetchedAt: string): DbEntity | null {
  const container = readRecord(raw.rcsb_entry_container_identifiers);
  const pdbId = String(container.entry_id ?? raw.rcsb_id ?? "").toUpperCase();
  if (!pdbId) return null;
  const struct = readRecord(raw.struct);
  const info = readRecord(raw.rcsb_entry_info);
  const accession = readRecord(raw.rcsb_accession_info);
  const status = readRecord(raw.pdbx_database_status);
  const experiments = readArray(raw.exptl).map(readRecord);
  const polymerEntities = readArray(raw.polymer_entities).map(readRecord);
  const title = sanitizeExternalText(struct.title, { maxLength: 500 }) ?? `PDB ${pdbId}`;
  const resolution = readNumberArray(info.resolution_combined)[0] ?? null;
  const macromolecules = readStringArray(info.polymer_entity_count_protein)
    .concat(readStringArray(info.polymer_entity_count_nucleic_acid))
    .concat(readPolymerEntityDescriptions(polymerEntities));
  const sourceOrganisms = readPolymerEntityOrganisms(polymerEntities);
  return {
    type: "structure",
    ids: { pdb: pdbId },
    primary_id: { scheme: "pdb", id: pdbId },
    source_db: ["pdb"],
    source_uri: `https://www.rcsb.org/structure/${pdbId}`,
    fetched_at: fetchedAt,
    raw_summary: sanitizeExternalText(title, { maxLength: 10_000 }),
    payload: {
      title,
      method: sanitizeExternalText(experiments[0]?.method, { maxLength: 200 }) ?? "unknown",
      resolution_angstrom: resolution,
      release_date: typeof accession.initial_release_date === "string"
        ? accession.initial_release_date
        : null,
      status: normalizePdbStatus(status.status_code),
      macromolecules: uniqueStrings(macromolecules),
      superseded_by: readStringArray(
        status.superseded_by ??
          status.replace_pdb_id ??
          status.replaced_by,
      ),
      source_organisms: uniqueStrings(sourceOrganisms),
    },
  };
}

async function fetchPdbPolymerEntities(
  pdbId: string,
  entry: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const container = readRecord(entry.rcsb_entry_container_identifiers);
  const entityIds = uniqueStrings(readStringArray(container.polymer_entity_ids));
  const entities: Record<string, unknown>[] = [];
  for (const entityId of entityIds) {
    try {
      entities.push(await fetchExternalJson<Record<string, unknown>>(
        "pdb",
        `https://data.rcsb.org/rest/v1/core/polymer_entity/${encodeURIComponent(pdbId)}/${encodeURIComponent(entityId)}`,
      ));
    } catch {
      // Organism/source enrichment is best-effort; the entry record remains the
      // authoritative exact fetch result when individual polymer entities fail.
    }
  }
  return entities;
}

function readPolymerEntityDescriptions(entities: Record<string, unknown>[]): string[] {
  return entities.flatMap((entity) =>
    readStringArray(readRecord(entity.rcsb_polymer_entity).pdbx_description)
      .concat(readStringArray(readRecord(entity.entity_poly).type)),
  );
}

function readPolymerEntityOrganisms(entities: Record<string, unknown>[]): string[] {
  return entities.flatMap((entity) => {
    const sources = readArray(entity.rcsb_entity_source_organism)
      .concat(readArray(entity.entity_src_gen))
      .concat(readArray(entity.entity_src_nat))
      .map(readRecord);
    return sources.flatMap((source) =>
      readStringArray(
        source.ncbi_scientific_name ??
          source.pdbx_gene_src_scientific_name ??
          source.pdbx_organism_scientific ??
          source.scientific_name,
      ),
    );
  });
}

function minimalPdbEntity(pdbId: string, fetchedAt: string): DbEntity {
  const normalized = pdbId.toUpperCase();
  return {
    type: "structure",
    ids: { pdb: normalized },
    primary_id: { scheme: "pdb", id: normalized },
    source_db: ["pdb"],
    source_uri: `https://www.rcsb.org/structure/${normalized}`,
    fetched_at: fetchedAt,
    raw_summary: `PDB ${normalized}`,
    payload: {
      title: `PDB ${normalized}`,
      method: "unknown",
      resolution_angstrom: null,
      release_date: null,
      status: "unknown",
      macromolecules: [],
    },
  };
}

function normalizePdbStatus(value: unknown): "active" | "obsolete" | "superseded" | "unknown" {
  const status = typeof value === "string" ? value.toUpperCase() : "";
  if (status.includes("OBS")) return "obsolete";
  if (status.includes("SPRSDE")) return "superseded";
  if (status) return "active";
  return "unknown";
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number")
    : [];
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap(readStringArray);
  }
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
