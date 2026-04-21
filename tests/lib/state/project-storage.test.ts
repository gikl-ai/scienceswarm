import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = join(tmpdir(), "scienceswarm-state-project-storage");

afterEach(() => {
  delete process.env.SCIENCESWARM_DIR;
  rmSync(ROOT, { recursive: true, force: true });
  vi.resetModules();
  vi.doUnmock("node:fs/promises");
});

describe("project-storage", () => {
  it("treats ENOENT during legacy relocation as an idempotent concurrent move", async () => {
    process.env.SCIENCESWARM_DIR = ROOT;

    const legacyManifestPath = join(ROOT, "brain", "state", "projects", "project-alpha", "manifest.json");
    const legacyProjectPagePath = join(ROOT, "brain", "wiki", "projects", "project-alpha.md");
    mkdirSync(join(ROOT, "brain", "state", "projects", "project-alpha"), { recursive: true });
    mkdirSync(join(ROOT, "brain", "wiki", "projects"), { recursive: true });

    writeFileSync(
      legacyManifestPath,
      JSON.stringify({
        version: 1,
        projectId: "project-alpha",
        slug: "project-alpha",
        title: "Project Alpha",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/project-alpha.md",
        sourceRefs: [],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-12T00:00:00.000Z",
      }, null, 2),
    );
    writeFileSync(legacyProjectPagePath, "# Project Alpha\n");

    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      return {
        ...actual,
        rename: vi.fn(async (source: string, target: string) => {
          if (source === legacyManifestPath) {
            await actual.rename(source, target);
            const error = new Error("concurrent move") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return actual.rename(source, target);
        }),
      };
    });

    const { getProjectLocalManifestPath, migrateLegacyProjectState } = await import(
      "@/lib/state/project-storage"
    );

    await expect(migrateLegacyProjectState("project-alpha")).resolves.toBeUndefined();

    const canonicalManifestPath = getProjectLocalManifestPath("project-alpha");
    expect(existsSync(canonicalManifestPath)).toBe(true);
    expect(readFileSync(canonicalManifestPath, "utf-8")).toContain("\"slug\": \"project-alpha\"");
  });

  it("recognizes canonical project-local state roots under a custom projects root", async () => {
    process.env.SCIENCESWARM_DIR = ROOT;

    const { getProjectLocalStateRoot, getLegacyProjectStateDir } = await import(
      "@/lib/state/project-storage"
    );

    const canonicalStateRoot = getProjectLocalStateRoot("project-alpha", join(ROOT, "custom-projects"));
    expect(getLegacyProjectStateDir("project-alpha", canonicalStateRoot)).toBe(canonicalStateRoot);
  });
});
