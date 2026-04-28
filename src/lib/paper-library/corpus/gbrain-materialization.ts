import {
  createInProcessGbrainClient,
  type InProcessGbrainClient,
  type PersistTransactionLinkInput,
} from "@/brain/in-process-gbrain-client";
import {
  describeBrainBackendError,
  ensureBrainStoreReady,
  getBrainStore,
  type BrainStore,
  type BrainStoreHealth,
} from "@/brain/store";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { getProjectBrainRootForBrainRoot } from "@/lib/state/project-storage";

import {
  GbrainCorpusCapabilitiesSchema,
  PaperProvenanceLedgerRecordSchema,
  type BibliographyEntryArtifact,
  type GbrainCorpusCapabilities,
  type GbrainCorpusCapability,
  type PaperCorpusWarning,
  type PaperIngestManifest,
  type PaperIngestPaper,
  type PaperProvenanceLedgerRecord,
  type PaperSectionMap,
  type PaperSourceArtifact,
  type PaperSummaryArtifact,
  type PaperSummaryTier,
} from "./contracts";
import { upsertPaperProvenanceRecord } from "./provenance";
import {
  readPaperProvenanceLedger,
  writePaperProvenanceLedger,
  type PaperProvenanceLedger,
} from "./state";

export const AUDITED_CORPUS_LINK_TYPES = [
  "has_source",
  "has_summary",
  "derived_from",
  "cites",
  "same_identity",
  "included_in_survey",
  "selected_for_context",
] as const;
export type AuditedCorpusLinkType = typeof AUDITED_CORPUS_LINK_TYPES[number];

const MATERIALIZATION_VERSION = 1;

export interface MaterializePaperCorpusManifestInput {
  project: string;
  brainRoot: string;
  manifest: PaperIngestManifest;
  stateRoot?: string;
  occurredAt?: string;
  actor?: string;
  client?: InProcessGbrainClient;
}

export interface MaterializePaperCorpusManifestResult {
  manifestId: string;
  project: string;
  paperCount: number;
  pagesWritten: number;
  linksWritten: number;
  provenanceRecords: PaperProvenanceLedgerRecord[];
  warnings: PaperCorpusWarning[];
}

