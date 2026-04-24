import crypto from "node:crypto";

import type {
  PaperIdentifier,
  PaperIdentityCandidate,
  PaperMetadataField,
  PaperMetadataSource,
  SourceRunStatus,
} from "./contracts";
import {
  buildMetadataField,
  mergeMetadataField,
  scorePaperIdentity,
} from "./metadata-merge";
import {
  buildEnrichmentCacheKey,
  getUsableCacheEntry,
  isSourcePaused,
  readEnrichmentCache,
  updateSourceHealth,
  upsertCacheEntry,
  writeEnrichmentCache,
} from "./enrichment-cache";
import { fetchArxivEntity } from "@/lib/skills/db-arxiv";
import type { DbEntity, PaperPayload } from "@/lib/skills/db-base";
import { fetchCrossrefEntity } from "@/lib/skills/db-crossref";
import { fetchOpenAlexEntity } from "@/lib/skills/db-openalex";
import { fetchPubmedEntity } from "@/lib/skills/db-pubmed";

type ScholarSource = Extract<PaperMetadataSource, "crossref" | "openalex" | "pubmed" | "arxiv">;

export interface ScholarEnrichmentFetchers {
  crossref?: (doi: string) => Promise<DbEntity | null>;
  openalex?: (id: string) => Promise<DbEntity | null>;
  pubmed?: (args: { id: string; scheme?: "pmid" | "doi" }) => Promise<DbEntity | null>;
  arxiv?: (id: string) => Promise<DbEntity | null>;
}

export interface EnrichIdentityCandidateInput {
  project: string;
  stateRoot: string;
  candidate: PaperIdentityCandidate;
  fetchers?: ScholarEnrichmentFetchers;
}

const DEFAULT_FETCHERS: Required<ScholarEnrichmentFetchers> = {
  crossref: fetchCrossrefEntity,
  openalex: (id) => fetchOpenAlexEntity(id, "paper"),
  pubmed: fetchPubmedEntity,
  arxiv: fetchArxivEntity,
};

function sourceFromEntity(entity: DbEntity): ScholarSource | null {
  const source = entity.source_db[0];
  if (source === "crossref" || source === "openalex" || source === "pubmed" || source === "arxiv") {
    return source;
  }
  return null;
}

function identifiersFromEntity(entity: DbEntity): PaperIdentifier {
  return {
    doi: entity.ids.doi,
    arxivId: entity.ids.arxiv,
    pmid: entity.ids.pmid,
    openAlexId: entity.ids.openalex,
  };
}

function paperPayload(entity: DbEntity): PaperPayload | null {
  return entity.type === "paper" ? entity.payload : null;
}

function fieldsFromEntity(entity: DbEntity): PaperMetadataField[] {
  const source = sourceFromEntity(entity);
  const payload = paperPayload(entity);
  if (!source || !payload) return [];
  const fields: PaperMetadataField[] = [
    buildMetadataField("title", payload.title, source, 0.97, [`${source}:title`]),
  ];
  if (payload.authors.length > 0) {
    fields.push(buildMetadataField("authors", payload.authors.map((author) => author.name), source, 0.94, [`${source}:authors`]));
  }
  if (payload.year) {
    fields.push(buildMetadataField("year", payload.year, source, 0.92, [`${source}:year`]));
  }
  if (payload.venue.name) {
    fields.push(buildMetadataField("venue", payload.venue.name, source, 0.88, [`${source}:venue`]));
  }
  return fields;
}

function baseMetadataFields(candidate: PaperIdentityCandidate): PaperMetadataField[] {
  const fields: PaperMetadataField[] = [];
  const fieldConfidence = candidate.source === "pdf_text" || candidate.source === "filename"
    ? Math.min(candidate.confidence, 0.55)
    : candidate.confidence;
  if (candidate.title) fields.push(buildMetadataField("title", candidate.title, candidate.source, fieldConfidence, ["scan:title"]));
  if (candidate.authors.length > 0) fields.push(buildMetadataField("authors", candidate.authors, candidate.source, fieldConfidence, ["scan:authors"]));
  if (candidate.year) fields.push(buildMetadataField("year", candidate.year, candidate.source, fieldConfidence, ["scan:year"]));
  if (candidate.venue) fields.push(buildMetadataField("venue", candidate.venue, candidate.source, fieldConfidence, ["scan:venue"]));
  return fields;
}

