import {
  fetchExternalJson,
  getRequiredDatabaseKey,
  persistEntity,
  persistSearchResult,
  sanitizeExternalText,
  type DbEntity,
  type PersistOptions,
} from "./db-base";

export interface DbMaterialsProjectFetchArgs {
  id: string;
  project?: string;
}

export interface DbMaterialsProjectSearchArgs {
  query: string;
  page?: number;
  page_size?: number;
  project?: string;
}

interface AdapterOptions extends PersistOptions {
  persist?: boolean;
}

interface MaterialsProjectResponse {
  data?: unknown[];
  meta?: {
    total_doc?: number;
  };
}

export async function materialsProjectFetch(
  args: DbMaterialsProjectFetchArgs,
  options: AdapterOptions = {},
) {
  const entity = await fetchMaterialsProjectEntity(args.id);
  if (!entity) return null;
  if (options.persist === false) return { entity, write_status: "in_memory_only" as const };
  return persistEntity(entity, { ...options, project: args.project ?? options.project });
}

export async function materialsProjectSearch(
  args: DbMaterialsProjectSearchArgs,
  options: AdapterOptions = {},
) {
  const pageSize = Math.min(200, Math.max(1, args.page_size ?? 25));
  const page = Math.max(1, args.page ?? 1);
  const apiKey = getRequiredDatabaseKey("MATERIALS_PROJECT_API_KEY");
  const params = new URLSearchParams({
    _limit: String(pageSize),
    _skip: String((page - 1) * pageSize),
  });
  if (/^mp-\d+$/i.test(args.query.trim())) {
    params.set("material_ids", args.query.trim().toLowerCase());
  } else {
    params.set("formula", args.query.trim());
  }
  const response = await fetchExternalJson<MaterialsProjectResponse>(
    "materials_project",
    `https://api.materialsproject.org/materials/summary/?${params}`,
    { headers: { "X-API-KEY": apiKey } },
  );
  const fetchedAt = new Date().toISOString();
  const entities = (response.data ?? [])
    .map((entry) => parseMaterialsProjectSummary(readRecord(entry), fetchedAt))
    .filter((entity): entity is DbEntity => Boolean(entity));
  const total = response.meta?.total_doc ?? entities.length;
  const cursor = entities.length === pageSize ? String(page + 1) : undefined;
  if (options.persist === false) {
    return { entities, total, cursor, write_status: "in_memory_only" as const };
  }
  return persistSearchResult(
    {
      sourceDb: "materials_project",
      query: args.query,
      filters: { page, page_size: pageSize },
      entities,
      total,
      cursor,
    },
    { ...options, project: args.project ?? options.project },
  );
}

export async function fetchMaterialsProjectEntity(id: string): Promise<DbEntity | null> {
  const materialId = id.trim().toLowerCase();
  const apiKey = getRequiredDatabaseKey("MATERIALS_PROJECT_API_KEY");
  const params = new URLSearchParams({ material_ids: materialId, _limit: "1" });
  const response = await fetchExternalJson<MaterialsProjectResponse>(
    "materials_project",
    `https://api.materialsproject.org/materials/summary/?${params}`,
    { headers: { "X-API-KEY": apiKey } },
  );
  const first = response.data?.[0];
  return first ? parseMaterialsProjectSummary(readRecord(first), new Date().toISOString()) : null;
}

export function parseMaterialsProjectSummary(
  raw: Record<string, unknown>,
  fetchedAt: string,
): DbEntity | null {
  const materialId = String(raw.material_id ?? raw.task_id ?? "").toLowerCase();
  if (!materialId) return null;
  const symmetry = readRecord(raw.symmetry);
  const formula = sanitizeExternalText(
    raw.formula_pretty ?? raw.formula_anonymous ?? materialId,
    { maxLength: 200 },
  ) ?? materialId;
  return {
    type: "material",
    ids: { mp: materialId, materials_project: materialId },
    primary_id: { scheme: "mp", id: materialId },
    source_db: ["materials_project"],
    source_uri: `https://materialsproject.org/materials/${materialId}/`,
    fetched_at: fetchedAt,
    raw_summary: sanitizeExternalText(`${formula} ${materialId}`, { maxLength: 10_000 }),
    payload: {
      material_id: materialId,
      formula,
      crystal_system: typeof symmetry.crystal_system === "string"
        ? symmetry.crystal_system
        : null,
      band_gap_ev: readNumber(raw.band_gap),
      energy_above_hull_ev: readNumber(raw.energy_above_hull),
      is_stable: typeof raw.is_stable === "boolean" ? raw.is_stable : null,
    },
  };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
