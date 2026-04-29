import { createHash, randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  PAPER_LIBRARY_STATE_VERSION,
  PaperLibraryScanSchema,
  PaperReviewShardSchema,
  type PaperLibraryScan,
  type PaperLibraryScanStatus,
  type PaperReviewItem,
} from "./contracts";
import {
  getPaperLibraryIdempotencyPath,
  getPaperLibraryStateDir,
  getPaperLibraryReviewShardPath,
  getPaperLibraryScanPath,
  readPersistedState,
} from "./state";
import {
  writePaperCorpusManifestForScan,
  type PaperCorpusPdfExtractionPayload,
} from "./corpus/pipeline";
import {
  createIdentityCandidateFromEvidence,
  extractPaperIdentityEvidence,
} from "./identity";
import { enrichIdentityCandidate } from "./identity-enrichment";
import { snapshotFile } from "./fs-safety";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import { isPathAllowed } from "@/lib/import/background-import-job";
import { shouldSkipImportDirectory, shouldSkipImportFile } from "@/lib/import/ignore";
import { extractPdfText } from "@/lib/pdf-text-extractor";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

const STALE_HEARTBEAT_MS = 30_000;
const HEARTBEAT_WRITE_INTERVAL_MS = 5_000;
const REVIEW_SHARD_SIZE = 250;
const runningScanJobs = new Set<string>();
type PartialScanCounters = Partial<PaperLibraryScan["counters"]>;

const ACTIVE_SCAN_STATUSES = new Set<PaperLibraryScanStatus>([
  "queued",
  "scanning",
  "identifying",
  "enriching",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function isPdf(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

function hashSemanticText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildSemanticText(input: {
  title?: string;
  abstract?: string;
  firstSentence?: string;
  venue?: string;
  identifiers?: { doi?: string; arxivId?: string; pmid?: string };
}): string | undefined {
  const abstractOrPreview = input.abstract?.trim() || input.firstSentence?.trim();
  const segments = [
    input.title?.trim(),
    abstractOrPreview,
    input.venue?.trim(),
    input.identifiers?.doi ? `doi ${input.identifiers.doi}` : undefined,
    input.identifiers?.arxivId ? `arxiv ${input.identifiers.arxivId}` : undefined,
    input.identifiers?.pmid ? `pmid ${input.identifiers.pmid}` : undefined,
  ].filter((segment): segment is string => Boolean(segment && segment.length > 0));
  if (segments.length === 0) return undefined;
  return segments.join(". ").slice(0, 4000);
}

function normalizeScan(scan: unknown): PaperLibraryScan {
  const parsed = PaperLibraryScanSchema.parse(scan);
  return {
    ...parsed,
    counters: scanCounters(parsed as { counters?: PartialScanCounters }),
    warnings: scanWarnings(parsed as { warnings?: string[] }),
    currentPath: parsed.currentPath ?? null,
    reviewShardIds: parsed.reviewShardIds ?? [],
  } as PaperLibraryScan;
}

async function writeScan(scan: PaperLibraryScan, stateRoot: string): Promise<PaperLibraryScan> {
  const parsed = normalizeScan(scan);
  await writeJsonFile(getPaperLibraryScanPath(parsed.project, parsed.id, stateRoot), parsed);
  return parsed;
}

function scanWarnings(scan: { warnings?: string[] }): string[] {
  return scan.warnings ?? [];
}

function scanCounters(scan: { counters?: PartialScanCounters }): PaperLibraryScan["counters"] {
  const counters = scan.counters ?? {};
  return {
    detectedFiles: counters.detectedFiles ?? 0,
    identified: counters.identified ?? 0,
    needsReview: counters.needsReview ?? 0,
    readyForApply: counters.readyForApply ?? 0,
    failed: counters.failed ?? 0,
  };
}

function scanIsStale(scan: PaperLibraryScan): boolean {
  if (!ACTIVE_SCAN_STATUSES.has(scan.status) || !scan.heartbeatAt) return false;
  return Date.now() - Date.parse(scan.heartbeatAt) > STALE_HEARTBEAT_MS;
}

export async function readPaperLibraryScan(
  project: string,
  scanId: string,
  brainRoot: string,
): Promise<PaperLibraryScan | null> {
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const parsed = await readPersistedState(
    getPaperLibraryScanPath(project, scanId, stateRoot),
    PaperLibraryScanSchema,
    "paper-library scan",
  );
  if (!parsed.ok) return null;

  return normalizeScan(parsed.data);
}

export async function findLatestPaperLibraryScan(
  project: string,
  brainRoot: string,
): Promise<PaperLibraryScan | null> {
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const scansDir = path.join(getPaperLibraryStateDir(project, stateRoot), "scans");
  const entries = await readdir(scansDir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return null;

  const scans = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        let scanId: string;
        try {
          scanId = decodeURIComponent(entry.name.slice(0, -".json".length));
        } catch {
          return null;
        }
        const parsed = await readPersistedState(
          getPaperLibraryScanPath(project, scanId, stateRoot),
          PaperLibraryScanSchema,
          "paper-library scan",
        );
        return parsed.ok ? normalizeScan(parsed.data) : null;
      }),
  );

  const ordered = scans
    .filter((scan): scan is PaperLibraryScan => scan !== null)
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt);
      const rightTime = Date.parse(right.updatedAt);
      return rightTime - leftTime;
    });

  return ordered[0] ?? null;
}

