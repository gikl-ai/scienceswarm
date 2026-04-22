import type {
  PaperEntity,
  ResearchLandscapeCandidate,
  ResearchLandscapeDuplicate,
  ResearchLandscapeRetainedCandidate,
  ResearchLandscapeSource,
} from "./contract";
import { DEFAULT_RESEARCH_LANDSCAPE_SOURCES } from "./contract";
import { normalizeResearchLandscapeTitle } from "./resolve";

import { normalizeTitle, titleSimilarity } from "@/lib/paper-dedupe";

const TITLE_SIMILARITY_THRESHOLD = 0.9;

export function dedupeResearchLandscapeCandidates(
  candidates: ResearchLandscapeCandidate[],
): {
  retained: ResearchLandscapeRetainedCandidate[];
  duplicates: ResearchLandscapeDuplicate[];
} {
  const groups: Array<{
    members: ResearchLandscapeCandidate[];
    duplicates: ResearchLandscapeDuplicate[];
  }> = [];
  const sorted = [...candidates].sort(compareCandidatePriority);

  for (const candidate of sorted) {
    const group = groups.find((entry) =>
      entry.members.some((member) => matchCandidates(member, candidate)),
    );
    if (!group) {
      groups.push({ members: [candidate], duplicates: [] });
      continue;
    }

    const canonicalBeforeMerge = chooseCanonicalMember(group.members);
    const reason = describeDuplicate(canonicalBeforeMerge, candidate);
    group.members.push(candidate);
    group.duplicates.push({
      droppedTitle: candidate.entity.payload.title,
      droppedSource: candidate.source,
      keptTitle: canonicalBeforeMerge.entity.payload.title,
      keptSources: uniqueSources(group.members.map((member) => member.source)),
      reason: reason.reason,
      similarity: reason.similarity,
    });
  }

  const retained = groups
    .map((group) => {
      const canonical = chooseCanonicalMember(group.members);
      const mergedEntity = mergePaperEntities(canonical, group.members);
      return {
        entity: mergedEntity,
        normalizedTitle: normalizeResearchLandscapeTitle(mergedEntity.payload.title),
        exactTitleMatch: group.members.some((member) => member.exactTitleMatch),
        bestRank: Math.min(...group.members.map((member) => member.rank)),
        sources: uniqueSources(group.members.map((member) => member.source)),
        duplicates: group.duplicates,
      } satisfies ResearchLandscapeRetainedCandidate;
    })
    .sort(compareRetainedPriority);

  return {
    retained,
    duplicates: retained.flatMap((candidate) => candidate.duplicates),
  };
}

function compareCandidatePriority(
  left: ResearchLandscapeCandidate,
  right: ResearchLandscapeCandidate,
): number {
  return (
    compareBoolean(right.exactTitleMatch, left.exactTitleMatch)
    || compareBoolean(Boolean(right.entity.ids.doi), Boolean(left.entity.ids.doi))
    || compareBoolean(Boolean(right.entity.payload.abstract), Boolean(left.entity.payload.abstract))
    || compareNumber(sourcePriority(left.source), sourcePriority(right.source))
    || compareNumber(left.rank, right.rank)
    || compareNumber(right.entity.payload.year ?? -1, left.entity.payload.year ?? -1)
    || left.normalizedTitle.localeCompare(right.normalizedTitle)
  );
}

function compareRetainedPriority(
  left: ResearchLandscapeRetainedCandidate,
  right: ResearchLandscapeRetainedCandidate,
): number {
  return (
    compareBoolean(right.exactTitleMatch, left.exactTitleMatch)
    || compareNumber(right.sources.length, left.sources.length)
    || compareBoolean(Boolean(right.entity.ids.doi), Boolean(left.entity.ids.doi))
    || compareBoolean(Boolean(right.entity.payload.abstract), Boolean(left.entity.payload.abstract))
    || compareNumber(right.entity.payload.year ?? -1, left.entity.payload.year ?? -1)
    || compareNumber(sourcePriority(left.sources[0] ?? "crossref"), sourcePriority(right.sources[0] ?? "crossref"))
    || compareNumber(left.bestRank, right.bestRank)
    || left.normalizedTitle.localeCompare(right.normalizedTitle)
  );
}

function matchCandidates(
  left: ResearchLandscapeCandidate,
  right: ResearchLandscapeCandidate,
): boolean {
  const reason = describeDuplicate(left, right);
  return reason.reason !== "title_similarity"
    ? true
    : Boolean(reason.similarity);
}

