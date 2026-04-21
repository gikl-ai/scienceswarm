import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureProjectManifest,
  getProjectManifestPath,
  getProjectPagePath,
  getProjectWatchConfigPath,
  listProjectManifests,
  readProjectManifest,
  writeProjectManifest,
} from "@/lib/state/project-manifests";
import type { ProjectManifest } from "@/brain/types";
import * as atomicJson from "@/lib/state/atomic-json";

const ROOT = join(tmpdir(), "scienceswarm-state-manifest");
const DATA_ROOT = join(tmpdir(), "scienceswarm-state-manifest-data");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

afterEach(() => {
  if (ORIGINAL_SCIENCESWARM_DIR !== undefined) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe("project-manifests", () => {
  it("writes and reads project manifests", async () => {
    const manifest: ProjectManifest = {
      version: 1,
      projectId: "project-alpha",
      slug: "project-alpha",
      title: "Project Alpha",
      privacy: "cloud-ok",
      status: "active",
      projectPagePath: "wiki/projects/project-alpha.md",
      sourceRefs: [{ kind: "import", ref: "raw/imports/project-alpha" }],
      decisionPaths: ["wiki/decisions/decision-1.md"],
      taskPaths: ["wiki/tasks/task-1.md"],
      artifactPaths: [],
      frontierPaths: [],
      activeThreads: [
        {
          channel: "telegram",
          threadId: "thread-1",
          lastActivityAt: "2026-04-08T00:00:00.000Z",
        },
      ],
      dedupeKeys: ["sha256:abc123"],
      updatedAt: "2026-04-08T00:00:00.000Z",
    };

    await writeProjectManifest(manifest, ROOT);

    const onDisk = await readProjectManifest("project-alpha", ROOT);
    expect(onDisk).toEqual(manifest);
    expect(readFileSync(getProjectManifestPath("project-alpha", ROOT), "utf-8")).toContain('"projectId": "project-alpha"');
    expect(getProjectWatchConfigPath("project-alpha", ROOT)).toBe(
      join(ROOT, "projects", "project-alpha", "watch-config.json"),
    );
  });

  it("rejects unsafe project slugs", async () => {
    await expect(readProjectManifest("../escape", ROOT)).rejects.toThrow(
      "Invalid project slug",
    );
  });

  it("bootstraps a missing manifest from project metadata on disk", async () => {
    const projectsRoot = join(DATA_ROOT, "projects");
    const stateRoot = join(DATA_ROOT, "brain", "state");
    const projectSlug = "project-alpha";
    mkdirSync(join(projectsRoot, projectSlug), { recursive: true });
    writeFileSync(
      join(projectsRoot, projectSlug, "project.json"),
      JSON.stringify({
        id: projectSlug,
        slug: projectSlug,
        name: "Project Alpha",
        description: "Track frontier work on alpha.",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastActive: "2026-04-09T12:00:00.000Z",
        status: "active",
      }, null, 2),
    );

    const manifest = await ensureProjectManifest(projectSlug, stateRoot, projectsRoot);

    expect(manifest).not.toBeNull();
    expect(manifest?.slug).toBe(projectSlug);
    expect(manifest?.projectPagePath).toBe(getProjectPagePath(projectSlug));
    expect(readFileSync(getProjectManifestPath(projectSlug, stateRoot), "utf-8")).toContain('"title": "Project Alpha"');
    expect(readFileSync(join(DATA_ROOT, "brain", getProjectPagePath(projectSlug)), "utf-8")).toContain(
      "Track frontier work on alpha.",
    );
  });

  it("uses the project root as the default manifest location and migrates legacy state", async () => {
    process.env.SCIENCESWARM_DIR = DATA_ROOT;
    const legacyStateRoot = join(DATA_ROOT, "brain", "state");
    const legacyManifestPath = getProjectManifestPath("project-alpha", legacyStateRoot);
    mkdirSync(join(DATA_ROOT, "brain", "wiki", "projects"), { recursive: true });
    mkdirSync(join(DATA_ROOT, "brain", "state", "projects", "project-alpha"), { recursive: true });

    writeFileSync(
      legacyManifestPath,
      JSON.stringify({
        version: 1,
        projectId: "project-alpha",
        slug: "project-alpha",
        title: "Project Alpha",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: getProjectPagePath("project-alpha"),
        sourceRefs: [],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-11T00:00:00.000Z",
      }, null, 2),
    );
    writeFileSync(
      join(DATA_ROOT, "brain", getProjectPagePath("project-alpha")),
      "# Project Alpha\n",
    );

    const manifest = await readProjectManifest("project-alpha");
    const canonicalManifestPath = getProjectManifestPath("project-alpha");

    expect(manifest?.title).toBe("Project Alpha");
    expect(canonicalManifestPath).toBe(
      join(DATA_ROOT, "projects", "project-alpha", ".brain", "state", "manifest.json"),
    );
    expect(readFileSync(canonicalManifestPath, "utf-8")).toContain("\"title\": \"Project Alpha\"");
    expect(existsSync(legacyManifestPath)).toBe(false);
    expect(
      existsSync(join(DATA_ROOT, "projects", "project-alpha", ".brain", getProjectPagePath("project-alpha"))),
    ).toBe(true);
  });

  it("treats an explicit project-local state root as canonical", () => {
    const canonicalStateRoot = join(DATA_ROOT, "projects", "project-alpha", ".brain", "state");

    expect(getProjectManifestPath("project-alpha", canonicalStateRoot)).toBe(
      join(canonicalStateRoot, "manifest.json"),
    );
    expect(getProjectWatchConfigPath("project-alpha", canonicalStateRoot)).toBe(
      join(canonicalStateRoot, "watch-config.json"),
    );
  });

  it("skips invalid project directories when listing manifests", async () => {
    const projectsRoot = join(DATA_ROOT, "projects");
    mkdirSync(join(projectsRoot, "project-alpha"), { recursive: true });
    mkdirSync(join(projectsRoot, ".tmp-cache"), { recursive: true });
    writeFileSync(
      join(projectsRoot, "project-alpha", "project.json"),
      JSON.stringify({
        id: "project-alpha",
        slug: "project-alpha",
        name: "Project Alpha",
        description: "Track frontier work on alpha.",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastActive: "2026-04-09T12:00:00.000Z",
        status: "active",
      }, null, 2),
    );

    const manifests = await listProjectManifests(projectsRoot);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.slug).toBe("project-alpha");
  });

  it("does not create canonical .brain directories when a project slug is unknown", async () => {
    process.env.SCIENCESWARM_DIR = DATA_ROOT;

    await expect(readProjectManifest("missing-project")).resolves.toBeNull();
    expect(existsSync(join(DATA_ROOT, "projects", "missing-project", ".brain"))).toBe(false);
  });

  it("re-reads the canonical manifest before returning null when a concurrent migration wins the race", async () => {
    process.env.SCIENCESWARM_DIR = DATA_ROOT;
    const canonicalManifestPath = getProjectManifestPath("project-alpha");
    const manifest: ProjectManifest = {
      version: 1,
      projectId: "project-alpha",
      slug: "project-alpha",
      title: "Project Alpha",
      privacy: "cloud-ok",
      status: "active",
      projectPagePath: getProjectPagePath("project-alpha"),
      sourceRefs: [],
      decisionPaths: [],
      taskPaths: [],
      artifactPaths: [],
      frontierPaths: [],
      activeThreads: [],
      dedupeKeys: [],
      updatedAt: "2026-04-12T00:00:00.000Z",
    };
    const readJsonFile = vi.spyOn(atomicJson, "readJsonFile");
    let canonicalReads = 0;

    readJsonFile.mockImplementation(async (targetPath) => {
      if (targetPath === canonicalManifestPath) {
        canonicalReads += 1;
        return canonicalReads === 1 ? null : manifest;
      }
      return null;
    });

    try {
      await expect(readProjectManifest("project-alpha")).resolves.toEqual(manifest);
      expect(canonicalReads).toBe(2);
    } finally {
      readJsonFile.mockRestore();
    }
  });
});
