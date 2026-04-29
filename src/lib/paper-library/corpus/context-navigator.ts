import {
  GbrainCorpusCapabilitiesSchema,
  ResearchContextPacketSchema,
  type GbrainChunkHandle,
  type GbrainCorpusCapabilities,
  type PaperCorpusWarning,
  type PaperSummaryTier,
  type ResearchContextGraphPath,
  type ResearchContextMissingPaper,
  type ResearchContextPacket,
  type ResearchContextPaper,
} from "./contracts";

export interface CorpusContextPage {
  path: string;
  title: string;
  type: string;
  content: string;
  frontmatter?: Record<string, unknown>;
}

export interface BuildResearchContextPacketFromPagesInput {
  studySlug: string;
  question: string;
  pages: readonly CorpusContextPage[];
  capabilities?: GbrainCorpusCapabilities;
  generatedAt?: string;
  selectionLimit?: number;
}

export const RESEARCH_CONTEXT_SELECTION_POLICY = "local-literature-first-v1";

const DEFAULT_SELECTION_LIMIT = 6;
const SUMMARY_TIERS: readonly PaperSummaryTier[] = ["relevance", "brief", "detailed"];

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
}

function normalizeSlug(slug: string): string {
  return slug.replace(/\.md$/i, "");
}

function pageFrontmatter(page: CorpusContextPage): Record<string, unknown> {
  return page.frontmatter ?? {};
}

function pagePaperSlug(page: CorpusContextPage): string | null {
  const frontmatter = pageFrontmatter(page);
  return readString(frontmatter.paper_slug)
    ?? readString(readRecord(frontmatter.scientific_corpus)?.paper_slug)
    ?? (isPaperPage(page) ? normalizeSlug(page.path) : null);
}

function isPaperPage(page: CorpusContextPage): boolean {
  const frontmatter = pageFrontmatter(page);
  return readString(frontmatter.entity_type) === "paper"
    || readString(frontmatter.type) === "paper"
    || readRecord(frontmatter.scientific_corpus) !== null;
}

function summaryTier(page: CorpusContextPage): PaperSummaryTier | null {
  const kind = readString(pageFrontmatter(page).summary_kind);
  if (kind === "paper_relevance") return "relevance";
  if (kind === "paper_brief") return "brief";
  if (kind === "paper_detailed") return "detailed";
  return null;
}

function isPaperSourcePage(page: CorpusContextPage): boolean {
  const frontmatter = pageFrontmatter(page);
  return readString(frontmatter.source_kind) === "paper_source_text"
    || readString(frontmatter.entity_type) === "paper_source";
}

function isBibliographyPage(page: CorpusContextPage): boolean {
  const frontmatter = pageFrontmatter(page);
  return readString(frontmatter.entity_type) === "bibliography_entry"
    || readString(frontmatter.type) === "bibliography_entry";
}

