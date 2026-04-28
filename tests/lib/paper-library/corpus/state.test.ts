import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPaperCorpusManifest,
  buildSourceChoiceProvenanceRecord,
  getPaperCorpusManifestByScanPath,
  getPaperCorpusManifestPath,
  getPaperCorpusPaperProvenancePath,
  parsePaperCorpusManifest,
  readPaperCorpusManifest,
  readPaperCorpusManifestByScan,
  readPaperProvenanceLedger,
  writePaperCorpusManifest,
  writePaperCorpusManifestByScan,
  writePaperProvenanceLedger,
} from "@/lib/paper-library/corpus";
import type { PaperReviewItem } from "@/lib/paper-library/contracts";

const now = "2026-04-28T12:00:00.000Z";
let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function reviewItem(): PaperReviewItem {
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
        identifiers: { doi: "10.1000/example" },
        title: "Local Paper 1",
        authors: [],
        source: "crossref",
        confidence: 0.82,
        evidence: ["doi"],
        conflicts: [],
      },
    ],
    selectedCandidateId: "identity-1",
    version: 1,
    updatedAt: now,
  };
}

describe("paper corpus state", () => {
  it("builds project-scoped corpus state paths", () => {
    expect(getPaperCorpusManifestPath("project-alpha", "manifest/1", "/tmp/state")).toBe(
      "/tmp/state/projects/project-alpha/paper-library/corpus/manifests/manifest%2F1.json",
    );
    expect(getPaperCorpusManifestByScanPath("project-alpha", "scan/1", "/tmp/state")).toBe(
      "/tmp/state/projects/project-alpha/paper-library/corpus/by-scan/scan%2F1.json",
    );
    expect(getPaperCorpusPaperProvenancePath("project-alpha", "wiki/entities/papers/paper-1", "/tmp/state")).toBe(
      "/tmp/state/projects/project-alpha/paper-library/corpus/provenance/wiki%2Fentities%2Fpapers%2Fpaper-1.json",
    );
  });

  it("writes and reads paper corpus manifests through the persisted-state guard", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-corpus-state-"));
    const manifest = buildPaperCorpusManifest({
      id: "corpus-manifest-1",
      project: "project-alpha",
      scanId: "scan-1",
      createdAt: now,
      items: [reviewItem()],
    });

    await writePaperCorpusManifest("project-alpha", manifest, tempRoot);

    const read = await readPaperCorpusManifest("project-alpha", "corpus-manifest-1", tempRoot);
    expect(read).toMatchObject({
      ok: true,
      data: {
        id: "corpus-manifest-1",
        papers: [
          {
            paperSlug: "wiki/entities/papers/doi-10-1000-example",
          },
        ],
      },
    });
  });

  it("writes and reads scan-indexed corpus manifests through the persisted-state guard", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-corpus-by-scan-"));
    const manifest = buildPaperCorpusManifest({
      id: "corpus-manifest-1",
      project: "project-alpha",
      scanId: "scan-1",
      createdAt: now,
      items: [reviewItem()],
    });

    await writePaperCorpusManifestByScan("project-alpha", "scan-1", manifest, tempRoot);

    const read = await readPaperCorpusManifestByScan("project-alpha", "scan-1", tempRoot);
    expect(read).toMatchObject({
      ok: true,
      data: {
        id: "corpus-manifest-1",
        scanId: "scan-1",
      },
    });
    await expect(
      writePaperCorpusManifestByScan("project-alpha", "scan-2", manifest, tempRoot),
    ).rejects.toThrow(/scanId/);
  });

  it("returns repairable state for malformed corpus manifests", () => {
    const parsed = parsePaperCorpusManifest(
      { version: 1, id: "corpus-manifest-1", project: "../bad" },
      { path: "/tmp/corpus-manifest.json" },
    );

    expect(parsed).toMatchObject({
      ok: false,
      repairable: {
        code: "malformed",
        path: "/tmp/corpus-manifest.json",
      },
    });
  });

  it("writes and reads paper provenance ledgers", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-corpus-ledger-"));
    const manifest = buildPaperCorpusManifest({
      id: "corpus-manifest-1",
      project: "project-alpha",
      createdAt: now,
      items: [reviewItem()],
    });
    const paper = manifest.papers[0];
    const selectedCandidate = paper?.sourceCandidates.find((candidate) => candidate.id === paper.selectedSourceCandidateId);
    if (!paper || !selectedCandidate) {
      throw new Error("expected manifest paper with selected source candidate");
    }
    const record = buildSourceChoiceProvenanceRecord({
      paperSlug: paper.paperSlug,
      occurredAt: now,
      candidate: selectedCandidate,
    });

    await writePaperProvenanceLedger("project-alpha", paper.paperSlug, [record], tempRoot);

    const read = await readPaperProvenanceLedger("project-alpha", paper.paperSlug, tempRoot);
    expect(read).toMatchObject({
      ok: true,
      data: [
        {
          id: "source-choice:paper-1:source:local-pdf",
          status: "succeeded",
        },
      ],
    });
  });
});
