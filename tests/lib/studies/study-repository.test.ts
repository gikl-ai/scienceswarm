import { describe, expect, it } from "vitest";
import type { BrainPage, BrainStore, ImportResult } from "@/brain/store";
import type { GbrainClient } from "@/brain/gbrain-client";
import type { ContentType } from "@/brain/types";
import {
  createStudyRepository,
  DuplicateStudyError,
} from "@/lib/studies/study-repository";

class FakeStore implements BrainStore {
  pages = new Map<string, BrainPage>();
  writes = new Map<string, string>();

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
    this.store.writes.set(slug, content);
    const type = content.match(/^type: (.+)$/m)?.[1]?.trim() ?? "study";
    const title = content.match(/^title: (.+)$/m)?.[1]?.replace(/^"|"$/g, "").trim() ?? slug;
    const study = content.match(/^study: (.+)$/m)?.[1]?.trim() ?? slug;
    const legacyProjectSlug = content.match(/^legacy_project_slug: (.+)$/m)?.[1]?.trim();
    const description = content.match(/^description: (.+)$/m)?.[1]?.trim() ?? "New study";
    const createdAt = content.match(/^created_at: (.+)$/m)?.[1]?.trim() ?? "2026-04-16T00:00:00.000Z";
    const lastActive = content.match(/^last_active: (.+)$/m)?.[1]?.trim() ?? createdAt;
    const status = content.match(/^status: (.+)$/m)?.[1]?.trim() ?? "active";
    this.store.pages.set(slug, {
      path: slug,
      title,
      type: type as ContentType,
      content,
      frontmatter: {
        type,
        title,
        study,
        study_slug: study,
        legacy_project_slug: legacyProjectSlug,
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

describe("StudyRepository", () => {
  it("creates canonical study pages with Study frontmatter", async () => {
    const store = new FakeStore();
    const repo = createStudyRepository({
      store,
      client: new FakeClient(store),
      now: () => new Date("2026-04-16T00:00:00.000Z"),
    });

    const created = await repo.create({
      name: "Study Alpha",
      description: "Alpha work",
      createdBy: "@tester",
    });

    expect(created).toMatchObject({
      slug: "study-alpha",
      name: "Study Alpha",
      studyPageSlug: "study-alpha",
      legacyProjectSlug: "study-alpha",
    });
    expect(store.writes.get("study-alpha")).toContain("type: study");
    expect(store.writes.get("study-alpha")).toContain("study_slug: study-alpha");
    await expect(repo.list()).resolves.toEqual([
      expect.objectContaining({
        slug: "study-alpha",
        description: "Alpha work",
      }),
    ]);
  });

  it("lists legacy project pages as compatibility studies", async () => {
    const store = new FakeStore();
    const repo = createStudyRepository({ store, client: new FakeClient(store) });
    store.pages.set("projects/legacy-alpha", {
      path: "projects/legacy-alpha.md",
      title: "Legacy Alpha",
      type: "project",
      content: "# Legacy Alpha\n\n## Summary\nImported project",
      frontmatter: {
        type: "project",
        title: "Legacy Alpha",
        project: "legacy-alpha",
        description: "Imported project",
        created_at: "2026-04-15T00:00:00.000Z",
        last_active: "2026-04-15T00:00:00.000Z",
        status: "active",
      },
    });

    await expect(repo.list()).resolves.toEqual([
      expect.objectContaining({
        slug: "legacy-alpha",
        legacyProjectSlug: "legacy-alpha",
        studyPageSlug: "projects/legacy-alpha",
      }),
    ]);
  });

  it("rejects creating a study over an active legacy project slug", async () => {
    const store = new FakeStore();
    const repo = createStudyRepository({ store, client: new FakeClient(store) });
    store.pages.set("projects/study-alpha", {
      path: "projects/study-alpha.md",
      title: "Study Alpha",
      type: "project",
      content: "# Study Alpha",
      frontmatter: {
        type: "project",
        title: "Study Alpha",
        project: "study-alpha",
        status: "active",
      },
    });

    await expect(
      repo.create({ name: "Study Alpha", createdBy: "@tester" }),
    ).rejects.toBeInstanceOf(DuplicateStudyError);
  });

  it("versions new studies instead of reusing an archived study slug", async () => {
    const store = new FakeStore();
    const repo = createStudyRepository({
      store,
      client: new FakeClient(store),
      now: () => new Date("2026-04-16T00:00:00.000Z"),
    });

    await repo.create({ name: "Test", createdBy: "@tester" });
    await repo.delete("test");

    const recreated = await repo.create({ name: "Test", createdBy: "@tester" });

    expect(recreated).toMatchObject({
      slug: "test-2",
      name: "Test-2",
      legacyProjectSlug: "test-2",
      status: "active",
    });
    expect(await repo.get("test")).toMatchObject({ status: "archived" });
    expect(await repo.get("test-2")).toMatchObject({ status: "active" });
    expect(store.writes.get("test-2")).toContain("study_slug: test-2");
  });

  it("skips already-used versioned names after archived studies", async () => {
    const store = new FakeStore();
    const repo = createStudyRepository({
      store,
      client: new FakeClient(store),
      now: () => new Date("2026-04-16T00:00:00.000Z"),
    });

    await repo.create({ name: "Test", createdBy: "@tester" });
    await repo.delete("test");
    await repo.create({ name: "Test-2", createdBy: "@tester" });

    await expect(
      repo.create({ name: "Test", createdBy: "@tester" }),
    ).resolves.toMatchObject({
      slug: "test-3",
      name: "Test-3",
      status: "active",
    });
  });
});
