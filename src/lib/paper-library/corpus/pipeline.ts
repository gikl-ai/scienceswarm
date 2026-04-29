import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { shouldSkipImportDirectory, shouldSkipImportFile } from "@/lib/import/ignore";
import { extractPdfText, type PdfExtractResult } from "@/lib/pdf-text-extractor";
import type { PaperReviewItem } from "../contracts";
import {
  PaperIngestManifestSchema,
  PaperIngestPaperSchema,
  PaperProvenanceLedgerRecordSchema,
  PaperSourceCandidateSchema,
  type BibliographyEntryArtifact,
  type CorpusArtifactStatus,
  type PaperCorpusWarning,
  type PaperIngestManifest,
  type PaperIngestPaper,
  type PaperProvenanceLedgerRecord,
  type PaperSectionMap,
  type PaperSourceArtifact,
  type PaperSourceCandidate,
  type PaperSummaryArtifact,
} from "./contracts";
import {
  extractHtmlCorpusSource,
  extractLatexCorpusSource,
  extractPdfTextCorpusSource,
} from "./extraction";
import { buildSourceChoiceProvenanceRecord } from "./provenance";
import { buildPaperCorpusManifest } from "./source-inventory";
import { writePaperCorpusManifestByScan } from "./state";
import {
  completePaperSummaryJob,
  planPaperSummaryJobs,
  runPaperSummaryJobsWithConcurrency,
  type PaperSummaryGenerationJob,
} from "./summary-planner";

export type PaperCorpusPdfExtractionPayload = Pick<PdfExtractResult, "text" | "wordCount" | "pageCount">;

type PdfExtractionByPaperId = Readonly<Record<string, PaperCorpusPdfExtractionPayload>>;

interface CandidateExtractionOutcome {
  candidate: PaperSourceCandidate;
  sourceArtifact: PaperSourceArtifact;
  sectionMap?: PaperSectionMap;
  bibliography: BibliographyEntryArtifact[];
  warnings: PaperCorpusWarning[];
}

function isSourceSidecar(name: string): boolean {
  const extension = path.posix.extname(name.toLowerCase());
  return extension === ".tex" || extension === ".html" || extension === ".htm";
}

async function walkSourceSidecars(rootRealpath: string, current: string, sidecars: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipImportDirectory(entry.name)) {
        await walkSourceSidecars(rootRealpath, absolutePath, sidecars);
      }
      continue;
    }
    if (!entry.isFile() || shouldSkipImportFile(entry.name) || !isSourceSidecar(entry.name)) continue;
    sidecars.push(path.relative(rootRealpath, absolutePath).replaceAll(path.sep, "/"));
  }
}

export async function listPaperCorpusSourceSidecars(rootRealpath: string): Promise<string[]> {
  const sidecars: string[] = [];
  await walkSourceSidecars(rootRealpath, rootRealpath, sidecars);
  return sidecars.sort((left, right) => left.localeCompare(right));
}

function uniqueWarnings(warnings: readonly PaperCorpusWarning[]): PaperCorpusWarning[] {
  const seen = new Set<string>();
  const result: PaperCorpusWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}\0${warning.message}\0${warning.artifactSlug ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
  }
  return result;
}

function corpusWarning(
  code: PaperCorpusWarning["code"],
  message: string,
  severity: PaperCorpusWarning["severity"] = "warning",
): PaperCorpusWarning {
  return { code, message, severity };
}

