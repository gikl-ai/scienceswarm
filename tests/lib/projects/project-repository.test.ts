import { describe, expect, it } from "vitest";
import type { BrainPage, BrainStore, ImportResult } from "@/brain/store";
import type { GbrainClient } from "@/brain/gbrain-client";
import type { ContentType } from "@/brain/types";
import {
  createProjectRepository,
  DuplicateProjectError,
} from "@/lib/projects/project-repository";

class FakeStore implements BrainStore {
  pages = new Map<string, BrainPage>();
  lastListFilters: { limit?: number; type?: ContentType } | undefined;
  async search() {
    return [];
  }
  async getPage(slug: string): Promise<BrainPage | null> {
    return this.pages.get(slug) ?? null;
  }
  async getTimeline() {
    return [];
  }
  async getLinks() {
    return [];
  }
  async getBacklinks() {
    return [];
  }
  async listPages(filters?: { limit?: number; type?: ContentType }) {
    this.lastListFilters = filters;
    let pages = Array.from(this.pages.values());
    if (filters?.type) {
      pages = pages.filter((page) => page.frontmatter.type === filters.type);
    }
    return pages.slice(0, filters?.limit);
  }
  async importCorpus(_dirPath: string): Promise<ImportResult> {
    throw new Error("not implemented");
  }
  async health() {
    return { ok: true, pageCount: this.pages.size };
  }
  async dispose() {}
}

class FakeClient implements GbrainClient {
  constructor(private readonly store: FakeStore) {}
  async putPage(slug: string, content: string) {
    const type = content.match(/^type: (.+)$/m)?.[1]?.trim() ?? "project";
    const title = content.match(/^title: (.+)$/m)?.[1]?.replace(/^"|"$/g, "").trim() ?? slug;
    const project = content.match(/^project: (.+)$/m)?.[1]?.trim() ?? slug;
    const status = content.match(/^status: (.+)$/m)?.[1]?.trim() ?? "active";
    const description = content.match(/^description: (.+)$/m)?.[1]?.trim() ?? "New project";
    const createdAt = content.match(/^created_at: (.+)$/m)?.[1]?.trim() ?? "2026-04-16T00:00:00.000Z";
    const lastActive = content.match(/^last_active: (.+)$/m)?.[1]?.trim() ?? createdAt;
    this.store.pages.set(slug, {
      path: slug,
      title,
      type: "project",
      content,
      frontmatter: {
        type,
        title,
        project,
        description,
        created_at: createdAt,
        last_active: lastActive,
        status,
      },
    });
    return { stdout: "ok", stderr: "" };
  }
  async linkPages() {
    return { stdout: "ok", stderr: "" };
  }
}

