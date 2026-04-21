import type { DbEntity, EntityType } from "../db-base";

export const ENTITY_DIRECTORIES: Record<EntityType, string> = {
  paper: "literature",
  trial: "trials",
  protein: "proteins",
  structure: "structures",
  compound: "compounds",
  material: "materials",
  person: "people",
};

export function renderEntityTitle(entity: DbEntity): string {
  switch (entity.type) {
    case "paper":
      return entity.payload.title || entity.primary_id.id;
    case "trial":
      return entity.payload.title || entity.primary_id.id;
    case "protein":
      return entity.payload.recommended_name || entity.primary_id.id;
    case "structure":
      return entity.payload.title || entity.primary_id.id;
    case "compound":
      return entity.payload.name || entity.primary_id.id;
    case "material":
      return entity.payload.formula || entity.primary_id.id;
    case "person":
      return entity.payload.name || entity.primary_id.id;
  }
}

export function renderEntityCompiledTruth(entity: DbEntity): string {
  switch (entity.type) {
    case "paper":
      return renderPaper(entity);
    case "trial":
      return renderTrial(entity);
    case "protein":
      return renderProtein(entity);
    case "structure":
      return renderStructure(entity);
    case "compound":
      return renderCompound(entity);
    case "material":
      return renderMaterial(entity);
    case "person":
      return renderPerson(entity);
  }
}

function line(label: string, value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return `- ${label}: ${value.join(", ")}`;
  }
  const text = String(value).trim();
  return text ? `- ${label}: ${text}` : null;
}

function lifecycleWarning(status: string | null | undefined): string | null {
  if (!status || status === "active" || status === "unknown" || status === "completed") {
    return null;
  }
  return `- Lifecycle warning: ${status}`;
}

function compact(lines: Array<string | null>): string {
  return lines.filter((entry): entry is string => Boolean(entry)).join("\n");
}

function external(text: string | null | undefined): string {
  return text ? `<external_source>${text}</external_source>` : "";
}

function renderPaper(entity: Extract<DbEntity, { type: "paper" }>): string {
  const payload = entity.payload;
  return compact([
    `# ${payload.title || entity.primary_id.id}`,
    "",
    "## Source Metadata",
    line("Primary ID", `${entity.primary_id.scheme}:${entity.primary_id.id}`),
    line("Source databases", entity.source_db),
    line("Source URI", entity.source_uri),
    line("Fetched at", entity.fetched_at),
    "",
    "## Bibliography",
    line("Authors", payload.authors.map((author) => author.name)),
    line("Venue", payload.venue.name),
    line("Venue type", payload.venue.type),
    line("Year", payload.year),
    line("Retraction status", payload.retraction_status ?? "unknown"),
    lifecycleWarning(payload.retraction_status),
    "",
    "## Abstract",
    external(payload.abstract),
  ]);
}

function renderTrial(entity: Extract<DbEntity, { type: "trial" }>): string {
  const payload = entity.payload;
  return compact([
    `# ${payload.title || entity.primary_id.id}`,
    "",
    "## Trial",
    line("Primary ID", `${entity.primary_id.scheme}:${entity.primary_id.id}`),
    line("Sponsor", payload.sponsor),
    line("Phase", payload.phase),
    line("Status", payload.status),
    lifecycleWarning(payload.status),
    line("Conditions", payload.conditions),
    line("Interventions", payload.interventions),
  ]);
}

function renderProtein(entity: Extract<DbEntity, { type: "protein" }>): string {
  const payload = entity.payload;
  return compact([
    `# ${payload.recommended_name || entity.primary_id.id}`,
    "",
    "## Protein",
    line("Primary ID", `${entity.primary_id.scheme}:${entity.primary_id.id}`),
    line("Organism", payload.organism),
    line("Reviewed", payload.reviewed ? "yes" : "no"),
    line("Status", payload.status),
    lifecycleWarning(payload.status),
    line("Genes", payload.genes),
  ]);
}

function renderStructure(entity: Extract<DbEntity, { type: "structure" }>): string {
  const payload = entity.payload;
  return compact([
    `# ${payload.title || entity.primary_id.id}`,
    "",
    "## Structure",
    line("Primary ID", `${entity.primary_id.scheme}:${entity.primary_id.id}`),
    line("Method", payload.method),
    line("Resolution", payload.resolution_angstrom),
    line("Release date", payload.release_date),
    line("Status", payload.status),
    lifecycleWarning(payload.status),
    line("Superseded by", payload.superseded_by),
    line("Source organisms", payload.source_organisms),
    line("Macromolecules", payload.macromolecules),
  ]);
}

function renderCompound(entity: Extract<DbEntity, { type: "compound" }>): string {
  const payload = entity.payload;
  return compact([
    `# ${payload.name || entity.primary_id.id}`,
    "",
    "## Compound",
    line("Primary ID", `${entity.primary_id.scheme}:${entity.primary_id.id}`),
    line("Molecular formula", payload.molecular_formula),
    line("InChIKey", payload.inchi_key),
    line("Status", payload.status),
    lifecycleWarning(payload.status),
    line("Max phase", payload.max_phase),
  ]);
}

function renderMaterial(entity: Extract<DbEntity, { type: "material" }>): string {
  const payload = entity.payload;
  return compact([
    `# ${payload.formula || entity.primary_id.id}`,
    "",
    "## Material",
    line("Primary ID", `${entity.primary_id.scheme}:${entity.primary_id.id}`),
    line("Formula", payload.formula),
    line("Crystal system", payload.crystal_system),
    line("Band gap eV", payload.band_gap_ev),
    line("Energy above hull eV", payload.energy_above_hull_ev),
    line("Stability", payload.is_stable == null ? "unknown" : payload.is_stable ? "stable" : "not stable"),
  ]);
}

function renderPerson(entity: Extract<DbEntity, { type: "person" }>): string {
  const payload = entity.payload;
  return compact([
    `# ${payload.name || entity.primary_id.id}`,
    "",
    "## Person",
    line("Primary ID", `${entity.primary_id.scheme}:${entity.primary_id.id}`),
    line("ORCID", payload.orcid),
    line("Affiliations", payload.affiliations),
    line("Works count", payload.works_count),
  ]);
}
