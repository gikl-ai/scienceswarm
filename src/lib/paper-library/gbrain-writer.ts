import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { getProjectBrainRootForBrainRoot } from "@/lib/state/project-storage";

import type { PersistAppliedPaperLocationsInput } from "./apply";
import type {
  ApplyManifestOperation,
  ApplyOperation,
  AppliedPaperMetadata,
  PaperIdentityCandidate,
  PaperReviewItem,
} from "./contracts";
import { buildAppliedPaperMetadata, paperLibraryPageSlugForMetadata } from "./applied-metadata";

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

function candidateForReviewItem(item: PaperReviewItem | undefined): PaperIdentityCandidate | undefined {
  if (!item) return undefined;
  return item.candidates.find((candidate) => candidate.id === item.selectedCandidateId) ?? item.candidates[0];
}

export function paperLibraryPageSlug(
  operation: ApplyOperation,
  candidate: PaperIdentityCandidate | undefined,
): string {
  return paperLibraryPageSlugForPaperId(operation.paperId, candidate);
}

export function paperLibraryPageSlugForPaperId(
  paperId: string,
  candidate: PaperIdentityCandidate | undefined,
): string {
  return paperLibraryPageSlugForMetadata(paperId, candidate?.identifiers ?? {});
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
  metadata: AppliedPaperMetadata;
}): string {
  const lines = [
    "## Paper Library",
    "",
    `Local PDF: \`${input.manifestOperation.destinationRelativePath}\``,
    `Paper library confidence: ${input.operation.confidence.toFixed(2)}`,
  ];
  if (input.metadata.year) lines.push(`Year: ${input.metadata.year}`);
  if (input.metadata.authors.length) lines.push(`Authors: ${input.metadata.authors.join(", ")}`);
  if (input.metadata.venue) lines.push(`Venue: ${input.metadata.venue}`);
  if (input.metadata.identifiers.doi) lines.push(`DOI: ${input.metadata.identifiers.doi}`);
  if (input.metadata.identifiers.arxivId) lines.push(`arXiv: ${input.metadata.identifiers.arxivId}`);
  if (input.metadata.identifiers.pmid) lines.push(`PMID: ${input.metadata.identifiers.pmid}`);
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
  const resolvedBrainRoot = getProjectBrainRootForBrainRoot(input.project, input.brainRoot);
  const client = createInProcessGbrainClient({ root: resolvedBrainRoot });
  const operationsById = new Map(input.operations.map((operation) => [operation.id, operation]));
  const reviewItemsByPaperId = new Map((input.reviewItems ?? []).map((item) => [item.paperId, item]));
  const nowIso = new Date().toISOString();

  for (const manifestOperation of input.manifestOperations) {
    if (manifestOperation.status !== "verified" && manifestOperation.status !== "applied") continue;
    const operation = operationsById.get(manifestOperation.operationId);
    if (!operation) continue;
    const reviewItem = reviewItemsByPaperId.get(operation.paperId);
    const fallbackCandidate = candidateForReviewItem(reviewItem);
    const metadata = manifestOperation.appliedMetadata ?? buildAppliedPaperMetadata(operation, reviewItem);
    const slug = metadata.pageSlug || paperLibraryPageSlug(operation, fallbackCandidate);
    const timelineDay = manifestOperation.appliedAt?.slice(0, 10) ?? nowIso.slice(0, 10);
    const timelineEntry = `- **${timelineDay}** | ScienceSwarm paper library - Applied local PDF path \`${manifestOperation.destinationRelativePath}\` (manifest ${input.manifestId}).`;

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
        identifiers: metadata.identifiers,
        authors: metadata.authors,
        year: metadata.year,
        venue: metadata.venue,
        captured_by: previousFrontmatter.captured_by ?? userHandle,
        updated_by: userHandle,
        updated_at: nowIso,
      });

      return {
        page: {
          type: "paper",
          title: metadata.title,
          compiledTruth: mergeCompiledTruth(
            existing?.compiledTruth,
            formatPaperLibraryBlock({ operation, manifestOperation, metadata }),
          ),
          timeline: appendTimeline(existing?.timeline ?? "", timelineEntry),
          frontmatter,
        },
      };
    });
  }
}
