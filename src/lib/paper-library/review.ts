import {
  PAPER_LIBRARY_STATE_VERSION,
  PaperReviewShardSchema,
  type PaperLibraryScan,
  type PaperReviewItem,
  type PaperReviewItemState,
  type PaperReviewUpdateRequest,
} from "./contracts";
import {
  getPaperLibraryReviewShardPath,
  readCursorWindow,
} from "./state";
import { writePaperCorpusManifestForScan } from "./corpus/pipeline";
import {
  readPaperLibraryScan,
  updatePaperLibraryScan,
} from "./jobs";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

export interface PaperReviewPage {
  items: PaperReviewItem[];
  nextCursor?: string;
  totalCount: number;
  filteredCount: number;
}

async function readReviewShard(
  project: string,
  scanId: string,
  shardId: string,
  stateRoot: string,
): Promise<PaperReviewItem[]> {
  const raw = await readJsonFile<unknown>(getPaperLibraryReviewShardPath(project, scanId, shardId, stateRoot));
  if (!raw) return [];
  return PaperReviewShardSchema.parse(raw).items;
}

async function writeReviewShard(
  project: string,
  scanId: string,
  shardId: string,
  items: PaperReviewItem[],
  stateRoot: string,
): Promise<void> {
  await writeJsonFile(getPaperLibraryReviewShardPath(project, scanId, shardId, stateRoot), PaperReviewShardSchema.parse({
    version: PAPER_LIBRARY_STATE_VERSION,
    scanId,
    items,
  }));
}

export async function readAllPaperReviewItems(
  project: string,
  scanId: string,
  brainRoot: string,
): Promise<{ scan: PaperLibraryScan; items: PaperReviewItem[]; stateRoot: string } | null> {
  const scan = await readPaperLibraryScan(project, scanId, brainRoot);
  if (!scan) return null;
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const shards = await Promise.all(
    scan.reviewShardIds.map((shardId) => readReviewShard(project, scanId, shardId, stateRoot)),
  );
  return { scan, items: shards.flat(), stateRoot };
}

export async function listPaperReviewItems(
  input: {
    project: string;
    scanId: string;
    brainRoot: string;
    cursor?: string;
    limit?: number;
    filter?: PaperReviewItemState;
  },
): Promise<PaperReviewPage | null> {
  const result = await readAllPaperReviewItems(input.project, input.scanId, input.brainRoot);
  if (!result) return null;
  const filtered = input.filter
    ? result.items.filter((item) => item.state === input.filter)
    : result.items;
  const page = readCursorWindow(filtered, { cursor: input.cursor, limit: input.limit });
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    totalCount: result.items.length,
    filteredCount: page.filteredCount,
  };
}

function chooseSelectedCandidate(item: PaperReviewItem, selectedCandidateId?: string): string | undefined {
  if (selectedCandidateId && item.candidates.some((candidate) => candidate.id === selectedCandidateId)) {
    return selectedCandidateId;
  }
  return item.selectedCandidateId ?? item.candidates[0]?.id;
}

function nextStateForAction(action: PaperReviewUpdateRequest["action"]): PaperReviewItemState {
  if (action === "accept") return "accepted";
  if (action === "correct") return "corrected";
  if (action === "ignore") return "ignored";
  return "unresolved";
}

function countReviewState(items: PaperReviewItem[]): {
  needsReview: number;
  readyForApply: number;
} {
  return {
    needsReview: items.filter((item) => item.state === "needs_review" || item.state === "unresolved").length,
    readyForApply: items.filter((item) => item.state === "accepted" || item.state === "corrected").length,
  };
}

async function updateScanReviewCounters(
  project: string,
  scanId: string,
  brainRoot: string,
  items: PaperReviewItem[],
): Promise<void> {
  const counts = countReviewState(items);
  await updatePaperLibraryScan(project, scanId, brainRoot, (scan) => ({
    ...scan,
    status: counts.needsReview === 0 ? "ready_for_apply" : "ready_for_review",
    applyPlanId: undefined,
    updatedAt: new Date().toISOString(),
    counters: {
      ...scan.counters,
      needsReview: counts.needsReview,
      readyForApply: counts.readyForApply,
    },
  }));
}

async function refreshPaperCorpusManifestForReview(input: {
  project: string;
  scan: PaperLibraryScan;
  stateRoot: string;
  brainRoot: string;
  items: readonly PaperReviewItem[];
}): Promise<void> {
  const updatedAt = new Date().toISOString();
  try {
    await writePaperCorpusManifestForScan({
      project: input.project,
      scanId: input.scan.id,
      rootRealpath: input.scan.rootRealpath ?? input.scan.rootPath,
      createdAt: input.scan.createdAt,
      updatedAt,
      items: input.items,
      stateRoot: input.stateRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Corpus source inventory failed.";
    await updatePaperLibraryScan(input.project, input.scan.id, input.brainRoot, (scan) => ({
      ...scan,
      warnings: Array.from(new Set([...scan.warnings, `corpus_source_inventory_failed: ${message}`])),
      updatedAt,
    }));
  }
}

export async function updatePaperReviewItem(
  input: PaperReviewUpdateRequest & { brainRoot: string },
): Promise<{ item: PaperReviewItem; remainingCount: number } | null> {
  const scan = await readPaperLibraryScan(input.project, input.scanId, input.brainRoot);
  if (!scan) return null;
  const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);

  for (const shardId of scan.reviewShardIds) {
    const items = await readReviewShard(input.project, input.scanId, shardId, stateRoot);
    const index = items.findIndex((item) => item.id === input.itemId);
    if (index === -1) continue;

    const current = items[index];
    const updated: PaperReviewItem = {
      ...current,
      state: nextStateForAction(input.action),
      selectedCandidateId: input.action === "ignore" || input.action === "unresolve"
        ? current.selectedCandidateId
        : chooseSelectedCandidate(current, input.selectedCandidateId),
      correction: input.action === "correct" ? input.correction ?? {} : current.correction,
      reasonCodes: input.action === "accept" || input.action === "correct" ? [] : current.reasonCodes,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    const nextItems = [...items];
    nextItems[index] = updated;
    await writeReviewShard(input.project, input.scanId, shardId, nextItems, stateRoot);

    const allItems = await readAllPaperReviewItems(input.project, input.scanId, input.brainRoot);
    const combined = allItems?.items ?? nextItems;
    await updateScanReviewCounters(input.project, input.scanId, input.brainRoot, combined);
    await refreshPaperCorpusManifestForReview({
      project: input.project,
      scan,
      stateRoot,
      brainRoot: input.brainRoot,
      items: combined,
    });
    return {
      item: updated,
      remainingCount: countReviewState(combined).needsReview,
    };
  }

  return null;
}
