import { createHash } from "node:crypto";
import path from "node:path";

import {
  PAPER_LIBRARY_STATE_VERSION,
  PaperIdentifierSchema,
  PaperLibraryGraphSchema,
  type PaperIdentifier,
  type PaperIdentityCandidate,
  type PaperLibraryErrorCode,
  type PaperLibraryGraph,
  type PaperLibraryGraphEdge,
  type PaperLibraryGraphNode,
  type PaperLibraryGraphResponse,
  type PaperLibraryGraphSourceRun,
  type PaperMetadataSource,
  type PaperReviewItem,
  type SourceRunStatus,
} from "./contracts";
import {
  buildEnrichmentCacheKey,
  getUsableCacheEntry,
  isSourcePaused,
  readEnrichmentCache,
  updateSourceHealth,
  upsertCacheEntry,
  writeEnrichmentCache,
} from "./enrichment-cache";
import { readApplyPlan, readManifestOperations } from "./apply";
import { readPaperLibraryScan } from "./jobs";
import { readAllPaperReviewItems } from "./review";
import {
  getPaperLibraryGraphPath,
  readCursorWindow,
  readPersistedState,
} from "./state";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import { extractPdfText } from "@/lib/pdf-text-extractor";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

const MAX_RELATIONS_PER_KIND = 25;
const MAX_LOCAL_REFERENCES_PER_PAPER = 250;
const REFERENCE_ENTRY_MIN_LENGTH = 20;
const LOCAL_TITLE_MATCH_THRESHOLD = 0.72;

interface PaperGraphSeed {
  item: PaperReviewItem;
  candidate: PaperIdentityCandidate;
  identifiers: PaperIdentifier;
  nodeId: string;
}

export interface PaperLibraryExternalPaper {
  sourceId?: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  identifiers?: PaperIdentifier;
  evidence?: string[];
  referenceCount?: number;
  citationCount?: number;
}

export interface PaperLibraryGraphRelations {
  references: PaperLibraryExternalPaper[];
  citations: PaperLibraryExternalPaper[];
  bridgePapers: PaperLibraryExternalPaper[];
  referenceCount?: number;
  citationCount?: number;
}

export interface PaperLibraryGraphFetchResult extends Partial<PaperLibraryGraphRelations> {
  status?: SourceRunStatus;
  errorCode?: PaperLibraryErrorCode;
  retryAfter?: string;
  message?: string;
}

export interface PaperLibraryGraphAdapter {
  source: PaperMetadataSource;
  lookupIdentifier?(identifiers: PaperIdentifier): string | null;
  fetch(seed: {
    paperId: string;
    identifiers: PaperIdentifier;
    title?: string;
    authors: string[];
    year?: number;
    venue?: string;
  }): Promise<PaperLibraryGraphFetchResult>;
}

export interface BuildPaperLibraryGraphInput {
  project: string;
  scanId: string;
  brainRoot: string;
  adapters?: PaperLibraryGraphAdapter[];
  useCache?: boolean;
  persist?: boolean;
}

function normalizeGraph(value: unknown): PaperLibraryGraph {
  const parsed = PaperLibraryGraphSchema.parse(value);
  return {
    ...parsed,
    nodes: parsed.nodes ?? [],
    edges: parsed.edges ?? [],
    sourceRuns: parsed.sourceRuns ?? [],
    warnings: parsed.warnings ?? [],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function normalizeDoi(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "")
    .toLowerCase();
  return normalized || undefined;
}

function normalizeArxivId(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/^arxiv:\s*/i, "")
    .replace(/[)\].,;:\s]+$/g, "")
    .replace(/v\d+$/i, "")
    .toLowerCase();
  return normalized || undefined;
}

function normalizePmid(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^pmid:\s*/i, "");
  return normalized || undefined;
}

function normalizeOpenAlexId(value: string | undefined): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^https?:\/\/openalex\.org\//i, "")
    .toLowerCase();
  return normalized || undefined;
}

export function normalizePaperIdentifiers(identifiers: PaperIdentifier | undefined): PaperIdentifier {
  return PaperIdentifierSchema.parse({
    doi: normalizeDoi(identifiers?.doi),
    arxivId: normalizeArxivId(identifiers?.arxivId),
    pmid: normalizePmid(identifiers?.pmid),
    openAlexId: normalizeOpenAlexId(identifiers?.openAlexId),
  });
}

export function deterministicPaperNodeId(identifiers: PaperIdentifier | undefined, fallback: string): string {
  const normalized = normalizePaperIdentifiers(identifiers);
  if (normalized.doi) return `paper:doi:${normalized.doi}`;
  if (normalized.arxivId) return `paper:arxiv:${normalized.arxivId}`;
  if (normalized.pmid) return `paper:pmid:${normalized.pmid}`;
  if (normalized.openAlexId) return `paper:openalex:${normalized.openAlexId}`;
  return fallback;
}

function identifierAliases(identifiers: PaperIdentifier | undefined): string[] {
  const normalized = normalizePaperIdentifiers(identifiers);
  return [
    normalized.doi ? `doi:${normalized.doi}` : undefined,
    normalized.arxivId ? `arxiv:${normalized.arxivId}` : undefined,
    normalized.pmid ? `pmid:${normalized.pmid}` : undefined,
    normalized.openAlexId ? `openalex:${normalized.openAlexId}` : undefined,
  ].filter((alias): alias is string => Boolean(alias));
}

function mergeUnique<T>(left: T[] | undefined, right: T[] | undefined): T[] {
  return Array.from(new Set([...(left ?? []), ...(right ?? [])]));
}

function mergeIdentifiers(left: PaperIdentifier | undefined, right: PaperIdentifier | undefined): PaperIdentifier {
  const normalizedLeft = normalizePaperIdentifiers(left);
  const normalizedRight = normalizePaperIdentifiers(right);
  return PaperIdentifierSchema.parse({
    doi: normalizedLeft.doi ?? normalizedRight.doi,
    arxivId: normalizedLeft.arxivId ?? normalizedRight.arxivId,
    pmid: normalizedLeft.pmid ?? normalizedRight.pmid,
    openAlexId: normalizedLeft.openAlexId ?? normalizedRight.openAlexId,
  });
}

