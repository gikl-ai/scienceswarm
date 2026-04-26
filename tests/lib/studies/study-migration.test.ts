import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  executeLegacyProjectStateMigration,
  planLegacyProjectStateMigration,
  readMigratedOrLegacyProjectFile,
} from "@/lib/studies";

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "studies", "legacy-migration");
const TEST_ROOT = path.join(os.tmpdir(), "scienceswarm-study-migration");

async function listFixtureFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFixtureFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function installFixture(): Promise<{ dataRoot: string; projectsRoot: string; brainRoot: string; stateRoot: string }> {
  const dataRoot = path.join(TEST_ROOT, `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dataRoot, { recursive: true });
  const fixtureFiles = await listFixtureFiles(FIXTURE_ROOT);
  for (const source of fixtureFiles) {
    const relative = path.relative(FIXTURE_ROOT, source);
    const destination = path.join(dataRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }
  return {
    dataRoot,
    projectsRoot: path.join(dataRoot, "projects"),
    brainRoot: path.join(dataRoot, "brain"),
    stateRoot: path.join(dataRoot, "state"),
  };
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function planFixture() {
  const roots = await installFixture();
  const plan = await planLegacyProjectStateMigration({
    legacyProjectSlug: "project-alpha",
    studyId: "study_alpha",
    threadId: "thread_alpha",
    projectsRoot: roots.projectsRoot,
    brainRoot: roots.brainRoot,
    stateRoot: roots.stateRoot,
    generatedAt: "2026-04-26T00:00:00.000Z",
  });
  return { roots, plan };
}

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("Study migration planning", () => {
  it("dry-runs a deterministic file manifest without copying legacy state", async () => {
    const { roots, plan } = await planFixture();

    expect(plan.summary.copy).toBeGreaterThanOrEqual(6);
    const secondPlan = await planLegacyProjectStateMigration({
      legacyProjectSlug: "project-alpha",
      studyId: "study_alpha",
      threadId: "thread_alpha",
      projectsRoot: roots.projectsRoot,
      brainRoot: roots.brainRoot,
      stateRoot: roots.stateRoot,
      generatedAt: "2026-04-26T00:00:00.000Z",
    });
    expect(secondPlan.entries.map((entry) => `${entry.classification}:${entry.relativePath}`)).toEqual(
      plan.entries.map((entry) => `${entry.classification}:${entry.relativePath}`),
    );
    expect(plan.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        classification: "project-manifest",
        action: "copy",
        relativePath: "legacy-project/manifest.json",
        status: "ready",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        classification: "chat-history",
        destinationPath: path.join(roots.stateRoot, "threads", "thread_alpha", "messages.jsonl"),
        status: "ready",
      }),
      expect.objectContaining({
        classification: "linked-wiki-payload",
        relativePath: "wiki/projects/project-alpha/source-note.md",
        status: "ready",
      }),
    ]));
    expect(existsSync(path.join(roots.stateRoot, "studies", "study_alpha"))).toBe(false);
    expect(existsSync(path.join(roots.projectsRoot, "project-alpha", ".brain", "state", "manifest.json"))).toBe(true);
  });

  it("inventories paper-library stores without planning copies", async () => {
    const { roots, plan } = await planFixture();
    const paperEntries = plan.entries.filter((entry) => entry.classification === "paper-library-inventory");

    expect(paperEntries.length).toBe(2);
    expect(paperEntries.every((entry) => entry.action === "inventory-only")).toBe(true);
    expect(paperEntries.every((entry) => entry.destinationPath === null)).toBe(true);
    expect(paperEntries.map((entry) => entry.sourcePath)).toEqual(expect.arrayContaining([
      path.join(roots.projectsRoot, "project-alpha", ".brain", "state", "paper-library", "scans", "scan-1.json"),
      path.join(roots.brainRoot, "state", "paper-library", "global-cache.json"),
    ]));
  });
});

describe("Study migration execution", () => {
  it("streams copied files with checksum verification and stays idempotent", async () => {
    const { roots, plan } = await planFixture();
    const report = await executeLegacyProjectStateMigration(plan, { concurrency: 2 });

    expect(report.state).toBe("completed");
    expect(report.summary.failed).toBe(0);
    expect(report.summary.copied).toBe(plan.entries.filter((entry) => entry.action === "copy" && entry.status === "ready").length);

    const copiedManifest = path.join(roots.stateRoot, "studies", "study_alpha", "legacy-project", "project-alpha", "manifest.json");
    const legacyManifest = path.join(roots.projectsRoot, "project-alpha", ".brain", "state", "manifest.json");
    expect(await sha256(copiedManifest)).toBe(await sha256(legacyManifest));
    expect(existsSync(legacyManifest)).toBe(true);
    expect(existsSync(path.join(roots.stateRoot, "studies", "study_alpha", "legacy-project", "project-alpha", "paper-library", "scans", "scan-1.json"))).toBe(false);

    const secondPlan = await planLegacyProjectStateMigration({
      legacyProjectSlug: "project-alpha",
      studyId: "study_alpha",
      threadId: "thread_alpha",
      projectsRoot: roots.projectsRoot,
      brainRoot: roots.brainRoot,
      stateRoot: roots.stateRoot,
      generatedAt: "2026-04-26T00:01:00.000Z",
    });
    expect(secondPlan.entries.filter((entry) => entry.action === "copy").every((entry) => entry.status === "already-canonical")).toBe(true);
    const secondReport = await executeLegacyProjectStateMigration(secondPlan, {
      concurrency: 2,
      checkpointPath: path.join(roots.stateRoot, "studies", "study_alpha", "migration-checkpoint-second.json"),
    });
    expect(secondReport.summary.alreadyCanonical).toBe(secondPlan.summary.copy);
  });

  it("can cancel and resume from checkpoints between file operations", async () => {
    const { roots, plan } = await planFixture();
    const controller = new AbortController();
    const checkpointPath = path.join(roots.stateRoot, "studies", "study_alpha", "migration-checkpoint.json");
    let completed = 0;

    const firstReport = await executeLegacyProjectStateMigration(plan, {
      concurrency: 1,
      checkpointPath,
      signal: controller.signal,
      onProgress: () => {
        completed += 1;
        if (completed === 1) controller.abort();
      },
    });

    expect(firstReport.state).toBe("cancelled");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf-8")) as { completedEntryIds: string[] };
    expect(checkpoint.completedEntryIds).toHaveLength(1);

    const secondReport = await executeLegacyProjectStateMigration(plan, {
      concurrency: 1,
      checkpointPath,
    });
    expect(secondReport.state).toBe("completed");
    expect(secondReport.entries.some((entry) => entry.status === "checkpointed")).toBe(true);
    expect(secondReport.summary.failed).toBe(0);
    expect(existsSync(path.join(roots.stateRoot, "studies", "study_alpha", "migration-reports"))).toBe(true);
  });

  it("reads migrated files first and falls back to untouched legacy files", async () => {
    const { plan } = await planFixture();
    const legacyManifest = await readMigratedOrLegacyProjectFile({
      plan,
      classification: "project-manifest",
    });

    await executeLegacyProjectStateMigration(plan, { concurrency: 2 });
    const migratedManifest = await readMigratedOrLegacyProjectFile({
      plan,
      classification: "project-manifest",
    });
    const migratedImportSummary = await readMigratedOrLegacyProjectFile({
      plan,
      classification: "import-summary",
    });

    expect(migratedManifest).toEqual(legacyManifest);
    expect(migratedImportSummary).toMatchObject({
      project: "project-alpha",
      lastImport: { name: "Placeholder source import" },
    });
  });
});