export async function reconcileStalePaperLibraryScan(
  project: string,
  scanId: string,
  brainRoot: string,
): Promise<PaperLibraryScan | null> {
  const scan = await readPaperLibraryScan(project, scanId, brainRoot);
  if (!scan || !scanIsStale(scan)) return scan;

  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  return writeScan({
    ...scan,
    status: scan.cancelRequestedAt ? "canceled" : "failed",
    claimId: undefined,
    updatedAt: nowIso(),
    warnings: scan.cancelRequestedAt ? scanWarnings(scan) : [...scanWarnings(scan), "scan_worker_stale"],
    counters: scanCounters(scan),
  }, stateRoot);
}

export async function cancelPaperLibraryScan(project: string, scanId: string, brainRoot: string): Promise<PaperLibraryScan | null> {
  const scan = await readPaperLibraryScan(project, scanId, brainRoot);
  if (!scan) return null;
  if (!ACTIVE_SCAN_STATUSES.has(scan.status)) return scan;

  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  return writeScan({
      ...scan,
      claimId: undefined,
      cancelRequestedAt: nowIso(),
      updatedAt: nowIso(),
      warnings: scanWarnings(scan),
      counters: scanCounters(scan),
  }, stateRoot);
}

async function findExistingScanForIdempotency(
  project: string,
  idempotencyKey: string | undefined,
  stateRoot: string,
): Promise<PaperLibraryScan | null> {
  if (!idempotencyKey) return null;
  const record = await readJsonFile<{ scanId: string }>(getPaperLibraryIdempotencyPath(project, idempotencyKey, stateRoot));
  if (!record?.scanId) return null;
  const parsed = await readPersistedState(
    getPaperLibraryScanPath(project, record.scanId, stateRoot),
    PaperLibraryScanSchema,
    "paper-library scan",
  );
  return parsed.ok ? normalizeScan(parsed.data) : null;
}

export async function startPaperLibraryScan(input: {
  project: string;
  rootPath: string;
  brainRoot: string;
  idempotencyKey?: string;
}): Promise<PaperLibraryScan> {
  const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
  const existing = await findExistingScanForIdempotency(input.project, input.idempotencyKey, stateRoot);
  if (existing) return existing;

  if (!(await isPathAllowed(input.rootPath))) {
    throw new Error("Path not allowed. Must be under your home directory and not in sensitive directories.");
  }
  const rootStat = await stat(input.rootPath);
  if (!rootStat.isDirectory()) {
    throw new Error("Root path is not a directory.");
  }

  const createdAt = nowIso();
  const scan: PaperLibraryScan = {
    version: PAPER_LIBRARY_STATE_VERSION,
    id: randomUUID(),
    project: input.project,
    rootPath: input.rootPath,
    rootRealpath: await realpath(input.rootPath),
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    heartbeatAt: createdAt,
    idempotencyKey: input.idempotencyKey,
    counters: {
      detectedFiles: 0,
      identified: 0,
      needsReview: 0,
      readyForApply: 0,
      failed: 0,
    },
    warnings: [],
    currentPath: null,
    reviewShardIds: [],
  };
  await writeScan(scan, stateRoot);
  if (input.idempotencyKey) {
    await writeJsonFile(getPaperLibraryIdempotencyPath(input.project, input.idempotencyKey, stateRoot), { scanId: scan.id });
  }

  // Route handlers can return before timer callbacks reliably fire in the
  // current preview/runtime environment. Start the async worker immediately
  // and let it continue in the background instead of bouncing through a timer.
  void runPaperLibraryScanJob(input.project, scan.id, input.brainRoot);

  return scan;
}

