import { describe, expect, it } from "vitest";

import {
  buildSourceChoiceProvenanceRecord,
  markPaperProvenanceRecordStale,
  PaperSourceCandidateSchema,
  upsertPaperProvenanceRecord,
} from "@/lib/paper-library/corpus";

const now = "2026-04-28T12:00:00.000Z";

const candidate = PaperSourceCandidateSchema.parse({
  id: "paper-1:source:local-pdf",
  paperId: "paper-1",
  paperSlug: "wiki/entities/papers/local-paper-1",
  sourceType: "pdf",
  origin: "local_pdf",
  status: "preferred",
  preferenceRank: 3,
  confidence: 0.78,
  detectedAt: now,
  evidence: ["local PDF papers/local-paper-1.pdf"],
});

describe("paper corpus provenance", () => {
  it("builds source-choice records with corpus source slugs", () => {
    expect(buildSourceChoiceProvenanceRecord({
      paperSlug: "wiki/entities/papers/local-paper-1",
      occurredAt: now,
      candidate,
    })).toMatchObject({
      id: "source-choice:paper-1:source:local-pdf",
      eventType: "source_choice",
      status: "succeeded",
      sourceSlug: "wiki/sources/papers/local-paper-1/source",
      details: {
        candidateId: "paper-1:source:local-pdf",
      },
    });
  });

  it("upserts records by id and keeps a stable chronological order", () => {
    const first = buildSourceChoiceProvenanceRecord({
      paperSlug: "wiki/entities/papers/local-paper-1",
      occurredAt: "2026-04-28T12:02:00.000Z",
      candidate,
    });
    const updated = {
      ...first,
      message: "Updated source choice.",
    };
    const earlier = {
      ...first,
      id: "identity:paper-1",
      occurredAt: "2026-04-28T12:01:00.000Z",
      eventType: "identity_resolution" as const,
    };

    expect(upsertPaperProvenanceRecord([first, earlier], updated)).toEqual([
      earlier,
      updated,
    ]);
  });

  it("marks stale records with an explicit reason", () => {
    const record = buildSourceChoiceProvenanceRecord({
      paperSlug: "wiki/entities/papers/local-paper-1",
      occurredAt: now,
      candidate,
    });

    expect(markPaperProvenanceRecordStale(record, "Selected source hash changed.")).toMatchObject({
      status: "stale",
      staleReason: "Selected source hash changed.",
    });
  });
});