function describeDuplicate(
  left: ResearchLandscapeCandidate,
  right: ResearchLandscapeCandidate,
): { reason: ResearchLandscapeDuplicate["reason"]; similarity?: number } {
  const leftDoi = normalizeIdentifier(left.entity.ids.doi);
  const rightDoi = normalizeIdentifier(right.entity.ids.doi);
  if (leftDoi && rightDoi && leftDoi === rightDoi) {
    return { reason: "shared_doi" };
  }

  const leftKeys = identifierKeys(left.entity);
  const rightKeys = identifierKeys(right.entity);
  for (const key of leftKeys) {
    if (rightKeys.has(key)) {
      return { reason: "shared_identifier" };
    }
  }

  const similarity = titleSimilarity(left.normalizedTitle, right.normalizedTitle);
  if (titlesCompatible(left, right, similarity)) {
    return { reason: "title_similarity", similarity };
  }

  return { reason: "title_similarity" };
}

function titlesCompatible(
  left: ResearchLandscapeCandidate,
  right: ResearchLandscapeCandidate,
  similarity: number,
): boolean {
  if (left.normalizedTitle.length === 0 || right.normalizedTitle.length === 0) {
    return false;
  }
  if (left.normalizedTitle === right.normalizedTitle) {
    return true;
  }
  if (similarity < TITLE_SIMILARITY_THRESHOLD) {
    return false;
  }
  if (!yearsCompatible(left.entity.payload.year, right.entity.payload.year)) {
    return false;
  }
  return authorsOverlap(left.entity, right.entity);
}

function authorsOverlap(left: PaperEntity, right: PaperEntity): boolean {
  const leftAuthors = new Set(left.payload.authors.map((author) => normalizeTitle(author.name)));
  const rightAuthors = new Set(right.payload.authors.map((author) => normalizeTitle(author.name)));
  if (leftAuthors.size === 0 || rightAuthors.size === 0) return true;
  for (const author of leftAuthors) {
    if (rightAuthors.has(author)) return true;
  }
  return false;
}

function yearsCompatible(
  leftYear: number | null | undefined,
  rightYear: number | null | undefined,
): boolean {
  if (leftYear == null || rightYear == null) return true;
  return Math.abs(leftYear - rightYear) <= 1;
}

function chooseCanonicalMember(
  members: ResearchLandscapeCandidate[],
): ResearchLandscapeCandidate {
  return [...members].sort(compareCandidatePriority)[0];
}

function mergePaperEntities(
  canonical: ResearchLandscapeCandidate,
  members: ResearchLandscapeCandidate[],
): PaperEntity {
  const orderedMembers = [
    canonical,
    ...members.filter((member) => member !== canonical),
  ];
  const sourceDb = uniqueSources(orderedMembers.flatMap((member) => member.entity.source_db as ResearchLandscapeSource[]));
  const ids = mergeIds(orderedMembers.map((member) => member.entity.ids));
  const title = chooseBestTitle(orderedMembers);
  const abstract = chooseLongestValue(orderedMembers.map((member) => member.entity.payload.abstract ?? ""));
  const venue = chooseBestVenue(orderedMembers);
  const authors = mergeAuthors(orderedMembers);
  const year = canonical.entity.payload.year ?? latestKnownYear(orderedMembers);
  const retractionStatus = chooseRetractionStatus(orderedMembers);
  const primary_id = choosePrimaryId(ids, canonical.entity);

  return {
    ...canonical.entity,
    ids,
    primary_id,
    source_db: sourceDb,
    source_uri: canonical.entity.source_uri,
    fetched_at: orderedMembers
      .map((member) => member.entity.fetched_at)
      .sort()
      .at(-1) ?? canonical.entity.fetched_at,
    raw_summary: chooseLongestValue(
      orderedMembers.map((member) => member.entity.raw_summary ?? ""),
    ) || canonical.entity.raw_summary,
    payload: {
      title,
      authors,
      venue,
      year,
      abstract: abstract || undefined,
      retraction_status: retractionStatus,
    },
  };
}

function chooseBestTitle(members: ResearchLandscapeCandidate[]): string {
  const exactMatch = members.find((member) => member.exactTitleMatch)?.entity.payload.title;
  if (exactMatch) return exactMatch;
  return chooseLongestValue(members.map((member) => member.entity.payload.title))
    || members[0]?.entity.payload.title
    || "Untitled paper";
}

