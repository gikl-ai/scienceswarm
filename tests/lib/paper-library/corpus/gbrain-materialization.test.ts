import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initBrain } from "@/brain/init";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { getBrainStore, resetBrainStore } from "@/brain/store";
import {
  detectGbrainCorpusCapabilities,
  materializePaperCorpusManifestToGbrain,
  PaperIngestManifestSchema,
  getPaperCorpusPaperProvenancePath,
  readPaperProvenanceLedger,
  type PaperIngestManifest,
} from "@/lib/paper-library/corpus";
import { getScienceSwarmProjectBrainRoot } from "@/lib/scienceswarm-paths";
import { phase0CorpusFixtureDescriptors } from "../../../fixtures/paper-library/corpus/phase0-fixtures";

const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;
const now = "2026-04-28T12:00:00.000Z";

let dataRoot: string;
let brainRoot: string;

function projectBrainRoot(): string {
  return getScienceSwarmProjectBrainRoot("project-alpha");
}

function withoutMarkdownSuffix(slug: string): string {
  return slug.replace(/\.md$/i, "");
}

function goodPdfManifest(): PaperIngestManifest {
  const fixture = phase0CorpusFixtureDescriptors.find((descriptor) => descriptor.kind === "good_text_layer_pdf");
  if (
    !fixture
    || !fixture.expectedSourceArtifact
    || !fixture.expectedSectionMap
    || !fixture.expectedRelevanceSummary
  ) {
    throw new Error("expected good text-layer PDF fixture artifacts");
  }

  return PaperIngestManifestSchema.parse({
    version: 1,
    id: "corpus-manifest-1",
    project: "project-alpha",
    scanId: "scan-1",
    status: "current",
    createdAt: now,
    updatedAt: now,
    parserConcurrencyLimit: 2,
    summaryConcurrencyLimit: 1,
    papers: [{
      paperId: fixture.paperId,
      paperSlug: fixture.paperSlug,
      identifiers: { doi: "10.1000/good-pdf" },
      title: "Good PDF fixture",
      status: "current",
      sourceCandidates: [fixture.expectedCandidate],
      selectedSourceCandidateId: fixture.expectedCandidate.id,
      sourceArtifact: fixture.expectedSourceArtifact,
      sectionMap: fixture.expectedSectionMap,
      summaries: [fixture.expectedRelevanceSummary],
      bibliography: fixture.expectedBibliography ?? [],
      provenance: [{
        id: "source-choice:candidate-good-pdf",
        paperSlug: fixture.paperSlug,
        occurredAt: now,
        eventType: "source_choice",
        status: "succeeded",
        sourceSlug: fixture.expectedSourceArtifact.sourceSlug,
        sourceType: fixture.expectedSourceArtifact.sourceType,
        message: "PDF fallback selected because no LaTeX or HTML source was available.",
        details: {},
        warnings: [],
      }],
      warnings: [],
    }],
    warnings: [],
  });
}