export async function updatePaperLibraryScan(
  project: string,
  scanId: string,
  brainRoot: string,
  updater: (scan: PaperLibraryScan) => PaperLibraryScan,
): Promise<PaperLibraryScan> {
  const scan = await readPaperLibraryScan(project, scanId, brainRoot);
  if (!scan) throw new Error(`Paper library scan ${scanId} not found.`);
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  return writeScan(updater(scan), stateRoot);
}

async function* walkPdfFiles(rootPath: string): AsyncGenerator<string> {
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipImportDirectory(entry.name)) {
        yield* walkPdfFiles(absolutePath);
      }
      continue;
    }
    if (!entry.isFile() || shouldSkipImportFile(entry.name) || !isPdf(entry.name)) continue;
    yield absolutePath;
  }
}

export async function runPaperLibraryScanJob(
  project: string,
  scanId: string,
  brainRoot: string,
): Promise<void> {
  if (runningScanJobs.has(scanId)) return;
  runningScanJobs.add(scanId);
  const claimId = randomUUID();

  try {
    let scan = await updatePaperLibraryScan(project, scanId, brainRoot, (current) => ({
      ...current,
      status: "scanning",
      claimId,
      heartbeatAt: nowIso(),
      updatedAt: nowIso(),
    }));

    const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
    const rootRealpath = scan.rootRealpath ?? await realpath(scan.rootPath);
    const shardIds: string[] = [];
    let reviewShardBuffer: PaperReviewItem[] = [];
    let detectedFiles = 0;
    let identified = 0;
    let failed = 0;
    let needsReviewCount = 0;
    let readyForApplyCount = 0;
    const allReviewItems: PaperReviewItem[] = [];
    const pdfExtractionByPaperId: Record<string, PaperCorpusPdfExtractionPayload> = {};

    async function flushReviewShard(): Promise<void> {
      if (reviewShardBuffer.length === 0) return;
      const shardId = String(shardIds.length + 1).padStart(4, "0");
      shardIds.push(shardId);
      await writeJsonFile(getPaperLibraryReviewShardPath(project, scanId, shardId, stateRoot), PaperReviewShardSchema.parse({
        version: PAPER_LIBRARY_STATE_VERSION,
        scanId,
        items: reviewShardBuffer,
      }));
      reviewShardBuffer = [];
    }

    for await (const absolutePath of walkPdfFiles(rootRealpath)) {
      const fresh = await readPaperLibraryScan(project, scanId, brainRoot);
      if (fresh?.cancelRequestedAt) {
        await flushReviewShard();
        await writeScan({
          ...fresh,
          status: "canceled",
          updatedAt: nowIso(),
          heartbeatAt: nowIso(),
          reviewShardIds: shardIds,
          counters: {
            ...scanCounters(fresh),
            detectedFiles,
            identified,
            needsReview: needsReviewCount,
            readyForApply: readyForApplyCount,
            failed,
          },
        }, stateRoot);
        return;
      }

      detectedFiles += 1;
      const relativePath = path.relative(rootRealpath, absolutePath);
      const snapshot = await snapshotFile(rootRealpath, absolutePath);
      if (!snapshot.ok) {
        failed += 1;
        continue;
      }

      let extracted: Awaited<ReturnType<typeof extractPdfText>> | null = null;
      try {
        extracted = await extractPdfText(absolutePath);
      } catch {
        extracted = null;
      }

      const evidence = extractPaperIdentityEvidence({
        relativePath,
        text: extracted?.text,
        pageCount: extracted?.pageCount,
        wordCount: extracted?.wordCount,
      });
      const candidate = await enrichIdentityCandidate({
        project,
        stateRoot,
        candidate: createIdentityCandidateFromEvidence(evidence, relativePath),
      });
      const semanticText = buildSemanticText({
        title: candidate.title,
        abstract: extracted?.abstract,
        firstSentence: extracted?.firstSentence,
        venue: candidate.venue,
        identifiers: candidate.identifiers,
      });
      const needsReview = candidate.confidence < 0.9 || candidate.conflicts.length > 0;
      if (!needsReview) identified += 1;
      if (needsReview) needsReviewCount += 1;
      else readyForApplyCount += 1;
      const reviewItem: PaperReviewItem = {
        id: randomUUID(),
        scanId,
        paperId: candidate.id,
        state: needsReview ? "needs_review" : "accepted",
        reasonCodes: needsReview ? (candidate.conflicts.length ? candidate.conflicts : ["low_confidence"]) : [],
        source: snapshot.snapshot,
        candidates: [candidate],
        selectedCandidateId: needsReview ? undefined : candidate.id,
        version: 0,
        semanticText,
        semanticTextHash: semanticText ? hashSemanticText(semanticText) : undefined,
        abstract: extracted?.abstract || undefined,
        firstSentence: extracted?.firstSentence || undefined,
        pageCount: extracted?.pageCount,
        wordCount: extracted?.wordCount,
        updatedAt: nowIso(),
      };
      reviewShardBuffer.push(reviewItem);
      allReviewItems.push(reviewItem);
      if (extracted) {
        pdfExtractionByPaperId[reviewItem.paperId] = {
          text: extracted.text,
          wordCount: extracted.wordCount,
          pageCount: extracted.pageCount,
        };
      }

      if (reviewShardBuffer.length >= REVIEW_SHARD_SIZE) {
        await flushReviewShard();
      }

      if (detectedFiles % 20 === 0 || Date.now() - Date.parse(scan.heartbeatAt ?? scan.updatedAt) > HEARTBEAT_WRITE_INTERVAL_MS) {
        scan = await updatePaperLibraryScan(project, scanId, brainRoot, (current) => ({
          ...current,
          status: "identifying",
          rootRealpath,
          heartbeatAt: nowIso(),
          updatedAt: nowIso(),
          currentPath: relativePath,
          counters: {
            ...scanCounters(current),
            detectedFiles,
            identified,
            needsReview: needsReviewCount,
            readyForApply: readyForApplyCount,
            failed,
          },
          reviewShardIds: shardIds,
        }));
      }
    }

    await flushReviewShard();
    const corpusWarnings: string[] = [];
    let heartbeatActive = true;
    const heartbeatWrites = new Set<Promise<void>>();
    const heartbeatTimer = setInterval(() => {
      const heartbeatWrite = updatePaperLibraryScan(project, scanId, brainRoot, (current) => {
        if (!heartbeatActive || !ACTIVE_SCAN_STATUSES.has(current.status)) return current;
        const heartbeatAt = nowIso();
        return {
          ...current,
          heartbeatAt,
          updatedAt: heartbeatAt,
        };
      }).then(() => undefined, () => undefined);
      heartbeatWrites.add(heartbeatWrite);
      void heartbeatWrite.finally(() => {
        heartbeatWrites.delete(heartbeatWrite);
      });
    }, HEARTBEAT_WRITE_INTERVAL_MS);
    try {
      await writePaperCorpusManifestForScan({
        project,
        scanId,
        rootRealpath,
        createdAt: scan.createdAt,
        updatedAt: nowIso(),
        items: allReviewItems,
        stateRoot,
        pdfExtractionByPaperId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Corpus source inventory failed.";
      corpusWarnings.push(`corpus_source_inventory_failed: ${message}`);
    } finally {
      heartbeatActive = false;
      clearInterval(heartbeatTimer);
      // Drain any heartbeat write that already read active scan state before
      // writing the terminal scan status below.
      await Promise.allSettled([...heartbeatWrites]);
    }

    const finalUpdatedAt = nowIso();
    await updatePaperLibraryScan(project, scanId, brainRoot, (current) => ({
      ...current,
      status: needsReviewCount > 0 ? "ready_for_review" : "ready_for_apply",
      rootRealpath,
      claimId: undefined,
      heartbeatAt: nowIso(),
      updatedAt: finalUpdatedAt,
      currentPath: null,
      reviewShardIds: shardIds,
      warnings: [...scanWarnings(current), ...corpusWarnings],
      counters: {
        detectedFiles,
        identified,
        needsReview: needsReviewCount,
        readyForApply: readyForApplyCount,
        failed,
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paper library scan failed.";
    await updatePaperLibraryScan(project, scanId, brainRoot, (current) => ({
      ...current,
      status: "failed",
      claimId: undefined,
      heartbeatAt: nowIso(),
      updatedAt: nowIso(),
      warnings: [...scanWarnings(current), message],
      counters: scanCounters(current),
    })).catch(() => undefined);
  } finally {
    runningScanJobs.delete(scanId);
  }
}
