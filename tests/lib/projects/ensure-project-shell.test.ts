import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureBrainStoreReady,
  getBrainStore,
  createProjectRepository,
  materializeProjectFolder,
  getCurrentUserHandle,
  DuplicateProjectError,
} = vi.hoisted(() => {
  class DuplicateProjectError extends Error {
    constructor(slug: string) {
      super(`Project already exists: ${slug}`);
      this.name = "DuplicateProjectError";
    }
  }

  return {
    ensureBrainStoreReady: vi.fn(),
    getBrainStore: vi.fn(),
    createProjectRepository: vi.fn(),
    materializeProjectFolder: vi.fn(),
    getCurrentUserHandle: vi.fn(() => "test-scientist"),
    DuplicateProjectError,
  };
});

vi.mock("@/brain/store", () => ({
  ensureBrainStoreReady,
  getBrainStore,
}));

vi.mock("@/lib/projects/project-repository", () => ({
  createProjectRepository,
  DuplicateProjectError,
}));

vi.mock("@/lib/projects/materialize-project", () => ({
  materializeProjectFolder,
}));

vi.mock("@/lib/setup/current-user-handle", () => ({
  getCurrentUserHandle,
}));

import { ensureProjectShellForProjectSlug } from "@/lib/projects/ensure-project-shell";
import type { BrainPage } from "@/brain/store";
import type { ProjectRecord } from "@/brain/gbrain-data-contracts";

describe("ensureProjectShellForProjectSlug", () => {
  beforeEach(() => {
    ensureBrainStoreReady.mockReset();
    ensureBrainStoreReady.mockResolvedValue(undefined);
    getBrainStore.mockReset();
    createProjectRepository.mockReset();
    materializeProjectFolder.mockReset();
    materializeProjectFolder.mockResolvedValue({ ok: true, path: "/tmp/project" });
    getCurrentUserHandle.mockReset();
    getCurrentUserHandle.mockReturnValue("test-scientist");
  });

  it("passes the requested slug through when creating a missing project shell", async () => {
    const record: ProjectRecord = {
      slug: "alpha--beta",
      name: "Alpha Beta",
      description: "Project created from saved ScienceSwarm critique artifacts.",
      createdAt: "2026-04-20T00:00:00.000Z",
      lastActive: "2026-04-20T00:00:00.000Z",
      status: "active",
      projectPageSlug: "alpha--beta",
    };
    const repo = {
      get: vi.fn(async () => null),
      create: vi.fn(async () => record),
    };
    createProjectRepository.mockReturnValue(repo);
    getBrainStore.mockReturnValue({
      listPages: vi.fn(async (): Promise<BrainPage[]> => [
        {
          path: "alpha--beta-critique.md",
          title: "Critique",
          type: "note",
          content: "",
          frontmatter: {
            type: "critique",
            project: "alpha--beta",
            source_filename: "alpha.pdf",
          },
        },
      ]),
    });

    const result = await ensureProjectShellForProjectSlug({
      projectSlug: "alpha--beta",
    });

    expect(result).toEqual(record);
    expect(repo.create).toHaveBeenCalledWith({
      slug: "alpha--beta",
      name: "Alpha Beta",
      description: "Study created from saved critique artifacts for alpha.pdf.",
      createdBy: "test-scientist",
    });
    expect(materializeProjectFolder).toHaveBeenCalledWith(record);
  });

  it("treats frontmatter.projects membership as evidence for creating a shell", async () => {
    const record: ProjectRecord = {
      slug: "project-alpha",
      name: "Project Alpha",
      description: "Study created from saved critique artifacts for alpha.pdf.",
      createdAt: "2026-04-20T00:00:00.000Z",
      lastActive: "2026-04-20T00:00:00.000Z",
      status: "active",
      projectPageSlug: "project-alpha",
    };
    const repo = {
      get: vi.fn(async () => null),
      create: vi.fn(async () => record),
    };
    createProjectRepository.mockReturnValue(repo);
    getBrainStore.mockReturnValue({
      listPages: vi.fn(async (): Promise<BrainPage[]> => [
        {
          path: "cross-linked-critique.md",
          title: "Cross linked critique",
          type: "note",
          content: "",
          frontmatter: {
            type: "critique",
            projects: ["project-alpha", "project-beta"],
            source_filename: "alpha.pdf",
          },
        },
      ]),
    });

    await ensureProjectShellForProjectSlug({
      projectSlug: "project-alpha",
    });

    expect(repo.create).toHaveBeenCalledWith({
      slug: "project-alpha",
      name: "Project Alpha",
      description: "Study created from saved critique artifacts for alpha.pdf.",
      createdBy: "test-scientist",
    });
  });

  it("fails loudly when the current user handle is unavailable and no createdBy is supplied", async () => {
    const repo = {
      get: vi.fn(async () => null),
      create: vi.fn(),
    };
    createProjectRepository.mockReturnValue(repo);
    getBrainStore.mockReturnValue({
      listPages: vi.fn(async (): Promise<BrainPage[]> => [
        {
          path: "project-alpha-critique.md",
          title: "Critique",
          type: "note",
          content: "",
          frontmatter: {
            type: "critique",
            project: "project-alpha",
            source_filename: "alpha.pdf",
          },
        },
      ]),
    });
    getCurrentUserHandle.mockImplementation(() => {
      throw new Error("SCIENCESWARM_USER_HANDLE is required");
    });

    await expect(
      ensureProjectShellForProjectSlug({
        projectSlug: "project-alpha",
      }),
    ).rejects.toThrow("SCIENCESWARM_USER_HANDLE is required");
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("lazy-loads the brain store instead of importing it at module scope", async () => {
    const source = await readFile(
      new URL("../../../src/lib/projects/ensure-project-shell.ts", import.meta.url),
      "utf-8",
    );

    expect(source).toContain('await import("@/brain/store")');
    expect(source).toContain("async function loadReadyBrainStore()");
    expect(source).not.toContain('import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";');
    expect(source).toContain('from "@/lib/setup/current-user-handle"');
    expect(source).not.toContain('from "@/lib/setup/gbrain-installer"');
  });
});