describe("paper corpus gbrain materialization", () => {
  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-corpus-gbrain-materialization-"));
    brainRoot = path.join(dataRoot, "brain");
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@corpus-gbrain-materialization-test";
    await resetBrainStore();
    initBrain({ root: brainRoot, name: "Test Researcher" });
  });

  afterEach(async () => {
    await resetBrainStore();
    if (ORIGINAL_SCIENCESWARM_DIR) process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
    else delete process.env.SCIENCESWARM_DIR;
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    else delete process.env.SCIENCESWARM_USER_HANDLE;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("writes corpus artifacts, audited links, chunks, and compact provenance idempotently", async () => {
    const manifest = goodPdfManifest();
    const paper = manifest.papers[0];
    const sourceSlug = paper?.sourceArtifact?.sourceSlug;
    const summarySlug = paper?.summaries[0]?.summarySlug;
    const bibliographySlug = paper?.bibliography[0]?.bibliographySlug;
    if (!paper || !sourceSlug || !summarySlug || !bibliographySlug) {
      throw new Error("expected complete fixture paper");
    }

    const client = createInProcessGbrainClient({ root: projectBrainRoot() });
    await client.persistTransaction(paper.paperSlug, () => ({
      page: {
        type: "paper",
        title: "Good PDF fixture",
        compiledTruth: [
          "Researcher note that must survive.",
          "",
          "## My Notes",
          "",
          "Keep this annotation.",
        ].join("\n"),
        timeline: "",
        frontmatter: { entity_type: "paper", custom: "keep-me" },
      },
    }));

    const first = await materializePaperCorpusManifestToGbrain({
      project: "project-alpha",
      brainRoot,
      manifest,
      occurredAt: now,
    });
    const second = await materializePaperCorpusManifestToGbrain({
      project: "project-alpha",
      brainRoot,
      manifest,
      occurredAt: now,
    });

    expect(first).toMatchObject({
      manifestId: "corpus-manifest-1",
      paperCount: 1,
      pagesWritten: 4,
      linksWritten: 5,
    });
    expect(second).toMatchObject({
      pagesWritten: 4,
      linksWritten: 0,
    });

    const store = getBrainStore({ root: projectBrainRoot() });
    const paperPage = await store.getPage(paper.paperSlug);
    expect(paperPage?.content).toContain("Researcher note that must survive.");
    expect(paperPage?.content).toContain("## Scientific Corpus");
    expect(paperPage?.frontmatter.custom).toBe("keep-me");
    expect(paperPage?.frontmatter.scientific_corpus).toMatchObject({
      manifest_id: "corpus-manifest-1",
      source_slug: sourceSlug,
      preferred_source_type: "pdf",
      source_quality_score: 0.76,
    });
    expect(paperPage?.frontmatter.summary_status).toMatchObject({
      relevance: "current",
      brief: "missing",
      detailed: "missing",
    });

    const sourcePage = await store.getPage(sourceSlug);
    expect(sourcePage?.frontmatter.type).toBe("source");
    expect(sourcePage?.content).toContain("This fixture stands in for extracted PDF text.");
    expect(sourcePage?.frontmatter.source_kind).toBe("paper_source_text");
    expect(sourcePage?.frontmatter.section_map).toMatchObject({
      status: "current",
    });

    const summaryPage = await store.getPage(summarySlug);
    expect(summaryPage?.type).toBe("note");
    expect(summaryPage?.content).toContain("Good PDF fixture has searchable source text.");
    expect(summaryPage?.frontmatter.summary_kind).toBe("paper_relevance");

    const bibliographyPage = await store.getPage(bibliographySlug);
    expect(bibliographyPage?.frontmatter.entity_type).toBe("bibliography_entry");
    expect(bibliographyPage?.frontmatter.seen_in).toEqual([
      expect.objectContaining({
        paperSlug: paper.paperSlug,
        extractionSource: "pdf_references",
      }),
    ]);

    const searchResults = await store.search({
      query: "fixture stands in for extracted PDF text",
      limit: 5,
    });
    expect(searchResults.some((result) => withoutMarkdownSuffix(result.path) === sourceSlug)).toBe(true);

    const links = await store.getLinks(paper.paperSlug);
    expect(links.filter((link) => link.kind === "has_source" && withoutMarkdownSuffix(link.toSlug) === sourceSlug))
      .toHaveLength(1);
    expect(links.filter((link) => link.kind === "has_summary" && withoutMarkdownSuffix(link.toSlug) === summarySlug))
      .toHaveLength(1);
    expect(links.filter((link) => link.kind === "cites" && withoutMarkdownSuffix(link.toSlug) === bibliographySlug))
      .toHaveLength(1);

    const sourceLinks = await store.getLinks(sourceSlug);
    expect(sourceLinks.filter((link) => (
      link.kind === "derived_from" && withoutMarkdownSuffix(link.toSlug) === paper.paperSlug
    )))
      .toHaveLength(1);

    const summaryLinks = await store.getLinks(summarySlug);
    expect(summaryLinks.filter((link) => link.kind === "derived_from" && withoutMarkdownSuffix(link.toSlug) === sourceSlug))
      .toHaveLength(1);

    const ledger = await readPaperProvenanceLedger("project-alpha", paper.paperSlug);
    if (!ledger.ok) throw new Error(`expected ledger: ${ledger.repairable.message}`);
    expect(ledger.data.some((record) => record.eventType === "source_choice")).toBe(true);
    expect(ledger.data.filter((record) => record.eventType === "gbrain_materialization")).toHaveLength(4);
  });

  it("reports corpus retrieval capabilities from gbrain health", async () => {
    const store = getBrainStore({ root: projectBrainRoot() });
    const capabilities = await detectGbrainCorpusCapabilities({ store, generatedAt: now });

    expect(capabilities.generatedAt).toBe(now);
    expect(capabilities.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: "health", status: "available" }),
      expect.objectContaining({ mode: "keyword_chunks", status: "available" }),
      expect.objectContaining({
        mode: "typed_links",
        status: "degraded",
        reason: "using audited first-train link subset",
      }),
      expect.objectContaining({
        mode: "section_anchors",
        status: "available",
      }),
    ]));
  });

  it("refuses to overwrite a repairable malformed provenance ledger", async () => {
    const manifest = goodPdfManifest();
    const paper = manifest.papers[0];
    const sourceSlug = paper?.sourceArtifact?.sourceSlug;
    if (!paper || !sourceSlug) throw new Error("expected complete fixture paper");

    const ledgerPath = getPaperCorpusPaperProvenancePath("project-alpha", paper.paperSlug);
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, JSON.stringify({ version: 1, invalid: true }), "utf-8");

    await expect(materializePaperCorpusManifestToGbrain({
      project: "project-alpha",
      brainRoot,
      manifest,
      occurredAt: now,
    })).rejects.toThrow(/Refusing to overwrite repairable ledger state/);

    const store = getBrainStore({ root: projectBrainRoot() });
    await expect(store.getPage(sourceSlug)).resolves.toBeNull();
  });
});
