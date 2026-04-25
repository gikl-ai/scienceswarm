import { createHash, randomUUID } from "node:crypto";

import { downloadArxivPdf } from "@/brain/arxiv-download";
import {
  PAPER_LIBRARY_STATE_VERSION,
  PaperLibraryAcquisitionPlanSchema,
  type GapSuggestion,
  type GapSuggestionState,
  type PaperLibraryAcquisitionCreateRequest,
  type PaperLibraryAcquisitionItem,
  type PaperLibraryAcquisitionLocation,
  type PaperLibraryAcquisitionMode,
  type PaperLibraryAcquisitionPlan,
  type PaperLibraryAcquisitionPlanStatus,
} from "./contracts";
import { getOrBuildPaperLibraryGaps, updatePaperLibraryGapSuggestion } from "./gaps";
import {
  acquisitionRecordFromItem,
  persistPaperAcquisitionRecordToGbrain,
} from "./library-enrichment";
import {
  getPaperLibraryAcquisitionDownloadsDir,
  getPaperLibraryAcquisitionPlanPath,
  readPersistedState,
} from "./state";
import { writeJsonFile } from "@/lib/state/atomic-json";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

interface AcquisitionCounts {
  acquiredCount: number;
  metadataOnlyCount: number;
  watchCount: number;
  failedCount: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function normalizeDoi(value: string): string {
  return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
}

function openAlexUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace("api.openalex.org", "openalex.org").replace("/works/", "/");
  const id = trimmed.match(/[WA]\d+/i)?.[0] ?? trimmed;
  return `https://openalex.org/${id}`;
}

export function resolveAcquisitionLocations(suggestion: GapSuggestion): PaperLibraryAcquisitionLocation[] {
  const locations: PaperLibraryAcquisitionLocation[] = [];
  const arxivId = suggestion.identifiers.arxivId?.trim();
  if (arxivId) {
    locations.push({
      source: "arxiv",
      kind: "pdf",
      identifier: arxivId,
      url: `https://arxiv.org/pdf/${arxivId}.pdf`,
      openAccess: true,
      canDownloadPdf: true,
      confidence: 0.98,
    });
  }

  const doi = suggestion.identifiers.doi ? normalizeDoi(suggestion.identifiers.doi) : undefined;
  if (doi) {
    locations.push({
      source: "doi",
      kind: "landing",
      identifier: doi,
      url: `https://doi.org/${doi}`,
      openAccess: false,
      canDownloadPdf: false,
      confidence: 0.7,
    });
  }

  const openAlexId = suggestion.identifiers.openAlexId?.trim();
  if (openAlexId) {
    locations.push({
      source: "openalex",
      kind: "metadata",
      identifier: openAlexId,
      url: openAlexUrl(openAlexId),
      openAccess: false,
      canDownloadPdf: false,
      confidence: 0.65,
    });
  }

  const pmid = suggestion.identifiers.pmid?.trim();
  if (pmid) {
    locations.push({
      source: "pubmed",
      kind: "metadata",
      identifier: pmid,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      openAccess: false,
      canDownloadPdf: false,
      confidence: 0.6,
    });
  }

  return locations;
}

function acquisitionMode(locations: PaperLibraryAcquisitionLocation[]): PaperLibraryAcquisitionMode {
  if (locations.some((location) => location.canDownloadPdf)) return "download_pdf";
  if (locations.length > 0) return "metadata_only";
  return "watch";
}

