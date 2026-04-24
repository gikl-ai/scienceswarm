import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichIdentityCandidate } from "@/lib/paper-library/identity-enrichment";
import { readEnrichmentCache } from "@/lib/paper-library/enrichment-cache";
import type { PaperIdentityCandidate } from "@/lib/paper-library/contracts";
import type { DbEntity } from "@/lib/skills/db-base";

let stateRoot: string;

function candidate(): PaperIdentityCandidate {
  return {
    id: "local-candidate",
    identifiers: { doi: "10.1000/example" },
    title: "Filename Title",
    authors: [],
    year: 2023,
    source: "pdf_text",
    confidence: 0.86,
    evidence: ["doi_detected", "title_from_filename"],
    conflicts: [],
  };
}

function crossrefEntity(): DbEntity {
  return {
    type: "paper",
    ids: { doi: "10.1000/example" },
    primary_id: { scheme: "doi", id: "10.1000/example" },
    source_db: ["crossref"],
    source_uri: "https://doi.org/10.1000/example",
    fetched_at: "2026-04-23T00:00:00.000Z",
    raw_summary: "Crossref Title",
    payload: {
      title: "Crossref Title",
      authors: [{ name: "Ada Lovelace" }],
      venue: { name: "Journal of Local Research", type: "journal" },
      year: 2024,
      abstract: "External metadata.",
      retraction_status: "active",
    },
  };
}

describe("paper-library identity enrichment", () => {
  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-enrichment-"));
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("enriches DOI candidates with deterministic scholarly metadata and caches source runs", async () => {
    const crossref = vi.fn(async () => crossrefEntity());
    const openalex = vi.fn(async () => null);
    const pubmed = vi.fn(async () => null);

    const enriched = await enrichIdentityCandidate({
      project: "project-alpha",
      stateRoot,
      candidate: candidate(),
      fetchers: { crossref, openalex, pubmed },
    });

    expect(enriched).toMatchObject({
      title: "Crossref Title",
      authors: ["Ada Lovelace"],
      year: 2024,
      venue: "Journal of Local Research",
      source: "crossref",
      confidence: 0.9,
      conflicts: [],
    });
    expect(enriched.evidence).toEqual(expect.arrayContaining([
      "crossref:success",
      "openalex:negative",
      "pubmed:negative",
    ]));

    const cached = await enrichIdentityCandidate({
      project: "project-alpha",
      stateRoot,
      candidate: candidate(),
      fetchers: {
        crossref: async () => {
          throw new Error("crossref should come from cache");
        },
        openalex: async () => {
          throw new Error("openalex should come from cache");
        },
        pubmed: async () => {
          throw new Error("pubmed should come from cache");
        },
      },
    });
    expect(cached.title).toBe("Crossref Title");
    expect(crossref).toHaveBeenCalledTimes(1);
    expect(openalex).toHaveBeenCalledTimes(1);
    expect(pubmed).toHaveBeenCalledTimes(1);

    const cache = await readEnrichmentCache("project-alpha", stateRoot);
    expect(cache.entries["crossref:10.1000/example"]).toMatchObject({ status: "success" });
    expect(cache.entries["openalex:10.1000/example"]).toMatchObject({ status: "negative" });
    expect(cache.entries["pubmed:doi:10.1000/example"]).toMatchObject({ status: "negative" });
  });
});