describe("ProjectRepository", () => {
  it("creates and lists gbrain-backed project records", async () => {
    const store = new FakeStore();
    const repo = createProjectRepository({
      store,
      client: new FakeClient(store),
      now: () => new Date("2026-04-16T00:00:00.000Z"),
    });
    const created = await repo.create({
      name: "Project Alpha",
      description: "Alpha work",
      createdBy: "@tester",
    });
    expect(created.slug).toBe("project-alpha");
    store.pages.set("paper-one", {
      path: "paper-one",
      title: "Paper One",
      type: "paper",
      content: "# Paper One",
      frontmatter: { type: "paper" },
    });
    expect(await repo.get("project-alpha")).toMatchObject({
      slug: "project-alpha",
      name: "Project Alpha",
      description: "Alpha work",
      status: "active",
    });
    expect(await repo.list()).toHaveLength(1);
    expect(store.lastListFilters).toEqual({ type: "project", limit: 5000 });
  });

  it("preserves an explicitly provided safe slug", async () => {
    const store = new FakeStore();
    const repo = createProjectRepository({
      store,
      client: new FakeClient(store),
      now: () => new Date("2026-04-16T00:00:00.000Z"),
    });

    const created = await repo.create({
      name: "Alpha Beta",
      slug: "alpha--beta",
      createdBy: "@tester",
    });

    expect(created.slug).toBe("alpha--beta");
    expect(await repo.get("alpha--beta")).toMatchObject({
      slug: "alpha--beta",
      name: "Alpha Beta",
    });
  });

  it("rejects duplicate projects before materialization", async () => {
    const store = new FakeStore();
    const repo = createProjectRepository({
      store,
      client: new FakeClient(store),
    });
    await repo.create({ name: "Project Alpha", createdBy: "@tester" });
    await expect(
      repo.create({ name: "Project Alpha", createdBy: "@tester" }),
    ).rejects.toBeInstanceOf(DuplicateProjectError);
  });

  it("rejects create when a non-project page already uses the slug", async () => {
    const store = new FakeStore();
    const repo = createProjectRepository({
      store,
      client: new FakeClient(store),
    });
    store.pages.set("project-alpha", {
      path: "project-alpha",
      title: "Paper Alpha",
      type: "paper",
      content: "# Paper Alpha",
      frontmatter: {
        type: "paper",
        project: "project-alpha",
      },
    });

    await expect(
      repo.create({ name: "Project Alpha", createdBy: "@tester" }),
    ).rejects.toBeInstanceOf(DuplicateProjectError);
    expect(store.pages.get("project-alpha")).toMatchObject({
      type: "paper",
      title: "Paper Alpha",
    });
  });

  it("rejects create when an imported project page already owns the slug", async () => {
    const store = new FakeStore();
    const repo = createProjectRepository({
      store,
      client: new FakeClient(store),
    });
    store.pages.set("projects/project-alpha", {
      path: "projects/project-alpha.md",
      title: "Project Alpha",
      type: "project",
      content: "# Project Alpha\n\n## Summary\nImported project",
      frontmatter: {
        type: "project",
        title: "Project Alpha",
        project: "project-alpha",
        description: "Imported project",
        created_at: "2026-04-15T00:00:00.000Z",
        last_active: "2026-04-15T00:00:00.000Z",
        status: "active",
      },
    });

    await expect(
      repo.create({ name: "Project Alpha", createdBy: "@tester" }),
    ).rejects.toBeInstanceOf(DuplicateProjectError);
    await expect(repo.get("project-alpha")).resolves.toMatchObject({
      slug: "project-alpha",
      description: "Imported project",
      projectPageSlug: "projects/project-alpha",
    });
  });

  it("deduplicates multiple active project pages with the same project slug", async () => {
    const store = new FakeStore();
    const repo = createProjectRepository({
      store,
      client: new FakeClient(store),
    });
    store.pages.set("projects/project-alpha", {
      path: "projects/project-alpha.md",
      title: "Project Alpha",
      type: "project",
      content: "# Project Alpha\n\n## Summary\nImported project",
      frontmatter: {
        type: "project",
        title: "Project Alpha",
        project: "project-alpha",
        description: "Imported project",
        created_at: "2026-04-15T00:00:00.000Z",
        last_active: "2026-04-15T00:00:00.000Z",
        status: "active",
      },
    });
    store.pages.set("project-alpha", {
      path: "project-alpha",
      title: "Project Alpha",
      type: "project",
      content: "# Project Alpha\n\n## Summary\nManual project",
      frontmatter: {
        type: "project",
        title: "Project Alpha",
        project: "project-alpha",
        description: "Manual project",
        created_at: "2026-04-16T00:00:00.000Z",
        last_active: "2026-04-16T00:00:00.000Z",
        status: "active",
      },
    });

    await expect(repo.list()).resolves.toEqual([
      expect.objectContaining({
        slug: "project-alpha",
        description: "Manual project",
      }),
    ]);
  });

  it("serializes concurrent duplicate project creates", async () => {
    const store = new FakeStore();
    const repo = createProjectRepository({
      store,
      client: new FakeClient(store),
    });

    const results = await Promise.allSettled([
      repo.create({ name: "Project Alpha", createdBy: "@tester" }),
      repo.create({ name: "Project Alpha", createdBy: "@tester" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.reason).toBeInstanceOf(DuplicateProjectError);
    expect(await repo.list()).toHaveLength(1);
  });

  it("archives deleted projects and omits them from list", async () => {
    const store = new FakeStore();
    const repo = createProjectRepository({
      store,
      client: new FakeClient(store),
    });
    await repo.create({ name: "Project Alpha", createdBy: "@tester" });
    await expect(repo.delete("project-alpha")).resolves.toEqual({
      ok: true,
      existed: true,
    });
    expect(await repo.get("project-alpha")).toMatchObject({ status: "archived" });
    expect(await repo.list()).toEqual([]);
  });

  it("versions recreated project names after the prior project is archived", async () => {
    const store = new FakeStore();
    const repo = createProjectRepository({
      store,
      client: new FakeClient(store),
    });
    await repo.create({ name: "Project Alpha", createdBy: "@tester" });
    await repo.delete("project-alpha");

    await expect(
      repo.create({ name: "Project Alpha", createdBy: "@tester" }),
    ).resolves.toMatchObject({
      slug: "project-alpha-2",
      name: "Project Alpha-2",
      status: "active",
    });
    expect(await repo.get("project-alpha")).toMatchObject({ status: "archived" });
    expect(await repo.get("project-alpha-2")).toMatchObject({ status: "active" });
  });
});