function acquisitionRationale(suggestion: GapSuggestion): string {
  const parts: string[] = [];
  const percent = Math.round(suggestion.score.overall * 100);
  parts.push(`Ranked ${percent}% by the paper-library gap graph.`);
  if (suggestion.localConnectionCount === 1) {
    parts.push("Connected to 1 paper already in the library.");
  } else if (suggestion.localConnectionCount > 1) {
    parts.push(`Connected to ${suggestion.localConnectionCount} papers already in the library.`);
  }
  if (suggestion.evidenceClusterIds.length > 1) {
    parts.push(`Bridges ${suggestion.evidenceClusterIds.length} library clusters.`);
  } else if (suggestion.evidenceClusterIds.length === 1) {
    parts.push("Fills a citation gap inside an existing library cluster.");
  }
  if (suggestion.reasonCodes.includes("recent_connected")) {
    parts.push("Close in time to connected local work.");
  }
  if (suggestion.reasonCodes.includes("source_disagreement")) {
    parts.push("Needs follow-up because sources disagree about the record.");
  }
  return parts.join(" ");
}

function toolFromLocationSource(source: PaperLibraryAcquisitionLocation["source"] | undefined): PaperLibraryAcquisitionItem["tool"] {
  switch (source) {
    case "arxiv":
      return "arxiv";
    case "openalex":
      return "openalex";
    case "semantic_scholar":
      return "semantic_scholar";
    default:
      return "manual";
  }
}

function itemFromSuggestion(
  suggestion: GapSuggestion,
  updatedAt: string,
  originatingQuestion?: string,
): PaperLibraryAcquisitionItem {
  const locations = resolveAcquisitionLocations(suggestion);
  const mode = acquisitionMode(locations);
  const selectedLocation = locations.find((location) => location.canDownloadPdf) ?? locations[0];
  return {
    id: `acq-item:${stableHash({ suggestionId: suggestion.id, nodeId: suggestion.nodeId })}`,
    suggestionId: suggestion.id,
    scanId: suggestion.scanId,
    nodeId: suggestion.nodeId,
    title: suggestion.title,
    authors: suggestion.authors,
    year: suggestion.year,
    venue: suggestion.venue,
    identifiers: suggestion.identifiers,
    sources: suggestion.sources,
    reasonCodes: suggestion.reasonCodes,
    score: suggestion.score,
    localConnectionCount: suggestion.localConnectionCount,
    evidencePaperIds: suggestion.evidencePaperIds,
    evidenceClusterIds: suggestion.evidenceClusterIds,
    evidenceNodeIds: suggestion.evidenceNodeIds,
    rationale: acquisitionRationale(suggestion),
    locations,
    selectedLocation,
    mode,
    status: "planned",
    originatingQuestion,
    sourceUrl: selectedLocation?.url,
    tool: toolFromLocationSource(selectedLocation?.source),
    consentScope: "per_session",
    updatedAt,
  };
}

function countItems(items: PaperLibraryAcquisitionItem[]): AcquisitionCounts {
  return {
    acquiredCount: items.filter((item) => item.status === "acquired").length,
    metadataOnlyCount: items.filter((item) => item.status === "metadata_only").length,
    watchCount: items.filter((item) => item.status === "watching").length,
    failedCount: items.filter((item) => item.status === "failed").length,
  };
}

function completedStatus(items: PaperLibraryAcquisitionItem[]): PaperLibraryAcquisitionPlanStatus {
  const counts = countItems(items);
  if (items.length === 0) return "completed";
  if (counts.failedCount === items.length) return "failed";
  if (counts.failedCount > 0) return "partial";
  return "completed";
}

function warningsForItems(items: PaperLibraryAcquisitionItem[]): string[] {
  return items.flatMap((item) => {
    if (item.mode === "watch") return [`No acquisition location found for ${item.title}.`];
    if (item.mode === "metadata_only") return [`No directly downloadable PDF found for ${item.title}.`];
    return [];
  });
}

function normalizeAcquisitionPlan(value: unknown): PaperLibraryAcquisitionPlan {
  const parsed = PaperLibraryAcquisitionPlanSchema.parse(value);
  return {
    ...parsed,
    items: parsed.items ?? [],
    warnings: parsed.warnings ?? [],
  };
}

