import path from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGbrainFileStore,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";
import type { GbrainFileObject } from "@/brain/gbrain-data-contracts";
import { __setWorkspaceFileStoreOverride } from "@/lib/testing/workspace-route-overrides";

const ROOT = path.join(tmpdir(), "scienceswarm-api-workspace-local-override");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = ROOT;
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  if (ORIGINAL_SCIENCESWARM_DIR !== undefined) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
  __setWorkspaceFileStoreOverride(null);
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@/brain/store");
});

async function importRoute() {
  return await import("@/app/api/workspace/route");
}

function mockGbrainPages(pagesByType: Record<string, unknown[]>): void {
  const allPages = Object.values(pagesByType).flat() as Array<{
    path?: string;
  }>;
  const listPages = vi.fn(async (filters?: { type?: string; limit?: number }) => {
    if (!filters?.type) {
      return allPages;
    }
    return pagesByType[filters.type] ?? [];
  });
  const getPage = vi.fn(async (pagePath: string) =>
    allPages.find((page) => page.path === pagePath) ?? null,
  );
  vi.doMock("@/brain/store", () => ({
    ensureBrainStoreReady: vi.fn(async () => {}),
    getBrainStore: vi.fn(() => ({ listPages, getPage })),
  }));
}

async function seedWorkspaceFileObject(
  fileStore: GbrainFileStore,
  project: string,
  name: string,
  bytes: Buffer,
  mime = "text/plain",
): Promise<GbrainFileObject> {
  return fileStore.putObject({
    project,
    filename: name,
    mime,
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
    uploadedBy: "@tester",
    maxBytes: 1024 * 1024,
    source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
  });
}

describe("workspace local override precedence", () => {
  it("prefers locally edited project files over imported gbrain objects on reload", async () => {
    const projectId = "test-project";
    const fileStore = createGbrainFileStore({ brainRoot: path.join(ROOT, "brain") });
    const gbrainObject = await seedWorkspaceFileObject(
      fileStore,
      projectId,
      "docs/design.txt",
      Buffer.from("original imported design memo\n", "utf-8"),
    );

    mockGbrainPages({
      note: [
        {
          path: "design-note",
          title: "Design Note",
          type: "note",
          content: "# Design Note\n\nImported source page",
          frontmatter: {
            type: "note",
            project: projectId,
            file_refs: [
              {
                role: "source",
                fileObjectId: gbrainObject.id,
                sha256: gbrainObject.sha256,
                filename: "docs/design.txt",
                mime: gbrainObject.mime,
                sizeBytes: gbrainObject.sizeBytes,
              },
            ],
          },
        },
      ],
    });

    __setWorkspaceFileStoreOverride(fileStore);
    const { GET, POST } = await importRoute();

    const writeRes = await POST(
      new Request("http://localhost/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write-file",
          projectId,
          file: "docs/design.txt",
          content: "revised local design memo\nwith stronger controls\n",
        }),
      }),
    );
    expect(writeRes.status).toBe(200);

    const fileRes = await GET(
      new Request(`http://localhost/api/workspace?action=file&projectId=${projectId}&file=docs/design.txt`),
    );
    expect(fileRes.status).toBe(200);
    await expect(fileRes.json()).resolves.toMatchObject({
      content: "revised local design memo\nwith stronger controls\n",
    });

    const syncRes = await POST(
      new Request("http://localhost/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "check-changes",
          projectId,
        }),
      }),
    );
    expect(syncRes.status).toBe(200);

    const readRes = await GET(
      new Request(`http://localhost/api/workspace?action=read&projectId=${projectId}&file=docs/design.txt`),
    );
    expect(readRes.status).toBe(200);
    await expect(readRes.json()).resolves.toMatchObject({
      content: "revised local design memo\nwith stronger controls\n",
    });

    expect(
      readFileSync(path.join(ROOT, "projects", projectId, "docs", "design.txt"), "utf-8"),
    ).toBe("revised local design memo\nwith stronger controls\n");
  });
});