function pageScore(page: CorpusContextPage, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const haystack = [
    page.title,
    page.path,
    page.content.slice(0, 5000),
    JSON.stringify(page.frontmatter ?? {}),
  ].join(" ").toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function sourceWarnings(source: CorpusContextPage | undefined): string[] {
  if (!source) return [];
  const quality = readRecord(pageFrontmatter(source).quality);
  const warnings = readArray(quality?.warnings ?? pageFrontmatter(source).warnings);
  return warnings.flatMap((warning) => {
    const record = readRecord(warning);
    const code = readString(record?.code);
    const message = readString(record?.message);
    if (code && message) return [`${code}: ${message}`];
    if (code) return [code];
    return [];
  });
}

function chunkHandlesFromSource(source: CorpusContextPage | undefined): GbrainChunkHandle[] {
  if (!source) return [];
  const sectionMap = readRecord(pageFrontmatter(source).section_map);
  const sections = readArray(sectionMap?.sections);
  const handles: GbrainChunkHandle[] = [];
  for (const section of sections) {
    const record = readRecord(section);
    for (const handle of readArray(record?.chunkHandles)) {
      const handleRecord = readRecord(handle);
      const sourceSlug = readString(handleRecord?.sourceSlug) ?? source.path;
      const chunkId = readString(handleRecord?.chunkId)
        ?? (typeof handleRecord?.chunkId === "number" ? handleRecord.chunkId : undefined);
      const chunkIndex = typeof handleRecord?.chunkIndex === "number" ? handleRecord.chunkIndex : undefined;
      const sectionId = readString(handleRecord?.sectionId) ?? readString(record?.sectionId) ?? undefined;
      if (chunkId === undefined && chunkIndex === undefined && sectionId === undefined) continue;
      handles.push({
        sourceSlug,
        ...(chunkId !== undefined ? { chunkId } : {}),
        ...(chunkIndex !== undefined ? { chunkIndex } : {}),
        ...(sectionId ? { sectionId } : {}),
      });
    }
  }
  return handles.slice(0, 4);
}

function graphPathsForPaper(input: {
  paperSlug: string;
  source?: CorpusContextPage;
  summaries: Partial<Record<PaperSummaryTier, CorpusContextPage>>;
  bibliography: readonly CorpusContextPage[];
}): ResearchContextGraphPath[] {
  const paths: ResearchContextGraphPath[] = [];
  if (input.source) {
    paths.push({
      from: input.paperSlug,
      relation: "has_source",
      to: input.source.path,
      evidence: ["source page frontmatter"],
    });
  }
  for (const tier of SUMMARY_TIERS) {
    const summary = input.summaries[tier];
    if (!summary) continue;
    paths.push({
      from: input.paperSlug,
      relation: "has_summary",
      to: summary.path,
      evidence: [`${tier} summary frontmatter`],
    });
  }
  for (const entry of input.bibliography) {
    paths.push({
      from: input.paperSlug,
      relation: "cites",
      to: entry.path,
      evidence: ["bibliography seen_in metadata"],
    });
  }
  return paths;
}

function bibliographyForPaper(
  bibliographyPages: readonly CorpusContextPage[],
  paperSlug: string,
): CorpusContextPage[] {
  const normalizedPaperSlug = normalizeSlug(paperSlug);
  return bibliographyPages.filter((page) => {
    const seenIn = readArray(pageFrontmatter(page).seen_in);
    return seenIn.some((entry) => {
      const seenPaperSlug = readString(readRecord(entry)?.paperSlug);
      return Boolean(seenPaperSlug && normalizeSlug(seenPaperSlug) === normalizedPaperSlug);
    });
  });
}

function missingPapersForSelection(
  bibliographyPages: readonly CorpusContextPage[],
  selectedPaperSlugs: ReadonlySet<string>,
): ResearchContextMissingPaper[] {
  const missing: ResearchContextMissingPaper[] = [];
  for (const page of bibliographyPages) {
    const frontmatter = pageFrontmatter(page);
    const localStatus = readString(frontmatter.local_status);
    if (localStatus === "local") continue;
    const seenIn = readArray(frontmatter.seen_in);
    const selectedSeenIn = seenIn.find((entry) => {
      const paperSlug = readString(readRecord(entry)?.paperSlug);
      return Boolean(paperSlug && selectedPaperSlugs.has(normalizeSlug(paperSlug)));
    });
    if (!selectedSeenIn) continue;
    missing.push({
      bibliographySlug: page.path,
      reason: `Cited by ${readString(readRecord(selectedSeenIn)?.paperSlug) ?? "a selected local paper"} but not available as a local corpus source.`,
      acquisitionStatus: localStatus === "unresolved" ? "unresolved" : "metadata_only",
    });
  }
  return missing.slice(0, 8);
}

function fallbackCapabilities(generatedAt: string): GbrainCorpusCapabilities {
  return GbrainCorpusCapabilitiesSchema.parse({
    generatedAt,
    capabilities: [],
  });
}

function capabilityCaveats(capabilities: GbrainCorpusCapabilities): string[] {
  return capabilities.capabilities
    .filter((capability) => capability.status !== "available")
    .map((capability) => `${capability.mode}: ${capability.status}${capability.reason ? ` - ${capability.reason}` : ""}`);
}

export function buildResearchContextPacketFromPages(
  input: BuildResearchContextPacketFromPagesInput,
): ResearchContextPacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const capabilities = input.capabilities ?? fallbackCapabilities(generatedAt);
  const terms = tokenize(input.question);
  const paperPages = input.pages.filter(isPaperPage);
  const sourcePages = input.pages.filter(isPaperSourcePage);
  const summaryPages = input.pages.filter((page) => summaryTier(page) !== null);
  const bibliographyPages = input.pages.filter(isBibliographyPage);

  const sourceByPaper = new Map<string, CorpusContextPage>();
  for (const source of sourcePages) {
    const paperSlug = pagePaperSlug(source);
    if (paperSlug) sourceByPaper.set(normalizeSlug(paperSlug), source);
  }

  const summariesByPaper = new Map<string, Partial<Record<PaperSummaryTier, CorpusContextPage>>>();
  for (const summary of summaryPages) {
    const paperSlug = pagePaperSlug(summary);
    const tier = summaryTier(summary);
    if (!paperSlug || !tier) continue;
    const current = summariesByPaper.get(normalizeSlug(paperSlug)) ?? {};
    current[tier] = summary;
    summariesByPaper.set(normalizeSlug(paperSlug), current);
  }

  const scoredPapers = paperPages.map((paperPage) => {
    const paperSlug = normalizeSlug(pagePaperSlug(paperPage) ?? paperPage.path);
    const source = sourceByPaper.get(paperSlug);
    const summaries = summariesByPaper.get(paperSlug) ?? {};
    const relatedPages = [
      paperPage,
      source,
      ...SUMMARY_TIERS.map((tier) => summaries[tier]),
    ].filter((page): page is CorpusContextPage => Boolean(page));
    const score = relatedPages.reduce((total, page) => total + pageScore(page, terms), 0);
    return {
      paperPage,
      paperSlug,
      source,
      summaries,
      score,
    };
  }).sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) return scoreDelta;
    return left.paperSlug.localeCompare(right.paperSlug);
  });

  const selected = scoredPapers
    .filter((entry, index) => entry.score > 0 || index < Math.min(3, scoredPapers.length))
    .slice(0, input.selectionLimit ?? DEFAULT_SELECTION_LIMIT);
  const selectedPaperSlugs = new Set(selected.map((entry) => entry.paperSlug));
  const caveats = capabilityCaveats(capabilities);
  const papers: ResearchContextPaper[] = selected.map((entry, index) => {
    const bibliography = bibliographyForPaper(bibliographyPages, entry.paperSlug);
    const chunkHandles = chunkHandlesFromSource(entry.source);
    const sourceCaveats = sourceWarnings(entry.source);
    const role = entry.score > 0
      ? index === 0 ? "core" : "supporting"
      : "background";
    return {
      paperSlug: entry.paperSlug,
      title: entry.paperPage.title,
      role,
      reasonSelected: entry.score > 0
        ? "Matched the question against corpus paper, source, or summary text."
        : "Included as an available local corpus paper despite weak lexical match.",
      relevanceCardSlug: entry.summaries.relevance?.path,
      briefSummarySlug: entry.summaries.brief?.path,
      detailedSummarySlug: entry.summaries.detailed?.path,
      sourceChunks: chunkHandles,
      graphPaths: graphPathsForPaper({
        paperSlug: entry.paperSlug,
        source: entry.source,
        summaries: entry.summaries,
        bibliography,
      }),
      caveats: sourceCaveats,
    };
  });

  const firstChunks = papers.flatMap((paper) => paper.sourceChunks).slice(0, 6);
  const warnings: PaperCorpusWarning[] = [
    ...capabilities.warnings,
    ...(papers.length === 0 ? [{
      code: "insufficient_local_evidence" as const,
      message: "No local corpus paper matched the question.",
      severity: "warning" as const,
    }] : []),
  ];

  return ResearchContextPacketSchema.parse({
    question: input.question,
    generatedAt,
    studySlug: input.studySlug,
    selectionPolicy: RESEARCH_CONTEXT_SELECTION_POLICY,
    capabilities,
    papers,
    claims: papers.length > 0 ? [{
      id: "local-corpus-selection",
      statement: `Selected ${papers.length} local corpus paper${papers.length === 1 ? "" : "s"} for this question.`,
      confidence: firstChunks.length > 0 ? "medium" : "low",
      supportingChunks: firstChunks,
      paperSlugs: papers.map((paper) => paper.paperSlug),
      caveats,
    }] : [{
      id: "local-corpus-selection",
      statement: "The local corpus did not provide enough evidence to select a paper.",
      confidence: "insufficient",
      supportingChunks: [],
      paperSlugs: [],
      caveats,
    }],
    tensions: [],
    missingPapers: missingPapersForSelection(bibliographyPages, selectedPaperSlugs),
    caveats,
    warnings,
  });
}

export function researchContextPacketPageSlugs(packet: ResearchContextPacket): string[] {
  const slugs = new Set<string>();
  for (const paper of packet.papers) {
    slugs.add(paper.paperSlug);
    if (paper.relevanceCardSlug) slugs.add(paper.relevanceCardSlug);
    if (paper.briefSummarySlug) slugs.add(paper.briefSummarySlug);
    if (paper.detailedSummarySlug) slugs.add(paper.detailedSummarySlug);
    for (const chunk of paper.sourceChunks) {
      slugs.add(chunk.sourceSlug);
    }
    for (const graphPath of paper.graphPaths) {
      slugs.add(graphPath.from);
      slugs.add(graphPath.to);
    }
  }
  for (const missingPaper of packet.missingPapers) {
    slugs.add(missingPaper.bibliographySlug);
  }
  return [...slugs].map(normalizeSlug);
}

export function formatResearchContextPacketForPrompt(packet: ResearchContextPacket): string {
  return JSON.stringify(packet, null, 2);
}
