import { describe, expect, it } from "vitest";

import {
  GbrainCorpusCapabilitiesSchema,
  PaperIngestManifestSchema,
  PaperSectionMapSchema,
  PaperSourceArtifactSchema,
  PaperSourceCandidateSchema,
  PaperSummaryArtifactSchema,
  ResearchContextPacketSchema,
  paperCorpusBibliographySlug,
  paperCorpusSourceSlugForPaperSlug,
  paperCorpusSummarySlugForPaperSlug,
} from "@/lib/paper-library/corpus";
import { phase0CorpusFixtureDescriptors } from "../../../fixtures/paper-library/corpus/phase0-fixtures";

const now = "2026-04-28T12:00:00.000Z";

describe("paper-library corpus contracts", () => {
  it("accepts source candidate precedence across LaTeX, HTML, PDF, and parser-unavailable fixtures", () => {
    for (const descriptor of phase0CorpusFixtureDescriptors) {
      expect(() => PaperSourceCandidateSchema.parse(descriptor.expectedCandidate)).not.toThrow();
    }

    const ranks = phase0CorpusFixtureDescriptors.map(
      (descriptor) => descriptor.expectedCandidate.preferenceRank,
    );
    expect(new Set(ranks)).toEqual(new Set([1, 2, 3, 4]));
  });

  it("parses gbrain materialization artifacts for source, section map, summary, and bibliography outputs", () => {
    const fixture = phase0CorpusFixtureDescriptors.find(
      (descriptor) => descriptor.kind === "good_text_layer_pdf",
    );
    if (!fixture?.expectedSourceArtifact || !fixture.expectedSectionMap || !fixture.expectedRelevanceSummary) {
      throw new Error("expected good text-layer PDF fixture artifacts");
    }

    expect(PaperSourceArtifactSchema.parse(fixture.expectedSourceArtifact)).toMatchObject({
      paperSlug: "wiki/entities/papers/good-pdf-2024",
      sourceSlug: "wiki/sources/papers/good-pdf-2024/source",
      sourceType: "pdf",
      status: "current",
    });
    expect(PaperSectionMapSchema.parse(fixture.expectedSectionMap).sections[0]).toMatchObject({
      sectionId: "abstract",
      chunkHandles: [
        expect.objectContaining({
          chunkId: "chunk-abstract",
          chunkIndex: 0,
        }),
      ],
    });
    expect(PaperSummaryArtifactSchema.parse(fixture.expectedRelevanceSummary)).toMatchObject({
      tier: "relevance",
      status: "current",
      promptVersion: "paper-relevance-v1",
    });
    const bibliography = fixture.expectedBibliography ?? [];
    expect(bibliography).toHaveLength(1);
    expect(bibliography[0]?.bibliographySlug).toBe(
      "wiki/bibliography/doi-10-1000-example-good-pdf",
    );
  });

  it("records visible warnings for duplicate, low-text, and unavailable-parser fixture paths", () => {
    expect(
      phase0CorpusFixtureDescriptors.find((descriptor) => descriptor.kind === "advanced_pdf_parser_unavailable")
        ?.expectedWarnings,
    ).toEqual(["parser_unavailable", "equations_degraded"]);
    expect(
      phase0CorpusFixtureDescriptors.find((descriptor) => descriptor.kind === "scanned_or_low_text_pdf")
        ?.expectedWarnings,
    ).toEqual(["low_text_layer", "ocr_required"]);
    expect(
      phase0CorpusFixtureDescriptors.find((descriptor) => descriptor.kind === "duplicate_identity")
        ?.expectedCandidate.warnings,
    ).toEqual([
      expect.objectContaining({
        code: "duplicate_identity",
        message: expect.stringContaining("DOI"),
      }),
    ]);
  });

  it("parses a manifest that carries concurrency gates and compact provenance", () => {
    const manifest = PaperIngestManifestSchema.parse({
      version: 1,
      id: "corpus-manifest-1",
      project: "project-alpha",
      scanId: "scan-1",
      status: "planned",
      createdAt: now,
      updatedAt: now,
      parserConcurrencyLimit: 2,
      summaryConcurrencyLimit: 1,
      papers: [
        {
          paperId: "paper-good-pdf-2024",
          paperSlug: "wiki/entities/papers/good-pdf-2024",
          identifiers: { doi: "10.1000/example-good-pdf" },
          title: "Good PDF fixture",
          status: "current",
          sourceCandidates: [
            phase0CorpusFixtureDescriptors.find((descriptor) => descriptor.kind === "good_text_layer_pdf")
              ?.expectedCandidate,
          ],
          selectedSourceCandidateId: "candidate-good-pdf",
          provenance: [
            {
              id: "provenance-source-choice-1",
              paperSlug: "wiki/entities/papers/good-pdf-2024",
              occurredAt: now,
              eventType: "source_choice",
              status: "succeeded",
              sourceType: "pdf",
              sourceSlug: "wiki/sources/papers/good-pdf-2024/source",
              inputHash: "sha256-good-pdf-source",
              message: "PDF fallback selected because no LaTeX or HTML source was available.",
            },
          ],
        },
      ],
    });

    expect(manifest.parserConcurrencyLimit).toBe(2);
    expect(manifest.summaryConcurrencyLimit).toBe(1);
    expect(manifest.papers[0]?.provenance[0]).toMatchObject({
      eventType: "source_choice",
      status: "succeeded",
    });
  });

  it("parses a research context packet with selected papers, graph paths, evidence handles, and capability caveats", () => {
    const packet = ResearchContextPacketSchema.parse({
      question: "Does mechanism X plausibly explain phenotype Y?",
      generatedAt: now,
      studySlug: "project-alpha",
      selectionPolicy: "local-literature-first-v1",
      capabilities: GbrainCorpusCapabilitiesSchema.parse({
        generatedAt: now,
        capabilities: [
          { mode: "keyword_chunks", status: "available" },
          { mode: "embeddings", status: "unavailable", reason: "embedding coverage missing" },
          { mode: "typed_links", status: "degraded", reason: "using audited first-train link subset" },
        ],
      }),
      papers: [
        {
          paperSlug: "wiki/entities/papers/good-pdf-2024",
          title: "Good PDF fixture",
          role: "core",
          reasonSelected: "Matched the mechanism and outcome in relevance-card text.",
          relevanceCardSlug: "wiki/summaries/papers/good-pdf-2024/relevance",
          sourceChunks: [
            {
              sourceSlug: "wiki/sources/papers/good-pdf-2024/source",
              chunkId: "chunk-abstract",
              chunkIndex: 0,
              sectionId: "abstract",
            },
          ],
          graphPaths: [
            {
              from: "wiki/entities/papers/good-pdf-2024",
              relation: "has_source",
              to: "wiki/sources/papers/good-pdf-2024/source",
            },
          ],
        },
      ],
      claims: [
        {
          id: "claim-1",
          statement: "The local corpus contains one usable PDF-derived evidence handle.",
          confidence: "medium",
          supportingChunks: [
            {
              sourceSlug: "wiki/sources/papers/good-pdf-2024/source",
              chunkId: "chunk-abstract",
              chunkIndex: 0,
            },
          ],
          paperSlugs: ["wiki/entities/papers/good-pdf-2024"],
        },
      ],
      tensions: [],
      missingPapers: [
        {
          bibliographySlug: "wiki/bibliography/doi-10-1000-example-good-pdf",
          reason: "Cited by the local paper but not yet present as a full local source.",
          acquisitionStatus: "metadata_only",
        },
      ],
      caveats: ["Embeddings unavailable; packet uses lexical chunks and audited links."],
    });

    expect(packet.papers[0]?.sourceChunks[0]).toMatchObject({
      sourceSlug: "wiki/sources/papers/good-pdf-2024/source",
      chunkId: "chunk-abstract",
    });
    expect(packet.capabilities.capabilities).toContainEqual(
      expect.objectContaining({
        mode: "embeddings",
        status: "unavailable",
      }),
    );
  });

  it("builds canonical corpus slugs from existing paper-library page slugs", () => {
    expect(paperCorpusSourceSlugForPaperSlug("wiki/entities/papers/arxiv-2401-01234")).toBe(
      "wiki/sources/papers/arxiv-2401-01234/source",
    );
    expect(paperCorpusSummarySlugForPaperSlug("wiki/entities/papers/doi-10-1000-example", "detailed")).toBe(
      "wiki/summaries/papers/doi-10-1000-example/detailed",
    );
    expect(paperCorpusBibliographySlug({ arxivId: "2401.01234v2" }, "Fallback Title")).toBe(
      "wiki/bibliography/arxiv-2401-01234v2",
    );
  });
});
