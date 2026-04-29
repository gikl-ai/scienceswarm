import { describe, expect, it } from "vitest";

import {
  buildResearchContextPacketFromPages,
  formatResearchContextPacketForPrompt,
  GbrainCorpusCapabilitiesSchema,
  researchContextPacketPageSlugs,
} from "@/lib/paper-library/corpus";

const now = "2026-04-28T12:00:00.000Z";

const capabilities = GbrainCorpusCapabilitiesSchema.parse({
  generatedAt: now,
  capabilities: [
    { mode: "keyword_chunks", status: "available" },
    { mode: "embeddings", status: "unavailable", reason: "embedding coverage is missing" },
    { mode: "typed_links", status: "degraded", reason: "using audited first-train link subset" },
  ],
});

const pages = [
  {
    path: "wiki/entities/papers/good-pdf-2024",
    title: "Good PDF fixture",
    type: "paper",
    content: "Canonical paper page for EGFR resistance and MEK co-targeting.",
    frontmatter: {
      entity_type: "paper",
      project: "project-alpha",
      scientific_corpus: {
        source_slug: "wiki/sources/papers/good-pdf-2024/source",
      },
    },
  },
  {
    path: "wiki/sources/papers/good-pdf-2024/source",
    title: "Good PDF fixture Source",
    type: "source",
    content: "EGFR inhibition rebounds unless MEK is co-targeted in patient organoids.",
    frontmatter: {
      entity_type: "paper_source",
      source_kind: "paper_source_text",
      paper_slug: "wiki/entities/papers/good-pdf-2024",
      quality: {
        warnings: [
          {
            code: "low_table_fidelity",
            message: "Tables were flattened during PDF extraction.",
            severity: "warning",
          },
        ],
      },
      section_map: {
        sections: [
          {
            sectionId: "abstract",
            title: "Abstract",
            anchor: "abstract",
            chunkHandles: [
              {
                sourceSlug: "wiki/sources/papers/good-pdf-2024/source",
                chunkId: "chunk-abstract",
                chunkIndex: 0,
                sectionId: "abstract",
              },
            ],
          },
        ],
      },
    },
  },
  {
    path: "wiki/summaries/papers/good-pdf-2024/relevance",
    title: "Good PDF fixture relevance summary",
    type: "note",
    content: "Best for EGFR resistance, MEK co-targeting, and organoid viability questions.",
    frontmatter: {
      entity_type: "paper_summary",
      summary_kind: "paper_relevance",
      paper_slug: "wiki/entities/papers/good-pdf-2024",
    },
  },
  {
    path: "wiki/bibliography/doi-10-1000-example-good-pdf",
    title: "Good PDF reference",
    type: "source",
    content: "A cited paper that is not yet local.",
    frontmatter: {
      entity_type: "bibliography_entry",
      local_status: "metadata_only",
      seen_in: [
        {
          paperSlug: "wiki/entities/papers/good-pdf-2024.md",
          extractionSource: "pdf_references",
          confidence: 0.72,
        },
      ],
    },
  },
];

describe("research context navigator", () => {
  it("builds local-literature-first packets from corpus paper artifacts", () => {
    const packet = buildResearchContextPacketFromPages({
      studySlug: "project-alpha",
      question: "Does EGFR resistance require MEK co-targeting?",
      pages,
      capabilities,
      generatedAt: now,
    });

    expect(packet).toMatchObject({
      question: "Does EGFR resistance require MEK co-targeting?",
      selectionPolicy: "local-literature-first-v1",
      papers: [
        expect.objectContaining({
          paperSlug: "wiki/entities/papers/good-pdf-2024",
          role: "core",
          relevanceCardSlug: "wiki/summaries/papers/good-pdf-2024/relevance",
          sourceChunks: [
            expect.objectContaining({
              sourceSlug: "wiki/sources/papers/good-pdf-2024/source",
              chunkId: "chunk-abstract",
            }),
          ],
          graphPaths: expect.arrayContaining([
            expect.objectContaining({
              relation: "has_source",
              to: "wiki/sources/papers/good-pdf-2024/source",
            }),
            expect.objectContaining({
              relation: "has_summary",
              to: "wiki/summaries/papers/good-pdf-2024/relevance",
            }),
            expect.objectContaining({
              relation: "cites",
              to: "wiki/bibliography/doi-10-1000-example-good-pdf",
            }),
          ]),
          caveats: [
            "low_table_fidelity: Tables were flattened during PDF extraction.",
          ],
        }),
      ],
      missingPapers: [
        expect.objectContaining({
          bibliographySlug: "wiki/bibliography/doi-10-1000-example-good-pdf",
          acquisitionStatus: "metadata_only",
        }),
      ],
      caveats: [
        "embeddings: unavailable - embedding coverage is missing",
        "typed_links: degraded - using audited first-train link subset",
      ],
    });
  });

  it("returns packet page slugs and prompt JSON for route consumption", () => {
    const packet = buildResearchContextPacketFromPages({
      studySlug: "project-alpha",
      question: "Does EGFR resistance require MEK co-targeting?",
      pages,
      capabilities,
      generatedAt: now,
    });

    expect(researchContextPacketPageSlugs(packet)).toEqual(expect.arrayContaining([
      "wiki/entities/papers/good-pdf-2024",
      "wiki/sources/papers/good-pdf-2024/source",
      "wiki/summaries/papers/good-pdf-2024/relevance",
      "wiki/bibliography/doi-10-1000-example-good-pdf",
    ]));
    expect(formatResearchContextPacketForPrompt(packet)).toContain("local-literature-first-v1");
  });
});
