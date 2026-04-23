import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import type { ImportPreview } from "@/brain/types";
import { getProjectAbsoluteWikiPath } from "@/lib/state/project-storage";

const DATA_ROOT = path.join(tmpdir(), "scienceswarm-mvp-warm-start");
const BRAIN_ROOT = path.join(DATA_ROOT, "brain");

const mockLoadBrainConfig = vi.fn();
vi.mock("@/brain/config", () => ({
  loadBrainConfig: () => mockLoadBrainConfig(),
  resolveBrainRoot: () => BRAIN_ROOT,
  brainExists: () => true,
}));

function makeConfig() {
  return {
    root: BRAIN_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function buildPreview(): ImportPreview {
  return {
    analysis: "Approved import preview",
    backend: "local-scan",
    files: [
      {
        path: "notes/summary.md",
        type: "md",
        size: 42,
        hash: "hash-summary",
        classification: "text",
        projectCandidates: ["alpha-project"],
        warnings: [],
      },
    ],
    projects: [
      {
        slug: "alpha-project",
        title: "Alpha Project",
        confidence: "high",
        reason: "Imported from Alpha Project",
        sourcePaths: ["notes/summary.md"],
      },
    ],
    duplicateGroups: [],
    warnings: [],
  };
}

beforeEach(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = DATA_ROOT;
  process.env.SCIENCESWARM_USER_HANDLE = "@test-researcher";
  initBrain({ root: BRAIN_ROOT, name: "Test Researcher" });
  mockLoadBrainConfig.mockReturnValue(makeConfig());
});

afterEach(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
  delete process.env.SCIENCESWARM_DIR;
  delete process.env.SCIENCESWARM_USER_HANDLE;
  mockLoadBrainConfig.mockReset();
});

describe("MVP warm-start to first answer", () => {
  it("imports a project and serves a brief from the imported pages", async () => {
    const { POST: importProject } = await import("@/app/api/brain/import-project/route");
    const { GET: briefProject } = await import("@/app/api/brain/brief/route");

    const request = new Request("http://localhost/api/brain/import-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: {
          name: "Alpha Project",
          totalFiles: 1,
          files: [
            {
              path: "notes/summary.md",
              name: "summary.md",
              type: "md",
              size: 42,
              content: "# Summary\nAlpha project notes.",
              hash: "hash-summary",
            },
          ],
          analysis: "Approved import preview",
          backend: "local-scan",
        },
        preview: buildPreview(),
        projectSlug: "alpha-project",
      }),
    });

    const importResponse = await importProject(request);
    expect(importResponse.status).toBe(200);
    const importBody = await importResponse.json();
    expect(importBody.project).toBe("alpha-project");
    expect(importBody.projectPagePath).toBe("wiki/projects/alpha-project.md");
    expect(readFileSync(getProjectAbsoluteWikiPath("alpha-project", importBody.projectPagePath), "utf-8")).toContain("Approved import preview");

    const briefResponse = await briefProject(
      new Request("http://localhost/api/brain/brief?project=alpha-project"),
    );
    expect(briefResponse.status).toBe(200);
    const brief = await briefResponse.json();
    expect(brief.project).toBe("alpha-project");
    expect(brief.topMatters.some((matter: { summary: string }) => matter.summary.includes("Approved import preview"))).toBe(true);
    expect(brief.nextMove.recommendation).toContain("Alpha Project");
  }, 30_000);
});