function chooseBestVenue(members: ResearchLandscapeCandidate[]): PaperEntity["payload"]["venue"] {
  const canonicalVenue = members[0]?.entity.payload.venue;
  const preferred = members
    .map((member) => member.entity.payload.venue)
    .sort((left, right) => (
      compareBoolean(right.type !== "database", left.type !== "database")
      || compareNumber(right.name.length, left.name.length)
    ))[0];
  return preferred ?? canonicalVenue ?? { name: "Unknown", type: "database" };
}

function mergeAuthors(
  members: ResearchLandscapeCandidate[],
): PaperEntity["payload"]["authors"] {
  const seen = new Set<string>();
  const authors: PaperEntity["payload"]["authors"] = [];
  const ordered = [...members].sort((left, right) => compareNumber(right.entity.payload.authors.length, left.entity.payload.authors.length));
  for (const member of ordered) {
    for (const author of member.entity.payload.authors) {
      const key = `${normalizeTitle(author.name)}:${(author.orcid ?? "").toLowerCase()}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      authors.push(author);
    }
  }
  return authors;
}

function mergeIds(idsList: Array<Record<string, string>>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const ids of idsList) {
    for (const [scheme, value] of Object.entries(ids)) {
      if (!merged[scheme] && value.trim()) {
        merged[scheme] = value.trim();
      }
    }
  }
  return merged;
}

function chooseRetractionStatus(
  members: ResearchLandscapeCandidate[],
): PaperEntity["payload"]["retraction_status"] {
  const priority = new Map<NonNullable<PaperEntity["payload"]["retraction_status"]>, number>([
    ["retracted", 4],
    ["withdrawn", 3],
    ["concern", 2],
    ["active", 1],
  ]);
  return members
    .map((member) => member.entity.payload.retraction_status)
    .filter((status): status is NonNullable<PaperEntity["payload"]["retraction_status"]> => Boolean(status))
    .sort((left, right) => compareNumber(priority.get(right) ?? 0, priority.get(left) ?? 0))[0]
    ?? canonicalRetractionFallback(members[0]?.entity.payload.retraction_status);
}

function canonicalRetractionFallback(
  status: PaperEntity["payload"]["retraction_status"] | undefined,
): PaperEntity["payload"]["retraction_status"] {
  return status ?? "active";
}

function choosePrimaryId(
  ids: Record<string, string>,
  canonical: PaperEntity,
): PaperEntity["primary_id"] {
  if (ids.doi) return { scheme: "doi", id: ids.doi };
  if (ids.pmid) return { scheme: "pmid", id: ids.pmid };
  if (ids.arxiv) return { scheme: "arxiv", id: ids.arxiv };
  if (ids.openalex) return { scheme: "openalex", id: ids.openalex };
  return canonical.primary_id;
}

function identifierKeys(entity: PaperEntity): Set<string> {
  const keys = new Set<string>();
  for (const [scheme, value] of Object.entries(entity.ids)) {
    const normalized = normalizeIdentifier(value);
    if (normalized) keys.add(`${scheme}:${normalized}`);
  }
  const primaryValue = normalizeIdentifier(entity.primary_id.id);
  if (primaryValue) {
    keys.add(`${entity.primary_id.scheme}:${primaryValue}`);
  }
  return keys;
}

function normalizeIdentifier(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function latestKnownYear(members: ResearchLandscapeCandidate[]): number | null {
  const years = members
    .map((member) => member.entity.payload.year)
    .filter((year): year is number => typeof year === "number");
  return years.length > 0 ? Math.max(...years) : null;
}

function chooseLongestValue(values: string[]): string {
  return [...values]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => compareNumber(right.length, left.length))[0] ?? "";
}

function uniqueSources(sources: ResearchLandscapeSource[]): ResearchLandscapeSource[] {
  const seen = new Set<ResearchLandscapeSource>();
  const ordered = [...DEFAULT_RESEARCH_LANDSCAPE_SOURCES];
  const extras = sources.filter((source) => !ordered.includes(source));
  const all = [...ordered, ...extras];
  const present = new Set(sources);
  const unique: ResearchLandscapeSource[] = [];
  for (const source of all) {
    if (!present.has(source) || seen.has(source)) continue;
    seen.add(source);
    unique.push(source);
  }
  return unique;
}

function sourcePriority(source: ResearchLandscapeSource): number {
  const index = DEFAULT_RESEARCH_LANDSCAPE_SOURCES.indexOf(source);
  return index === -1 ? DEFAULT_RESEARCH_LANDSCAPE_SOURCES.length : index;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function compareBoolean(left: boolean, right: boolean): number {
  return Number(left) - Number(right);
}
