import {
  paperCorpusBibliographySlug,
  paperCorpusSourceSlugForPaperSlug,
  paperCorpusSummarySlugForPaperSlug,
} from "@/lib/paper-library/corpus";
import type { CorpusFixtureDescriptor } from "../../../lib/paper-library/corpus/fixture-helpers";

const now = "2026-04-28T12:00:00.000Z";

function sourceCandidateBase(input: {
  id: string;
  paperId: string;
  paperSlug: string;
  sourceType: "latex" | "html" | "pdf" | "metadata";
  origin: "arxiv_source" | "local_sidecar" | "local_pdf" | "remote_html" | "manual" | "gbrain";
  status?: "available" | "preferred" | "fallback" | "unavailable" | "blocked";
  preferenceRank: number;
  confidence: number;
  evidence: string[];
}): CorpusFixtureDescriptor["expectedCandidate"] {
  return {
    id: input.id,
    paperId: input.paperId,
    paperSlug: input.paperSlug,
    sourceType: input.sourceType,
    origin: input.origin,
    status: input.status ?? "available",
    preferenceRank: input.preferenceRank,
    confidence: input.confidence,
    detectedAt: now,
    evidence: input.evidence,
  };
}

export const phase0CorpusFixtureDescriptors: CorpusFixtureDescriptor[] = [
  {
    kind: "arxiv_latex_source",
    paperId: "paper-arxiv-2401-00001",
    paperSlug: "wiki/entities/papers/arxiv-2401-00001",
    description: "arXiv paper with a preferred LaTeX source candidate.",
    expectedCandidate: sourceCandidateBase({
      id: "candidate-arxiv-latex",
      paperId: "paper-arxiv-2401-00001",
      paperSlug: "wiki/entities/papers/arxiv-2401-00001",
      sourceType: "latex",
      origin: "arxiv_source",
      status: "preferred",
      preferenceRank: 1,
      confidence: 0.98,
      evidence: ["arxiv_identifier", "source_archive_available"],
    }),
    expectedWarnings: [],
  },
  {
    kind: "local_latex_or_html_sidecar",
    paperId: "paper-local-html-2024",
    paperSlug: "wiki/entities/papers/local-html-2024",
    description: "Local paper with a sidecar HTML source preferred over PDF.",
    expectedCandidate: sourceCandidateBase({
      id: "candidate-local-html",
      paperId: "paper-local-html-2024",
      paperSlug: "wiki/entities/papers/local-html-2024",
      sourceType: "html",
      origin: "local_sidecar",
      status: "preferred",
      preferenceRank: 2,
      confidence: 0.9,
      evidence: ["sidecar_detected", "html_readable"],
    }),
    expectedWarnings: [],
  },
  {
    kind: "good_text_layer_pdf",
    paperId: "paper-good-pdf-2024",
    paperSlug: "wiki/entities/papers/good-pdf-2024",
    description: "PDF fallback with enough text layer quality to materialize source artifacts.",
    expectedCandidate: sourceCandidateBase({
      id: "candidate-good-pdf",
      paperId: "paper-good-pdf-2024",
      paperSlug: "wiki/entities/papers/good-pdf-2024",
      sourceType: "pdf",
      origin: "local_pdf",
      status: "fallback",
      preferenceRank: 3,
      confidence: 0.76,
      evidence: ["pdf_text_layer_detected"],
    }),
    expectedSourceArtifact: {
      paperId: "paper-good-pdf-2024",
      paperSlug: "wiki/entities/papers/good-pdf-2024",
      sourceSlug: paperCorpusSourceSlugForPaperSlug("wiki/entities/papers/good-pdf-2024"),
      selectedCandidateId: "candidate-good-pdf",
      sourceType: "pdf",
      origin: "local_pdf",
      status: "current",
      extractor: { name: "pdf-parse", adapter: "text-layer", installed: true },
      sourceHash: "sha256-good-pdf-source",
      sectionMapHash: "sha256-good-pdf-section-map",
      normalizedMarkdown: "# Good PDF\n\nThis fixture stands in for extracted PDF text.",
      quality: {
        score: 0.76,
        wordCount: 1200,
        hasTextLayer: true,
        warnings: [],
      },
      createdAt: now,
      updatedAt: now,
    },
    expectedSectionMap: {
      paperSlug: "wiki/entities/papers/good-pdf-2024",
      sourceSlug: paperCorpusSourceSlugForPaperSlug("wiki/entities/papers/good-pdf-2024"),
      sourceHash: "sha256-good-pdf-source",
      sectionMapHash: "sha256-good-pdf-section-map",
      status: "current",
      sections: [
        {
          sectionId: "abstract",
          title: "Abstract",
          level: 1,
          ordinal: 0,
          anchor: "abstract",
          chunkHandles: [
            {
              sourceSlug: paperCorpusSourceSlugForPaperSlug("wiki/entities/papers/good-pdf-2024"),
              chunkId: "chunk-abstract",
              chunkIndex: 0,
              sectionId: "abstract",
            },
          ],
        },
      ],
      createdAt: now,
      updatedAt: now,
    },
    expectedRelevanceSummary: {
      paperSlug: "wiki/entities/papers/good-pdf-2024",
      sourceSlug: paperCorpusSourceSlugForPaperSlug("wiki/entities/papers/good-pdf-2024"),
      summarySlug: paperCorpusSummarySlugForPaperSlug("wiki/entities/papers/good-pdf-2024", "relevance"),
      tier: "relevance",
      status: "current",
      sourceHash: "sha256-good-pdf-source",
      sectionMapHash: "sha256-good-pdf-section-map",
      promptVersion: "paper-relevance-v1",
      modelId: "local-fixture-model",
      generationSettings: { temperature: 0 },
      createdAt: now,
      updatedAt: now,
      generatedAt: now,
      evidence: [
        {
          statement: "Good PDF fixture has searchable source text.",
          chunkHandles: [
            {
              sourceSlug: paperCorpusSourceSlugForPaperSlug("wiki/entities/papers/good-pdf-2024"),
              chunkId: "chunk-abstract",
              chunkIndex: 0,
              sectionId: "abstract",
            },
          ],
        },
      ],
    },
    expectedBibliography: [
      {
        bibliographySlug: paperCorpusBibliographySlug(
          { doi: "10.1000/example-good-pdf" },
          "Good PDF reference",
        ),
        identifiers: { doi: "10.1000/example-good-pdf" },
        title: "Good PDF reference",
        authors: ["A. Example"],
        year: 2024,
        localStatus: "metadata_only",
        seenIn: [
          {
            paperSlug: "wiki/entities/papers/good-pdf-2024",
            bibKey: "example2024",
            extractionSource: "pdf_references",
            confidence: 0.72,
          },
        ],
      },
    ],
    expectedWarnings: [],
  },
  {
    kind: "advanced_pdf_parser_unavailable",
    paperId: "paper-math-heavy-pdf-2024",
    paperSlug: "wiki/entities/papers/math-heavy-pdf-2024",
    description: "Math-heavy PDF that should expose advanced parser unavailability.",
    expectedCandidate: sourceCandidateBase({
      id: "candidate-math-heavy-pdf",
      paperId: "paper-math-heavy-pdf-2024",
      paperSlug: "wiki/entities/papers/math-heavy-pdf-2024",
      sourceType: "pdf",
      origin: "local_pdf",
      status: "unavailable",
      preferenceRank: 3,
      confidence: 0.4,
      evidence: ["math_heavy_pdf", "advanced_parser_missing"],
    }),
    expectedWarnings: ["parser_unavailable", "equations_degraded"],
  },
  {
    kind: "scanned_or_low_text_pdf",
    paperId: "paper-scanned-pdf-2024",
    paperSlug: "wiki/entities/papers/scanned-pdf-2024",
    description: "Scanned PDF that must fail visibly instead of producing weak summaries.",
    expectedCandidate: sourceCandidateBase({
      id: "candidate-scanned-pdf",
      paperId: "paper-scanned-pdf-2024",
      paperSlug: "wiki/entities/papers/scanned-pdf-2024",
      sourceType: "pdf",
      origin: "local_pdf",
      status: "blocked",
      preferenceRank: 3,
      confidence: 0.15,
      evidence: ["low_text_layer"],
    }),
    expectedWarnings: ["low_text_layer", "ocr_required"],
  },
  {
    kind: "duplicate_identity",
    paperId: "paper-duplicate-doi",
    paperSlug: "wiki/entities/papers/doi-10-1000-duplicate",
    description: "Duplicate identity candidate that should preserve same-identity repair evidence.",
    expectedCandidate: {
      ...sourceCandidateBase({
        id: "candidate-duplicate-doi",
        paperId: "paper-duplicate-doi",
        paperSlug: "wiki/entities/papers/doi-10-1000-duplicate",
        sourceType: "metadata",
        origin: "gbrain",
        status: "blocked",
        preferenceRank: 4,
        confidence: 0.65,
        evidence: ["doi_collision"],
      }),
      identifiers: { doi: "10.1000/duplicate" },
      warnings: [
        {
          code: "duplicate_identity",
          message: "DOI maps to more than one candidate paper slug.",
          severity: "warning",
        },
      ],
    },
    expectedWarnings: ["duplicate_identity"],
  },
];