function resolveInsideRoot(rootRealpath: string, relativePath: string): string {
  const absolutePath = path.resolve(rootRealpath, relativePath);
  const relative = path.relative(rootRealpath, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Corpus source path escapes the selected library root: ${relativePath}`);
  }
  return absolutePath;
}

async function readOptionalUtf8(rootRealpath: string, relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(resolveInsideRoot(rootRealpath, relativePath), "utf-8");
  } catch {
    return undefined;
  }
}

function sidecarCompanionPath(relativePath: string, extension: ".bib" | ".bbl"): string {
  const parsed = path.posix.parse(relativePath.replaceAll(path.sep, "/"));
  return path.posix.join(parsed.dir, `${parsed.name}${extension}`);
}

function orderedCandidates(paper: PaperIngestPaper): PaperSourceCandidate[] {
  return [...paper.sourceCandidates].sort((left, right) => (
    left.preferenceRank - right.preferenceRank || left.id.localeCompare(right.id)
  ));
}

function markSelectedCandidate(
  candidates: readonly PaperSourceCandidate[],
  selectedCandidateId: string,
): PaperSourceCandidate[] {
  return candidates.map((candidate) => {
    if (candidate.status === "blocked" || candidate.status === "unavailable") return candidate;
    return PaperSourceCandidateSchema.parse({
      ...candidate,
      status: candidate.id === selectedCandidateId ? "preferred" : "fallback",
    });
  });
}

function provenanceStatusForSource(source: PaperSourceArtifact): PaperProvenanceLedgerRecord["status"] {
  if (source.status === "current") return "succeeded";
  if (source.status === "blocked" || source.status === "skipped") return source.status;
  if (source.status === "stale") return "stale";
  return "failed";
}

function buildExtractionProvenanceRecord(input: {
  paperSlug: string;
  occurredAt: string;
  source: PaperSourceArtifact;
}): PaperProvenanceLedgerRecord {
  return PaperProvenanceLedgerRecordSchema.parse({
    id: `extraction:${input.source.selectedCandidateId}`,
    paperSlug: input.paperSlug,
    occurredAt: input.occurredAt,
    eventType: "extraction",
    status: provenanceStatusForSource(input.source),
    sourceSlug: input.source.sourceSlug,
    artifactSlug: input.source.sourceSlug,
    sourceType: input.source.sourceType,
    inputHash: input.source.sourceHash,
    outputHash: input.source.sectionMapHash,
    message: `Extracted ${input.source.sourceType} corpus source from ${input.source.origin}.`,
    warnings: input.source.warnings,
    details: {
      origin: input.source.origin,
      extractor: input.source.extractor,
      qualityScore: input.source.quality.score,
    },
  });
}

async function extractFromCandidate(input: {
  candidate: PaperSourceCandidate;
  paper: PaperIngestPaper;
  rootRealpath: string;
  extractedAt: string;
  pdfExtractionByPaperId?: PdfExtractionByPaperId;
}): Promise<CandidateExtractionOutcome | null> {
  const title = input.paper.title ?? input.candidate.title;
  const baseInput = {
    candidate: input.candidate,
    extractedAt: input.extractedAt,
    paperSlug: input.paper.paperSlug,
    title,
  };

  if (input.candidate.origin === "arxiv_source") {
    return null;
  }

  if (input.candidate.origin === "local_sidecar" && input.candidate.relativePath) {
    if (input.candidate.sourceType === "latex") {
      const latex = await readOptionalUtf8(input.rootRealpath, input.candidate.relativePath);
      if (!latex) return null;
      const result = extractLatexCorpusSource({
        ...baseInput,
        latex,
        bibtex: await readOptionalUtf8(input.rootRealpath, sidecarCompanionPath(input.candidate.relativePath, ".bib")),
        bbl: await readOptionalUtf8(input.rootRealpath, sidecarCompanionPath(input.candidate.relativePath, ".bbl")),
      });
      return { candidate: input.candidate, ...result };
    }

    if (input.candidate.sourceType === "html") {
      const html = await readOptionalUtf8(input.rootRealpath, input.candidate.relativePath);
      if (!html) return null;
      const result = extractHtmlCorpusSource({ ...baseInput, html });
      return { candidate: input.candidate, ...result };
    }
  }

  if (input.candidate.origin === "local_pdf" && input.candidate.relativePath) {
    let extracted = input.pdfExtractionByPaperId?.[input.paper.paperId];
    if (!extracted) {
      try {
        extracted = await extractPdfText(resolveInsideRoot(input.rootRealpath, input.candidate.relativePath));
      } catch {
        extracted = { text: "", wordCount: 0, pageCount: 0 };
      }
    }
    const wordCount = extracted.wordCount ?? extracted.text.split(/\s+/).filter(Boolean).length;
    const result = extractPdfTextCorpusSource({
      ...baseInput,
      text: extracted.text,
      wordCount,
      pageCount: extracted.pageCount,
      hasTextLayer: wordCount > 0,
      scanned: wordCount === 0,
    });
    return { candidate: input.candidate, ...result };
  }

  return null;
}

async function populatePaperCorpusArtifacts(input: {
  paper: PaperIngestPaper;
  rootRealpath: string;
  extractedAt: string;
  pdfExtractionByPaperId?: PdfExtractionByPaperId;
}): Promise<PaperIngestPaper> {
  const skippedWarnings: PaperCorpusWarning[] = [];
  for (const candidate of orderedCandidates(input.paper)) {
    const outcome = await extractFromCandidate({
      candidate,
      paper: input.paper,
      rootRealpath: input.rootRealpath,
      extractedAt: input.extractedAt,
      pdfExtractionByPaperId: input.pdfExtractionByPaperId,
    });
    if (!outcome) {
      if (candidate.origin === "arxiv_source") {
        skippedWarnings.push(corpusWarning(
          "source_fallback",
          "arXiv source candidate was inventoried, but arXiv source download is not available in the local scan path yet.",
          "info",
        ));
      }
      continue;
    }

    const sourceCandidates = markSelectedCandidate(input.paper.sourceCandidates, outcome.candidate.id);
    const selectedCandidate = sourceCandidates.find((entry) => entry.id === outcome.candidate.id) ?? outcome.candidate;
    const provenance = [
      ...input.paper.provenance.filter((record) => record.eventType !== "source_choice"),
      buildSourceChoiceProvenanceRecord({
        paperSlug: input.paper.paperSlug,
        occurredAt: input.extractedAt,
        candidate: selectedCandidate,
        message: `Selected ${selectedCandidate.origin} ${selectedCandidate.sourceType} source candidate for corpus extraction.`,
      }),
      buildExtractionProvenanceRecord({
        paperSlug: input.paper.paperSlug,
        occurredAt: input.extractedAt,
        source: outcome.sourceArtifact,
      }),
    ];

    return PaperIngestPaperSchema.parse({
      ...input.paper,
      status: outcome.sourceArtifact.status,
      sourceCandidates,
      selectedSourceCandidateId: outcome.candidate.id,
      sourceArtifact: outcome.sourceArtifact,
      sectionMap: outcome.sectionMap,
      bibliography: outcome.bibliography,
      provenance,
      warnings: uniqueWarnings([...input.paper.warnings, ...skippedWarnings, ...outcome.warnings]),
    });
  }

  return PaperIngestPaperSchema.parse({
    ...input.paper,
    warnings: uniqueWarnings([...input.paper.warnings, ...skippedWarnings]),
  });
}

function manifestStatusForPapers(papers: readonly PaperIngestPaper[]): CorpusArtifactStatus {
  if (papers.length === 0) return "planned";
  if (papers.some((paper) => paper.status === "failed")) return "failed";
  if (papers.some((paper) => paper.status === "current")) return "current";
  if (papers.every((paper) => paper.status === "blocked")) return "blocked";
  if (papers.some((paper) => paper.status === "queued")) return "queued";
  if (papers.some((paper) => paper.status === "stale")) return "stale";
  if (papers.every((paper) => paper.status === "skipped")) return "skipped";
  return "planned";
}

function relevanceSummaryMarkdown(paper: PaperIngestPaper, job: PaperSummaryGenerationJob): string {
  const source = paper.sourceArtifact;
  const text = source?.normalizedMarkdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
  const title = paper.title ?? paper.paperSlug;
  return [
    `Local relevance card for ${title}.`,
    source
      ? `Selected ${source.sourceType} source from ${source.origin} with extraction quality ${source.quality.score.toFixed(2)}.`
      : `Selected source ${job.sourceSlug}.`,
    text ? `Evidence preview: ${text}` : "Evidence preview is unavailable for this source.",
  ].join("\n\n");
}

function replaceSummary(
  summaries: readonly PaperSummaryArtifact[],
  summary: PaperSummaryArtifact,
): PaperSummaryArtifact[] {
  return [
    ...summaries.filter((entry) => entry.tier !== summary.tier),
    summary,
  ].sort((left, right) => left.tier.localeCompare(right.tier));
}

function attachCompletedRelevanceSummaries(input: {
  manifest: PaperIngestManifest;
  jobs: readonly PaperSummaryGenerationJob[];
  provenanceRecords: readonly PaperProvenanceLedgerRecord[];
  generatedAt: string;
}): PaperIngestManifest {
  const jobsByPaperSlug = new Map<string, PaperSummaryGenerationJob[]>();
  for (const job of input.jobs) {
    if (job.tier !== "relevance") continue;
    jobsByPaperSlug.set(job.paperSlug, [...(jobsByPaperSlug.get(job.paperSlug) ?? []), job]);
  }
  const planRecordsByPaperSlug = new Map<string, PaperProvenanceLedgerRecord[]>();
  for (const record of input.provenanceRecords) {
    planRecordsByPaperSlug.set(record.paperSlug, [...(planRecordsByPaperSlug.get(record.paperSlug) ?? []), record]);
  }

  const papers = input.manifest.papers.map((paper) => {
    let summaries = paper.summaries;
    const provenance = [
      ...paper.provenance,
      ...(planRecordsByPaperSlug.get(paper.paperSlug) ?? []),
    ];
    for (const job of jobsByPaperSlug.get(paper.paperSlug) ?? []) {
      const completion = completePaperSummaryJob({
        job,
        generatedAt: input.generatedAt,
        generatedBy: "ScienceSwarm corpus",
        summaryMarkdown: relevanceSummaryMarkdown(paper, job),
      });
      summaries = replaceSummary(summaries, completion.summary);
      provenance.push(completion.provenanceRecord);
    }
    return PaperIngestPaperSchema.parse({
      ...paper,
      summaries,
      provenance,
    });
  });

  return PaperIngestManifestSchema.parse({
    ...input.manifest,
    papers,
    status: manifestStatusForPapers(papers),
    updatedAt: input.generatedAt,
  });
}

async function mapWithConcurrency<T, Result>(
  items: readonly T[],
  concurrencyLimit: number,
  worker: (item: T, index: number) => Promise<Result>,
): Promise<Result[]> {
  return runPaperSummaryJobsWithConcurrency({
    jobs: items,
    concurrencyLimit,
    worker,
  });
}

export async function writePaperCorpusManifestForScan(input: {
  project: string;
  scanId: string;
  rootRealpath: string;
  createdAt: string;
  updatedAt: string;
  items: readonly PaperReviewItem[];
  stateRoot: string;
  pdfExtractionByPaperId?: PdfExtractionByPaperId;
}) {
  const includedItems = input.items.filter((item) => item.state !== "ignored");
  const plannedManifest = buildPaperCorpusManifest({
    id: `corpus-${input.scanId}`,
    project: input.project,
    scanId: input.scanId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    items: includedItems,
    sidecarRelativePaths: await listPaperCorpusSourceSidecars(input.rootRealpath),
  });
  const extractedPapers = await mapWithConcurrency(
    plannedManifest.papers,
    plannedManifest.parserConcurrencyLimit,
    (paper) => populatePaperCorpusArtifacts({
      paper,
      rootRealpath: input.rootRealpath,
      extractedAt: input.updatedAt,
      pdfExtractionByPaperId: input.pdfExtractionByPaperId,
    }),
  );
  const extractedManifest = PaperIngestManifestSchema.parse({
    ...plannedManifest,
    papers: extractedPapers,
    status: manifestStatusForPapers(extractedPapers),
    updatedAt: input.updatedAt,
  });
  const summaryPlan = planPaperSummaryJobs({
    manifest: extractedManifest,
    generatedAt: input.updatedAt,
    actor: "ScienceSwarm corpus",
    projectPolicy: "local-only",
    destination: "local-gbrain",
  });
  const manifest = attachCompletedRelevanceSummaries({
    manifest: summaryPlan.manifest,
    jobs: summaryPlan.jobs,
    provenanceRecords: summaryPlan.provenanceRecords,
    generatedAt: input.updatedAt,
  });
  return writePaperCorpusManifestByScan(input.project, input.scanId, manifest, input.stateRoot);
}