function upsertNode(nodes: Map<string, PaperLibraryGraphNode>, next: PaperLibraryGraphNode): void {
  const existing = nodes.get(next.id);
  if (!existing) {
    nodes.set(next.id, next);
    return;
  }
  const local = existing.local || next.local;
  const suggestion = local ? false : existing.suggestion || next.suggestion;
  nodes.set(next.id, {
    ...existing,
    kind: local ? "local_paper" : (suggestion ? "bridge_suggestion" : existing.kind),
    paperIds: mergeUnique(existing.paperIds, next.paperIds),
    title: existing.local ? existing.title ?? next.title : next.title ?? existing.title,
    authors: existing.authors.length > 0 ? existing.authors : next.authors,
    year: existing.year ?? next.year,
    venue: existing.venue ?? next.venue,
    identifiers: mergeIdentifiers(existing.identifiers, next.identifiers),
    local,
    suggestion,
    sources: mergeUnique(existing.sources, next.sources),
    evidence: mergeUnique(existing.evidence, next.evidence),
    referenceCount: existing.referenceCount ?? next.referenceCount,
    citationCount: existing.citationCount ?? next.citationCount,
  });
}

function addEdge(edges: Map<string, PaperLibraryGraphEdge>, edge: Omit<PaperLibraryGraphEdge, "id">): void {
  const id = `edge:${stableHash({
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    kind: edge.kind,
    source: edge.source,
  })}`;
  const existing = edges.get(id);
  edges.set(id, existing ? { ...existing, evidence: mergeUnique(existing.evidence, edge.evidence) } : { id, ...edge });
}

function candidateForItem(item: PaperReviewItem): PaperIdentityCandidate | undefined {
  return item.candidates.find((candidate) => candidate.id === item.selectedCandidateId) ?? item.candidates[0];
}

function correctionString(item: PaperReviewItem, key: string): string | undefined {
  const value = item.correction?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function correctionNumber(item: PaperReviewItem, key: string): number | undefined {
  const value = item.correction?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function correctionAuthors(item: PaperReviewItem): string[] | undefined {
  const value = item.correction?.authors;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  if (typeof value === "string") return value.split(/,\s*/).filter(Boolean);
  return undefined;
}

function identifiersForItem(item: PaperReviewItem, candidate: PaperIdentityCandidate): PaperIdentifier {
  return normalizePaperIdentifiers({
    ...candidate.identifiers,
    doi: correctionString(item, "doi") ?? candidate.identifiers.doi,
    arxivId: correctionString(item, "arxiv_id") ?? correctionString(item, "arxivId") ?? candidate.identifiers.arxivId,
    pmid: correctionString(item, "pmid") ?? candidate.identifiers.pmid,
    openAlexId: correctionString(item, "openalex_id") ?? correctionString(item, "openAlexId") ?? candidate.identifiers.openAlexId,
  });
}

function seedForItem(item: PaperReviewItem): PaperGraphSeed | null {
  if (item.state === "ignored") return null;
  const candidate = candidateForItem(item);
  if (!candidate) return null;
  const identifiers = identifiersForItem(item, candidate);
  const nodeId = deterministicPaperNodeId(identifiers, `paper:local:${item.paperId}`);
  return { item, candidate, identifiers, nodeId };
}

function nodeFromSeed(seed: PaperGraphSeed): PaperLibraryGraphNode {
  const { item, candidate, identifiers } = seed;
  return {
    id: seed.nodeId,
    kind: "local_paper",
    paperIds: [item.paperId],
    title: correctionString(item, "title") ?? candidate.title,
    authors: correctionAuthors(item) ?? candidate.authors,
    year: correctionNumber(item, "year") ?? candidate.year,
    venue: correctionString(item, "venue") ?? candidate.venue,
    identifiers,
    local: true,
    suggestion: false,
    sources: [candidate.source],
    evidence: mergeUnique(candidate.evidence, [
      item.source?.relativePath ? `local:${item.source.relativePath}` : undefined,
      item.state === "corrected" ? "user_corrected" : `review:${item.state}`,
    ].filter((entry): entry is string => Boolean(entry))),
  };
}

function hasStableIdentifier(identifiers: PaperIdentifier): boolean {
  return identifierAliases(identifiers).length > 0;
}

interface ParsedPdfReference extends PaperLibraryExternalPaper {
  rawText: string;
  index: number;
}

interface LocalGraphPaper {
  nodeId: string;
  title?: string;
  normalizedTitle: string;
  titleTokens: Set<string>;
  aliases: string[];
}

const REFERENCE_DOI_RE = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;
const REFERENCE_ARXIV_RE = /\b(?:arXiv\s*:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)\b/gi;
const REFERENCE_PMID_RE = /\b(?:PMID\s*:?\s*)(\d{6,9})\b/gi;
const REFERENCE_YEAR_RE = /\b(19\d{2}|20\d{2})\b/g;

function cleanReferenceText(value: string): string {
  return value
    .replace(/\u00ad/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .trim();
}

function stripReferenceMarker(value: string): string {
  return cleanReferenceText(value)
    .replace(/^(?:\[\d{1,4}\]|\d{1,3}\.|\[[A-Za-z][A-Za-z0-9+.-]{1,16}\])\s*/, "")
    .trim();
}

function findReferenceSection(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let headingIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (index < Math.floor(lines.length * 0.25)) continue;
    if (/^(references|bibliography|works cited)$/i.test(lines[index].trim())) {
      headingIndex = index;
      break;
    }
  }
  if (headingIndex === -1) return null;

  const sectionLines: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (
      sectionLines.length > 8
      && /^(appendix|supplementary material|acknowledg(e)?ments|author contributions)$/i.test(line.trim())
    ) {
      break;
    }
    sectionLines.push(line);
  }

  const section = sectionLines.join("\n").trim();
  return section.length >= REFERENCE_ENTRY_MIN_LENGTH ? section : null;
}

function startsWithReferenceMarker(line: string): boolean {
  return /^(?:\[\d{1,4}\]|\d{1,3}\.|\[[A-Za-z][A-Za-z0-9+.-]{1,16}\])\s+/.test(line.trim());
}

function likelyAuthorYearReferenceStart(line: string): boolean {
  const trimmed = line.trim();
  if (startsWithReferenceMarker(trimmed)) return true;
  if (!/^[A-Z\p{Lu}]/u.test(trimmed)) return false;
  if (!/\b(19\d{2}|20\d{2})\b/.test(trimmed)) return false;
  if (/^(abstract|appendix|table|figure|theorem|proof|lemma)\b/i.test(trimmed)) return false;
  return /[,\.]\s+/.test(trimmed.slice(0, 160));
}

function splitReferenceEntries(section: string): string[] {
  const markerized = section
    .replace(/\r\n?/g, "\n")
    .replace(/\s+(?=(?:\[\d{1,4}\]|\d{1,3}\.|\[[A-Za-z][A-Za-z0-9+.-]{1,16}\])\s+)/g, "\n");
  const markerEntries = markerized
    .split(/\n+/)
    .map(stripReferenceMarker)
    .filter((entry) => entry.length >= REFERENCE_ENTRY_MIN_LENGTH);
  if (markerEntries.length >= 3) return markerEntries;

  const entries: string[] = [];
  let current = "";
  for (const rawLine of section.split(/\n+/)) {
    const line = cleanReferenceText(rawLine);
    if (!line) continue;
    const startsEntry = likelyAuthorYearReferenceStart(line);
    if (current && startsEntry && /[.!?)]$/.test(current)) {
      entries.push(stripReferenceMarker(current));
      current = line;
    } else {
      current = current ? `${current} ${line}` : line;
    }
  }
  if (current) entries.push(stripReferenceMarker(current));

  return entries
    .map(stripReferenceMarker)
    .filter((entry) => entry.length >= REFERENCE_ENTRY_MIN_LENGTH);
}

