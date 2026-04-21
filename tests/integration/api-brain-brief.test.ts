import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initBrain } from "@/brain/init";
import { writeProjectImportSummary } from "@/lib/state/project-import-summary";

let tempDir: string | null = null;
let originalBrainRoot: string | undefined;

async function createBrainRoot(): Promise<string> {
  const tmpRoot = os.tmpdir();
  tempDir = await mkdtemp(path.join(tmpRoot, "scienceswarm-api-brief-"));
  const brainRoot = path.join(tempDir, "brain");
  initBrain({ root: brainRoot, name: "Test Researcher" });
  return brainRoot;
}

afterEach(async () => {
  if (originalBrainRoot === undefined) {
    delete process.env.BRAIN_ROOT;
  } else {
    process.env.BRAIN_ROOT = originalBrainRoot;
  }
  originalBrainRoot = undefined;

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("GET /api/brain/brief", () => {
  it("returns a usable brief seeded by the local import summary", async () => {
    const brainRoot = await createBrainRoot();
    originalBrainRoot = process.env.BRAIN_ROOT;
    process.env.BRAIN_ROOT = brainRoot;

    await writeProjectImportSummary(
      "alpha-project",
      {
        name: "Alpha Project",
        preparedFiles: 24,
        detectedItems: 31,
        detectedBytes: 15_271_433_016,
        duplicateGroups: 4,
        generatedAt: "2026-04-11T08:00:00.000Z",
        source: "local-scan",
      },
      path.join(brainRoot, "state"),
    );

    const { GET } = await import("@/app/api/brain/brief/route");
    const response = await GET(
      new Request("http://localhost/api/brain/brief?project=alpha-project"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.project).toBe("alpha-project");
    expect(body.topMatters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: expect.stringContaining("Latest import: Alpha Project"),
          evidence: ["projects/alpha-project/.brain/state/import-summary.json"],
        }),
      ]),
    );
    expect(body.nextMove.recommendation).toContain("Review the latest import summary");
  });

  it("rejects unsafe project slugs", async () => {
    const brainRoot = await createBrainRoot();
    originalBrainRoot = process.env.BRAIN_ROOT;
    process.env.BRAIN_ROOT = brainRoot;

    const { GET } = await import("@/app/api/brain/brief/route");
    const response = await GET(
      new Request("http://localhost/api/brain/brief?project=bad/slug"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "project must be a safe bare slug",
    });
  });
});
