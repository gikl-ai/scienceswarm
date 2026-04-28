import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StudyRecord } from "@/brain/gbrain-data-contracts";
import type { StudyRepository } from "@/lib/studies/study-repository";
import { __setStudyRepositoryOverride } from "@/lib/testing/studies-route-overrides";

let dataRoot: string;
const originalCwd = process.cwd();

function buildCreateRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/studies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/studies", () => {
  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-study-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@study-route-test";
  });

  afterEach(async () => {
    __setStudyRepositoryOverride(null);
    process.chdir(originalCwd);
    delete process.env.SCIENCESWARM_DIR;
    delete process.env.SCIENCESWARM_USER_HANDLE;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("creates a Study, writes canonical Study state, and keeps a legacy project shell", async () => {
    const { POST } = await import("@/app/api/studies/route");
    const createdRecords: StudyRecord[] = [];
    const fakeRepository: StudyRepository = {
      async list() {
        return createdRecords;
      },
      async get(slug) {
        return createdRecords.find((record) => record.slug === slug) ?? null;
      },
      async create(input) {
        const now = "2026-04-16T00:00:00.000Z";
        const record: StudyRecord = {
          slug: "my-first-test-study",
          name: input.name,
          description: input.description ?? "New study",
          createdAt: now,
          lastActive: now,
          status: "active",
          studyPageSlug: "my-first-test-study",
          legacyProjectSlug: "my-first-test-study",
        };
        createdRecords.push(record);
        return record;
      },
      async delete() {
        return { ok: true, existed: true };
      },
      async touch() {},
    };
    __setStudyRepositoryOverride(fakeRepository);

    const response = await POST(buildCreateRequest({
      action: "create",
      name: "my_first_test_study",
      description: "Track frontier AI updates.",
    }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.study).toEqual(
      expect.objectContaining({
        id: "study_my-first-test-study",
        slug: "my-first-test-study",
        legacyProjectSlug: "my-first-test-study",
      }),
    );
    expect(data.normalization).toEqual({
      requestedName: "my_first_test_study",
      slug: "my-first-test-study",
      changed: true,
    });
    await expect(readFile(
      path.join(dataRoot, "projects", "my-first-test-study", "study.json"),
      "utf-8",
    )).resolves.toContain('"studyId": "study_my-first-test-study"');
    await expect(readFile(
      path.join(dataRoot, "projects", "my-first-test-study", "project.json"),
      "utf-8",
    )).resolves.toContain('"canonicalType": "study"');
    await expect(readFile(
      path.join(dataRoot, "state", "studies", "study_my-first-test-study", "study.json"),
      "utf-8",
    )).resolves.toContain('"legacyProjectSlug": "my-first-test-study"');
  });

  it("archives by canonical studyId while preserving local files", async () => {
    const { POST } = await import("@/app/api/studies/route");
    const fakeRepository: StudyRepository = {
      async list() {
        return [];
      },
      async get() {
        return null;
      },
      async create() {
        throw new Error("not implemented");
      },
      async delete(slug) {
        expect(slug).toBe("study-alpha");
        return { ok: true, existed: true };
      },
      async touch() {},
    };
    __setStudyRepositoryOverride(fakeRepository);
    const studyDir = path.join(dataRoot, "projects", "study-alpha");
    await mkdir(studyDir, { recursive: true });
    await writeFile(path.join(studyDir, "paper.pdf"), "keep this local copy");

    const response = await POST(buildCreateRequest({
      action: "archive",
      studyId: "study_study-alpha",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      existed: true,
    });
    await expect(readFile(path.join(studyDir, "paper.pdf"), "utf-8")).resolves.toBe(
      "keep this local copy",
    );
  });
});

describe("GET /api/studies", () => {
  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-study-route-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    process.env.SCIENCESWARM_USER_HANDLE = "@study-route-test";
  });

  afterEach(async () => {
    __setStudyRepositoryOverride(null);
    process.chdir(originalCwd);
    delete process.env.SCIENCESWARM_DIR;
    delete process.env.SCIENCESWARM_USER_HANDLE;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("returns canonical study metadata", async () => {
    const { GET } = await import("@/app/api/studies/route");
    const fakeRepository: StudyRepository = {
      async list() {
        return [
          {
            slug: "study-alpha",
            name: "Study Alpha",
            description: "Track alpha updates.",
            createdAt: "2026-04-16T00:00:00.000Z",
            lastActive: "2026-04-18T00:00:00.000Z",
            status: "active",
            studyPageSlug: "study-alpha",
            legacyProjectSlug: "study-alpha",
          },
        ];
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
    __setStudyRepositoryOverride(fakeRepository);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      studies: [
        expect.objectContaining({
          id: "study_study-alpha",
          slug: "study-alpha",
          name: "Study Alpha",
          legacyProjectSlug: "study-alpha",
        }),
      ],
    });
  });
});
