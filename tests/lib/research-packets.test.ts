import { describe, it, expect, vi } from "vitest";

import {
  runResearchLandscape,
  type ResearchLandscapeSource,
} from "@/lib/research-packets";
import type { PaperEntity } from "@/lib/research-packets/contract";

function paper(input: {
  source: ResearchLandscapeSource;
  title: string;
  doi?: string;
  pmid?: string;
  arxiv?: string;
  openalex?: string;
  year?: number | null;
  abstract?: string;
  authors?: string[];
}): PaperEntity {
  const ids = Object.fromEntries(
    Object.entries({
      doi: input.doi,
      pmid: input.pmid,
      arxiv: input.arxiv,
      openalex: input.openalex,
    }).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  const primary = input.doi
    ? { scheme: "doi", id: input.doi }
    : input.pmid
      ? { scheme: "pmid", id: input.pmid }
      : input.arxiv
        ? { scheme: "arxiv", id: input.arxiv }
        : { scheme: "openalex", id: input.openalex ?? `${input.source}-id` };
  return {
    type: "paper",
    ids,
    primary_id: primary,
    source_db: [input.source],
    source_uri: `https://example.test/${input.source}/${encodeURIComponent(input.title)}`,
    fetched_at: "2026-04-22T12:00:00.000Z",
    raw_summary: `${input.title}\n${input.abstract ?? ""}`.trim(),
    payload: {
      title: input.title,
      authors: (input.authors ?? ["Ada Lovelace"]).map((name) => ({ name })),
      venue: { name: input.source.toUpperCase(), type: input.source === "arxiv" ? "preprint" : "journal" },
      year: input.year ?? 2024,
      abstract: input.abstract,
      retraction_status: "active",
    },
  };
}

function makeDeps() {
  return {
    brainRoot: "/tmp/scienceswarm-test-brain",
    now: new Date("2026-04-22T15:30:00.000Z"),
    createClient: () => ({}) as never,
    ensureReady: async () => {},
    getUserHandle: () => "@tester",
    persistPaper: vi.fn(async (candidate) => ({
      entity: candidate.entity,
      slug: `literature/${candidate.entity.payload.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      diskPath: `/tmp/scienceswarm-test-brain/literature/${candidate.entity.payload.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
      write_status: "persisted" as const,
      correlation_id: "corr",
      dedup_hit: false,
    })),
    persistArtifactPage: vi.fn(async (input) => ({
      slug: input.slug,
      diskPath: `${input.brainRoot}/${input.slug}.md`,
      title: input.title,
      write_status: "persisted" as const,
    })),
    writeLastRun: vi.fn(() => "/tmp/scienceswarm-test-brain/.research-landscape-last-run.json"),
  };
}

describe("runResearchLandscape", () => {
  it("resolves an exact title after cross-source dedupe", async () => {
    const deps = makeDeps();

    const result = await runResearchLandscape({
      query: "graph neural networks",
      exactTitle: "Exact Match Paper",
      sources: ["pubmed", "openalex"],
    }, {
      ...deps,
      searches: {
        pubmed: async () => ({
          entities: [
            paper({
              source: "pubmed",
              title: "Exact Match Paper",
              doi: "10.1000/exact",
              pmid: "12345",
              abstract: "PubMed abstract",
            }),
          ],
          total: 1,
        }),
        openalex: async () => ({
          entities: [
            paper({
              source: "openalex",
              title: "Exact Match Paper",
              doi: "10.1000/exact",
              openalex: "W123",
              abstract: "Longer OpenAlex abstract for the exact paper.",
            }),
          ],
          total: 1,
        }),
      },
    });

    expect(result.status).toBe("completed");
    expect(result.retainedCandidates).toBe(1);
    expect(result.duplicatesDropped).toBe(1);
    expect(result.titleResolution).toEqual(
      expect.objectContaining({
        status: "resolved",
        matchedCount: 1,
      }),
    );
    expect(result.retainedWrites[0].candidate.sources).toEqual(["pubmed", "openalex"]);
    expect(result.retainedWrites[0].candidate.entity.payload.abstract).toContain("Longer OpenAlex abstract");
  });

  it("dedupes candidates across sources by shared identifier", async () => {
    const deps = makeDeps();

    const result = await runResearchLandscape({
      query: "crispr delivery",
      sources: ["pubmed", "openalex", "arxiv"],
    }, {
      ...deps,
      searches: {
        pubmed: async () => ({
          entities: [
            paper({ source: "pubmed", title: "CRISPR delivery benchmark", doi: "10.1000/crispr", pmid: "42" }),
          ],
          total: 1,
        }),
        openalex: async () => ({
          entities: [
            paper({ source: "openalex", title: "CRISPR delivery benchmark", doi: "10.1000/crispr", openalex: "W42" }),
          ],
          total: 1,
        }),
        arxiv: async () => ({
          entities: [
            paper({ source: "arxiv", title: "A different retained paper", arxiv: "2404.00001" }),
          ],
          total: 1,
        }),
      },
    });

    expect(result.retainedCandidates).toBe(2);
    expect(result.duplicatesDropped).toBe(1);
    expect(result.retainedWrites[0].candidate.sources).toEqual(["pubmed", "openalex"]);
  });

  it("records partial failures and retries failed sources", async () => {
    const deps = makeDeps();
    let pubmedAttempts = 0;
    let crossrefAttempts = 0;

    const result = await runResearchLandscape({
      query: "single-cell atlases",
      sources: ["pubmed", "crossref"],
      retryCount: 1,
    }, {
      ...deps,
      searches: {
        pubmed: async () => {
          pubmedAttempts += 1;
          if (pubmedAttempts === 1) {
            throw new Error("temporary PubMed failure");
          }
          return {
            entities: [paper({ source: "pubmed", title: "Recovered PubMed paper", doi: "10.1000/recovered" })],
            total: 1,
          };
        },
        crossref: async () => {
          crossrefAttempts += 1;
          throw new Error("persistent Crossref failure");
        },
      },
    });

    expect(result.status).toBe("partial");
    expect(pubmedAttempts).toBe(2);
    expect(crossrefAttempts).toBe(2);
    expect(result.sourceRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "pubmed", status: "ok", attempts: 2 }),
        expect.objectContaining({ source: "crossref", status: "failed", attempts: 2 }),
      ]),
    );
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "source", source: "crossref" }),
      ]),
    );
  });

  it("uses stable packet and journal slugs for identical reruns on the same day", async () => {
    const deps = makeDeps();
    const searches = {
      pubmed: async () => ({
        entities: [paper({ source: "pubmed", title: "Stable packet paper", doi: "10.1000/stable" })],
        total: 1,
      }),
    };

    const first = await runResearchLandscape({
      query: "stable packet",
      sources: ["pubmed"],
    }, { ...deps, searches });
    const second = await runResearchLandscape({
      query: "stable packet",
      sources: ["pubmed"],
    }, { ...deps, searches });

    expect(first.packet.slug).toBe(second.packet.slug);
    expect(first.journal.slug).toBe(second.journal.slug);
  });
});
