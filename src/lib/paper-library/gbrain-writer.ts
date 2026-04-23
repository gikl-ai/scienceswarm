import path from "node:path";

import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

import type { PersistAppliedPaperLocationsInput } from "./apply";
import type {
  ApplyManifestOperation,
  ApplyOperation,
  PaperIdentityCandidate,
  PaperReviewItem,
} from "./contracts";

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

function slugSegment(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "paper";
}

function candidateForReviewItem(item: PaperReviewItem | undefined): PaperIdentityCandidate | undefined {
  if (!item) return undefined;
  return item.candidates.find((candidate) => candidate.id === item.selectedCandidateId) ?? item.candidates[0];
}

export function paperLibraryPageSlug(operation: ApplyOperation, candidate: PaperIdentityCandidate | undefined): string {
  return paperLibraryPageSlugForPaperId(operation.paperId, candidate);
}

export function paperLibraryPageSlugForPaperId(
  paperId: string,
  candidate: PaperIdentityCandidate | undefined,
): string {
  if (candidate?.identifiers.doi) return `wiki/entities/papers/doi-${slugSegment(candidate.identifiers.doi)}`;
  if (candidate?.identifiers.arxivId) return `wiki/entities/papers/arxiv-${slugSegment(candidate.identifiers.arxivId)}`;
  if (candidate?.identifiers.pmid) return `wiki/entities/papers/pmid-${slugSegment(candidate.identifiers.pmid)}`;
  return `wiki/entities/papers/local-${slugSegment(paperId)}`;
}

function paperTitle(
  operation: ApplyOperation,
  reviewItem: PaperReviewItem | undefined,
  candidate: PaperIdentityCandidate | undefined,
): string {
  const correctedTitle = typeof reviewItem?.correction?.title === "string" ? reviewItem.correction.title.trim() : "";
  if (correctedTitle) return correctedTitle;
  if (candidate?.title) return candidate.title;
  return path.basename(operation.destinationRelativePath, path.extname(operation.destinationRelativePath));
}

function appendTimeline(existingTimeline: string, entry: string): string {
  const trimmedExisting = existingTimeline.trim();
  const trimmedEntry = entry.trim();
  if (!trimmedEntry || trimmedExisting.includes(trimmedEntry)) return trimmedExisting;
  return trimmedExisting ? `${trimmedExisting}\n\n${trimmedEntry}` : trimmedEntry;
}

function formatPaperLibraryBlock(input: {
  operation: ApplyOperation;
  manifestOperation: ApplyManifestOperation;
  candidate?: PaperIdentityCandidate;
}): string {
  const lines = [
    "## Paper Library",
    "",
    `Local PDF: \`${input.manifestOperation.destinationRelativePath}\``,
    `Paper library confidence: ${input.operation.confidence.toFixed(2)}`,
  ];
  if (input.candidate?.year) lines.push(`Year: ${input.candidate.year}`);
  if (input.candidate?.authors.length) lines.push(`Authors: ${input.candidate.authors.join(", ")}`);
  if (input.candidate?.venue) lines.push(`Venue: ${input.candidate.venue}`);
  if (input.candidate?.identifiers.doi) lines.push(`DOI: ${input.candidate.identifiers.doi}`);
  if (input.candidate?.identifiers.arxivId) lines.push(`arXiv: ${input.candidate.identifiers.arxivId}`);
  if (input.candidate?.identifiers.pmid) lines.push(`PMID: ${input.candidate.identifiers.pmid}`);
  return lines.join("\n");
}

function mergeCompiledTruth(existingCompiledTruth: string | undefined, paperLibraryBlock: string): string {
  const trimmedExisting = (existingCompiledTruth ?? "").trim();
  if (!trimmedExisting) return paperLibraryBlock;
  const sectionMatch = /^## Paper Library\s*$/m.exec(trimmedExisting);
  if (!sectionMatch) return `${trimmedExisting}\n\n${paperLibraryBlock}`;
  const sectionStart = sectionMatch.index;
  const afterHeading = sectionStart + sectionMatch[0].length;
  const nextSectionOffset = trimmedExisting.slice(afterHeading).search(/\n##\s+/);
  const sectionEnd = nextSectionOffset === -1
    ? trimmedExisting.length
    : afterHeading + nextSectionOffset;
  return [
    trimmedExisting.slice(0, sectionStart).trim(),
    paperLibraryBlock,
    trimmedExisting.slice(sectionEnd).trim(),
  ].filter(Boolean).join("\n\n");
}

export async function persistAppliedPaperLocations(input: PersistAppliedPaperLocationsInput): Promise<void> {
  const userHandle = getCurrentUserHandle();
  const client = createInProcessGbrainClient({ root: input.brainRoot });
  const operationsById = new Map(input.operations.map((operation) => [operation.id, operation]));
  const reviewItemsByPaperId = new Map(input.reviewItems.map((item) => [item.paperId, item]));
  const nowIso = new Date().toISOString();

  for (const manifestOperation of input.manifestOperations) {
    if (manifestOperation.status !== "verified" && manifestOperation.status !== "applied") continue;
    const operation = operationsById.get(manifestOperation.operationId);
    if (!operation) continue;
    const reviewItem = reviewItemsByPaperId.get(operation.paperId);
    const candidate = candidateForReviewItem(reviewItem);
    const slug = paperLibraryPageSlug(operation, candidate);
    const title = paperTitle(operation, reviewItem, candidate);
    const timelineEntry = `- **${nowIso.slice(0, 10)}** | ScienceSwarm paper library - Applied local PDF path \`${manifestOperation.destinationRelativePath}\` (manifest ${input.manifestId}).`;

    await client.persistTransaction(slug, async (existing) => {
      const previousFrontmatter = existing?.frontmatter ?? {};
      const paperLibrary = {
        ...(
          previousFrontmatter.paper_library && typeof previousFrontmatter.paper_library === "object"
            ? previousFrontmatter.paper_library as Record<string, unknown>
            : {}
        ),
        project: input.project,
        paper_id: operation.paperId,
        apply_plan_id: input.plan.id,
        apply_manifest_id: input.manifestId,
        source_relative_path: manifestOperation.sourceRelativePath,
        destination_relative_path: manifestOperation.destinationRelativePath,
        destination_fingerprint: manifestOperation.destinationSnapshot?.fingerprint,
        applied_at: manifestOperation.appliedAt,
        updated_at: nowIso,
        updated_by: userHandle,
      };
      const frontmatter = compactObject({
        ...previousFrontmatter,
        entity_type: "paper",
        paper_library: paperLibrary,
        identifiers: candidate?.identifiers,
        authors: candidate?.authors,
        year: candidate?.year,
        venue: candidate?.venue,
        captured_by: previousFrontmatter.captured_by ?? userHandle,
        updated_by: userHandle,
        updated_at: nowIso,
      });

      return {
        page: {
          type: "paper",
          title,
          compiledTruth: mergeCompiledTruth(
            existing?.compiledTruth,
            formatPaperLibraryBlock({ operation, manifestOperation, candidate }),
          ),
          timeline: appendTimeline(existing?.timeline ?? "", timelineEntry),
          frontmatter,
        },
      };
    });
  }
}