export interface DetectGbrainCorpusCapabilitiesInput {
  store?: BrainStore;
  generatedAt?: string;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      compacted[key] = compactObject(entry as Record<string, unknown>);
      continue;
    }
    compacted[key] = entry;
  }
  return compacted;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeSection(
  existingCompiledTruth: string | undefined,
  heading: string,
  body: string,
): string {
  const block = [`## ${heading}`, "", body.trim()].filter(Boolean).join("\n");
  const trimmedExisting = (existingCompiledTruth ?? "").trim();
  if (!trimmedExisting) return block;

  const sectionMatch = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m").exec(trimmedExisting);
  if (!sectionMatch) return `${trimmedExisting}\n\n${block}`;

  const sectionStart = sectionMatch.index;
  const afterHeading = sectionStart + sectionMatch[0].length;
  const nextSectionOffset = trimmedExisting.slice(afterHeading).search(/\n##\s+/);
  const sectionEnd = nextSectionOffset === -1
    ? trimmedExisting.length
    : afterHeading + nextSectionOffset;

  return [
    trimmedExisting.slice(0, sectionStart).trim(),
    block,
    trimmedExisting.slice(sectionEnd).trim(),
  ].filter(Boolean).join("\n\n");
}

function appendTimeline(existingTimeline: string, entry: string): string {
  const trimmedExisting = existingTimeline.trim();
  const trimmedEntry = entry.trim();
  if (!trimmedEntry || trimmedExisting.includes(trimmedEntry)) return trimmedExisting;
  return trimmedExisting ? `${trimmedExisting}\n\n${trimmedEntry}` : trimmedEntry;
}

function summaryStatusByTier(summaries: readonly PaperSummaryArtifact[]): Record<PaperSummaryTier, string> {
  return {
    relevance: summaries.find((summary) => summary.tier === "relevance")?.status ?? "missing",
    brief: summaries.find((summary) => summary.tier === "brief")?.status ?? "missing",
    detailed: summaries.find((summary) => summary.tier === "detailed")?.status ?? "missing",
  };
}

function warningCodes(warnings: readonly PaperCorpusWarning[]): string[] {
  return uniqueStrings(warnings.map((warning) => warning.code));
}

function paperTitle(paper: PaperIngestPaper): string {
  return paper.title ?? paper.paperSlug.split("/").filter(Boolean).at(-1) ?? paper.paperSlug;
}

function formatWarnings(warnings: readonly PaperCorpusWarning[]): string[] {
  if (warnings.length === 0) return ["Warnings: none"];
  return [
    "Warnings:",
    ...warnings.map((warning) => `- ${warning.severity}: ${warning.code} - ${warning.message}`),
  ];
}

function formatPaperCorpusBlock(input: {
  manifest: PaperIngestManifest;
  paper: PaperIngestPaper;
}): string {
  const { manifest, paper } = input;
  const source = paper.sourceArtifact;
  const sourceLine = source
    ? `Source page: [[${source.sourceSlug}]]`
    : "Source page: not materialized";
  const summaryLines = Object.entries(summaryStatusByTier(paper.summaries))
    .map(([tier, status]) => {
      const summary = paper.summaries.find((entry) => entry.tier === tier);
      return `- ${tier}: ${summary ? `[[${summary.summarySlug}]]` : "not materialized"} (${status})`;
    });

  return [
    `Manifest: ${manifest.id}`,
    `Status: ${paper.status}`,
    `Preferred source: ${source ? `${source.sourceType} (${source.origin})` : "none"}`,
    `Source quality: ${source?.quality.score ?? "n/a"}`,
    sourceLine,
    "Summaries:",
    ...summaryLines,
    `Bibliography entries: ${paper.bibliography.length}`,
    ...formatWarnings([...paper.warnings, ...(source?.warnings ?? [])]),
  ].join("\n");
}

function formatSourceCompiledTruth(source: PaperSourceArtifact): string {
  const sourceText = source.normalizedMarkdown.trim();
  if (sourceText) return sourceText;
  return [
    "# Source text unavailable",
    "",
    "This corpus source artifact has no normalized source text.",
    ...formatWarnings(source.warnings),
  ].join("\n");
}

function formatSummaryCompiledTruth(summary: PaperSummaryArtifact): string {
  const evidenceLines = summary.evidence.length > 0
    ? summary.evidence.map((entry) => {
        const handles = entry.chunkHandles
          .map((handle) => [
            handle.sourceSlug,
            handle.sectionId ? `section=${handle.sectionId}` : undefined,
            handle.chunkId !== undefined ? `chunk=${handle.chunkId}` : undefined,
            handle.chunkIndex !== undefined ? `index=${handle.chunkIndex}` : undefined,
          ].filter(Boolean).join(" "))
          .join("; ");
        return `- ${entry.statement ?? entry.claimId ?? "Evidence"}${handles ? ` (${handles})` : ""}`;
      })
    : ["- No evidence handles recorded yet."];

  return [
    "## Summary Artifact",
    "",
    `Tier: ${summary.tier}`,
    `Status: ${summary.status}`,
    `Source: [[${summary.sourceSlug}]]`,
    `Prompt version: ${summary.promptVersion ?? "n/a"}`,
    `Model: ${summary.modelId ?? "n/a"}`,
    "",
    "## Evidence",
    "",
    ...evidenceLines,
    "",
    ...formatWarnings(summary.warnings),
  ].join("\n");
}

function formatBibliographyCompiledTruth(entry: BibliographyEntryArtifact): string {
  const seenInLines = entry.seenIn.length > 0
    ? entry.seenIn.map((seen) => [
        `- [[${seen.paperSlug}]]`,
        `via ${seen.extractionSource}`,
        seen.bibKey ? `key=${seen.bibKey}` : undefined,
        `confidence=${seen.confidence.toFixed(2)}`,
      ].filter(Boolean).join(" "))
    : ["- Not seen in any local paper yet."];

  return [
    "## Bibliography Entry",
    "",
    entry.title ? `Title: ${entry.title}` : "Title: unknown",
    entry.year ? `Year: ${entry.year}` : "Year: unknown",
    entry.venue ? `Venue: ${entry.venue}` : "Venue: unknown",
    entry.identifiers.doi ? `DOI: ${entry.identifiers.doi}` : undefined,
    entry.identifiers.arxivId ? `arXiv: ${entry.identifiers.arxivId}` : undefined,
    entry.identifiers.pmid ? `PMID: ${entry.identifiers.pmid}` : undefined,
    "",
    "## Seen In",
    "",
    ...seenInLines,
    "",
    ...formatWarnings(entry.warnings),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function mergeSeenIn(
  existing: unknown,
  next: readonly BibliographyEntryArtifact["seenIn"][number][],
): BibliographyEntryArtifact["seenIn"] {
  const current = Array.isArray(existing)
    ? existing.filter((entry): entry is BibliographyEntryArtifact["seenIn"][number] => {
        return Boolean(
          entry
          && typeof entry === "object"
          && "paperSlug" in entry
          && "extractionSource" in entry
          && "confidence" in entry,
        );
      })
    : [];
  const byKey = new Map<string, BibliographyEntryArtifact["seenIn"][number]>();
  for (const seen of [...current, ...next]) {
    byKey.set([
      seen.paperSlug,
      seen.bibKey ?? "",
      seen.extractionSource,
    ].join("|"), seen);
  }
  return [...byKey.values()];
}

function sourceFrontmatter(input: {
  source: PaperSourceArtifact;
  sectionMap?: PaperSectionMap;
  project: string;
  manifestId: string;
  actor: string;
  occurredAt: string;
}): Record<string, unknown> {
  const { source, sectionMap, project, manifestId, actor, occurredAt } = input;
  return compactObject({
    entity_type: "paper_source",
    source_kind: "paper_source_text",
    paper_slug: source.paperSlug,
    study: project,
    study_slug: project,
    legacy_project_slug: project,
    corpus_manifest_id: manifestId,
    source_type: source.sourceType,
    source_origin: source.origin,
    source_status: source.status,
    extractor: source.extractor,
    source_hash: source.sourceHash,
    section_map_hash: source.sectionMapHash,
    section_map: sectionMap ? {
      status: sectionMap.status,
      sections: sectionMap.sections,
      warnings: sectionMap.warnings,
    } : undefined,
    quality: source.quality,
    warnings: source.warnings,
    created_at: source.createdAt,
    updated_at: occurredAt,
    updated_by: actor,
    materialization_version: MATERIALIZATION_VERSION,
  });
}

function summaryFrontmatter(input: {
  summary: PaperSummaryArtifact;
  project: string;
  manifestId: string;
  actor: string;
  occurredAt: string;
}): Record<string, unknown> {
  const { summary, project, manifestId, actor, occurredAt } = input;
  return compactObject({
    entity_type: "paper_summary",
    summary_kind: `paper_${summary.tier}`,
    paper_slug: summary.paperSlug,
    source_slug: summary.sourceSlug,
    study: project,
    study_slug: project,
    legacy_project_slug: project,
    corpus_manifest_id: manifestId,
    source_hash: summary.sourceHash,
    section_map_hash: summary.sectionMapHash,
    prompt_version: summary.promptVersion,
    model: summary.modelId,
    generation_settings: summary.generationSettings,
    generated_at: summary.generatedAt,
    generated_by: summary.generatedBy,
    evidence: summary.evidence,
    status: summary.status,
    stale_reason: summary.staleReason,
    warnings: summary.warnings,
    created_at: summary.createdAt,
    updated_at: occurredAt,
    updated_by: actor,
    materialization_version: MATERIALIZATION_VERSION,
  });
}

function bibliographyFrontmatter(input: {
  entry: BibliographyEntryArtifact;
  seenIn: BibliographyEntryArtifact["seenIn"];
  project: string;
  manifestId: string;
  actor: string;
  occurredAt: string;
}): Record<string, unknown> {
  const { entry, seenIn, project, manifestId, actor, occurredAt } = input;
  return compactObject({
    entity_type: "bibliography_entry",
    identifiers: entry.identifiers,
    authors: entry.authors,
    year: entry.year,
    venue: entry.venue,
    canonical_paper_slug: entry.canonicalPaperSlug,
    study: project,
    study_slug: project,
    legacy_project_slug: project,
    corpus_manifest_id: manifestId,
    status: entry.status,
    local_status: entry.localStatus,
    stale_reason: entry.staleReason,
    seen_in: seenIn,
    warnings: entry.warnings,
    created_at: entry.createdAt,
    updated_at: occurredAt,
    updated_by: actor,
    materialization_version: MATERIALIZATION_VERSION,
  });
}

function paperFrontmatter(input: {
  existingFrontmatter: Record<string, unknown>;
  manifest: PaperIngestManifest;
  paper: PaperIngestPaper;
  project: string;
  actor: string;
  occurredAt: string;
}): Record<string, unknown> {
  const { existingFrontmatter, manifest, paper, project, actor, occurredAt } = input;
  const existingCorpus = existingFrontmatter.scientific_corpus
    && typeof existingFrontmatter.scientific_corpus === "object"
    ? existingFrontmatter.scientific_corpus as Record<string, unknown>
    : {};
  const source = paper.sourceArtifact;
  const studySlugs = uniqueStrings([
    ...toStringArray(existingFrontmatter.study_slugs),
    project,
  ]);

  return compactObject({
    ...existingFrontmatter,
    entity_type: "paper",
    identifiers: paper.identifiers,
    study: existingFrontmatter.study ?? project,
    study_slug: existingFrontmatter.study_slug ?? project,
    legacy_project_slug: existingFrontmatter.legacy_project_slug ?? existingFrontmatter.project ?? project,
    study_slugs: studySlugs,
    corpus_ids: uniqueStrings([
      ...toStringArray(existingFrontmatter.corpus_ids),
      manifest.id,
    ]),
    source_status: source?.status ?? paper.status,
    preferred_source_type: source?.sourceType,
    source_quality_score: source?.quality.score,
    summary_status: summaryStatusByTier(paper.summaries),
    scientific_corpus: {
      ...existingCorpus,
      project,
      manifest_id: manifest.id,
      scan_id: manifest.scanId,
      paper_id: paper.paperId,
      status: paper.status,
      source_slug: source?.sourceSlug,
      source_status: source?.status,
      preferred_source_type: source?.sourceType,
      source_origin: source?.origin,
      source_hash: source?.sourceHash,
      section_map_hash: source?.sectionMapHash,
      source_quality_score: source?.quality.score,
      bibliography_count: paper.bibliography.length,
      warning_codes: warningCodes([...paper.warnings, ...(source?.warnings ?? [])]),
      materialized_at: occurredAt,
      materialized_by: actor,
      materialization_version: MATERIALIZATION_VERSION,
    },
    captured_by: existingFrontmatter.captured_by ?? actor,
    updated_by: actor,
    updated_at: occurredAt,
  });
}

function materializationRecord(input: {
  paperSlug: string;
  occurredAt: string;
  actor: string;
  artifactSlug: string;
  message: string;
  sourceSlug?: string;
  sourceType?: PaperSourceArtifact["sourceType"];
  inputHash?: string;
  outputHash?: string;
  details?: Record<string, unknown>;
  warnings?: PaperCorpusWarning[];
}): PaperProvenanceLedgerRecord {
  return PaperProvenanceLedgerRecordSchema.parse({
    id: `gbrain-materialization:${input.artifactSlug}`,
    paperSlug: input.paperSlug,
    occurredAt: input.occurredAt,
    eventType: "gbrain_materialization",
    status: "succeeded",
    actor: input.actor,
    sourceSlug: input.sourceSlug,
    artifactSlug: input.artifactSlug,
    sourceType: input.sourceType,
    inputHash: input.inputHash,
    outputHash: input.outputHash,
    message: input.message,
    details: input.details ?? {},
    warnings: input.warnings ?? [],
  });
}

function linkKey(link: PersistTransactionLinkInput): string {
  return [
    normalizeLinkSlug(link.from),
    normalizeLinkSlug(link.to),
    link.linkType ?? "references",
    link.context ?? "",
  ].join("|");
}

function normalizeLinkSlug(slug: string): string {
  return slug.replace(/\.md$/i, "");
}

async function filterNewLinks(
  store: BrainStore,
  links: readonly PersistTransactionLinkInput[],
): Promise<PersistTransactionLinkInput[]> {
  const linksByFrom = new Map<string, PersistTransactionLinkInput[]>();
  for (const link of links) {
    const existing = linksByFrom.get(link.from) ?? [];
    existing.push(link);
    linksByFrom.set(link.from, existing);
  }

  const filtered: PersistTransactionLinkInput[] = [];
  for (const [from, fromLinks] of linksByFrom) {
    const existingLinks = await store.getLinks(from).catch(() => []);
    const existingKeys = new Set(existingLinks.map((link) => [
      normalizeLinkSlug(link.fromSlug),
      normalizeLinkSlug(link.toSlug),
      link.kind,
      link.context ?? "",
    ].join("|")));
    const batchKeys = new Set<string>();
    for (const link of fromLinks) {
      const key = linkKey(link);
      if (existingKeys.has(key) || batchKeys.has(key)) continue;
      batchKeys.add(key);
      filtered.push(link);
    }
  }
  return filtered;
}

function sourceLinks(paper: PaperIngestPaper): PersistTransactionLinkInput[] {
  if (!paper.sourceArtifact) return [];
  return [
    {
      from: paper.paperSlug,
      to: paper.sourceArtifact.sourceSlug,
      linkType: "has_source",
      context: [
        `Corpus source selected from ${paper.sourceArtifact.origin}`,
        `quality=${paper.sourceArtifact.quality.score.toFixed(2)}`,
        paper.sourceArtifact.sourceHash ? `source_hash=${paper.sourceArtifact.sourceHash}` : undefined,
      ].filter(Boolean).join("; "),
    },
    {
      from: paper.sourceArtifact.sourceSlug,
      to: paper.paperSlug,
      linkType: "derived_from",
      context: "Corpus source text is derived from the canonical paper page.",
    },
  ];
}

function summaryLinks(summary: PaperSummaryArtifact): PersistTransactionLinkInput[] {
  return [
    {
      from: summary.paperSlug,
      to: summary.summarySlug,
      linkType: "has_summary",
      context: `Corpus ${summary.tier} summary status=${summary.status}.`,
    },
    {
      from: summary.summarySlug,
      to: summary.sourceSlug,
      linkType: "derived_from",
      context: `Corpus ${summary.tier} summary is derived from source_hash=${summary.sourceHash ?? "unknown"}.`,
    },
  ];
}

function bibliographyLinks(
  paper: PaperIngestPaper,
  entry: BibliographyEntryArtifact,
): PersistTransactionLinkInput[] {
  const seen = entry.seenIn.find((source) => source.paperSlug === paper.paperSlug) ?? entry.seenIn[0];
  const links: PersistTransactionLinkInput[] = [
    {
      from: paper.paperSlug,
      to: entry.bibliographySlug,
      linkType: "cites",
      context: seen
        ? `Citation parsed from ${seen.extractionSource}${seen.bibKey ? ` key=${seen.bibKey}` : ""}; confidence=${seen.confidence.toFixed(2)}.`
        : "Citation parsed from corpus bibliography metadata.",
    },
  ];
  if (entry.canonicalPaperSlug && entry.canonicalPaperSlug !== paper.paperSlug) {
    links.push({
      from: entry.bibliographySlug,
      to: entry.canonicalPaperSlug,
      linkType: "same_identity",
      context: "Bibliography entry resolves to a local canonical paper page.",
    });
  }
  return links;
}

async function existingLedger(
  project: string,
  paper: PaperIngestPaper,
  stateRoot?: string,
): Promise<PaperProvenanceLedger> {
  const parsed = await readPaperProvenanceLedger(project, paper.paperSlug, stateRoot);
  if (parsed.ok) return parsed.data;
  if (parsed.repairable.code === "missing") return paper.provenance;
  throw new Error(
    [
      `Paper corpus provenance ledger for ${paper.paperSlug} is ${parsed.repairable.code}.`,
      "Refusing to overwrite repairable ledger state during gbrain materialization.",
      parsed.repairable.path ? `Path: ${parsed.repairable.path}.` : undefined,
      parsed.repairable.message,
    ].filter(Boolean).join(" "),
  );
}

async function writePaperCorpusLedger(input: {
  project: string;
  paper: PaperIngestPaper;
  records: readonly PaperProvenanceLedgerRecord[];
  stateRoot?: string;
}): Promise<PaperProvenanceLedger> {
  let ledger = await existingLedger(input.project, input.paper, input.stateRoot);
  for (const record of input.records) {
    ledger = upsertPaperProvenanceRecord(ledger, record);
  }
  return writePaperProvenanceLedger(input.project, input.paper.paperSlug, ledger, input.stateRoot);
}

async function materializePaper(input: {
  client: InProcessGbrainClient;
  store: BrainStore;
  project: string;
  manifest: PaperIngestManifest;
  paper: PaperIngestPaper;
  occurredAt: string;
  actor: string;
}): Promise<{
  pagesWritten: number;
  linksWritten: number;
  records: PaperProvenanceLedgerRecord[];
}> {
  const records: PaperProvenanceLedgerRecord[] = [];
  let pagesWritten = 0;

  if (input.paper.sourceArtifact) {
    const source = input.paper.sourceArtifact;
    await input.client.persistTransaction(source.sourceSlug, () => ({
      page: {
        type: "source",
        title: `${paperTitle(input.paper)} Source`,
        compiledTruth: formatSourceCompiledTruth(source),
        timeline: `- **${input.occurredAt.slice(0, 10)}** | ScienceSwarm corpus - Source materialized from ${source.origin}.`,
        frontmatter: sourceFrontmatter({
          source,
          sectionMap: input.paper.sectionMap,
          project: input.project,
          manifestId: input.manifest.id,
          actor: input.actor,
          occurredAt: input.occurredAt,
        }),
      },
    }));
    pagesWritten += 1;
    records.push(materializationRecord({
      paperSlug: input.paper.paperSlug,
      occurredAt: input.occurredAt,
      actor: input.actor,
      artifactSlug: source.sourceSlug,
      sourceSlug: source.sourceSlug,
      sourceType: source.sourceType,
      inputHash: source.sourceHash,
      outputHash: source.sectionMapHash,
      message: "Materialized corpus source page in gbrain.",
      details: {
        status: source.status,
        extractor: source.extractor,
        qualityScore: source.quality.score,
      },
      warnings: source.warnings,
    }));
  }

  for (const summary of input.paper.summaries) {
    await input.client.persistTransaction(summary.summarySlug, () => ({
      page: {
        type: "note",
        title: `${paperTitle(input.paper)} ${summary.tier} summary`,
        compiledTruth: formatSummaryCompiledTruth(summary),
        timeline: `- **${input.occurredAt.slice(0, 10)}** | ScienceSwarm corpus - ${summary.tier} summary materialized.`,
        frontmatter: summaryFrontmatter({
          summary,
          project: input.project,
          manifestId: input.manifest.id,
          actor: input.actor,
          occurredAt: input.occurredAt,
        }),
      },
    }));
    pagesWritten += 1;
    records.push(materializationRecord({
      paperSlug: input.paper.paperSlug,
      occurredAt: input.occurredAt,
      actor: input.actor,
      artifactSlug: summary.summarySlug,
      sourceSlug: summary.sourceSlug,
      inputHash: summary.sourceHash,
      outputHash: summary.sectionMapHash,
      message: `Materialized corpus ${summary.tier} summary page in gbrain.`,
      details: {
        status: summary.status,
        promptVersion: summary.promptVersion,
        modelId: summary.modelId,
      },
      warnings: summary.warnings,
    }));
  }

  for (const bibliography of input.paper.bibliography) {
    await input.client.persistTransaction(bibliography.bibliographySlug, (existing) => {
      const previousFrontmatter = existing?.frontmatter ?? {};
      const seenIn = mergeSeenIn(previousFrontmatter.seen_in, bibliography.seenIn);
      return {
        page: {
          type: "source",
          title: bibliography.title ?? bibliography.bibliographySlug,
          compiledTruth: formatBibliographyCompiledTruth({
            ...bibliography,
            seenIn,
          }),
          timeline: appendTimeline(
            existing?.timeline ?? "",
            `- **${input.occurredAt.slice(0, 10)}** | ScienceSwarm corpus - Bibliography entry materialized from ${input.paper.paperSlug}.`,
          ),
          frontmatter: bibliographyFrontmatter({
            entry: bibliography,
            seenIn,
            project: input.project,
            manifestId: input.manifest.id,
            actor: input.actor,
            occurredAt: input.occurredAt,
          }),
        },
      };
    });
    pagesWritten += 1;
    records.push(materializationRecord({
      paperSlug: input.paper.paperSlug,
      occurredAt: input.occurredAt,
      actor: input.actor,
      artifactSlug: bibliography.bibliographySlug,
      message: "Materialized corpus bibliography entry in gbrain.",
      details: {
        status: bibliography.status,
        localStatus: bibliography.localStatus,
        seenInCount: bibliography.seenIn.length,
      },
      warnings: bibliography.warnings,
    }));
  }

  const links = [
    ...sourceLinks(input.paper),
    ...input.paper.summaries.flatMap(summaryLinks),
    ...input.paper.bibliography.flatMap((entry) => bibliographyLinks(input.paper, entry)),
  ];
  const linksToWrite = await filterNewLinks(input.store, links);

  await input.client.persistTransaction(input.paper.paperSlug, (existing) => {
    const previousFrontmatter = existing?.frontmatter ?? {};
    return {
      page: {
        type: "paper",
        title: paperTitle(input.paper),
        compiledTruth: mergeSection(
          existing?.compiledTruth,
          "Scientific Corpus",
          formatPaperCorpusBlock({ manifest: input.manifest, paper: input.paper }),
        ),
        timeline: appendTimeline(
          existing?.timeline ?? "",
          `- **${input.occurredAt.slice(0, 10)}** | ScienceSwarm corpus - Materialized corpus artifacts from manifest ${input.manifest.id}.`,
        ),
        frontmatter: paperFrontmatter({
          existingFrontmatter: previousFrontmatter,
          manifest: input.manifest,
          paper: input.paper,
          project: input.project,
          actor: input.actor,
          occurredAt: input.occurredAt,
        }),
      },
      links: linksToWrite,
    };
  });
  pagesWritten += 1;
  records.push(materializationRecord({
    paperSlug: input.paper.paperSlug,
    occurredAt: input.occurredAt,
    actor: input.actor,
    artifactSlug: input.paper.paperSlug,
    sourceSlug: input.paper.sourceArtifact?.sourceSlug,
    sourceType: input.paper.sourceArtifact?.sourceType,
    inputHash: input.paper.sourceArtifact?.sourceHash,
    outputHash: input.paper.sourceArtifact?.sectionMapHash,
    message: "Materialized canonical corpus paper page in gbrain.",
    details: {
      status: input.paper.status,
      linksWritten: linksToWrite.length,
      summaries: summaryStatusByTier(input.paper.summaries),
    },
    warnings: input.paper.warnings,
  }));

  return {
    pagesWritten,
    linksWritten: linksToWrite.length,
    records,
  };
}

export async function materializePaperCorpusManifestToGbrain(
  input: MaterializePaperCorpusManifestInput,
): Promise<MaterializePaperCorpusManifestResult> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const actor = input.actor ?? getCurrentUserHandle();
  const projectBrainRoot = getProjectBrainRootForBrainRoot(input.project, input.brainRoot);
  const client = input.client ?? createInProcessGbrainClient({ root: projectBrainRoot });
  await ensureBrainStoreReady({ root: projectBrainRoot });
  const store = getBrainStore({ root: projectBrainRoot });

  let pagesWritten = 0;
  let linksWritten = 0;
  const provenanceRecords: PaperProvenanceLedgerRecord[] = [];
  const warnings: PaperCorpusWarning[] = [...input.manifest.warnings];

  for (const paper of input.manifest.papers) {
    await existingLedger(input.project, paper, input.stateRoot);
    const result = await materializePaper({
      client,
      store,
      project: input.project,
      manifest: input.manifest,
      paper,
      occurredAt,
      actor,
    });
    pagesWritten += result.pagesWritten;
    linksWritten += result.linksWritten;
    provenanceRecords.push(...result.records);
    await writePaperCorpusLedger({
      project: input.project,
      paper,
      records: result.records,
      stateRoot: input.stateRoot,
    });
  }

  return {
    manifestId: input.manifest.id,
    project: input.project,
    paperCount: input.manifest.papers.length,
    pagesWritten,
    linksWritten,
    provenanceRecords,
    warnings,
  };
}

function capability(
  mode: GbrainCorpusCapability["mode"],
  status: GbrainCorpusCapability["status"],
  reason?: string,
  evidence: string[] = [],
): GbrainCorpusCapability {
  return {
    mode,
    status,
    ...(reason ? { reason } : {}),
    evidence,
  };
}

function healthEvidence(health: BrainStoreHealth): string[] {
  return [
    `pages=${health.pageCount}`,
    health.chunkCount !== undefined ? `chunks=${health.chunkCount}` : undefined,
    health.linkCount !== undefined ? `links=${health.linkCount}` : undefined,
    health.embedCoverage !== undefined ? `embedCoverage=${health.embedCoverage}` : undefined,
  ].filter((entry): entry is string => entry !== undefined);
}

export async function detectGbrainCorpusCapabilities(
  input: DetectGbrainCorpusCapabilitiesInput = {},
): Promise<GbrainCorpusCapabilities> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  let health: BrainStoreHealth;

  try {
    const store = input.store ?? getBrainStore();
    health = await store.health();
  } catch (error) {
    const reason = describeBrainBackendError(error);
    return GbrainCorpusCapabilitiesSchema.parse({
      generatedAt,
      capabilities: [
        capability("health", "unavailable", reason),
        capability("keyword_chunks", "unavailable", "gbrain health unavailable"),
        capability("embeddings", "unavailable", "gbrain health unavailable"),
        capability("typed_links", "unavailable", "gbrain health unavailable"),
        capability("backlinks", "unavailable", "gbrain health unavailable"),
        capability("frontmatter_filter", "unavailable", "gbrain health unavailable"),
        capability("section_anchors", "unavailable", "gbrain health unavailable"),
      ],
      warnings: [{
        code: "capability_unavailable",
        message: `gbrain capability detection failed: ${reason}`,
        severity: "warning",
      }],
    });
  }

  if (!health.ok) {
    const reason = health.error ?? "gbrain health check failed";
    return GbrainCorpusCapabilitiesSchema.parse({
      generatedAt,
      capabilities: [
        capability("health", "unavailable", reason, healthEvidence(health)),
        capability("keyword_chunks", "unavailable", reason),
        capability("embeddings", "unavailable", reason),
        capability("typed_links", "unavailable", reason),
        capability("backlinks", "unavailable", reason),
        capability("frontmatter_filter", "unavailable", reason),
        capability("section_anchors", "unavailable", reason),
      ],
      warnings: [{
        code: "capability_unavailable",
        message: `gbrain is not healthy for corpus retrieval: ${reason}`,
        severity: "warning",
      }],
    });
  }

  const embeddingsAvailable = (health.embedCoverage ?? 0) > 0;

  return GbrainCorpusCapabilitiesSchema.parse({
    generatedAt,
    capabilities: [
      capability("health", "available", undefined, healthEvidence(health)),
      capability("keyword_chunks", "available", undefined, healthEvidence(health)),
      capability(
        "embeddings",
        embeddingsAvailable ? "available" : "unavailable",
        embeddingsAvailable ? undefined : "embedding coverage is missing",
        healthEvidence(health),
      ),
      capability(
        "typed_links",
        "degraded",
        "using audited first-train link subset",
        healthEvidence(health),
      ),
      capability("backlinks", "available", undefined, healthEvidence(health)),
      capability(
        "frontmatter_filter",
        "degraded",
        "frontmatter filtering is currently caller-side over bounded page reads",
        healthEvidence(health),
      ),
      capability(
        "section_anchors",
        "available",
        "corpus section maps are stored in source-page frontmatter",
        healthEvidence(health),
      ),
    ],
  });
}
