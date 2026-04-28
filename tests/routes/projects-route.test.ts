import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRepository } from "@/lib/projects/project-repository";
import type { ProjectRecord } from "@/brain/gbrain-data-contracts";
import { __setProjectRepositoryOverride } from "@/lib/testing/projects-route-overrides";

let dataRoot: string;
const originalCwd = process.cwd();

function buildCreateRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/projects", () => {
  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-project-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@project-route-test";
  });

  afterEach(async () => {
    __setProjectRepositoryOverride(null);
    process.chdir(originalCwd);
    delete process.env.SCIENCESWARM_DIR;
    delete process.env.SCIENCESWARM_USER_HANDLE;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("rejects non-local create and delete requests", async () => {
    const { POST } = await import("@/app/api/projects/route");

    const create = await POST(new Request("http://example.com/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name: "Project Alpha" }),
    }));
    const del = await POST(new Request("http://example.com/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", projectId: "project-alpha" }),
    }));

    expect(create.status).toBe(403);
    expect(del.status).toBe(403);
  });

  it("creates a project, bootstraps Study state, and returns explicit slug normalization details", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const createdRecords: ProjectRecord[] = [];
    const fakeRepository: ProjectRepository = {
      async list() {
        return createdRecords;
      },
      async get(slug) {
        return createdRecords.find((record) => record.slug === slug) ?? null;
      },
      async create(input) {
        const now = "2026-04-16T00:00:00.000Z";
        const record: ProjectRecord = {
          slug: "my-first-test-project",
          name: input.name,
          description: input.description ?? "New project",
          createdAt: now,
          lastActive: now,
          status: "active",
          projectPageSlug: "my-first-test-project",
        };
        createdRecords.push(record);
        return record;
      },
      async delete() {
        return { ok: true, existed: true };
      },
      async touch() {},
    };
    __setProjectRepositoryOverride(fakeRepository);

    const response = await POST(buildCreateRequest({
      action: "create",
      name: "my_first_test_project",
      description: "Track frontier AI updates.",
    }));

    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.normalization).toEqual({
      requestedName: "my_first_test_project",
      slug: "my-first-test-project",
      changed: true,
    });

    const studyStatePath = path.join(
      dataRoot,
      "state",
      "studies",
      "study_my-first-test-project",
      "study.json",
    );
    const legacyBrainPath = path.join(
      dataRoot,
      "projects",
      "my-first-test-project",
      ".brain",
    );

    expect(await readFile(studyStatePath, "utf-8")).toContain('"legacyProjectSlug": "my-first-test-project"');
    await expect(readFile(legacyBrainPath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    __setProjectRepositoryOverride(null);
  });

  it("creates a project from the handle persisted by setup without requiring a restart", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const createdRecords: Array<ProjectRecord & { createdBy?: string }> = [];
    const fakeRepository: ProjectRepository = {
      async list() {
        return createdRecords;
      },
      async get(slug) {
        return createdRecords.find((record) => record.slug === slug) ?? null;
      },
      async create(input) {
        const now = "2026-04-16T00:00:00.000Z";
        const record: ProjectRecord & { createdBy?: string } = {
          slug: "saved-env-project",
          name: input.name,
          description: input.description ?? "New project",
          createdAt: now,
          lastActive: now,
          status: "active",
          projectPageSlug: "saved-env-project",
          createdBy: input.createdBy,
        };
        createdRecords.push(record);
        return record;
      },
      async delete() {
        return { ok: true, existed: true };
      },
      async touch() {},
    };
    __setProjectRepositoryOverride(fakeRepository);
    delete process.env.SCIENCESWARM_USER_HANDLE;
    await writeFile(
      path.join(dataRoot, ".env"),
      "SCIENCESWARM_USER_HANDLE=@persisted-after-setup\n",
    );
    process.chdir(dataRoot);

    const response = await POST(buildCreateRequest({
      action: "create",
      name: "Saved Env Project",
    }));

    expect(response.status).toBe(200);
    expect(createdRecords).toHaveLength(1);
    expect(createdRecords[0]?.createdBy).toBe("@persisted-after-setup");
  });

  it("returns the project-specific path when materialization fails", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const fakeRepository: ProjectRepository = {
      async list() {
        return [];
      },
      async get() {
        return null;
      },
      async create(input) {
        const now = "2026-04-16T00:00:00.000Z";
        return {
          slug: "blocked-project",
          name: input.name,
          description: input.description ?? "New project",
          createdAt: now,
          lastActive: now,
          status: "active",
          projectPageSlug: "blocked-project",
        };
      },
      async delete() {
        return { ok: true, existed: true };
      },
      async touch() {},
    };
    __setProjectRepositoryOverride(fakeRepository);
    await writeFile(path.join(dataRoot, "projects"), "not a directory");

    const response = await POST(buildCreateRequest({
      action: "create",
      name: "Blocked Project",
    }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.materialized).toBe(false);
    expect(data.path).toBe(path.join(dataRoot, "projects", "blocked-project"));
    expect(data.materializationError).toContain("not a directory");
  });

  it("creates a disk-backed project when the gbrain repository is unavailable", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const unavailable = new Error("Brain backend unavailable");
    unavailable.name = "BrainBackendUnavailableError";
    const fakeRepository: ProjectRepository = {
      async list() {
        throw unavailable;
      },
      async get() {
        return null;
      },
      async create() {
        throw unavailable;
      },
      async delete() {
        return { ok: true, existed: true };
      },
      async touch() {},
    };
    __setProjectRepositoryOverride(fakeRepository);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const response = await POST(buildCreateRequest({
        action: "create",
        name: "Disk Fallback Project",
        description: "Keep onboarding usable when gbrain is degraded.",
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.persistence).toBe("disk-fallback");
      expect(data.persistenceWarning).toBe("Brain backend unavailable");
      expect(data.persistenceRecoveryWarning).toContain(
        "duplicate checks were limited to disk",
      );
      expect(data.project).toEqual(
        expect.objectContaining({
          slug: "disk-fallback-project",
          name: "Disk Fallback Project",
          description: "Keep onboarding usable when gbrain is degraded.",
        }),
      );
      expect(await readFile(
        path.join(dataRoot, "projects", "disk-fallback-project", "project.json"),
        "utf-8",
      )).toContain("Keep onboarding usable when gbrain is degraded.");
      expect(warn).toHaveBeenCalledWith(
        "[projects] repository create failed; falling back to disk:",
        unavailable,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("fails disk-fallback creation when the project cannot be saved to disk", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const unavailable = new Error("Brain backend unavailable");
    unavailable.name = "BrainBackendUnavailableError";
    const fakeRepository: ProjectRepository = {
      async list() {
        throw unavailable;
      },
      async get() {
        return null;
      },
      async create() {
        throw unavailable;
      },
      async delete() {
        return { ok: true, existed: true };
      },
      async touch() {},
    };
    __setProjectRepositoryOverride(fakeRepository);
    await writeFile(path.join(dataRoot, "projects"), "not a directory");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const response = await POST(buildCreateRequest({
        action: "create",
        name: "Unwritable Disk Fallback",
      }));

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe(
        "Project could not be saved to disk while gbrain was unavailable.",
      );
      expect(data.persistence).toBe("disk-fallback");
      expect(data.materialized).toBe(false);
      expect(data.materializationError).toContain("not a directory");
      expect(data.path).toBe(
        path.join(dataRoot, "projects", "unwritable-disk-fallback"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not recurse forever when repository errors have circular causes", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const circular = new Error("wrapped unavailable");
    (circular as Error & { cause?: unknown }).cause = circular;
    const fakeRepository: ProjectRepository = {
      async list() {
        return [];
      },
      async get() {
        return null;
      },
      async create() {
        throw circular;
      },
      async delete() {
        return { ok: true, existed: true };
      },
      async touch() {},
    };
    __setProjectRepositoryOverride(fakeRepository);

    const response = await POST(buildCreateRequest({
      action: "create",
      name: "Circular Cause Project",
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Error: wrapped unavailable",
    });
  });

  it.each(["archive", "delete"] as const)(
    "archives the project record and preserves local files for %s requests",
    async (action) => {
      const { POST } = await import("@/app/api/projects/route");
      const fakeRepository: ProjectRepository = {
        async list() {
          return [];
        },
        async get() {
          return null;
        },
        async create() {
          throw new Error("not implemented");
        },
        async delete() {
          return { ok: true, existed: true };
        },
        async touch() {},
      };
      __setProjectRepositoryOverride(fakeRepository);
      const projectDir = path.join(dataRoot, "projects", "project-alpha");
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, "paper.pdf"), "keep this local copy");

      const response = await POST(buildCreateRequest({
        action,
        projectId: "project-alpha",
      }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        existed: true,
      });
      await expect(readFile(path.join(projectDir, "paper.pdf"), "utf-8")).resolves.toBe(
        "keep this local copy",
      );
    },
  );

  it("archives the disk compatibility manifest when gbrain is unavailable", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const unavailable = new Error("Brain backend unavailable");
    unavailable.name = "BrainBackendUnavailableError";
    const fakeRepository: ProjectRepository = {
      async list() {
        return [];
      },
      async get() {
        return null;
      },
      async create() {
        throw new Error("not implemented");
      },
      async delete() {
        throw unavailable;
      },
      async touch() {},
    };
    __setProjectRepositoryOverride(fakeRepository);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectDir = path.join(dataRoot, "projects", "disk-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "project.json"),
      JSON.stringify(
        {
          slug: "disk-project",
          name: "Disk Project",
          description: "Disk-backed project",
          createdAt: "2026-04-16T00:00:00.000Z",
          lastActive: "2026-04-17T00:00:00.000Z",
          status: "active",
        },
        null,
        2,
      ),
    );
    await writeFile(path.join(projectDir, "paper.pdf"), "keep this local copy");

    try {
      const response = await POST(buildCreateRequest({
        action: "archive",
        projectId: "disk-project",
      }));

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(
        expect.objectContaining({
          ok: true,
          existed: true,
          existedOnDisk: true,
          mayExistInGbrain: true,
          persistence: "disk-fallback",
          persistenceWarning: "Brain backend unavailable",
        }),
      );
      expect(data.persistenceRecoveryWarning).toContain(
        "local project compatibility manifest was archived",
      );
      const diskMeta = JSON.parse(
        await readFile(path.join(projectDir, "project.json"), "utf-8"),
      );
      expect(diskMeta.status).toBe("archived");
      await expect(readFile(path.join(projectDir, "paper.pdf"), "utf-8")).resolves.toBe(
        "keep this local copy",
      );
      expect(warn).toHaveBeenCalledWith(
        "[projects] repository archive failed; falling back to disk:",
        unavailable,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("marks disk-fallback archive existence unknown when no local manifest exists", async () => {
    const { POST } = await import("@/app/api/projects/route");
    const unavailable = new Error("Brain backend unavailable");
    unavailable.name = "BrainBackendUnavailableError";
    const fakeRepository: ProjectRepository = {
      async list() {
        return [];
      },
      async get() {
        return null;
      },
      async create() {
        throw new Error("not implemented");
      },
      async delete() {
        throw unavailable;
      },
      async touch() {},
    };
    __setProjectRepositoryOverride(fakeRepository);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const response = await POST(buildCreateRequest({
        action: "archive",
        projectId: "gbrain-only-project",
      }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          ok: true,
          existed: null,
          existedOnDisk: false,
          mayExistInGbrain: true,
          persistence: "disk-fallback",
          persistenceWarning: "Brain backend unavailable",
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GET /api/projects", () => {
  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-project-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@project-route-test";
  });

  afterEach(async () => {
    __setProjectRepositoryOverride(null);
    process.chdir(originalCwd);
    delete process.env.SCIENCESWARM_DIR;
    delete process.env.SCIENCESWARM_USER_HANDLE;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("falls back to canonical on-disk project folders when the gbrain list fails", async () => {
    const { GET } = await import("@/app/api/projects/route");
    const fakeRepository: ProjectRepository = {
      async list() {
        throw new Error("Brain backend unavailable");
      },
      async get() {
        return null;
      },
      async create() {
        throw new Error("not implemented");
      },
      async delete() {
        return { ok: true, existed: true };
      },
      async touch() {},
    };
    __setProjectRepositoryOverride(fakeRepository);

    await mkdir(path.join(dataRoot, "projects", "papers", ".brain", "state"), {
      recursive: true,
    });
    await writeFile(
      path.join(dataRoot, "projects", "papers", ".brain", "state", "manifest.json"),
      "{}",
    );

    await mkdir(path.join(dataRoot, "projects", "project-alpha"), {
      recursive: true,
    });
    await writeFile(
      path.join(dataRoot, "projects", "project-alpha", "project.json"),
      JSON.stringify({
        id: "project-alpha",
        slug: "project-alpha",
        name: "Project Alpha",
        description: "Track alpha updates.",
        createdAt: "2026-04-16T00:00:00.000Z",
        lastActive: "2026-04-18T00:00:00.000Z",
        status: "idle",
      }),
    );

    await mkdir(path.join(dataRoot, "projects", "Research Papers"), {
      recursive: true,
    });
    await writeFile(
      path.join(dataRoot, "projects", "Research Papers", "project.json"),
      JSON.stringify({
        id: "Research Papers",
        name: "Research Papers",
      }),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const response = await GET();

      expect(response.status).toBe(200);
      const data = await response.json() as { projects: Array<Record<string, unknown>> };
      expect(data.projects).toHaveLength(2);
      expect(data.projects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            slug: "papers",
            name: "Papers",
            description: "",
            status: "active",
          }),
          expect.objectContaining({
            slug: "project-alpha",
            name: "Project Alpha",
            description: "Track alpha updates.",
            status: "idle",
          }),
        ]),
      );
      expect(data.projects.find((project) => project.slug === "Research Papers")).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "[projects] repository list failed; falling back to disk:",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to disk when the gbrain-backed list stalls", async () => {
    vi.useFakeTimers();
    const { GET } = await import("@/app/api/projects/route");
    const fakeRepository: ProjectRepository = {
      async list() {
        return await new Promise<never>(() => {});
      },
      async get() {
        return null;
      },
      async create() {
        throw new Error("not implemented");
      },
      async delete() {
        return { ok: true, existed: true };
      },
      async touch() {},
    };
    __setProjectRepositoryOverride(fakeRepository);

    await mkdir(path.join(dataRoot, "projects", "papers", ".brain", "state"), {
      recursive: true,
    });
    await writeFile(
      path.join(dataRoot, "projects", "papers", ".brain", "state", "manifest.json"),
      "{}",
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const responsePromise = GET();
      await vi.advanceTimersByTimeAsync(1_500);
      const response = await responsePromise;

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        projects: [
          expect.objectContaining({
            slug: "papers",
            name: "Papers",
          }),
        ],
      });
      expect(warn).toHaveBeenCalledWith(
        "[projects] repository list failed; falling back to disk:",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
