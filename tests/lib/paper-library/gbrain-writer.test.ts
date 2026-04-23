import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBrain } from "@/brain/init";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { getBrainStore, resetBrainStore } from "@/brain/store";
import { persistAppliedPaperLocations } from "@/lib/paper-library/gbrain-writer";

const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;
let brainRoot: string;

describe("paper-library gbrain writer", () => {
  beforeEach(async () => {
    brainRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-paper-library-gbrain-writer-"));
    process.env.SCIENCESWARM_USER_HANDLE = "@paper-library-gbrain-writer-test";
    await resetBrainStore();
    initBrain({ root: brainRoot, name: "Test Researcher" });
  });

  afterEach(async () => {
    await resetBrainStore();
    if (ORIGINAL_SCIENCESWARM_USER_HANDLE) process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
    else delete process.env.SCIENCESWARM_USER_HANDLE;
    await rm(brainRoot, { recursive: true, force: true });
  });

  it("preserves existing paper notes while writing the applied PDF location", async () => {
    const client = createInProcessGbrainClient({ root: brainRoot });
    await client.persistTransaction("wiki/entities/papers/local-paper-1", () => ({
      page: {
        type: "paper",
        title: "Existing Paper",
        compiledTruth: [
          "Existing researcher note that must survive.",
          "",
          "## Paper Library",
          "",
          "Local PDF: `old.pdf`",
          "",
          "## My Notes",
          "",
          "Downstream notes must also survive.",
        ].join("\n"),
        timeline: "",
        frontmatter: { entity_type: "paper", custom: "keep-me" },
      },
    }));

    await persistAppliedPaperLocations({
      project: "project-alpha",
      brainRoot,
      manifestId: "manifest-1",
      plan: {
        version: 1,
        id: "plan-1",
        scanId: "scan-1",
        project: "project-alpha",
        status: "applied",
        rootPath: "/Users/example/papers",
        rootRealpath: "/Users/example/papers",
        templateFormat: "{year} - {title}.pdf",
        operationCount: 1,
        conflictCount: 0,
        operationShardIds: [],
        createdAt: "2026-04-23T00:00:00.000Z",
        updatedAt: "2026-04-23T00:00:00.000Z",
      },
      operations: [{
        id: "operation-1",
        paperId: "paper-1",
        kind: "rename",
        destinationRelativePath: "2024 - Existing Paper.pdf",
        reason: "test",
        confidence: 0.95,
        conflictCodes: [],
      }],
      reviewItems: [{
        id: "review-1",
        scanId: "scan-1",
        paperId: "paper-1",
        state: "accepted",
        reasonCodes: [],
        candidates: [{
          id: "paper-1",
          identifiers: {},
          title: "Existing Paper",
          authors: [],
          source: "pdf_text",
          confidence: 0.95,
          evidence: [],
          conflicts: [],
        }],
        selectedCandidateId: "paper-1",
        version: 0,
        updatedAt: "2026-04-23T00:00:00.000Z",
      }],
      manifestOperations: [{
        operationId: "operation-1",
        paperId: "paper-1",
        sourceRelativePath: "messy.pdf",
        destinationRelativePath: "2024 - Existing Paper.pdf",
        status: "verified",
        appliedAt: "2026-04-23T00:00:00.000Z",
      }],
    });

    const page = await getBrainStore({ root: brainRoot }).getPage("wiki/entities/papers/local-paper-1");
    expect(page?.content).toContain("Existing researcher note that must survive.");
    expect(page?.content).toContain("## Paper Library");
    expect(page?.content).toContain("2024 - Existing Paper.pdf");
    expect(page?.content).toContain("## My Notes");
    expect(page?.content).toContain("Downstream notes must also survive.");
    expect(page?.content).not.toContain("old.pdf");
    expect(page?.frontmatter.custom).toBe("keep-me");
    expect(page?.frontmatter.paper_library).toMatchObject({
      project: "project-alpha",
      apply_manifest_id: "manifest-1",
    });
  });
});
