import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntimeArtifactRecord,
  validateRuntimeArtifactImport,
} from "@/lib/runtime-hosts/artifacts";
import { createRuntimePathMapper } from "@/lib/runtime-hosts/path-mapping";

let tempRoot = "";

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
  tempRoot = "";
});

describe("runtime host path mapping and artifact import", () => {
  it("maps project-relative paths to local absolute paths and back", () => {
    const projectRoot = path.join(os.tmpdir(), "project-alpha");
    const mapper = createRuntimePathMapper({
      projectId: "project-alpha",
      hostId: "codex",
      projectRoot,
    });

    const mapping = mapper.fromProjectRelative("figures/ratio-trend.svg");

    expect(mapping).toEqual({
      projectId: "project-alpha",
      hostId: "codex",
      projectRelativePath: "figures/ratio-trend.svg",
      localAbsolutePath: path.join(projectRoot, "figures", "ratio-trend.svg"),
      hostNativePath: path.join(projectRoot, "figures", "ratio-trend.svg"),
    });
    expect(mapper.fromLocalAbsolute(mapping.localAbsolutePath)).toEqual(mapping);
  });

  it("maps OpenHands container paths to project workspace paths", () => {
    const projectRoot = path.join(os.tmpdir(), "project-alpha");
    const mapper = createRuntimePathMapper({
      projectId: "project-alpha",
      hostId: "openhands",
      projectRoot,
      hostWorkspaceRoot: "/workspace/project-alpha",
    });

    const mapping = mapper.fromHostNative(
      "/workspace/project-alpha/results/summary.md",
    );

    expect(mapping).toEqual({
      projectId: "project-alpha",
      hostId: "openhands",
      projectRelativePath: "results/summary.md",
      localAbsolutePath: path.join(projectRoot, "results", "summary.md"),
      hostNativePath: "/workspace/project-alpha/results/summary.md",
    });
  });

  it("rejects path traversal before import validation", () => {
    const mapper = createRuntimePathMapper({
      projectId: "project-alpha",
      hostId: "openhands",
      projectRoot: path.join(os.tmpdir(), "project-alpha"),
      hostWorkspaceRoot: "/workspace/project-alpha",
    });

    expect(() => mapper.fromProjectRelative("../secrets.txt")).toThrow(
      "Path escapes the project workspace",
    );
    expect(() => mapper.fromHostNative("/workspace/other/secrets.txt")).toThrow(
      "Path is outside the host workspace root",
    );
  });

  it("requires approval for external artifact paths and validates approved roots", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-artifacts-"));
    const projectRoot = path.join(tempRoot, "project-alpha");
    const externalRoot = path.join(tempRoot, "declared-openhands-artifacts");
    const externalArtifact = path.join(externalRoot, "summary.md");
    await mkdir(externalRoot, { recursive: true });
    await writeFile(externalArtifact, "# result", "utf-8");

    const mapper = createRuntimePathMapper({
      projectId: "project-alpha",
      hostId: "openhands",
      projectRoot,
      hostWorkspaceRoot: "/workspace/project-alpha",
    });

    const pending = await validateRuntimeArtifactImport({
      projectId: "project-alpha",
      sourceHostId: "openhands",
      sourceSessionId: "session-1",
      sourcePath: externalArtifact,
      sourcePathKind: "local-absolute",
      importReason: "user-selected-external-path",
      approvalState: "required",
      allowedRoots: [projectRoot, externalRoot],
      pathMapper: mapper,
    });

    expect(pending).toMatchObject({
      ok: false,
      reason: "approval-required",
      approvalRequired: true,
    });

    const approved = await validateRuntimeArtifactImport({
      projectId: "project-alpha",
      sourceHostId: "openhands",
      sourceSessionId: "session-1",
      sourcePath: externalArtifact,
      sourcePathKind: "local-absolute",
      importReason: "user-selected-external-path",
      approvalState: "approved",
      allowedRoots: [projectRoot, externalRoot],
      pathMapper: mapper,
    });

    expect(approved).toMatchObject({
      ok: true,
      approvalRequired: false,
      mapping: {
        projectRelativePath: "summary.md",
        localAbsolutePath: externalArtifact,
      },
    });
  });

  it("preserves host, session, path, and provenance on artifact records", () => {
    const record = createRuntimeArtifactRecord({
      projectId: "project-alpha",
      sourceHostId: "openhands",
      sourceSessionId: "session-1",
      sourcePath: "/workspace/project-alpha/results/summary.md",
      workspacePath: "results/summary.md",
      promptHash: "prompt-hash-1",
      inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
      generatedAt: "2026-04-22T10:00:00.000Z",
      importedBy: "@tester",
      approvalState: "not-required",
    });

    expect(record).toMatchObject({
      artifactId: "runtime-artifact-openhands-session-1-results-summary-md",
      projectId: "project-alpha",
      sourceHostId: "openhands",
      sourceSessionId: "session-1",
      sourcePath: "/workspace/project-alpha/results/summary.md",
      workspacePath: "results/summary.md",
      provenance: {
        promptHash: "prompt-hash-1",
        inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
        generatedAt: "2026-04-22T10:00:00.000Z",
        importedBy: "@tester",
        approvalState: "not-required",
      },
    });
  });
});
