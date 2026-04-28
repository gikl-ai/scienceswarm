import { describe, expect, it } from "vitest";

import {
  buildPaperCorpusIngestPaper,
  buildPaperCorpusManifest,
  buildPaperCorpusSourceCandidates,
} from "@/lib/paper-library/corpus";
import type { PaperReviewItem } from "@/lib/paper-library/contracts";

const now = "2026-04-28T12:00:00.000Z";

function reviewItem(input: Partial<PaperReviewItem> = {}): PaperReviewItem {
  return {
    id: "review-1",
    scanId: "scan-1",
    paperId: "paper-1",
    state: "accepted",
    reasonCodes: [],
    source: {
      relativePath: "papers/local-paper-1.pdf",
      rootRealpath: "/library",
      size: 1200,
      mtimeMs: 1000,
      fingerprint: "sha256-local-paper-1",
      fingerprintStrength: "sha256",
      symlink: false,
    },
    candidates: [
      {
        id: "identity-1",
        identifiers: { arxivId: "2401.01234v2" },
        title: "Local Paper 1",
        authors: [],
        source: "arxiv",
        confidence: 0.9,
        evidence: ["arxiv identifier"],
        conflicts: [],
      },
    ],
    selectedCandidateId: "identity-1",
    version: 1,
    updatedAt: now,
    ...input,
  };
}