function planWithItems(
  plan: PaperLibraryAcquisitionPlan,
  items: PaperLibraryAcquisitionItem[],
  status: PaperLibraryAcquisitionPlanStatus,
  updatedAt: string,
): PaperLibraryAcquisitionPlan {
  const counts = countItems(items);
  return PaperLibraryAcquisitionPlanSchema.parse({
    ...plan,
    status,
    itemCount: items.length,
    downloadableCount: items.filter((item) => item.mode === "download_pdf").length,
    ...counts,
    items,
    warnings: Array.from(new Set([...plan.warnings, ...warningsForItems(items)])).sort(),
    updatedAt,
  });
}

export async function readAcquisitionPlan(
  project: string,
  acquisitionPlanId: string,
  brainRoot: string,
): Promise<PaperLibraryAcquisitionPlan | null> {
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const parsed = await readPersistedState(
    getPaperLibraryAcquisitionPlanPath(project, acquisitionPlanId, stateRoot),
    PaperLibraryAcquisitionPlanSchema,
    "paper-library acquisition plan",
  );
  return parsed.ok ? normalizeAcquisitionPlan(parsed.data) : null;
}

export async function createAcquisitionPlan(
  input: PaperLibraryAcquisitionCreateRequest & { brainRoot: string },
): Promise<PaperLibraryAcquisitionPlan | null> {
  const gaps = await getOrBuildPaperLibraryGaps({
    project: input.project,
    scanId: input.scanId,
    brainRoot: input.brainRoot,
  });
  if (!gaps) return null;

  const includeStates = new Set<GapSuggestionState>(input.includeStates);
  const suggestionsById = new Map(gaps.suggestions.map((suggestion) => [suggestion.id, suggestion]));
  const selected = input.suggestionIds
    ? input.suggestionIds.map((suggestionId) => {
      const suggestion = suggestionsById.get(suggestionId);
      if (!suggestion) throw new Error(`Gap suggestion not found: ${suggestionId}`);
      return suggestion;
    })
    : gaps.suggestions
      .filter((suggestion) => includeStates.has(suggestion.state))
      .slice(0, input.limit);

  const createdAt = nowIso();
  const items = selected.map((suggestion) =>
    itemFromSuggestion(suggestion, createdAt, input.originatingQuestion)
  );
  const id = randomUUID();
  const plan = PaperLibraryAcquisitionPlanSchema.parse({
    version: PAPER_LIBRARY_STATE_VERSION,
    id,
    project: input.project,
    scanId: input.scanId,
    status: "planned",
    itemCount: items.length,
    downloadableCount: items.filter((item) => item.mode === "download_pdf").length,
    acquiredCount: 0,
    metadataOnlyCount: 0,
    watchCount: 0,
    failedCount: 0,
    items,
    warnings: warningsForItems(items),
    createdAt,
    updatedAt: createdAt,
  });

  const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
  await writeJsonFile(getPaperLibraryAcquisitionPlanPath(input.project, id, stateRoot), plan);
  return plan;
}

async function markGapAction(input: {
  project: string;
  scanId: string;
  brainRoot: string;
  suggestionId: string;
  action: "import" | "watch";
}): Promise<void> {
  await updatePaperLibraryGapSuggestion({
    project: input.project,
    scanId: input.scanId,
    brainRoot: input.brainRoot,
    suggestionId: input.suggestionId,
    action: input.action,
  });
}

