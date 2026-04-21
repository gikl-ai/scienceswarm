import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { GbrainClient } from "@/brain/gbrain-client";
import type { GbrainFileObject } from "@/brain/gbrain-data-contracts";
import type { GbrainFileStore } from "@/brain/gbrain-file-store";
import { writeBackOpenClawGeneratedFiles } from "@/lib/openclaw/gbrain-writeback";

let tempRoot = "";

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  tempRoot = "";
});

describe("writeBackOpenClawGeneratedFiles", () => {
  it("persists durable source snapshots on generated artifact pages", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-openclaw-writeback-"));
    const sourcePath = path.join(tempRoot, "figures", "ratio-trend.svg");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "<svg><rect width=\"10\" height=\"10\" /></svg>", "utf-8");

    const fileObject: GbrainFileObject = {
      id: `sha256:${"f".repeat(64)}`,
      sha256: "f".repeat(64),
      sizeBytes: 41,
      mime: "image/svg+xml",
      originalFilename: "ratio-trend.svg",
      project: "project-alpha",
      uploadedAt: "2026-04-16T00:00:00.000Z",
      uploadedBy: "@tester",
      source: {
        kind: "openclaw_output",
        sessionId: "session-1",
        relativePath: "figures/ratio-trend.svg",
      },
      storagePath: `objects/files/ff/${"f".repeat(64)}`,
      contentEncoding: "raw",
    };
    const fileStore: GbrainFileStore = {
      async putObject() {
        return fileObject;
      },
      async getObject() {
        return fileObject;
      },
      async openObjectStream() {
        return null;
      },
      async hasObject() {
        return true;
      },
    };
    const pageWrites: Array<{ slug: string; content: string }> = [];
    const gbrain: GbrainClient = {
      async putPage(slug, content) {
        pageWrites.push({ slug, content });
        return { stdout: "ok", stderr: "" };
      },
      async linkPages() {
        return { stdout: "ok", stderr: "" };
      },
    };

    const result = await writeBackOpenClawGeneratedFiles({
      project: "project-alpha",
      sessionId: "session-1",
      uploadedBy: "@tester",
      projectRoot: tempRoot,
      fileStore,
      gbrain,
      now: () => new Date("2026-04-16T00:00:00.000Z"),
      provenance: {
        prompt: "Create a chart from the assay summary.",
        tool: "OpenClaw CLI",
        sourceFiles: ["gbrain:wiki/notes/assay-summary"],
        sourceSnapshots: [
          {
            slug: "wiki/notes/assay-summary",
            title: "Assay summary",
            type: "note",
            workspacePath: "notes/assay-summary.md",
            fingerprint: "e".repeat(64),
            fingerprintKind: "content_sha256",
            observedAt: "2026-04-16T00:00:00.000Z",
          },
        ],
      },
      files: [
        {
          sourcePath,
          relativePath: "figures/ratio-trend.svg",
          mime: "image/svg+xml",
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      slug: "openclaw-session-1-figures-ratio-trend-svg",
      type: "artifact",
    });
    expect(pageWrites[0].content).toContain("artifact_prompt: Create a chart from the assay summary.");
    expect(pageWrites[0].content).toContain("artifact_tool: OpenClaw CLI");
    expect(pageWrites[0].content).toContain("artifact_source_files:");
    expect(pageWrites[0].content).toContain("artifact_source_snapshots:");
    expect(pageWrites[0].content).toContain("derived_from:");
    expect(pageWrites[0].content).toContain("- wiki/notes/assay-summary");
  });

  it("refuses to import generated files from reserved workspace directories", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-openclaw-writeback-"));
    const sourcePath = path.join(tempRoot, ".brain", "wiki", "tasks", "unsafe.md");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "# unsafe", "utf-8");

    const fileStore: GbrainFileStore = {
      async putObject() {
        throw new Error("should not store reserved-path files");
      },
      async getObject() {
        throw new Error("not used");
      },
      async openObjectStream() {
        return null;
      },
      async hasObject() {
        return false;
      },
    };
    const gbrain: GbrainClient = {
      async putPage() {
        throw new Error("should not write reserved-path pages");
      },
      async linkPages() {
        return { stdout: "ok", stderr: "" };
      },
    };

    const result = await writeBackOpenClawGeneratedFiles({
      project: "project-alpha",
      sessionId: "session-1",
      uploadedBy: "@tester",
      projectRoot: tempRoot,
      fileStore,
      gbrain,
      files: [
        {
          sourcePath,
          relativePath: ".brain/wiki/tasks/unsafe.md",
          mime: "text/markdown",
        },
      ],
    });

    expect(result.created).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([
      {
        relativePath: ".brain/wiki/tasks/unsafe.md",
        reason: "invalid relative path",
      },
    ]);
  });
});