describe("paper corpus source inventory", () => {
  it("ranks arXiv source, local sidecars, and local PDF fallback deterministically", () => {
    const candidates = buildPaperCorpusSourceCandidates({
      item: reviewItem(),
      detectedAt: now,
      sidecarRelativePaths: [
        "papers/local-paper-1.html",
        "papers/local-paper-1.tex",
        "papers/unrelated.tex",
      ],
    });

    expect(candidates.map((candidate) => ({
      id: candidate.id,
      origin: candidate.origin,
      sourceType: candidate.sourceType,
      status: candidate.status,
      rank: candidate.preferenceRank,
    }))).toEqual([
      {
        id: "paper-1:source:arxiv-source",
        origin: "arxiv_source",
        sourceType: "latex",
        status: "preferred",
        rank: 1,
      },
      {
        id: "paper-1:source:sidecar-html-papers-local-paper-1-html",
        origin: "local_sidecar",
        sourceType: "html",
        status: "fallback",
        rank: 2,
      },
      {
        id: "paper-1:source:sidecar-latex-papers-local-paper-1-tex",
        origin: "local_sidecar",
        sourceType: "latex",
        status: "fallback",
        rank: 2,
      },
      {
        id: "paper-1:source:local-pdf",
        origin: "local_pdf",
        sourceType: "pdf",
        status: "fallback",
        rank: 3,
      },
    ]);
    expect(candidates[0]?.url).toBe("https://arxiv.org/e-print/2401.01234");
  });

  it("prefers a local source sidecar when no arXiv source is known", () => {
    const candidates = buildPaperCorpusSourceCandidates({
      item: reviewItem({
        candidates: [
          {
            id: "identity-1",
            identifiers: { doi: "10.1000/example" },
            title: "Local Paper 1",
            authors: [],
            source: "crossref",
            confidence: 0.82,
            evidence: ["doi"],
            conflicts: [],
          },
        ],
      }),
      detectedAt: now,
      sidecarRelativePaths: ["papers/local-paper-1.tex"],
    });

    expect(candidates.map((candidate) => [candidate.origin, candidate.status])).toEqual([
      ["local_sidecar", "preferred"],
      ["local_pdf", "fallback"],
    ]);
  });

  it("does not attach metadata from an unresolved selected identity candidate", () => {
    const candidates = buildPaperCorpusSourceCandidates({
      item: reviewItem({
        selectedCandidateId: "missing-identity",
      }),
      detectedAt: now,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      origin: "local_pdf",
      status: "preferred",
      identifiers: {},
      title: "local-paper-1",
    });
  });

  it("treats empty trimmed identity titles as missing", () => {
    const candidates = buildPaperCorpusSourceCandidates({
      item: reviewItem({
        candidates: [
          {
            id: "identity-1",
            identifiers: {},
            title: "   ",
            authors: [],
            source: "filename",
            confidence: 0.5,
            evidence: ["filename"],
            conflicts: [],
          },
        ],
      }),
      detectedAt: now,
    });

    expect(candidates[0]).toMatchObject({
      title: "local-paper-1",
    });
  });

  it("keeps long sidecar candidate ids unique with a path hash suffix", () => {
    const sharedPrefix = `${"long-prefix-".repeat(10)}paper`;
    const candidates = buildPaperCorpusSourceCandidates({
      item: reviewItem({
        source: undefined,
        candidates: [
          {
            id: "identity-1",
            identifiers: {},
            title: "Sidecar Only Paper",
            authors: [],
            source: "filename",
            confidence: 0.5,
            evidence: ["filename"],
            conflicts: [],
          },
        ],
      }),
      detectedAt: now,
      sidecarRelativePaths: [
        `sources/${sharedPrefix}-alpha.tex`,
        `sources/${sharedPrefix}-beta.tex`,
      ],
    });

    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(2);
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      expect.stringMatching(/^paper-1:source:sidecar-latex-sources-long-prefix-.+-[a-f0-9]{8}$/),
      expect.stringMatching(/^paper-1:source:sidecar-latex-sources-long-prefix-.+-[a-f0-9]{8}$/),
    ]);
  });

  it("accepts explicit sidecar-only source paths when no local PDF snapshot exists", () => {
    const ingestPaper = buildPaperCorpusIngestPaper({
      item: reviewItem({
        source: undefined,
        candidates: [
          {
            id: "identity-1",
            identifiers: { doi: "10.1000/example" },
            title: "Sidecar Only Paper",
            authors: [],
            source: "crossref",
            confidence: 0.82,
            evidence: ["doi"],
            conflicts: [],
          },
        ],
      }),
      detectedAt: now,
      sidecarRelativePaths: ["sources/sidecar-only-paper.tex"],
    });

    expect(ingestPaper).toMatchObject({
      status: "planned",
      selectedSourceCandidateId: "paper-1:source:sidecar-latex-sources-sidecar-only-paper-tex",
      sourceCandidates: [
        {
          origin: "local_sidecar",
          sourceType: "latex",
          status: "preferred",
          relativePath: "sources/sidecar-only-paper.tex",
        },
      ],
      warnings: [],
    });
  });

  it("builds blocked ingest papers when no source candidate exists", () => {
    const ingestPaper = buildPaperCorpusIngestPaper({
      item: reviewItem({
        source: undefined,
        candidates: [
          {
            id: "identity-1",
            identifiers: {},
            title: "Metadata Only Paper",
            authors: [],
            source: "filename",
            confidence: 0.4,
            evidence: ["filename"],
            conflicts: [],
          },
        ],
      }),
      detectedAt: now,
    });

    expect(ingestPaper).toMatchObject({
      status: "blocked",
      selectedSourceCandidateId: undefined,
      warnings: [
        {
          code: "insufficient_local_evidence",
        },
      ],
    });
  });

  it("assembles manifest papers with source-choice provenance", () => {
    const manifest = buildPaperCorpusManifest({
      id: "corpus-manifest-1",
      project: "project-alpha",
      scanId: "scan-1",
      createdAt: now,
      items: [
        reviewItem({
          candidates: [
            {
              id: "identity-1",
              identifiers: { doi: "10.1000/example" },
              title: "Local Paper 1",
              authors: [],
              source: "crossref",
              confidence: 0.82,
              evidence: ["doi"],
              conflicts: [],
            },
          ],
        }),
      ],
      sidecarRelativePathsByPaperId: {
        "paper-1": ["papers/local-paper-1.html"],
      },
    });

    expect(manifest).toMatchObject({
      version: 1,
      id: "corpus-manifest-1",
      project: "project-alpha",
      scanId: "scan-1",
      parserConcurrencyLimit: 2,
      summaryConcurrencyLimit: 1,
      papers: [
        {
          paperSlug: "wiki/entities/papers/doi-10-1000-example",
          selectedSourceCandidateId: "paper-1:source:sidecar-html-papers-local-paper-1-html",
          provenance: [
            {
              eventType: "source_choice",
              status: "succeeded",
            },
          ],
        },
      ],
    });
  });
});