function chooseMergedValue<T>(fields: PaperMetadataField[], fallback: T): { value: T; field?: PaperMetadataField } {
  const merged = mergeMetadataField(fields);
  return {
    value: (merged.field?.value ?? fallback) as T,
    field: merged.field ?? undefined,
  };
}

function candidateId(candidate: PaperIdentityCandidate, identifiers: PaperIdentifier, title?: string): string {
  const stableIdentifier = identifiers.doi ?? identifiers.arxivId ?? identifiers.pmid ?? identifiers.openAlexId;
  if (!stableIdentifier) return candidate.id;
  return crypto
    .createHash("sha1")
    .update(`${stableIdentifier}:${title ?? candidate.title ?? ""}`)
    .digest("hex");
}

function queryPlan(identifiers: PaperIdentifier): Array<{ source: ScholarSource; identifier: string; cacheKey: string }> {
  const plan: Array<{ source: ScholarSource; identifier: string; cacheKey: string }> = [];
  if (identifiers.doi) {
    plan.push({ source: "crossref", identifier: identifiers.doi, cacheKey: buildEnrichmentCacheKey("crossref", identifiers.doi) });
    plan.push({ source: "openalex", identifier: `https://doi.org/${identifiers.doi}`, cacheKey: buildEnrichmentCacheKey("openalex", identifiers.doi) });
    plan.push({ source: "pubmed", identifier: identifiers.doi, cacheKey: buildEnrichmentCacheKey("pubmed", `doi:${identifiers.doi}`) });
  }
  if (identifiers.pmid) {
    plan.push({ source: "pubmed", identifier: identifiers.pmid, cacheKey: buildEnrichmentCacheKey("pubmed", `pmid:${identifiers.pmid}`) });
  }
  if (identifiers.arxivId) {
    plan.push({ source: "arxiv", identifier: identifiers.arxivId, cacheKey: buildEnrichmentCacheKey("arxiv", identifiers.arxivId) });
  }
  if (identifiers.openAlexId) {
    plan.push({ source: "openalex", identifier: identifiers.openAlexId, cacheKey: buildEnrichmentCacheKey("openalex", identifiers.openAlexId) });
  }
  return plan;
}

function entityFromCachedValue(value: unknown): DbEntity | null {
  if (!value || typeof value !== "object") return null;
  const entity = value as Partial<DbEntity>;
  return entity.type === "paper" ? entity as DbEntity : null;
}

async function fetchWithCache(
  input: {
    project: string;
    stateRoot: string;
    source: ScholarSource;
    identifier: string;
    cacheKey: string;
    fetchers: Required<ScholarEnrichmentFetchers>;
  },
): Promise<{ entity: DbEntity | null; status: SourceRunStatus; evidence: string }> {
  let cache = await readEnrichmentCache(input.project, input.stateRoot);
  if (isSourcePaused(cache, input.source)) {
    return { entity: null, status: "paused", evidence: `${input.source}:paused` };
  }

  const cached = getUsableCacheEntry(cache, input.cacheKey);
  if (cached) {
    return {
      entity: cached.status === "success" ? entityFromCachedValue(cached.value) : null,
      status: cached.status,
      evidence: `${input.source}:cache:${cached.status}`,
    };
  }

  try {
    const entity = input.source === "pubmed"
      ? await input.fetchers.pubmed({ id: input.identifier, scheme: input.identifier.startsWith("10.") ? "doi" : undefined })
      : input.source === "crossref"
        ? await input.fetchers.crossref(input.identifier)
        : input.source === "openalex"
          ? await input.fetchers.openalex(input.identifier)
          : await input.fetchers.arxiv(input.identifier);
    cache = upsertCacheEntry(cache, {
      key: input.cacheKey,
      source: input.source,
      status: entity ? "success" : "negative",
      value: entity ?? undefined,
    });
    cache = updateSourceHealth(cache, { source: input.source, status: "healthy" });
    await writeEnrichmentCache(input.project, cache, input.stateRoot);
    return {
      entity,
      status: entity ? "success" : "negative",
      evidence: `${input.source}:${entity ? "success" : "negative"}`,
    };
  } catch {
    cache = upsertCacheEntry(cache, {
      key: input.cacheKey,
      source: input.source,
      status: "metadata_unavailable",
      errorCode: "metadata_unavailable",
    });
    cache = updateSourceHealth(cache, { source: input.source, status: "degraded", failure: true });
    await writeEnrichmentCache(input.project, cache, input.stateRoot);
    return { entity: null, status: "metadata_unavailable", evidence: `${input.source}:unavailable` };
  }
}