async function executeItem(input: {
  project: string;
  brainRoot: string;
  planId: string;
  stateRoot: string;
  item: PaperLibraryAcquisitionItem;
  updatedAt: string;
}): Promise<PaperLibraryAcquisitionItem> {
  if (input.item.mode === "metadata_only") {
    const candidate = { ...input.item, status: "metadata_only" as const, error: undefined, updatedAt: input.updatedAt };
    try {
      const record = await persistPaperAcquisitionRecordToGbrain({
        brainRoot: input.brainRoot,
        record: acquisitionRecordFromItem({
          project: input.project,
          item: candidate,
          status: "metadata_persisted",
          createdAt: input.updatedAt,
        }),
      });
      await markGapAction({
        project: input.project,
        scanId: input.item.scanId,
        brainRoot: input.brainRoot,
        suggestionId: input.item.suggestionId,
        action: "import",
      });
      return {
        ...candidate,
        sourceUrl: record.sourceUrl,
        gbrainSlug: record.gbrainSlug,
        checksum: record.checksum,
      };
    } catch (error) {
      return {
        ...input.item,
        status: "failed",
        error: error instanceof Error ? error.message : "Metadata-only persistence failed.",
        updatedAt: input.updatedAt,
      };
    }
  }
  if (input.item.mode === "watch") {
    await markGapAction({
      project: input.project,
      scanId: input.item.scanId,
      brainRoot: input.brainRoot,
      suggestionId: input.item.suggestionId,
      action: "watch",
    });
    return { ...input.item, status: "watching", error: undefined, updatedAt: input.updatedAt };
  }

  const arxivId = input.item.selectedLocation?.source === "arxiv"
    ? input.item.selectedLocation.identifier ?? input.item.identifiers.arxivId
    : input.item.identifiers.arxivId;
  if (!arxivId) {
    return { ...input.item, status: "failed", error: "No arXiv identifier available for PDF download.", updatedAt: input.updatedAt };
  }

  try {
    const localPath = await downloadArxivPdf(
      arxivId,
      getPaperLibraryAcquisitionDownloadsDir(input.project, input.planId, input.stateRoot),
    );
    const candidate = { ...input.item, status: "acquired" as const, localPath, error: undefined, updatedAt: input.updatedAt };
    const record = await persistPaperAcquisitionRecordToGbrain({
      brainRoot: input.brainRoot,
      record: acquisitionRecordFromItem({
        project: input.project,
        item: candidate,
        status: "downloaded",
        createdAt: input.updatedAt,
      }),
    });
    await markGapAction({
      project: input.project,
      scanId: input.item.scanId,
      brainRoot: input.brainRoot,
      suggestionId: input.item.suggestionId,
      action: "import",
    });
    return {
      ...candidate,
      sourceUrl: record.sourceUrl,
      gbrainSlug: record.gbrainSlug,
      checksum: record.checksum,
    };
  } catch (error) {
    return {
      ...input.item,
      status: "failed",
      error: error instanceof Error ? error.message : "PDF acquisition failed.",
      updatedAt: input.updatedAt,
    };
  }
}

export async function executeAcquisitionPlan(input: {
  project: string;
  acquisitionPlanId: string;
  brainRoot: string;
}): Promise<PaperLibraryAcquisitionPlan | null> {
  const plan = await readAcquisitionPlan(input.project, input.acquisitionPlanId, input.brainRoot);
  if (!plan) return null;
  if (plan.status === "running") throw new Error("Acquisition plan is already running.");

  const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
  const startedAt = nowIso();
  const running = PaperLibraryAcquisitionPlanSchema.parse({
    ...plan,
    status: "running",
    updatedAt: startedAt,
  });
  await writeJsonFile(getPaperLibraryAcquisitionPlanPath(input.project, input.acquisitionPlanId, stateRoot), running);

  const updatedItems: PaperLibraryAcquisitionItem[] = [];
  for (const item of running.items) {
    updatedItems.push(await executeItem({
      project: input.project,
      brainRoot: input.brainRoot,
      planId: running.id,
      stateRoot,
      item,
      updatedAt: nowIso(),
    }));
  }

  const updatedAt = nowIso();
  const completed = planWithItems(running, updatedItems, completedStatus(updatedItems), updatedAt);
  await writeJsonFile(getPaperLibraryAcquisitionPlanPath(input.project, input.acquisitionPlanId, stateRoot), completed);
  return completed;
}
