import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root = "";
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_BRAIN_ROOT = process.env.BRAIN_ROOT;

async function importProjectImportSourceModule() {
  return await import("@/lib/state/project-import-source");
}

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(path.join(os.tmpdir(), "scienceswarm-project-import-source-"));
  process.env.SCIENCESWARM_DIR = path.join(root, "data");
  delete process.env.BRAIN_ROOT;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (ORIGINAL_SCIENCESWARM_DIR === undefined) {
    delete process.env.SCIENCESWARM_DIR;
  } else {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  }
  if (ORIGINAL_BRAIN_ROOT === undefined) {
    delete process.env.BRAIN_ROOT;
  } else {
    process.env.BRAIN_ROOT = ORIGINAL_BRAIN_ROOT;
  }
});

describe("project import source state", () => {
  it("persists inferred legacy sources from an explicit BRAIN_ROOT", async () => {
    process.env.BRAIN_ROOT = path.join(root, "legacy-brain");
    const jobsRoot = path.join(process.env.BRAIN_ROOT, "state", "import-jobs");
    mkdirSync(jobsRoot, { recursive: true });
    writeFileSync(
      path.join(jobsRoot, "job-1.json"),
      JSON.stringify({
        id: "job-1",
        project: "project-alpha",
        folderPath: "/tmp/project-alpha",
        source: "background-local-import",
        updatedAt: "2026-04-13T12:00:00.000Z",
      }, null, 2),
      "utf-8",
    );

    const { readProjectImportSource } = await importProjectImportSourceModule();
    const record = await readProjectImportSource("project-alpha");

    expect(record).toMatchObject({
      project: "project-alpha",
      folderPath: "/tmp/project-alpha",
      source: "background-local-import",
      lastJobId: "job-1",
    });

    const persistedPath = path.join(
      process.env.SCIENCESWARM_DIR!,
      "projects",
      "project-alpha",
      ".brain",
      "state",
      "import-source.json",
    );
    expect(existsSync(persistedPath)).toBe(true);
    expect(readFileSync(persistedPath, "utf-8")).toContain("\"folderPath\": \"/tmp/project-alpha\"");
  });

  it("skips malformed legacy import-job records while inferring sources", async () => {
    process.env.BRAIN_ROOT = path.join(root, "legacy-brain");
    const jobsRoot = path.join(process.env.BRAIN_ROOT, "state", "import-jobs");
    mkdirSync(jobsRoot, { recursive: true });
    writeFileSync(path.join(jobsRoot, "broken.json"), "{ not valid json", "utf-8");
    writeFileSync(
      path.join(jobsRoot, "job-2.json"),
      JSON.stringify({
        id: "job-2",
        project: "project-alpha",
        folderPath: "/tmp/project-alpha-v2",
        source: "background-local-import",
        updatedAt: "2026-04-13T13:00:00.000Z",
      }, null, 2),
      "utf-8",
    );

    const { readProjectImportSource } = await importProjectImportSourceModule();
    const record = await readProjectImportSource("project-alpha");

    expect(record).toMatchObject({
      project: "project-alpha",
      folderPath: "/tmp/project-alpha-v2",
      lastJobId: "job-2",
    });
  });
});
