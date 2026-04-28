import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initBrain } from "@/brain/init";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { getBrainStore, resetBrainStore } from "@/brain/store";
import {
  PaperAcquisitionRecordSchema,
  type LibraryCitationGraphNode,
  type PaperAcquisitionRecord,
} from "@/lib/paper-library/contracts";
import {
  normalizeAgentPaperSuggestions,
  persistPaperAcquisitionRecordToGbrain,
} from "@/lib/paper-library/library-enrichment";

const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;
let brainRoot: string;

describe("paper-library library enrichment", () => {
  beforeEach(async () => {
    brainRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-library-enrichment-"));
    process.env.SCIENCESWARM_USER_HANDLE = "@library-enrichment-test";
    await resetBrainStore();
    initBrain({ root: brainRoot, name: "Test Researcher" });
  });

  afterEach(async () => {
    await resetBrainStore();
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    else delete process.env.SCIENCESWARM_USER_HANDLE;
    await rm(brainRoot, { recursive: true, force: true });
  });

  it("normalizes agent suggestions and marks duplicates already local", () => {
    const localNode: LibraryCitationGraphNode = {
      id: "paper:doi:10.1000/local",
      kind: "local_paper",
      paperIds: ["paper-local"],
      title: "Already Local Paper",
      authors: [],
      identifiers: { doi: "10.1000/local" },
      local: true,
      suggestion: false,
      sources: ["gbrain"],
      evidence: ["gbrain:wiki/entities/papers/local"],
      gbrainSlug: "wiki/entities/papers/local",
      localStatus: "gbrain_page",
    };

    const normalized = normalizeAgentPaperSuggestions({
      suggestions: [
        {
          title: "Already Local Paper",
          identifiers: { doi: "https://doi.org/10.1000/local" },
          sourceUrls: ["https://doi.org/10.1000/local"],
          reasonForThisQuestion: "It anchors the user's question.",
          graphEvidence: ["node:paper:doi:10.1000/local"],
          localEvidencePaperIds: ["paper-local"],
          downloadStatus: "open_pdf_found",
          recommendedAction: "download_now",
          confidence: 0.82,
        },
        {
          title: "",
          confidence: 2,
        },
      ],
    }, { localNodes: [localNode] });

    expect(normalized.suggestions).toHaveLength(1);
    expect(normalized.suggestions[0]).toMatchObject({
      title: "Already Local Paper",
      downloadStatus: "already_local",
      recommendedAction: "cite_only",
    });
    expect(normalized.rejected).toHaveLength(1);
    expect(normalized.rejected[0]?.issues.join("\n")).toContain("title");
  });

  it("requires source URL and local path before a record can be marked downloaded", () => {
    expect(() =>
      PaperAcquisitionRecordSchema.parse({
        project: "project-alpha",
        suggestion: {
          title: "Missing PDF",
          identifiers: { arxivId: "2401.01234" },
          sourceUrls: ["https://arxiv.org/pdf/2401.01234.pdf"],
          reasonForThisQuestion: "The graph says it matters.",
          graphEvidence: ["gap:1"],
          localEvidencePaperIds: [],
          downloadStatus: "open_pdf_found",
          recommendedAction: "download_now",
          confidence: 0.9,
        },
        tool: "arxiv",
        status: "downloaded",
        createdAt: "2026-04-24T12:00:00.000Z",
      })
    ).toThrow();
  });

  it("persists metadata-only acquisition records through gbrain merge semantics", async () => {
    const client = createInProcessGbrainClient({ root: brainRoot });
    await client.persistTransaction("wiki/entities/papers/doi-10-3000-metadata", () => ({
      page: {
        type: "paper",
        title: "Existing Metadata Paper",
        compiledTruth: "Existing note that should survive.",
        timeline: "",
        frontmatter: { entity_type: "paper", custom: "keep-me" },
      },
    }));

    const record: PaperAcquisitionRecord = {
      project: "project-alpha",
      originatingQuestion: "Which papers would improve this answer?",
      suggestion: {
        title: "Missing Metadata Only Paper",
        identifiers: { doi: "10.3000/metadata" },
        sourceUrls: ["https://doi.org/10.3000/metadata"],
        reasonForThisQuestion: "It bridges the local cluster to the question.",
        graphEvidence: ["gap:metadata", "node:paper:doi:10.1000/local"],
        localEvidencePaperIds: ["paper-local"],
        downloadStatus: "metadata_only",
        recommendedAction: "cite_only",
        confidence: 0.74,
      },
      tool: "manual",
      sourceUrl: "https://doi.org/10.3000/metadata",
      status: "metadata_persisted",
      consentScope: "per_session",
      createdAt: "2026-04-24T12:00:00.000Z",
    };

    const persisted = await persistPaperAcquisitionRecordToGbrain({
      brainRoot,
      record,
    });

    expect(persisted.gbrainSlug).toBe("wiki/entities/papers/doi-10-3000-metadata");
    const page = await getBrainStore({ root: brainRoot }).getPage("wiki/entities/papers/doi-10-3000-metadata");
    expect(page?.content).toContain("Existing note that should survive.");
    expect(page?.content).toContain("## Research Library Enrichment");
    expect(page?.content).toContain("Download status: no legal open PDF was persisted");
    expect(page?.frontmatter.custom).toBe("keep-me");
    expect(page?.frontmatter.paper_library_enrichment).toMatchObject({
      study: "project-alpha",
      study_slug: "project-alpha",
      status: "metadata_persisted",
      source_url: "https://doi.org/10.3000/metadata",
    });
  });
});
