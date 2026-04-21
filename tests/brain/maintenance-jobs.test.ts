import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readMaintenanceJob,
  startMaintenanceJob,
  previewSyncFromRepo,
  MaintenanceJobConflictError,
  type MaintenanceJobResult,
} from "@/brain/maintenance-jobs";
import type { BrainConfig } from "@/brain/types";

const ORIGINAL_BRAIN_ROOT = process.env.BRAIN_ROOT;
const ORIGINAL_BRAIN_PGLITE_PATH = process.env.BRAIN_PGLITE_PATH;

let root: string;

function makeConfig(): BrainConfig {
  return {
    root,
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

describe("maintenance jobs", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "scienceswarm-maintenance-jobs-"));
    process.env.BRAIN_ROOT = root;
    delete process.env.BRAIN_PGLITE_PATH;
  });

  afterEach(() => {
    if (ORIGINAL_BRAIN_ROOT === undefined) {
      delete process.env.BRAIN_ROOT;
    } else {
      process.env.BRAIN_ROOT = ORIGINAL_BRAIN_ROOT;
    }
    if (ORIGINAL_BRAIN_PGLITE_PATH === undefined) {
      delete process.env.BRAIN_PGLITE_PATH;
    } else {
      process.env.BRAIN_PGLITE_PATH = ORIGINAL_BRAIN_PGLITE_PATH;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("persists completed dry-run previews without writing to gbrain", async () => {
    mkdirSync(join(root, "wiki"), { recursive: true });
    writeFileSync(
      join(root, "wiki", "source.md"),
      [
        "# Source",
        "",
        "[Target](target.md)",
        "",
        "- **2026-04-16** | Notebook - Result captured.",
      ].join("\n"),
      "utf-8",
    );

    const job = await startMaintenanceJob({
      config: makeConfig(),
      action: "extract-timeline",
      mode: "dry-run",
    });

    expect(job).toMatchObject({
      action: "extract-timeline",
      mode: "dry-run",
      status: "completed",
      result: {
        metrics: {
          pages: 1,
          timelineCandidates: 1,
        },
      },
    });

    await expect(readMaintenanceJob(job.id, root)).resolves.toMatchObject({
      id: job.id,
      status: "completed",
    });
  });

  it("skips markdown symlinks that resolve outside the scan root", async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "scienceswarm-maintenance-outside-"));
    try {
      mkdirSync(join(root, "wiki"), { recursive: true });
      writeFileSync(
        join(outsideRoot, "outside.md"),
        ["# Outside", "", "[Secret](secret.md)"].join("\n"),
        "utf-8",
      );
      symlinkSync(join(outsideRoot, "outside.md"), join(root, "wiki", "outside.md"));

      const job = await startMaintenanceJob({
        config: makeConfig(),
        action: "extract-links",
        mode: "dry-run",
      });

      expect(job.result?.metrics).toMatchObject({
        pages: 0,
        linkCandidates: 0,
      });
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("prevents concurrent started jobs against the same store", async () => {
    const config = makeConfig();
    const preview = await startMaintenanceJob({
      config,
      action: "extract-links",
      mode: "dry-run",
    });

    let release!: () => void;
    const blocked = new Promise<MaintenanceJobResult>((resolve) => {
      release = () =>
        resolve({
          summary: "done",
          steps: [],
          warnings: [],
        });
    });

    const first = await startMaintenanceJob(
      {
        config,
        action: "extract-links",
        mode: "start",
        previewJobId: preview.id,
      },
      {
        executeJob: () => blocked,
      },
    );

    expect(first.status).toBe("queued");
    await expect(
      startMaintenanceJob({
        config,
        action: "extract-links",
        mode: "start",
        previewJobId: preview.id,
      }),
    ).rejects.toBeInstanceOf(MaintenanceJobConflictError);

    release();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const job = await readMaintenanceJob(first.id, root);
      if (job?.status === "completed") {
        expect(job.result?.summary).toBe("done");
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    throw new Error("maintenance job did not complete");
  });

  it("previews first git sync without invoking write-capable sync", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "scienceswarm-sync-preview-"));
    try {
      execFileSync("git", ["init"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.name", "ScienceSwarm Test"], { cwd: repoRoot });
      writeFileSync(join(repoRoot, "README.md"), "# Project Alpha\n", "utf-8");
      writeFileSync(join(repoRoot, "notes.txt"), "not syncable\n", "utf-8");
      execFileSync("git", ["add", "."], { cwd: repoRoot });
      execFileSync("git", ["commit", "-m", "seed"], { cwd: repoRoot });

      const preview = await previewSyncFromRepo(
        { getConfig: async () => null } as never,
        repoRoot,
      );

      expect(preview).toMatchObject({
        status: "dry_run",
        fullImport: true,
        added: 1,
        modified: 0,
        deleted: 0,
        renamed: 0,
        pagesAffected: ["README.md"],
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
