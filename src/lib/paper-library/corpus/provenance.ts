import {
  PaperProvenanceLedgerRecordSchema,
  paperCorpusSourceSlugForPaperSlug,
  type PaperProvenanceLedgerRecord,
  type PaperSourceCandidate,
} from "./contracts";

export function createPaperProvenanceRecord(
  input: Parameters<typeof PaperProvenanceLedgerRecordSchema.parse>[0],
): PaperProvenanceLedgerRecord {
  return PaperProvenanceLedgerRecordSchema.parse(input);
}

export function upsertPaperProvenanceRecord(
  records: readonly PaperProvenanceLedgerRecord[],
  record: PaperProvenanceLedgerRecord,
): PaperProvenanceLedgerRecord[] {
  const byId = new Map(records.map((entry) => [entry.id, entry]));
  byId.set(record.id, record);
  return [...byId.values()].sort((left, right) => {
    const occurredAtOrder = left.occurredAt.localeCompare(right.occurredAt);
    return occurredAtOrder === 0 ? left.id.localeCompare(right.id) : occurredAtOrder;
  });
}

export function markPaperProvenanceRecordStale(
  record: PaperProvenanceLedgerRecord,
  staleReason: string,
): PaperProvenanceLedgerRecord {
  return PaperProvenanceLedgerRecordSchema.parse({
    ...record,
    status: "stale",
    staleReason,
  });
}

export function buildSourceChoiceProvenanceRecord(input: {
  paperSlug: string;
  occurredAt: string;
  candidate: PaperSourceCandidate;
  message?: string;
}): PaperProvenanceLedgerRecord {
  return PaperProvenanceLedgerRecordSchema.parse({
    id: `source-choice:${input.candidate.id}`,
    paperSlug: input.paperSlug,
    occurredAt: input.occurredAt,
    eventType: "source_choice",
    status: input.candidate.status === "unavailable" || input.candidate.status === "blocked" ? "blocked" : "succeeded",
    sourceType: input.candidate.sourceType,
    sourceSlug: paperCorpusSourceSlugForPaperSlug(input.paperSlug),
    message: input.message ?? `Selected ${input.candidate.origin} ${input.candidate.sourceType} source candidate.`,
    details: {
      candidateId: input.candidate.id,
      origin: input.candidate.origin,
      preferenceRank: input.candidate.preferenceRank,
    },
    warnings: input.candidate.warnings,
  });
}
