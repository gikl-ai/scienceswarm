import { describe, expect, it } from "vitest";

import {
  completePaperSummaryJob,
  PaperIngestManifestSchema,
  PaperSummaryArtifactSchema,
  planPaperSummaryJobs,
  runPaperSummaryJobsWithConcurrency,
  type PaperIngestManifest,
  type PaperSummaryArtifact,
} from "@/lib/paper-library/corpus";
import { phase0CorpusFixtureDescriptors } from "../../../fixtures/paper-library/corpus/phase0-fixtures";

const now = "2026-04-28T12:00:00.000Z";
const later = "2026-04-28T13:00:00.000Z";

function goodPdfManifest(summaries: PaperSummaryArtifact[] = []): PaperIngestManifest {
  const fixture = phase0CorpusFixtureDescriptors.find((descriptor) => descriptor.kind === "good_text_layer_pdf");
  if (
    !fixture
    || !fixture.expectedSourceArtifact
    || !fixture.expectedSectionMap
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
    summaryConcurrencyLimit: 2,
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
      summaries,
      bibliography: fixture.expectedBibliography ?? [],
      provenance: [],
      warnings: [],
    }],
    warnings: [],
  });
}

describe("paper corpus summary planner", () => {
  it("queues eager relevance cards for successfully extracted sources", () => {
    const result = planPaperSummaryJobs({
      manifest: goodPdfManifest(),
      generatedAt: later,
      projectPolicy: "local-only",
      destination: "local-ollama",
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      paperSlug: "wiki/entities/papers/good-pdf-2024",
      tier: "relevance",
      triggeredBy: ["eager_relevance"],
      sourceHash: "sha256-good-pdf-source",
      sectionMapHash: "sha256-good-pdf-section-map",
    });
    expect(result.manifest.papers[0]?.summaries).toEqual([
      expect.objectContaining({
        tier: "relevance",
        status: "queued",
        summarySlug: "wiki/summaries/papers/good-pdf-2024/relevance",
      }),
    ]);
    expect(result.provenanceRecords).toEqual([
      expect.objectContaining({
        eventType: "summary",
        status: "queued",
        summaryTier: "relevance",
      }),
    ]);
  });

  it("adds brief and detailed jobs only when lazy triggers request them", () => {
    const result = planPaperSummaryJobs({
      manifest: goodPdfManifest(),
      generatedAt: later,
      projectPolicy: "cloud-ok",
      destination: "openai",
      requests: [
        {
          paperSlug: "wiki/entities/papers/good-pdf-2024",
          tier: "brief",
          trigger: "active_study",
        },
        {
          paperSlug: "wiki/entities/papers/good-pdf-2024",
          tier: "detailed",
          trigger: "evidence_map",
        },
      ],
    });

    expect(result.jobs.map((job) => job.tier).sort()).toEqual([
      "brief",
      "detailed",
      "relevance",
    ]);
    expect(result.jobs.find((job) => job.tier === "brief")?.triggeredBy).toEqual(["active_study"]);
    expect(result.jobs.find((job) => job.tier === "detailed")?.triggeredBy).toEqual(["evidence_map"]);
  });

  it("marks current summaries stale when their source key changes and queues regeneration", () => {
    const fixture = phase0CorpusFixtureDescriptors.find((descriptor) => descriptor.kind === "good_text_layer_pdf");
    if (!fixture?.expectedRelevanceSummary) throw new Error("expected relevance summary fixture");
    const existing = PaperSummaryArtifactSchema.parse(fixture.expectedRelevanceSummary);
    const staleInput = {
      ...existing,
      sourceHash: "sha256-old-source",
    };

    const result = planPaperSummaryJobs({
      manifest: goodPdfManifest([staleInput]),
      generatedAt: later,
      projectPolicy: "local-only",
      destination: "local-ollama",
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      tier: "relevance",
      sourceHash: "sha256-good-pdf-source",
      staleReason: "Selected source hash changed.",
    });
    expect(result.manifest.papers[0]?.summaries[0]).toMatchObject({
      tier: "relevance",
      status: "stale",
      sourceHash: "sha256-old-source",
      staleReason: "Selected source hash changed.",
    });
    expect(result.provenanceRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/:stale:[a-f0-9]{16}$/),
        status: "stale",
        staleReason: "Selected source hash changed.",
      }),
      expect.objectContaining({
        status: "queued",
      }),
    ]));
  });

  it("blocks hosted summary jobs under local-only policy and records a visible warning", () => {
    const result = planPaperSummaryJobs({
      manifest: goodPdfManifest(),
      generatedAt: later,
      projectPolicy: "local-only",
      destination: "openai",
    });

    expect(result.jobs).toHaveLength(0);
    expect(result.manifest.papers[0]?.summaries[0]).toMatchObject({
      tier: "relevance",
      status: "blocked",
      warnings: [
        expect.objectContaining({
          code: "privacy_blocked",
          message: expect.stringContaining("Local-only project policy blocks"),
        }),
      ],
    });
    expect(result.provenanceRecords).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/:blocked:[a-f0-9]{16}$/),
        status: "blocked",
        warnings: [
          expect.objectContaining({
            code: "privacy_blocked",
          }),
        ],
      }),
    ]);
  });

  it("blocks hosted summary jobs when strict local-only mode is enabled", () => {
    const result = planPaperSummaryJobs({
      manifest: goodPdfManifest(),
      generatedAt: later,
      projectPolicy: "cloud-ok",
      destination: "openai",
      env: { SCIENCESWARM_STRICT_LOCAL_ONLY: "1" },
    });

    expect(result.jobs).toHaveLength(0);
    expect(result.warnings[0]).toMatchObject({
      code: "privacy_blocked",
      message: expect.stringContaining("Strict local-only mode blocks"),
    });
  });

  it("replaces blocked summaries with queued retries instead of reparsing them as stale", () => {
    const blockedSummary = PaperSummaryArtifactSchema.parse({
      paperSlug: "wiki/entities/papers/good-pdf-2024",
      sourceSlug: "wiki/sources/papers/good-pdf-2024/source",
      summarySlug: "wiki/summaries/papers/good-pdf-2024/relevance",
      tier: "relevance",
      status: "blocked",
      createdAt: now,
      updatedAt: now,
      warnings: [
        {
          code: "privacy_blocked",
          message: "Previous hosted summary job was blocked.",
          severity: "warning",
        },
      ],
    });

    const result = planPaperSummaryJobs({
      manifest: goodPdfManifest([blockedSummary]),
      generatedAt: later,
      projectPolicy: "local-only",
      destination: "local-ollama",
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.manifest.papers[0]?.summaries[0]).toMatchObject({
      tier: "relevance",
      status: "queued",
      sourceHash: "sha256-good-pdf-source",
    });
  });

  it("completes a summary job as a current artifact with provenance", () => {
    const plan = planPaperSummaryJobs({
      manifest: goodPdfManifest(),
      generatedAt: later,
      projectPolicy: "local-only",
      destination: "local-ollama",
    });
    const job = plan.jobs[0];
    if (!job) throw new Error("expected summary job");

    const completion = completePaperSummaryJob({
      job,
      generatedAt: later,
      generatedBy: "summary-test",
      summaryMarkdown: "This relevance card routes questions about good PDF source text.",
    });

    expect(completion.summary).toMatchObject({
      tier: "relevance",
      status: "current",
      generatedBy: "summary-test",
      summaryMarkdown: "This relevance card routes questions about good PDF source text.",
    });
    expect(completion.provenanceRecord).toMatchObject({
      eventType: "summary",
      status: "succeeded",
      summaryTier: "relevance",
      inputHash: job.inputHash,
    });
  });

  it("runs summary workers through the configured concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;

    const results = await runPaperSummaryJobsWithConcurrency({
      jobs: [1, 2, 3, 4, 5],
      concurrencyLimit: 2,
      worker: async (job) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return job * 2;
      },
    });

    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
