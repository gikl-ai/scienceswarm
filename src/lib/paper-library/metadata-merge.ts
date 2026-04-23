import type {
  PaperIdentityCandidate,
  PaperMetadataField,
  PaperMetadataSource,
} from "./contracts";

const SOURCE_PRIORITY: Record<PaperMetadataSource, number> = {
  user: 100,
  gbrain: 90,
  crossref: 80,
  pubmed: 78,
  arxiv: 76,
  openalex: 74,
  semantic_scholar: 70,
  pdf_text: 55,
  filename: 35,
  path: 30,
  model: 20,
};

function sourcePriority(source: PaperMetadataSource): number {
  return SOURCE_PRIORITY[source] ?? 0;
}

function normalizeComparable(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(normalizeComparable).join("|");
  }
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export interface MergeMetadataResult {
  field: PaperMetadataField | null;
  conflicts: PaperMetadataField[];
  unavailableSources: PaperMetadataField[];
}

export function mergeMetadataField(fields: PaperMetadataField[]): MergeMetadataResult {
  const available = fields.filter((field) => field.sourceStatus !== "unavailable");
  const unavailableSources = fields.filter((field) => field.sourceStatus === "unavailable");

  if (available.length === 0) {
    return { field: null, conflicts: [], unavailableSources };
  }

  const sorted = [...available].sort((left, right) => {
    const priorityDelta = sourcePriority(right.source) - sourcePriority(left.source);
    if (priorityDelta !== 0) return priorityDelta;
    return right.confidence - left.confidence;
  });

  const chosen = sorted[0];
  const chosenComparable = normalizeComparable(chosen.value);
  const conflicts = sorted
    .slice(1)
    .filter((field) => normalizeComparable(field.value) !== chosenComparable && field.confidence >= 0.7);

  return {
    field: {
      ...chosen,
      conflict: conflicts.length > 0,
      evidence: [
        ...chosen.evidence,
        ...unavailableSources.map((source) => `${source.source}:unavailable`),
        ...conflicts.map((field) => `${field.source}:conflict`),
      ],
    },
    conflicts,
    unavailableSources,
  };
}

export type PaperConfidenceBand = "high" | "medium" | "low" | "blocked";

export interface PaperConfidenceResult {
  score: number;
  band: PaperConfidenceBand;
  blockReasons: string[];
}

export function scorePaperIdentity(input: {
  candidate: PaperIdentityCandidate | null;
  metadataFields: PaperMetadataField[];
  requiredTemplateFieldsMissing?: string[];
  pathConflictCodes?: string[];
}): PaperConfidenceResult {
  const blockReasons = [
    ...(input.requiredTemplateFieldsMissing ?? []).map((field) => `missing:${field}`),
    ...(input.pathConflictCodes ?? []),
  ];

  const deterministicIdentifier = Boolean(
    input.candidate?.identifiers.doi
      || input.candidate?.identifiers.arxivId
      || input.candidate?.identifiers.pmid,
  );
  const deterministicSource = input.candidate
    ? ["crossref", "openalex", "pubmed", "arxiv", "pdf_text", "gbrain", "user"].includes(input.candidate.source)
    : false;
  const metadataConflict = input.metadataFields.some((field) => field.conflict);
  if (metadataConflict) blockReasons.push("metadata_conflict");
  if (input.candidate?.conflicts.length) blockReasons.push(...input.candidate.conflicts);

  let score = input.candidate?.confidence ?? 0;
  if (deterministicIdentifier && deterministicSource) score = Math.max(score, 0.9);
  if (!input.candidate) score = 0;
  if (blockReasons.length > 0) {
    return { score, band: "blocked", blockReasons };
  }
  if (score >= 0.9) return { score, band: "high", blockReasons };
  if (score >= 0.7) return { score, band: "medium", blockReasons };
  return { score, band: "low", blockReasons };
}

export function buildMetadataField(
  name: string,
  value: unknown,
  source: PaperMetadataSource,
  confidence: number,
  evidence: string[] = [],
): PaperMetadataField {
  return {
    name,
    value,
    source,
    confidence,
    evidence,
    conflict: false,
    sourceStatus: "available",
  };
}
