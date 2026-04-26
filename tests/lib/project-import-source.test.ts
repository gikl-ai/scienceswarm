import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLegacyProjectStudyFilePath } from "@/lib/studies/state";

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
  it("infers legacy sources from an explicit BRAIN_ROOT without writing default Study state", async () => {
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

    const persistedPath = getLegacyProjectStudyFilePath("project-alpha", "import-source.json");
    const customPersistedPath = path.join(
      process.env.BRAIN_ROOT,
      "state",
      "projects",
      "project-alpha",
      "import-source.json",
    );
    expect(existsSync(persistedPath)).toBe(false);
    expect(readFileSync(customPersistedPath, "utf-8")).toContain("\"folderPath\": \"/tmp/project-alpha\"");
    expect(existsSync(path.join(
      process.env.SCIENCESWARM_DIR!,
      "projects",
      "project-alpha",
      ".brain",
      "state",
      "import-source.json",
    ))).toBe(false);
  });

  it("does not let stale default Study import-source state override an explicit BRAIN_ROOT", async () => {
    const defaultStudyPath = getLegacyProjectStudyFilePath("project-alpha", "import-source.json");
    mkdirSync(path.dirname(defaultStudyPath), { recursive: true });
    writeFileSync(
      defaultStudyPath,
      JSON.stringify({
        version: 1,
        project: "project-alpha",
        folderPath: "/tmp/stale-project-alpha",
        source: "default-study-state",
        updatedAt: "2026-04-12T12:00:00.000Z",
      }, null, 2),
      "utf-8",
    );

    process.env.BRAIN_ROOT = path.join(root, "custom-brain");
    const jobsRoot = path.join(process.env.BRAIN_ROOT, "state", "import-jobs");
    mkdirSync(jobsRoot, { recursive: true });
    writeFileSync(
      path.join(jobsRoot, "job-1.json"),
      JSON.stringify({
        id: "job-1",
        project: "project-alpha",
        folderPath: "/tmp/custom-project-alpha",
        source: "background-local-import",
        updatedAt: "2026-04-13T12:00:00.000Z",
      }, null, 2),
      "utf-8",
    );

    const { readProjectImportSource } = await importProjectImportSourceModule();
    const record = await readProjectImportSource("project-alpha");

    expect(record).toMatchObject({
      project: "project-alpha",
      folderPath: "/tmp/custom-project-alpha",
      source: "background-local-import",
      lastJobId: "job-1",
    });
    expect(readFileSync(defaultStudyPath, "utf-8")).toContain("/tmp/stale-project-alpha");
    expect(readFileSync(
      path.join(process.env.BRAIN_ROOT, "state", "projects", "project-alpha", "import-source.json"),
      "utf-8",
    )).toContain("/tmp/custom-project-alpha");
  });

  it("writes explicit BRAIN_ROOT import-source records where explicit reads consult them", async () => {
    process.env.BRAIN_ROOT = path.join(root, "custom-brain");

    const { readProjectImportSource, writeProjectImportSource } = await importProjectImportSourceModule();
    await writeProjectImportSource("project-alpha", {
      folderPath: "/tmp/custom-write-project-alpha",
      source: "background-local-import",
      updatedAt: "2026-04-14T12:00:00.000Z",
      lastJobId: "job-write",
    });

    const defaultStudyPath = getLegacyProjectStudyFilePath("project-alpha", "import-source.json");
    const customPath = path.join(
      process.env.BRAIN_ROOT,
      "state",
      "projects",
      "project-alpha",
      "import-source.json",
    );
    expect(existsSync(defaultStudyPath)).toBe(false);
    expect(readFileSync(customPath, "utf-8")).toContain("/tmp/custom-write-project-alpha");

    await expect(readProjectImportSource("project-alpha")).resolves.toMatchObject({
      project: "project-alpha",
      folderPath: "/tmp/custom-write-project-alpha",
      lastJobId: "job-write",
    });
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