export async function enrichIdentityCandidate(
  input: EnrichIdentityCandidateInput,
): Promise<PaperIdentityCandidate> {
  const plan = queryPlan(input.candidate.identifiers);
  if (plan.length === 0) return input.candidate;

  const fetchers: Required<ScholarEnrichmentFetchers> = { ...DEFAULT_FETCHERS, ...input.fetchers };
  const entities: DbEntity[] = [];
  const evidence = [...input.candidate.evidence];
  const unavailableSources: string[] = [];

  for (const query of plan) {
    const result = await fetchWithCache({
      project: input.project,
      stateRoot: input.stateRoot,
      source: query.source,
      identifier: query.identifier,
      cacheKey: query.cacheKey,
      fetchers,
    });
    evidence.push(result.evidence);
    if (result.entity) entities.push(result.entity);
    if (result.status === "metadata_unavailable" || result.status === "paused") {
      unavailableSources.push(query.source);
    }
  }

  const metadataFields = [
    ...baseMetadataFields(input.candidate),
    ...entities.flatMap(fieldsFromEntity),
    ...unavailableSources.flatMap((source) => [
      {
        name: "source",
        value: source,
        source: source as PaperMetadataSource,
        confidence: 0,
        evidence: [`${source}:unavailable`],
        conflict: false,
        sourceStatus: "unavailable" as const,
      },
    ]),
  ];
  const identifiers = entities.reduce<PaperIdentifier>((merged, entity) => ({
    ...merged,
    ...Object.fromEntries(
      Object.entries(identifiersFromEntity(entity)).filter(([, value]) => Boolean(value)),
    ),
  }), { ...input.candidate.identifiers });

  const title = chooseMergedValue<string | undefined>(
    metadataFields.filter((field) => field.name === "title"),
    input.candidate.title,
  );
  const authors = chooseMergedValue<string[]>(
    metadataFields.filter((field) => field.name === "authors"),
    input.candidate.authors,
  );
  const year = chooseMergedValue<number | undefined>(
    metadataFields.filter((field) => field.name === "year"),
    input.candidate.year,
  );
  const venue = chooseMergedValue<string | undefined>(
    metadataFields.filter((field) => field.name === "venue"),
    input.candidate.venue,
  );
  const source = (title.field?.source ?? input.candidate.source) as PaperMetadataSource;
  const score = scorePaperIdentity({
    candidate: {
      ...input.candidate,
      identifiers,
      title: title.value,
      authors: authors.value,
      year: year.value,
      venue: venue.value,
      source,
    },
    metadataFields,
  });

  return {
    ...input.candidate,
    id: candidateId(input.candidate, identifiers, title.value),
    identifiers,
    title: title.value,
    authors: authors.value,
    year: year.value,
    venue: venue.value,
    source,
    confidence: score.score,
    evidence: Array.from(new Set([
      ...evidence,
      ...metadataFields.flatMap((field) => field.evidence),
    ])),
    conflicts: Array.from(new Set([
      ...input.candidate.conflicts,
      ...score.blockReasons,
    ])),
  };
}
