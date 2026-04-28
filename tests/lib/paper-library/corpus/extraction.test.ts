import { describe, expect, it } from "vitest";

import {
  buildPaperSectionMap,
  extractHtmlCorpusSource,
  extractLatexCorpusSource,
  extractPdfTextCorpusSource,
  PaperSourceCandidateSchema,
  selectPdfParserAdapter,
  type PaperSourceCandidate,
} from "@/lib/paper-library/corpus";
import { phase0CorpusFixtureDescriptors } from "../../../fixtures/paper-library/corpus/phase0-fixtures";

const now = "2026-04-28T12:00:00.000Z";

function fixtureCandidate(kind: string): PaperSourceCandidate {
  const descriptor = phase0CorpusFixtureDescriptors.find((item) => item.kind === kind);
  if (!descriptor) throw new Error(`missing fixture ${kind}`);
  return PaperSourceCandidateSchema.parse(descriptor.expectedCandidate);
}

describe("paper-library corpus extraction adapters", () => {
  it("normalizes LaTeX source into source, section-map, and bibliography artifacts", () => {
    const candidate = fixtureCandidate("arxiv_latex_source");
    const result = extractLatexCorpusSource({
      candidate,
      extractedAt: now,
      latex: String.raw`
        \documentclass{article}
        \title{Neural Fields for Cell Signaling}
        \begin{document}
        \maketitle
        \begin{abstract}
        We test whether neural field models recover signaling dynamics from sparse assays.
        \end{abstract}
        \section{Introduction to {Field} Models}
        The paper cites \citep{smith2024signals} and states the biological mechanism.
        \section{Methods}
        We fit a compact model to perturbation data.
        \begin{thebibliography}{1}
        \bibitem{smith2024signals}
        Smith, A.
        \newblock Signaling dynamics at scale.
        \newblock Journal of Cell Systems, 2024.
        \newblock doi:10.1000/signals.
        \end{thebibliography}
        \end{document}
      `,
    });

    expect(result.sourceArtifact).toMatchObject({
      paperSlug: "wiki/entities/papers/arxiv-2401-00001",
      sourceType: "latex",
      status: "current",
      extractor: { name: "latex-source", adapter: "latex-to-markdown", installed: true },
    });
    expect(result.sourceArtifact.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceArtifact.sectionMapHash).toBe(result.sectionMap?.sectionMapHash);
    expect(result.sourceArtifact.normalizedMarkdown).toContain("# Neural Fields for Cell Signaling");
    expect(result.sourceArtifact.normalizedMarkdown).toContain("## Abstract");
    expect(result.sectionMap?.sections.map((section) => section.sectionId)).toEqual([
      "abstract",
      "introduction-to-field-models",
      "methods",
      "references",
    ]);
    expect(result.sectionMap?.sections[0]?.chunkHandles[0]).toMatchObject({
      chunkId: "section-abstract",
      chunkIndex: 0,
      sectionId: "abstract",
    });
    expect(result.bibliography[0]).toMatchObject({
      bibliographySlug: "wiki/bibliography/doi-10-1000-signals",
      title: "Signaling dynamics at scale",
      year: 2024,
      seenIn: [
        {
          paperSlug: "wiki/entities/papers/arxiv-2401-00001",
          bibKey: "smith2024signals",
          extractionSource: "bbl",
        },
      ],
    });
  });

  it("normalizes HTML sidecars and extracts reference identifiers", () => {
    const candidate = fixtureCandidate("local_latex_or_html_sidecar");
    const result = extractHtmlCorpusSource({
      candidate,
      extractedAt: now,
      html: `
        <!doctype html>
        <html>
          <head><title>HTML Evidence Paper</title></head>
          <body>
            <article>
              <h1>HTML Evidence Paper</h1>
              <h2>Abstract</h2>
              <p>HTML carries structured paper text without PDF artifacts.</p>
              <h2>Results</h2>
              <p>The extracted source remains section addressable.</p>
              <h3>References</h3>
              <ol>
                <li>[1] Roe, B. (2019). "Semantic sidecars for research." Web Journal, 2019. DOI registered 2020. doi:10.1000/html-sidecar.</li>
              </ol>
            </article>
          </body>
        </html>
      `,
    });

    expect(result.sourceArtifact).toMatchObject({
      sourceType: "html",
      origin: "local_sidecar",
      status: "current",
      extractor: { name: "html-sidecar", adapter: "html-to-markdown", installed: true },
    });
    expect(result.sourceArtifact.normalizedMarkdown).toContain("## Abstract");
    expect(result.sourceArtifact.normalizedMarkdown.startsWith("# HTML Evidence Paper")).toBe(true);
    expect(result.sourceArtifact.normalizedMarkdown.split("\n").filter((line) => line === "HTML Evidence Paper"))
      .toHaveLength(0);
    expect(result.sectionMap?.sections.map((section) => section.title)).toContain("Results");
    expect(result.bibliography[0]).toMatchObject({
      bibliographySlug: "wiki/bibliography/doi-10-1000-html-sidecar",
      year: 2019,
      seenIn: [expect.objectContaining({ extractionSource: "html_references" })],
    });
  });

  it("guards malformed bibliography metadata instead of emitting invalid artifacts", () => {
    const candidate = fixtureCandidate("arxiv_latex_source");
    const result = extractLatexCorpusSource({
      candidate,
      extractedAt: now,
      latex: String.raw`
        \title{Malformed Bibliography Paper}
        \begin{abstract}A short abstract.\end{abstract}
        \section{Findings}
        The paper cites malformed metadata from a sidecar BibTeX file.
      `,
      bibtex: String.raw`
        @article{forthcoming,
          title = {Forthcoming work with malformed DOI},
          author = {Curie, M.},
          year = {forthcoming},
          doi = {https://doi.org/}
        }
      `,
    });

    expect(result.bibliography[0]).toMatchObject({
      bibliographySlug: "wiki/bibliography/title-forthcoming-work-with-malformed-doi",
      title: "Forthcoming work with malformed DOI",
      year: undefined,
      identifiers: {},
      seenIn: [expect.objectContaining({ extractionSource: "latex_bib" })],
    });
  });

  it("uses the PDF text-layer baseline when quality is adequate", () => {
    const candidate = fixtureCandidate("good_text_layer_pdf");
    const result = extractPdfTextCorpusSource({
      candidate,
      extractedAt: now,
      wordCount: 1200,
      hasTextLayer: true,
      text: [
        "Good Text Layer Paper",
        "Abstract",
        "A searchable text layer gives enough material for corpus extraction.",
        "1 Introduction",
        "The introduction explains the source quality assumptions.",
        "2 Methods",
        "The method section preserves stable section handles.",
        "References",
        "[1] Example, A. \"Good PDF reference.\" Journal of Fixtures, 2024. doi:10.1000/example-good-pdf.",
      ].join("\n"),
    });

    expect(result.parserDecision).toMatchObject({
      status: "available",
      extractor: { name: "pdf-parse", adapter: "text-layer", installed: true },
    });
    expect(result.sourceArtifact).toMatchObject({
      sourceType: "pdf",
      status: "current",
      quality: expect.objectContaining({
        score: 0.76,
        wordCount: 1200,
        hasTextLayer: true,
      }),
    });
    expect(result.sectionMap?.sections.map((section) => section.sectionId)).toEqual([
      "abstract",
      "introduction",
      "methods",
      "references",
    ]);
    expect(result.bibliography[0]?.bibliographySlug).toBe(
      "wiki/bibliography/doi-10-1000-example-good-pdf",
    );
  });

  it("makes Marker/MinerU-class parser absence visible for math-heavy PDFs", () => {
    const decision = selectPdfParserAdapter({
      wordCount: 1800,
      hasTextLayer: true,
      hasEquations: true,
      requiresAdvancedParser: true,
      adapters: {
        marker: { name: "marker", installed: false },
        mineru: { name: "mineru", installed: false },
      },
    });

    expect(decision).toMatchObject({
      status: "unavailable",
      extractor: { name: "marker-or-mineru", adapter: "advanced-pdf", installed: false },
      unavailableReason: "Advanced PDF parser unavailable for math-heavy or table-heavy source.",
    });
    expect(decision.warnings.map((item) => item.code)).toEqual([
      "parser_unavailable",
      "equations_degraded",
    ]);

    const result = extractPdfTextCorpusSource({
      candidate: fixtureCandidate("advanced_pdf_parser_unavailable"),
      extractedAt: now,
      wordCount: 1800,
      hasTextLayer: true,
      hasEquations: true,
      requiresAdvancedParser: true,
      text: "A math-heavy source with many equations.",
    });
    expect(result.sourceArtifact).toMatchObject({
      status: "blocked",
      extractor: { name: "marker-or-mineru", adapter: "advanced-pdf", installed: false },
    });
    expect(result.sectionMap).toBeUndefined();
    expect(result.warnings.map((item) => item.code)).toEqual([
      "parser_unavailable",
      "equations_degraded",
    ]);
  });

  it("blocks scanned or low-text PDFs instead of producing weak artifacts", () => {
    const result = extractPdfTextCorpusSource({
      candidate: fixtureCandidate("scanned_or_low_text_pdf"),
      extractedAt: now,
      hasTextLayer: false,
      scanned: true,
      text: "Abstract",
    });

    expect(result.sourceArtifact.status).toBe("blocked");
    expect(result.sourceArtifact.quality).toMatchObject({
      score: 0.05,
      hasTextLayer: false,
    });
    expect(result.warnings.map((item) => item.code)).toEqual([
      "no_text_layer",
      "low_text_layer",
      "ocr_required",
    ]);
  });

  it("keeps source hashes, section map hashes, and chunk handles deterministic", () => {
    const candidate = fixtureCandidate("local_latex_or_html_sidecar");
    const input = {
      candidate,
      extractedAt: now,
      html: `
        <h1>Deterministic Artifact</h1>
        <h2>Abstract</h2>
        <p>The adapter should produce repeatable hashes.</p>
        <h2>Conclusion</h2>
        <p>Stable handles let gbrain chunks stay addressable.</p>
      `,
    };
    const first = extractHtmlCorpusSource(input);
    const second = extractHtmlCorpusSource(input);

    expect(first.sourceArtifact.normalizedMarkdown.startsWith("# Deterministic Artifact")).toBe(true);
    expect(first.sourceArtifact.sourceHash).toBe(second.sourceArtifact.sourceHash);
    expect(first.sectionMap?.sectionMapHash).toBe(second.sectionMap?.sectionMapHash);
    expect(first.sectionMap?.sections).toEqual(second.sectionMap?.sections);
    expect(first.sectionMap?.sections[1]?.chunkHandles[0]).toEqual({
      sourceSlug: first.sourceArtifact.sourceSlug,
      chunkId: "section-conclusion",
      chunkIndex: 1,
      sectionId: "conclusion",
    });

    const rebuilt = buildPaperSectionMap({
      paperSlug: first.sourceArtifact.paperSlug,
      sourceSlug: first.sourceArtifact.sourceSlug,
      sourceHash: first.sourceArtifact.sourceHash ?? "",
      normalizedMarkdown: first.sourceArtifact.normalizedMarkdown,
      createdAt: now,
    });
    expect(rebuilt.sectionMapHash).toBe(first.sectionMap?.sectionMapHash);
  });
});