function allMatches(regex: RegExp, value: string): string[] {
  regex.lastIndex = 0;
  return Array.from(value.matchAll(regex), (match) => match[1] ?? match[0]);
}

function firstYear(value: string): number | undefined {
  const years = allMatches(REFERENCE_YEAR_RE, value)
    .map((year) => Number(year))
    .filter((year) => Number.isInteger(year) && year >= 1000 && year <= 3000);
  return years[years.length - 1];
}

function referenceSentences(value: string): string[] {
  return stripReferenceMarker(value)
    .replace(/\b(et al)\./gi, "$1")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((segment) => cleanReferenceText(segment.replace(/\b(et al)\b/gi, "$1.")))
    .filter(Boolean);
}

function isLikelyAuthorSegment(segment: string): boolean {
  const commaCount = (segment.match(/,/g) ?? []).length;
  const initials = (segment.match(/\b[A-Z]\./g) ?? []).length;
  const words = segment.split(/\s+/).filter(Boolean).length;
  return commaCount >= 1 || initials >= 2 || (/\band\b/i.test(segment) && words <= 12);
}

function cleanReferenceTitle(value: string): string | undefined {
  const cleaned = cleanReferenceText(value)
    .replace(/^["“”']+|["“”']+$/g, "")
    .replace(/\b(arXiv preprint|preprint|Technical report|In:|In )\b.*$/i, "")
    .replace(/\barXiv\s*:?\s*\d{4}\.\d{4,5}(?:v\d+)?.*$/i, "")
    .replace(/\bdoi:\s*10\.\d{4,9}\/\S+.*$/i, "")
    .replace(/\bURL\s+\S+.*$/i, "")
    .replace(/[.,;:\s]+$/g, "")
    .trim();
  if (cleaned.length < 8) return undefined;
  if (/^(in|doi|url|arxiv|available at|accessed)\b/i.test(cleaned)) return undefined;
  if (!/\p{L}/u.test(cleaned)) return undefined;
  return cleaned.slice(0, 220);
}

function titleFromReference(entry: string): string | undefined {
  const quoted = /["“]([^"”]{8,220})["”]/.exec(entry)?.[1];
  if (quoted) return cleanReferenceTitle(quoted);

  const sentences = referenceSentences(entry);
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    if (index === 0 && isLikelyAuthorSegment(sentence)) continue;
    const title = cleanReferenceTitle(sentence);
    if (title) return title;
  }

  return cleanReferenceTitle(sentences[0] ?? entry);
}

function authorsFromReference(entry: string): string[] {
  const first = referenceSentences(entry)[0];
  if (!first || !isLikelyAuthorSegment(first)) return [];
  return first
    .replace(/\bet al\.?$/i, "")
    .split(/\s+(?:and|&)\s+|,\s*/)
    .map((author) => author.trim())
    .filter((author) => author.length > 1 && /\p{L}/u.test(author))
    .slice(0, 12);
}

function parsePdfReference(entry: string, index: number): ParsedPdfReference | null {
  const rawText = stripReferenceMarker(entry);
  if (rawText.length < REFERENCE_ENTRY_MIN_LENGTH) return null;

  const identifiers = normalizePaperIdentifiers({
    doi: allMatches(REFERENCE_DOI_RE, rawText).map(normalizeDoi).find(Boolean),
    arxivId: allMatches(REFERENCE_ARXIV_RE, rawText).map(normalizeArxivId).find(Boolean),
    pmid: allMatches(REFERENCE_PMID_RE, rawText).map(normalizePmid).find(Boolean),
  });
  const title = titleFromReference(rawText);
  if (!title && !hasStableIdentifier(identifiers)) return null;

  return {
    sourceId: hasStableIdentifier(identifiers)
      ? identifierAliases(identifiers)[0]
      : `local-ref:${stableHash({ title, year: firstYear(rawText), rawText: rawText.slice(0, 220) })}`,
    title,
    authors: authorsFromReference(rawText),
    year: firstYear(rawText),
    identifiers,
    evidence: [`pdf_reference:${index + 1}:${rawText.slice(0, 260)}`],
    rawText,
    index,
  };
}

function normalizeTitleForMatch(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:a|an|and|for|in|of|on|the|to|via|with)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(value: string): Set<string> {
  return new Set(
    normalizeTitleForMatch(value)
      .split(/\s+/)
      .filter((token) => token.length >= 4),
  );
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.max(left.size, right.size);
}

function buildLocalGraphPapers(seeds: PaperGraphSeed[]): LocalGraphPaper[] {
  return seeds.map((seed) => {
    const title = correctionString(seed.item, "title") ?? seed.candidate.title;
    return {
      nodeId: seed.nodeId,
      title,
      normalizedTitle: normalizeTitleForMatch(title),
      titleTokens: titleTokens(title ?? ""),
      aliases: identifierAliases(seed.identifiers),
    };
  });
}

function findLocalReferenceMatch(
  reference: ParsedPdfReference,
  localPapers: LocalGraphPaper[],
  localAliasToNodeId: Map<string, string>,
  sourceNodeId: string,
): string | null {
  for (const alias of identifierAliases(reference.identifiers)) {
    const nodeId = localAliasToNodeId.get(alias);
    if (nodeId && nodeId !== sourceNodeId) return nodeId;
  }

  const referenceText = normalizeTitleForMatch(`${reference.title ?? ""} ${reference.rawText}`);
  const referenceTokens = titleTokens(referenceText);
  let best: { nodeId: string; score: number } | null = null;
  for (const paper of localPapers) {
    if (paper.nodeId === sourceNodeId || !paper.normalizedTitle) continue;
    const containsTitle = paper.normalizedTitle.length >= 16 && referenceText.includes(paper.normalizedTitle);
    const containsReferenceTitle = reference.title
      ? paper.normalizedTitle.includes(normalizeTitleForMatch(reference.title))
      : false;
    const score = containsTitle || containsReferenceTitle
      ? 1
      : tokenOverlap(paper.titleTokens, referenceTokens);
    if (score > (best?.score ?? 0)) best = { nodeId: paper.nodeId, score };
  }

  return best && best.score >= LOCAL_TITLE_MATCH_THRESHOLD ? best.nodeId : null;
}

async function readAppliedPaperPaths(
  project: string,
  scanId: string,
  brainRoot: string,
): Promise<Map<string, string>> {
  const scan = await readPaperLibraryScan(project, scanId, brainRoot);
  if (!scan?.applyPlanId) return new Map();
  const plan = await readApplyPlan(project, scan.applyPlanId, brainRoot).catch(() => null);
  if (!plan?.manifestId) return new Map();
  const operations = await readManifestOperations(project, plan.manifestId, brainRoot).catch(() => []);
  return new Map(
    operations
      .filter((operation) => operation.status === "verified" || operation.status === "applied")
      .map((operation) => [operation.paperId, operation.destinationRelativePath]),
  );
}

function pdfPathForSeed(
  seed: PaperGraphSeed,
  rootRealpath: string | undefined,
  appliedPathsByPaperId: Map<string, string>,
): string | null {
  if (!rootRealpath) return null;
  const relativePath = appliedPathsByPaperId.get(seed.item.paperId) ?? seed.item.source?.relativePath;
  return relativePath ? path.join(rootRealpath, relativePath) : null;
}

async function enrichSeedsFromLocalPdfReferences(input: {
  project: string;
  scanId: string;
  brainRoot: string;
  rootRealpath?: string;
  seeds: PaperGraphSeed[];
  nodes: Map<string, PaperLibraryGraphNode>;
  edges: Map<string, PaperLibraryGraphEdge>;
  localAliasToNodeId: Map<string, string>;
  sourceRuns: PaperLibraryGraphSourceRun[];
  warnings: string[];
}): Promise<void> {
  const appliedPathsByPaperId = await readAppliedPaperPaths(input.project, input.scanId, input.brainRoot);
  const hasReadablePdfPaths = Boolean(input.rootRealpath)
    && input.seeds.some((seed) => seed.item.source?.relativePath || appliedPathsByPaperId.has(seed.item.paperId));
  if (!hasReadablePdfPaths) return;

  const localPapers = buildLocalGraphPapers(input.seeds);

  for (const seed of input.seeds) {
    const startedAt = nowIso();
    const pdfPath = pdfPathForSeed(seed, input.rootRealpath, appliedPathsByPaperId);
    if (!pdfPath) {
      input.sourceRuns.push(sourceRun({
        source: "pdf_text",
        status: "negative",
        paperId: seed.item.paperId,
        attempts: 0,
        fetchedCount: 0,
        cacheHits: 0,
        message: "No local PDF path is available for reference extraction.",
        startedAt,
        completedAt: nowIso(),
      }));
      continue;
    }

    try {
      const extracted = await extractPdfText(pdfPath);
      const section = findReferenceSection(extracted.text);
      if (!section) {
        input.sourceRuns.push(sourceRun({
          source: "pdf_text",
          status: "negative",
          paperId: seed.item.paperId,
          attempts: 1,
          fetchedCount: 0,
          cacheHits: 0,
          message: "No references section found in local PDF text.",
          startedAt,
          completedAt: nowIso(),
        }));
        continue;
      }

      const entries = splitReferenceEntries(section);
      const parsedReferences = entries
        .slice(0, MAX_LOCAL_REFERENCES_PER_PAPER)
        .map(parsePdfReference)
        .filter((reference): reference is ParsedPdfReference => Boolean(reference));
      if (entries.length > MAX_LOCAL_REFERENCES_PER_PAPER) {
        input.warnings.push(`${seed.item.paperId}: local reference extraction capped at ${MAX_LOCAL_REFERENCES_PER_PAPER} references.`);
      }

      const relations: PaperLibraryGraphRelations = {
        references: parsedReferences.map((reference) => {
          const targetNodeId = findLocalReferenceMatch(reference, localPapers, input.localAliasToNodeId, seed.nodeId);
          if (targetNodeId) {
            return {
              ...reference,
              sourceId: targetNodeId,
              evidence: mergeUnique(reference.evidence, [`local_match:${targetNodeId}`]),
            };
          }
          return reference;
        }),
        citations: [],
        bridgePapers: [],
        referenceCount: parsedReferences.length,
      };

      for (const reference of relations.references) {
        const localTarget = reference.sourceId?.startsWith("paper:")
          ? reference.sourceId
          : findLocalReferenceMatch(reference as ParsedPdfReference, localPapers, input.localAliasToNodeId, seed.nodeId);
        if (localTarget) {
          addEdge(input.edges, {
            sourceNodeId: seed.nodeId,
            targetNodeId: localTarget,
            kind: "references",
            source: "pdf_text",
            evidence: reference.evidence ?? [`${seed.item.paperId} references ${localTarget}`],
          });
          continue;
        }
        applyRelations({
          nodes: input.nodes,
          edges: input.edges,
          localAliasToNodeId: input.localAliasToNodeId,
          sourceNodeId: seed.nodeId,
          sourcePaperId: seed.item.paperId,
          adapterSource: "pdf_text",
          relations: { references: [reference], citations: [], bridgePapers: [] },
        });
      }

      const node = input.nodes.get(seed.nodeId);
      if (node) input.nodes.set(seed.nodeId, { ...node, referenceCount: parsedReferences.length });
      input.sourceRuns.push(sourceRun({
        source: "pdf_text",
        status: parsedReferences.length > 0 ? "success" : "negative",
        paperId: seed.item.paperId,
        attempts: 1,
        fetchedCount: parsedReferences.length,
        cacheHits: 0,
        message: `Extracted ${parsedReferences.length} local PDF references.`,
        startedAt,
        completedAt: nowIso(),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local PDF reference extraction failed.";
      input.warnings.push(`${seed.item.paperId}:pdf_text:${message}`);
      input.sourceRuns.push(sourceRun({
        source: "pdf_text",
        status: "metadata_unavailable",
        paperId: seed.item.paperId,
        attempts: 1,
        fetchedCount: 0,
        cacheHits: 0,
        errorCode: "metadata_unavailable",
        message,
        startedAt,
        completedAt: nowIso(),
      }));
    }
  }
}

function cacheIdentifier(identifiers: PaperIdentifier): string | null {
  const normalized = normalizePaperIdentifiers(identifiers);
  if (normalized.doi) return `doi:${normalized.doi}`;
  if (normalized.arxivId) return `arxiv:${normalized.arxivId}`;
  if (normalized.pmid) return `pmid:${normalized.pmid}`;
  if (normalized.openAlexId) return `openalex:${normalized.openAlexId}`;
  return null;
}

function normalizeRelations(result: PaperLibraryGraphFetchResult): PaperLibraryGraphRelations {
  return {
    references: (result.references ?? []).slice(0, MAX_RELATIONS_PER_KIND),
    citations: (result.citations ?? []).slice(0, MAX_RELATIONS_PER_KIND),
    bridgePapers: (result.bridgePapers ?? []).slice(0, MAX_RELATIONS_PER_KIND),
    referenceCount: result.referenceCount,
    citationCount: result.citationCount,
  };
}

function relationCount(relations: PaperLibraryGraphRelations): number {
  return relations.references.length + relations.citations.length + relations.bridgePapers.length;
}

function relationsFromCacheValue(value: unknown): PaperLibraryGraphRelations {
  if (typeof value !== "object" || value === null) {
    return { references: [], citations: [], bridgePapers: [] };
  }
  const record = value as Partial<PaperLibraryGraphRelations>;
  return normalizeRelations({
    references: Array.isArray(record.references) ? record.references : [],
    citations: Array.isArray(record.citations) ? record.citations : [],
    bridgePapers: Array.isArray(record.bridgePapers) ? record.bridgePapers : [],
    referenceCount: typeof record.referenceCount === "number" ? record.referenceCount : undefined,
    citationCount: typeof record.citationCount === "number" ? record.citationCount : undefined,
  });
}

function retryAfterIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(Date.now() + Math.max(0, value) * 1000).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return new Date(Date.now() + Math.max(0, seconds) * 1000).toISOString();
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function classifyError(error: unknown): {
  status: SourceRunStatus;
  errorCode: PaperLibraryErrorCode;
  retryAfter?: string;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
  const retryAfter = retryAfterIso(
    typeof error === "object" && error !== null && "retryAfter" in error
      ? (error as { retryAfter?: unknown }).retryAfter
      : undefined,
  );
  if (status === 429 || /\b429\b|rate limit|quota/i.test(message)) {
    return { status: "rate_limited", errorCode: "metadata_unavailable", retryAfter, message };
  }
  if (status === 401 || status === 403 || /api[_ -]?key|unauthori[sz]ed|forbidden/i.test(message)) {
    return { status: "auth_unavailable", errorCode: "metadata_unavailable", message };
  }
  return { status: "metadata_unavailable", errorCode: "metadata_unavailable", message };
}

function applyRelations(input: {
  nodes: Map<string, PaperLibraryGraphNode>;
  edges: Map<string, PaperLibraryGraphEdge>;
  localAliasToNodeId: Map<string, string>;
  sourceNodeId: string;
  sourcePaperId: string;
  adapterSource: PaperMetadataSource;
  relations: PaperLibraryGraphRelations;
}): void {
  const addPaper = (
    paper: PaperLibraryExternalPaper,
    kind: "references" | "cited_by" | "bridge_suggestion",
  ): string => {
    const identifiers = normalizePaperIdentifiers(paper.identifiers);
    const localMatch = identifierAliases(identifiers)
      .map((alias) => input.localAliasToNodeId.get(alias))
      .find((nodeId): nodeId is string => Boolean(nodeId));
    if (localMatch) return localMatch;

    const fallback = paper.sourceId
      ? `paper:external:${input.adapterSource}:${paper.sourceId}`
      : `paper:external:${input.adapterSource}:${stableHash(paper)}`;
    const nodeId = deterministicPaperNodeId(identifiers, fallback);
    upsertNode(input.nodes, {
      id: nodeId,
      kind: kind === "bridge_suggestion" ? "bridge_suggestion" : "external_paper",
      paperIds: [],
      title: paper.title,
      authors: paper.authors ?? [],
      year: paper.year,
      venue: paper.venue,
      identifiers,
      local: false,
      suggestion: kind === "bridge_suggestion",
      sources: [input.adapterSource],
      evidence: mergeUnique(paper.evidence, [`${input.adapterSource}:${kind}`]),
      referenceCount: paper.referenceCount,
      citationCount: paper.citationCount,
    });
    return nodeId;
  };

  for (const reference of input.relations.references) {
    const targetNodeId = addPaper(reference, "references");
    addEdge(input.edges, {
      sourceNodeId: input.sourceNodeId,
      targetNodeId,
      kind: "references",
      source: input.adapterSource,
      evidence: [`${input.sourcePaperId} references ${targetNodeId}`],
    });
  }

  for (const citation of input.relations.citations) {
    const citingNodeId = addPaper(citation, "cited_by");
    addEdge(input.edges, {
      sourceNodeId: citingNodeId,
      targetNodeId: input.sourceNodeId,
      kind: "cited_by",
      source: input.adapterSource,
      evidence: [`${citingNodeId} cites ${input.sourcePaperId}`],
    });
  }

  for (const bridgePaper of input.relations.bridgePapers) {
    const targetNodeId = addPaper(bridgePaper, "bridge_suggestion");
    addEdge(input.edges, {
      sourceNodeId: input.sourceNodeId,
      targetNodeId,
      kind: "bridge_suggestion",
      source: input.adapterSource,
      evidence: [`${input.sourcePaperId} may connect through ${targetNodeId}`],
    });
  }
}

function sourceRun(input: Omit<PaperLibraryGraphSourceRun, "id">): PaperLibraryGraphSourceRun {
  return {
    id: `source-run:${stableHash(input)}`,
    ...input,
  };
}

async function enrichSeed(input: {
  seed: PaperGraphSeed;
  adapter: PaperLibraryGraphAdapter;
  useCache: boolean;
  project: string;
  stateRoot: string;
  nodes: Map<string, PaperLibraryGraphNode>;
  edges: Map<string, PaperLibraryGraphEdge>;
  localAliasToNodeId: Map<string, string>;
  sourceRuns: PaperLibraryGraphSourceRun[];
  warnings: string[];
}): Promise<void> {
  const startedAt = nowIso();
  const identifier = input.adapter.lookupIdentifier?.(input.seed.identifiers) ?? cacheIdentifier(input.seed.identifiers);
  if (!identifier) {
    input.sourceRuns.push(sourceRun({
      source: input.adapter.source,
      status: "negative",
      paperId: input.seed.item.paperId,
      attempts: 0,
      fetchedCount: 0,
      cacheHits: 0,
      message: `No supported identifier available for ${input.adapter.source} graph enrichment.`,
      startedAt,
      completedAt: nowIso(),
    }));
    return;
  }

  let cache = await readEnrichmentCache(input.project, input.stateRoot);
  if (isSourcePaused(cache, input.adapter.source)) {
    const health = cache.sourceHealth[input.adapter.source];
    input.sourceRuns.push(sourceRun({
      source: input.adapter.source,
      status: "paused",
      paperId: input.seed.item.paperId,
      identifier,
      attempts: 0,
      fetchedCount: 0,
      cacheHits: 0,
      retryAfter: health?.retryAfter,
      message: "External graph source is paused after repeated failures.",
      startedAt,
      completedAt: nowIso(),
    }));
    return;
  }

  const key = buildEnrichmentCacheKey(input.adapter.source, identifier);
  const cached = input.useCache ? getUsableCacheEntry(cache, key) : null;
  if (cached) {
    const relations = cached.status === "success" ? relationsFromCacheValue(cached.value) : undefined;
    if (relations) {
      applyRelations({
        nodes: input.nodes,
        edges: input.edges,
        localAliasToNodeId: input.localAliasToNodeId,
        sourceNodeId: input.seed.nodeId,
        sourcePaperId: input.seed.item.paperId,
        adapterSource: input.adapter.source,
        relations,
      });
    }
    input.sourceRuns.push(sourceRun({
      source: input.adapter.source,
      status: cached.status,
      paperId: input.seed.item.paperId,
      identifier,
      attempts: cached.attempts,
      fetchedCount: relations ? relationCount(relations) : 0,
      cacheHits: 1,
      retryAfter: cached.retryAfter,
      errorCode: cached.errorCode,
      startedAt,
      completedAt: nowIso(),
    }));
    return;
  }

  try {
    const result = await input.adapter.fetch({
      paperId: input.seed.item.paperId,
      identifiers: input.seed.identifiers,
      title: correctionString(input.seed.item, "title") ?? input.seed.candidate.title,
      authors: correctionAuthors(input.seed.item) ?? input.seed.candidate.authors,
      year: correctionNumber(input.seed.item, "year") ?? input.seed.candidate.year,
      venue: correctionString(input.seed.item, "venue") ?? input.seed.candidate.venue,
    });
    const relations = normalizeRelations(result);
    const fetchedCount = relationCount(relations);
    const status = result.status ?? (fetchedCount > 0 ? "success" : "negative");
    if (status === "success") {
      applyRelations({
        nodes: input.nodes,
        edges: input.edges,
        localAliasToNodeId: input.localAliasToNodeId,
        sourceNodeId: input.seed.nodeId,
        sourcePaperId: input.seed.item.paperId,
        adapterSource: input.adapter.source,
        relations,
      });
    }
    cache = upsertCacheEntry(cache, {
      key,
      source: input.adapter.source,
      status,
      value: status === "success" ? relations : undefined,
      errorCode: result.errorCode,
      retryAfter: retryAfterIso(result.retryAfter),
    });
    cache = updateSourceHealth(cache, {
      source: input.adapter.source,
      status: status === "success" || status === "negative" ? "healthy" : "degraded",
      retryAfter: retryAfterIso(result.retryAfter),
      failure: status !== "success" && status !== "negative",
    });
    await writeEnrichmentCache(input.project, cache, input.stateRoot);

    input.sourceRuns.push(sourceRun({
      source: input.adapter.source,
      status,
      paperId: input.seed.item.paperId,
      identifier,
      attempts: cache.entries[key]?.attempts ?? 1,
      fetchedCount,
      cacheHits: 0,
      retryAfter: retryAfterIso(result.retryAfter),
      errorCode: result.errorCode,
      message: result.message,
      startedAt,
      completedAt: nowIso(),
    }));
  } catch (error) {
    const classified = classifyError(error);
    input.warnings.push(`${input.adapter.source}:${input.seed.item.paperId}:${classified.message}`);
    cache = upsertCacheEntry(cache, {
      key,
      source: input.adapter.source,
      status: classified.status,
      errorCode: classified.errorCode,
      retryAfter: classified.retryAfter,
    });
    cache = updateSourceHealth(cache, {
      source: input.adapter.source,
      status: "degraded",
      retryAfter: classified.retryAfter,
      failure: true,
    });
    await writeEnrichmentCache(input.project, cache, input.stateRoot);
    input.sourceRuns.push(sourceRun({
      source: input.adapter.source,
      status: classified.status,
      paperId: input.seed.item.paperId,
      identifier,
      attempts: cache.entries[key]?.attempts ?? 1,
      fetchedCount: 0,
      cacheHits: 0,
      retryAfter: classified.retryAfter,
      errorCode: classified.errorCode,
      message: classified.message,
      startedAt,
      completedAt: nowIso(),
    }));
  }
}

export async function buildPaperLibraryGraph(input: BuildPaperLibraryGraphInput): Promise<PaperLibraryGraph | null> {
  const review = await readAllPaperReviewItems(input.project, input.scanId, input.brainRoot);
  if (!review) return null;

  const nodes = new Map<string, PaperLibraryGraphNode>();
  const edges = new Map<string, PaperLibraryGraphEdge>();
  const sourceRuns: PaperLibraryGraphSourceRun[] = [];
  const warnings: string[] = [];
  const seeds = review.items
    .map(seedForItem)
    .filter((seed): seed is PaperGraphSeed => Boolean(seed));
  const localAliasToNodeId = new Map<string, string>();

  for (const seed of seeds) {
    upsertNode(nodes, nodeFromSeed(seed));
    for (const alias of identifierAliases(seed.identifiers)) {
      const existingNodeId = localAliasToNodeId.get(alias);
      if (existingNodeId && existingNodeId !== seed.nodeId) {
        addEdge(edges, {
          sourceNodeId: existingNodeId,
          targetNodeId: seed.nodeId,
          kind: "same_identity",
          source: "gbrain",
          evidence: [`shared_identifier:${alias}`],
        });
      }
      localAliasToNodeId.set(alias, existingNodeId ?? seed.nodeId);
    }
  }

  await enrichSeedsFromLocalPdfReferences({
    project: input.project,
    scanId: input.scanId,
    brainRoot: input.brainRoot,
    rootRealpath: review.scan.rootRealpath ?? review.scan.rootPath,
    seeds,
    nodes,
    edges,
    localAliasToNodeId,
    sourceRuns,
    warnings,
  });

  const adapters = input.adapters ?? [createSemanticScholarGraphAdapter()];
  for (const seed of seeds.filter((entry) => hasStableIdentifier(entry.identifiers))) {
    for (const adapter of adapters) {
      await enrichSeed({
        seed,
        adapter,
        useCache: input.useCache ?? true,
        project: input.project,
        stateRoot: review.stateRoot,
        nodes,
        edges,
        localAliasToNodeId,
        sourceRuns,
        warnings,
      });
    }
  }

  const createdAt = nowIso();
  const graph = PaperLibraryGraphSchema.parse({
    version: PAPER_LIBRARY_STATE_VERSION,
    project: input.project,
    scanId: input.scanId,
    createdAt,
    updatedAt: createdAt,
    nodes: Array.from(nodes.values()).sort((left, right) => left.id.localeCompare(right.id)),
    edges: Array.from(edges.values()).sort((left, right) => left.id.localeCompare(right.id)),
    sourceRuns,
    warnings,
  });
  if (input.persist !== false) {
    await writeJsonFile(getPaperLibraryGraphPath(input.project, input.scanId, review.stateRoot), graph);
  }
  return graph;
}

export async function readPaperLibraryGraph(
  project: string,
  scanId: string,
  brainRoot: string,
): Promise<PaperLibraryGraph | null> {
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const parsed = await readPersistedState(
    getPaperLibraryGraphPath(project, scanId, stateRoot),
    PaperLibraryGraphSchema,
    "paper-library graph",
  );
  return parsed.ok ? normalizeGraph(parsed.data) : null;
}

export async function getOrBuildPaperLibraryGraph(input: BuildPaperLibraryGraphInput & { refresh?: boolean }): Promise<PaperLibraryGraph | null> {
  if (!input.refresh) {
    const raw = await readJsonFile<unknown>(
      getPaperLibraryGraphPath(input.project, input.scanId, getProjectStateRootForBrainRoot(input.project, input.brainRoot)),
    );
    if (raw) {
      try {
        const graph = normalizeGraph(raw);
        const scan = await readPaperLibraryScan(input.project, input.scanId, input.brainRoot);
        if (!scan) return null;
        if (Date.parse(graph.updatedAt) >= Date.parse(scan.updatedAt)) return graph;
      } catch {
        // Malformed or version-mismatched graph cache falls through to a rebuild.
      }
    }
  }
  return buildPaperLibraryGraph(input);
}

export function windowPaperLibraryGraph(
  graph: PaperLibraryGraph,
  options: { cursor?: string; limit?: number; focusNodeId?: string; all?: boolean },
): PaperLibraryGraphResponse {
  const focus = options.focusNodeId;
  const focusNeighbors = new Set<string>();
  if (focus) {
    focusNeighbors.add(focus);
    for (const edge of graph.edges) {
      if (edge.sourceNodeId === focus) focusNeighbors.add(edge.targetNodeId);
      if (edge.targetNodeId === focus) focusNeighbors.add(edge.sourceNodeId);
    }
  }
  const filteredNodes = focus
    ? graph.nodes.filter((node) => focusNeighbors.has(node.id))
    : graph.nodes;
  if (options.all) {
    const visibleIds = new Set(filteredNodes.map((node) => node.id));
    return {
      nodes: filteredNodes,
      edges: graph.edges.filter((edge) => visibleIds.has(edge.sourceNodeId) && visibleIds.has(edge.targetNodeId)),
      loadedNodeCount: filteredNodes.length,
      totalEdgeCount: graph.edges.length,
      sourceRuns: graph.sourceRuns,
      warnings: graph.warnings,
      nextCursor: undefined,
      totalCount: graph.nodes.length,
      filteredCount: filteredNodes.length,
    };
  }
  const page = readCursorWindow(filteredNodes, { cursor: options.cursor, limit: options.limit });
  const filteredNodeIds = new Set(filteredNodes.map((node) => node.id));
  const primaryIds = new Set(page.items.map((node) => node.id));
  const included = new Set(primaryIds);
  const visibleEdges = graph.edges.filter((edge) => {
    if (!filteredNodeIds.has(edge.sourceNodeId) || !filteredNodeIds.has(edge.targetNodeId)) return false;
    return primaryIds.has(edge.sourceNodeId) || primaryIds.has(edge.targetNodeId);
  });
  for (const edge of visibleEdges) {
    included.add(edge.sourceNodeId);
    included.add(edge.targetNodeId);
  }
  const nodesById = new Map(filteredNodes.map((node) => [node.id, node]));
  const nodes = page.items.slice();
  for (const nodeId of included) {
    if (primaryIds.has(nodeId)) continue;
    const node = nodesById.get(nodeId);
    if (node) nodes.push(node);
  }
  const includeMetadata = !options.cursor;
  return {
    nodes,
    edges: visibleEdges,
    loadedNodeCount: page.items.length,
    totalEdgeCount: graph.edges.length,
    sourceRuns: includeMetadata ? graph.sourceRuns : [],
    warnings: includeMetadata ? graph.warnings : [],
    nextCursor: page.nextCursor,
    totalCount: graph.nodes.length,
    filteredCount: filteredNodes.length,
  };
}

const SEMANTIC_SCHOLAR_GRAPH_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "year",
  "venue",
  "referenceCount",
  "citationCount",
  "references.paperId",
  "references.externalIds",
  "references.title",
  "references.year",
  "references.venue",
  "citations.paperId",
  "citations.externalIds",
  "citations.title",
  "citations.year",
  "citations.venue",
].join(",");

export function createSemanticScholarGraphAdapter(): PaperLibraryGraphAdapter {
  return {
    source: "semantic_scholar",
    lookupIdentifier: semanticScholarLookupId,
    async fetch(seed) {
      const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim();
      if (!apiKey) {
        return {
          status: "auth_unavailable",
          errorCode: "metadata_unavailable",
          message: "SEMANTIC_SCHOLAR_API_KEY is not configured.",
        };
      }
      const semanticId = semanticScholarLookupId(seed.identifiers);
      if (!semanticId) {
        return { status: "negative", message: "No Semantic Scholar lookup identifier available." };
      }
      const params = new URLSearchParams({ fields: SEMANTIC_SCHOLAR_GRAPH_FIELDS });
      const response = await fetch(
        `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(semanticId)}?${params}`,
        {
          headers: { "x-api-key": apiKey },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (response.status === 429) {
        return {
          status: "rate_limited",
          errorCode: "metadata_unavailable",
          retryAfter: retryAfterIso(response.headers.get("retry-after")),
          message: "Semantic Scholar rate limit reached.",
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          status: "auth_unavailable",
          errorCode: "metadata_unavailable",
          message: "Semantic Scholar credentials were rejected.",
        };
      }
      if (!response.ok) {
        return {
          status: response.status === 404 ? "negative" : "metadata_unavailable",
          errorCode: "metadata_unavailable",
          message: `Semantic Scholar returned HTTP ${response.status}.`,
        };
      }
      let raw: unknown;
      try {
        raw = await response.json();
      } catch (error) {
        return {
          status: "metadata_unavailable",
          errorCode: "metadata_unavailable",
          message: `Malformed Semantic Scholar graph payload: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const relations = parseSemanticScholarGraph(raw);
      return {
        status: relationCount(relations) > 0 ? "success" : "negative",
        ...relations,
      };
    },
  };
}

function semanticScholarLookupId(identifiers: PaperIdentifier): string | null {
  const normalized = normalizePaperIdentifiers(identifiers);
  if (normalized.doi) return `DOI:${normalized.doi}`;
  if (normalized.arxivId) return `ARXIV:${normalized.arxivId}`;
  if (normalized.pmid) return `PMID:${normalized.pmid}`;
  // Semantic Scholar's documented paper lookup examples cover DOI, arXiv, PMID, and Semantic Scholar paper IDs.
  // OpenAlex IDs remain useful as local graph identities, but we do not attempt to query them here.
  return null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseSemanticScholarGraph(raw: unknown): PaperLibraryGraphRelations {
  const record = readRecord(raw);
  return {
    references: readArray(record.references)
      .map(parseSemanticScholarPaper)
      .filter((paper): paper is PaperLibraryExternalPaper => Boolean(paper))
      .slice(0, MAX_RELATIONS_PER_KIND),
    citations: readArray(record.citations)
      .map(parseSemanticScholarPaper)
      .filter((paper): paper is PaperLibraryExternalPaper => Boolean(paper))
      .slice(0, MAX_RELATIONS_PER_KIND),
    bridgePapers: [],
    referenceCount: readNumber(record.referenceCount),
    citationCount: readNumber(record.citationCount),
  };
}

function parseSemanticScholarPaper(value: unknown): PaperLibraryExternalPaper | null {
  const record = readRecord(value);
  const paper = readRecord(record.citedPaper ?? record.citingPaper ?? value);
  const sourceId = readString(paper.paperId);
  const externalIds = readRecord(paper.externalIds);
  const identifiers = normalizePaperIdentifiers({
    doi: readString(externalIds.DOI),
    arxivId: readString(externalIds.ArXiv),
    pmid: readString(externalIds.PubMed),
    openAlexId: readString(externalIds.OpenAlex),
  });
  if (!sourceId && !readString(paper.title) && !hasStableIdentifier(identifiers)) return null;
  return {
    sourceId,
    title: readString(paper.title),
    year: readNumber(paper.year),
    venue: readString(paper.venue),
    identifiers,
    evidence: sourceId ? [`semantic_scholar:${sourceId}`] : ["semantic_scholar"],
  };
}
