import path from "node:path";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  createGbrainFileStore,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";
import type { GbrainFileObject } from "@/brain/gbrain-data-contracts";
import { computeFileFingerprintSync } from "@/lib/import/file-fingerprint";
import { __setWorkspaceFileStoreOverride } from "@/lib/testing/workspace-route-overrides";
import { hashContent } from "@/lib/workspace-manager";

const ROOT = path.join(tmpdir(), "scienceswarm-api-workspace");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = ROOT;
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  // Use undefined check (not truthy) so an empty-string original env value
  // round-trips correctly instead of being deleted across tests.
  if (ORIGINAL_SCIENCESWARM_DIR !== undefined) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
  __setWorkspaceFileStoreOverride(null);
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@/brain/store");
  vi.doUnmock("@/lib/state/legacy-import-repair");
  vi.doUnmock("@/lib/file-parser");
});

// Import after env stub so the module-level path helpers resolve under ROOT.
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

function writeSparseLargeFile(filePath: string, size: number, label: string): void {
  const fd = openSync(filePath, "w");
  const writes = [
    { offset: 0, value: `${label}-start` },
    { offset: Math.max(0, Math.floor((size - `${label}-middle`.length) / 2)), value: `${label}-middle` },
    { offset: Math.max(0, size - `${label}-end`.length), value: `${label}-end` },
  ];

  try {
    ftruncateSync(fd, size);
    writes.forEach(({ offset, value }) => {
      const buffer = Buffer.from(value, "utf-8");
      writeSync(fd, buffer, 0, buffer.length, offset);
    });
  } finally {
    closeSync(fd);
  }
}

describe("GET /api/workspace?action=tree", () => {
  it("returns files from the per-project directory when projectId is supplied", async () => {
    // Seed a legacy-style project layout under ~/.scienceswarm/projects/<slug>/
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    mkdirSync(path.join(projectDir, "code"), { recursive: true });
    writeFileSync(path.join(projectDir, "papers", "intro.pdf"), "%PDF-1.4 fake");
    writeFileSync(path.join(projectDir, "code", "main.py"), "print('hi')");

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${projectId}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toBeDefined();

    const folderNames = (body.tree as Array<{ name: string; type: string }>).map((n) => n.name);
    expect(folderNames).toContain("papers");
    expect(folderNames).toContain("code");
  });

  it("hides internal brain state and repairs flat imported PDFs into papers", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(path.join(projectDir, ".brain", "state"), { recursive: true });
    writeFileSync(path.join(projectDir, ".brain", "state", "chat.json"), "{}");
    writeFileSync(path.join(projectDir, "hubble-1929.pdf"), "%PDF-1.4 fake");
    writeFileSync(
      path.join(projectDir, ".references.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            originalPath: "/source/hubble-1929.pdf",
            workspacePath: "hubble-1929.pdf",
            hash: hashContent(Buffer.from("%PDF-1.4 fake")),
            type: "pdf",
            size: 13,
            importedAt: "2026-04-16T00:00:00.000Z",
          },
        ],
      }, null, 2),
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${projectId}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      tree: Array<{ name: string; children?: Array<{ name: string }> }>;
    };
    expect(body.tree.map((node) => node.name)).not.toContain(".brain");
    const papersDir = body.tree.find((node) => node.name === "papers");
    expect(papersDir?.children?.map((child) => child.name)).toContain("hubble-1929.pdf");
    expect(existsSync(path.join(projectDir, "papers", "hubble-1929.pdf"))).toBe(true);

    const refs = JSON.parse(readFileSync(path.join(projectDir, ".references.json"), "utf-8")) as {
      files: Array<{ workspacePath: string; type: string }>;
    };
    expect(refs.files).toEqual([
      expect.objectContaining({ workspacePath: "papers/hubble-1929.pdf", type: "papers" }),
    ]);
  });

  it("returns the empty global workspace when no projectId is supplied", async () => {
    // Seed a project that should NOT be visible without projectId scoping.
    const projectDir = path.join(ROOT, "projects", "hidden-project");
    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    writeFileSync(path.join(projectDir, "papers", "secret.pdf"), "%PDF-1.4 fake");

    const { GET } = await importRoute();
    const res = await GET(new Request("http://localhost/api/workspace?action=tree"));

    expect(res.status).toBe(200);
    const body = await res.json();
    // The global workspace root is empty, so the per-project files must not leak.
    const folderNames = (body.tree as Array<{ name: string }>).map((n) => n.name);
    expect(folderNames).not.toContain("papers");
  });

  it("does not create a project directory as a side effect of reads", async () => {
    // Reading the tree for a slug that doesn't exist on disk should return
    // an empty tree, NOT silently mkdir ~/.scienceswarm/projects/<slug>/.
    const phantomSlug = "phantom-project";
    const phantomDir = path.join(ROOT, "projects", phantomSlug);
    expect(existsSync(phantomDir)).toBe(false);

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${phantomSlug}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toEqual([]);
    // Crucially: the read must not have materialised the directory.
    expect(existsSync(phantomDir)).toBe(false);
  });

  it("logs and falls back to the legacy tree when the gbrain view fails", async () => {
    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {}),
      getBrainStore: vi.fn(() => ({
        listPages: vi.fn(async () => {
          throw new Error("gbrain unavailable");
        }),
      })),
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/workspace?action=tree&projectId=test-project"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tree).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[workspace] gbrain view failed, falling back to legacy:",
      expect.any(Error),
    );
  });

  it("builds the workspace tree from type-filtered gbrain pages", async () => {
    const sha = "a".repeat(64);
    const listPages = vi.fn(async (filters?: { type?: string; limit?: number }) => {
      if (filters?.type !== "paper") return [];
      return [
        {
          path: "paper-page",
          title: "Paper Page",
          type: "paper",
          content: "# Paper Page",
          frontmatter: {
            type: "paper",
            project: "test-project",
            file_refs: [
              {
                role: "source",
                fileObjectId: `sha256:${sha}`,
                sha256: sha,
                filename: "paper.pdf",
                mime: "application/pdf",
                sizeBytes: 123,
              },
            ],
          },
        },
      ];
    });
    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {}),
      getBrainStore: vi.fn(() => ({ listPages })),
    }));

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/workspace?action=tree&projectId=test-project"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalFiles).toBe(1);
    expect((body.tree as Array<{ name: string }>).map((node) => node.name)).toContain("papers");
    expect(listPages).toHaveBeenCalledWith({ type: "paper", limit: 5000 });
    expect(
      listPages.mock.calls.some(([filters]) => filters?.type === "project"),
    ).toBe(true);
  });

  it("builds the workspace tree from the fast metadata query without loading page content", async () => {
    const projectId = "test-project";
    const dbQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM files f")) {
        return {
          rows: [
            {
              page_slug: "paper-page",
              page_type: "paper",
              page_title: "Paper Page",
              page_frontmatter: {
                project: projectId,
                uploaded_at: "2026-04-20T10:00:00.000Z",
              },
              updated_at: "2026-04-20T10:00:00.000Z",
              filename: "paper.pdf",
              mime_type: "application/pdf",
              size_bytes: 123,
              content_hash: "a".repeat(64),
            },
          ],
        };
      }
      return { rows: [] };
    });

    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {}),
      getBrainStore: vi.fn(() => ({
        engine: {
          db: {
            query: dbQuery,
          },
        },
      })),
    }));

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${projectId}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      totalFiles: number;
      tree: Array<{ name: string; children?: Array<{ name: string }> }>;
    };
    expect(body.totalFiles).toBe(1);
    expect(body.tree.find((node) => node.name === "papers")?.children).toEqual([
      expect.objectContaining({ name: "paper.pdf" }),
    ]);
    expect(
      dbQuery.mock.calls.some(([sql]) => String(sql).includes("FROM files f")),
    ).toBe(true);
  });

  it("prefers the gbrain file-ref tree over pre-existing materialized cache files", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    writeFileSync(path.join(projectDir, "papers", "legacy.pdf"), "%PDF-1.4 legacy");
    const sha = "b".repeat(64);
    const listPages = vi.fn(async (filters?: { type?: string; limit?: number }) => {
      if (filters?.type !== "paper") return [];
      return [
        {
          path: "new-paper-page",
          title: "New Paper Page",
          type: "paper",
          content: "# New Paper Page",
          frontmatter: {
            type: "paper",
            project: projectId,
            file_refs: [
              {
                role: "source",
                fileObjectId: `sha256:${sha}`,
                sha256: sha,
                filename: "new-paper.pdf",
                mime: "application/pdf",
                sizeBytes: 456,
              },
            ],
          },
        },
      ];
    });
    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {}),
      getBrainStore: vi.fn(() => ({ listPages })),
    }));

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${projectId}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      totalFiles: number;
      tree: Array<{ name: string; children?: Array<{ name: string }> }>;
    };
    const papersDir = body.tree.find((node) => node.name === "papers");
    expect(papersDir?.children?.map((child) => child.name)).toEqual(["new-paper.pdf"]);
    expect(body.totalFiles).toBe(1);
  });

  it("does not let legacy cache files conflict with the gbrain project view", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "papers"), "legacy non-directory entry");
    const sha = "c".repeat(64);
    const listPages = vi.fn(async (filters?: { type?: string; limit?: number }) => {
      if (filters?.type !== "paper") return [];
      return [
        {
          path: "nested-paper-page",
          title: "Nested Paper Page",
          type: "paper",
          content: "# Nested Paper Page",
          frontmatter: {
            type: "paper",
            project: projectId,
            file_refs: [
              {
                role: "source",
                fileObjectId: `sha256:${sha}`,
                sha256: sha,
                filename: "papers/nested.pdf",
                mime: "application/pdf",
                sizeBytes: 789,
              },
            ],
          },
        },
      ];
    });
    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {}),
      getBrainStore: vi.fn(() => ({ listPages })),
    }));

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${projectId}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      totalFiles: number;
      tree: Array<{ name: string; type: string; children?: Array<{ name: string }> }>;
    };
    expect(body.totalFiles).toBe(1);
    expect(body.tree).toEqual([
      expect.objectContaining({
        name: "papers",
        type: "directory",
        children: expect.arrayContaining([
          expect.objectContaining({ name: "nested.pdf", type: "file" }),
        ]),
      }),
    ]);
  });

  it("reports merged totalFiles consistently for tree and watch when gbrain files replace legacy files", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    writeFileSync(path.join(projectDir, "papers", "duplicate.pdf"), "%PDF-1.4 legacy");
    const sha = "d".repeat(64);
    const listPages = vi.fn(async (filters?: { type?: string; limit?: number }) => {
      if (filters?.type !== "paper") return [];
      return [
        {
          path: "duplicate-paper-page",
          title: "Duplicate Paper Page",
          type: "paper",
          content: "# Duplicate Paper Page",
          frontmatter: {
            type: "paper",
            project: projectId,
            file_refs: [
              {
                role: "source",
                fileObjectId: `sha256:${sha}`,
                sha256: sha,
                filename: "duplicate.pdf",
                mime: "application/pdf",
                sizeBytes: 123,
              },
            ],
          },
        },
      ];
    });
    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {}),
      getBrainStore: vi.fn(() => ({ listPages })),
    }));

    const { GET } = await importRoute();
    const treeRes = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${projectId}`),
    );
    const watchRes = await GET(
      new Request(`http://localhost/api/workspace?action=watch&projectId=${projectId}`),
    );

    expect(treeRes.status).toBe(200);
    expect(watchRes.status).toBe(200);
    const treeBody = await treeRes.json() as { totalFiles: number };
    const watchBody = await watchRes.json() as { totalFiles: number };
    expect(treeBody.totalFiles).toBe(1);
    expect(watchBody.totalFiles).toBe(treeBody.totalFiles);
  });

  it("deduplicates gbrain file refs by keeping the freshest artifact for a workspace path", async () => {
    const projectId = "test-project";
    const olderSha = "e".repeat(64);
    const newerSha = "f".repeat(64);
    const listPages = vi.fn(async (filters?: { type?: string; limit?: number }) => {
      if (filters?.type !== "paper") return [];
      return [
        {
          path: "duplicate-paper-page-newer",
          title: "Duplicate Paper Page Newer",
          type: "paper",
          content: "# Duplicate Paper Page Newer",
          frontmatter: {
            type: "paper",
            project: projectId,
            uploaded_at: "2026-04-18T22:58:20.000Z",
            file_refs: [
              {
                role: "source",
                fileObjectId: `sha256:${newerSha}`,
                sha256: newerSha,
                filename: "duplicate.pdf",
                mime: "application/pdf",
                sizeBytes: 456,
              },
            ],
          },
        },
        {
          path: "duplicate-paper-page-older",
          title: "Duplicate Paper Page Older",
          type: "paper",
          content: "# Duplicate Paper Page Older",
          frontmatter: {
            type: "paper",
            project: projectId,
            uploaded_at: "2026-04-18T22:50:00.000Z",
            file_refs: [
              {
                role: "source",
                fileObjectId: `sha256:${olderSha}`,
                sha256: olderSha,
                filename: "duplicate.pdf",
                mime: "application/pdf",
                sizeBytes: 123,
              },
            ],
          },
        },
      ];
    });
    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {}),
      getBrainStore: vi.fn(() => ({ listPages })),
    }));

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${projectId}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      totalFiles: number;
      tree: Array<{ name: string; children?: Array<{ name: string; size?: string }> }>;
    };
    const papersDir = body.tree.find((node) => node.name === "papers");
    expect(body.totalFiles).toBe(1);
    expect(papersDir?.children).toEqual([
      expect.objectContaining({ name: "duplicate.pdf", size: "456 B" }),
    ]);
  });

  it("does not start a gbrain watch fetch without a projectId", async () => {
    const listPages = vi.fn(async () => []);
    const ensureBrainStoreReady = vi.fn(async () => {});
    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady,
      getBrainStore: vi.fn(() => ({ listPages })),
    }));

    const { GET } = await importRoute();
    const res = await GET(new Request("http://localhost/api/workspace?action=watch"));

    expect(res.status).toBe(200);
    expect(ensureBrainStoreReady).not.toHaveBeenCalled();
    expect(listPages).not.toHaveBeenCalled();
  });

  it("returns a stable watch revision for visible files and ignores companion metadata writes", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(path.join(projectDir, "results"), { recursive: true });
    writeFileSync(path.join(projectDir, "results", "new-chart.svg"), "<svg></svg>");

    const { GET } = await importRoute();
    const initialRes = await GET(
      new Request(`http://localhost/api/workspace?action=watch&projectId=${projectId}`),
    );

    expect(initialRes.status).toBe(200);
    const initial = await initialRes.json() as { revision: string; changed: boolean };
    expect(initial.changed).toBe(false);
    expect(initial.revision).toMatch(/^[a-f0-9]+$/);

    writeFileSync(path.join(projectDir, "results", "new-chart.svg.md"), "# companion");
    const companionRes = await GET(
      new Request(`http://localhost/api/workspace?action=watch&projectId=${projectId}&since=${initial.revision}`),
    );

    expect(companionRes.status).toBe(200);
    const companion = await companionRes.json() as { revision: string; changed: boolean };
    expect(companion.changed).toBe(false);
    expect(companion.revision).toBe(initial.revision);

    writeFileSync(path.join(projectDir, "results", "summary.md"), "# visible result");
    const changedRes = await GET(
      new Request(`http://localhost/api/workspace?action=watch&projectId=${projectId}&since=${initial.revision}`),
    );

    expect(changedRes.status).toBe(200);
    const changed = await changedRes.json() as { revision: string; changed: boolean };
    expect(changed.changed).toBe(true);
    expect(changed.revision).not.toBe(initial.revision);
  });

  it("repairs a normalized legacy import into the canonical project workspace on tree reads", async () => {
    const canonicalSlug = "project-alpha";
    const legacySlug = "projectalpha";
    const projectDir = path.join(ROOT, "projects", canonicalSlug);
    mkdirSync(path.join(projectDir, "code", "tests"), { recursive: true });
    writeFileSync(path.join(projectDir, "project.json"), JSON.stringify({ name: "Project Alpha" }));

    mkdirSync(path.join(ROOT, "brain", "state", "projects", legacySlug), { recursive: true });
    writeFileSync(
      path.join(ROOT, "brain", "state", "projects", legacySlug, "import-summary.json"),
      JSON.stringify({
        project: legacySlug,
        lastImport: {
          name: "Project Alpha",
          preparedFiles: 1,
          detectedItems: 1,
          detectedBytes: 24,
          duplicateGroups: 0,
          generatedAt: "2026-04-12T00:00:00.000Z",
          source: "background-local-import",
        },
      }, null, 2),
    );

    mkdirSync(
      path.join(ROOT, "brain", "wiki", "entities", "artifacts", "imports", legacySlug),
      { recursive: true },
    );
    writeFileSync(
      path.join(
        ROOT,
        "brain",
        "wiki",
        "entities",
        "artifacts",
        "imports",
        legacySlug,
        "code-main.py-a1b2c3d4.md",
      ),
      [
        "---",
        "date: 2026-04-12",
        'title: "main.py"',
        "type: artifact",
        "para: resources",
        'tags: ["import","code"]',
        `project: ${JSON.stringify(legacySlug)}`,
        'source_refs: [{"kind":"import","ref":"code/main.py","hash":"hash-main"}]',
        "status: active",
        'import_classification: "code"',
        'format: "py"',
        "---",
        "",
        "# main.py",
        "",
        "## Imported Content",
        "",
        "print('repaired from legacy import')",
        "",
      ].join("\n"),
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${canonicalSlug}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const tree = body.tree as Array<{ name: string; children?: Array<{ name: string }> }>;
    const codeDir = tree.find((node) => node.name === "code");
    expect(codeDir).toBeDefined();
    expect(codeDir?.children?.some((child) => child.name === "main.py")).toBe(true);
    expect(body.totalFiles).toBe(1);
    expect(
      readFileSync(path.join(projectDir, "code", "main.py"), "utf-8"),
    ).toContain("repaired from legacy import");
  });

  it("continues serving the tree when best-effort legacy repair fails", async () => {
    const projectId = "project-alpha";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(path.join(projectDir, "code"), { recursive: true });
    writeFileSync(path.join(projectDir, "project.json"), JSON.stringify({ name: "Project Alpha" }));
    writeFileSync(path.join(projectDir, "code", "main.py"), "print('still listed')", "utf-8");

    vi.doMock("@/lib/state/legacy-import-repair", async () => {
      const actual = await vi.importActual<typeof import("@/lib/state/legacy-import-repair")>(
        "@/lib/state/legacy-import-repair",
      );
      return {
        ...actual,
        repairLegacyImportedProject: vi.fn(async () => {
          throw new Error("repair failed");
        }),
      };
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${projectId}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const codeDir = (body.tree as Array<{ name: string; children?: Array<{ name: string }> }>)
      .find((node) => node.name === "code");
    expect(codeDir?.children?.some((child) => child.name === "main.py")).toBe(true);
  });

  it("syncs newly added files from the saved local import source into the project workspace", async () => {
    const projectId = "project-alpha";
    const projectDir = path.join(ROOT, "projects", projectId);
    const sourceRoot = path.join(homedir(), "tmp", `scienceswarm-workspace-sync-${Date.now()}`);

    rmSync(sourceRoot, { recursive: true, force: true });
    mkdirSync(path.join(sourceRoot, "papers", "incoming-pdfs"), { recursive: true });
    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    mkdirSync(path.join(projectDir, ".brain", "state"), { recursive: true });

    writeFileSync(path.join(sourceRoot, "papers", "existing.pdf"), "%PDF-1.4 existing");
    writeFileSync(path.join(projectDir, "papers", "existing.pdf"), "%PDF-1.4 existing");
    writeFileSync(
      path.join(projectDir, ".brain", "state", "import-source.json"),
      JSON.stringify({
        version: 1,
        project: projectId,
        folderPath: sourceRoot,
        source: "background-local-import",
        updatedAt: "2026-04-13T00:00:00.000Z",
      }, null, 2),
    );

    writeFileSync(path.join(sourceRoot, "papers", "incoming-pdfs", "new-paper.pdf"), "%PDF-1.4 new");

    try {
      const { POST, GET } = await importRoute();
      const res = await POST(
        new Request("http://localhost/api/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check-changes", projectId }),
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        added: Array<{ workspacePath: string }>;
        updated: Array<{ workspacePath: string }>;
      };
      expect(body.added.map((entry) => entry.workspacePath)).toContain("papers/incoming-pdfs/new-paper.pdf");
      expect(body.updated).toEqual([]);
      expect(
        readFileSync(path.join(projectDir, "papers", "incoming-pdfs", "new-paper.pdf"), "utf-8"),
      ).toContain("new");

      const refs = JSON.parse(
        readFileSync(path.join(projectDir, ".references.json"), "utf-8"),
      ) as { files: Array<{ workspacePath: string; originalPath: string }> };
      expect(refs.files.map((entry) => entry.workspacePath)).toEqual(
        expect.arrayContaining(["papers/existing.pdf", "papers/incoming-pdfs/new-paper.pdf"]),
      );

      const treeRes = await GET(
        new Request(`http://localhost/api/workspace?action=tree&projectId=${projectId}`),
      );
      expect(treeRes.status).toBe(200);
      const treeBody = await treeRes.json() as {
        tree: Array<{ name: string; children?: Array<{ name: string; children?: Array<{ name: string }> }> }>;
      };
      const papersDir = treeBody.tree.find((node) => node.name === "papers");
      expect(papersDir?.children?.some((child) => child.name === "existing.pdf")).toBe(true);
      const incomingDir = papersDir?.children?.find((child) => child.name === "incoming-pdfs");
      expect(incomingDir?.children?.some((child) => child.name === "new-paper.pdf")).toBe(true);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("falls back to missing detection when the saved import source folder is gone", async () => {
    const projectId = "project-alpha";
    const projectDir = path.join(ROOT, "projects", projectId);
    const deletedSourceRoot = path.join(homedir(), "tmp", `scienceswarm-missing-source-${Date.now()}`);

    rmSync(deletedSourceRoot, { recursive: true, force: true });
    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    mkdirSync(path.join(projectDir, ".brain", "state"), { recursive: true });
    writeFileSync(path.join(projectDir, "papers", "paper.pdf"), "%PDF-1.4 existing");
    writeFileSync(
      path.join(projectDir, ".brain", "state", "import-source.json"),
      JSON.stringify({
        version: 1,
        project: projectId,
        folderPath: deletedSourceRoot,
        source: "background-local-import",
        updatedAt: "2026-04-13T00:00:00.000Z",
      }, null, 2),
    );
    writeFileSync(
      path.join(projectDir, ".references.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            originalPath: path.join(deletedSourceRoot, "papers", "paper.pdf"),
            workspacePath: "papers/paper.pdf",
            hash: "hash-paper",
            type: "pdf",
            size: 14,
            importedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
      }, null, 2),
    );

    const { POST } = await importRoute();
    const res = await POST(
      new Request("http://localhost/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check-changes", projectId }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      changed: Array<{ workspacePath: string }>;
      updated: Array<{ workspacePath: string }>;
      missing: Array<{ workspacePath: string }>;
    };
    expect(body.changed.map((entry) => entry.workspacePath)).toEqual(["papers/paper.pdf"]);
    expect(body.updated).toEqual([]);
    expect(body.missing.map((entry) => entry.workspacePath)).toEqual(["papers/paper.pdf"]);
  });

  it("reports deleted originals as missing instead of updated in the fallback path", async () => {
    const projectId = "project-alpha";
    const projectDir = path.join(ROOT, "projects", projectId);
    const missingOriginal = path.join(homedir(), "tmp", `scienceswarm-missing-original-${Date.now()}`, "paper.pdf");

    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    writeFileSync(path.join(projectDir, "papers", "paper.pdf"), "%PDF-1.4 existing");
    writeFileSync(
      path.join(projectDir, ".references.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            originalPath: missingOriginal,
            workspacePath: "papers/paper.pdf",
            hash: "hash-paper",
            type: "pdf",
            size: 14,
            importedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
      }, null, 2),
    );

    const { POST } = await importRoute();
    const res = await POST(
      new Request("http://localhost/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check-changes", projectId }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      changed: Array<{ workspacePath: string }>;
      updated: Array<{ workspacePath: string }>;
      missing: Array<{ workspacePath: string }>;
    };
    expect(body.changed.map((entry) => entry.workspacePath)).toEqual(["papers/paper.pdf"]);
    expect(body.updated).toEqual([]);
    expect(body.missing.map((entry) => entry.workspacePath)).toEqual(["papers/paper.pdf"]);
  });

  it("does not mark duplicate-content refs as missing when the source file still exists", async () => {
    const projectId = "project-alpha";
    const projectDir = path.join(ROOT, "projects", projectId);
    const sourceRoot = path.join(homedir(), "tmp", `scienceswarm-duplicate-source-${Date.now()}`);
    const originalRelativePath = path.join("papers", "paper-a.pdf");
    const duplicateRelativePath = path.join("papers", "paper-b.pdf");
    const duplicateContent = "%PDF-1.4 identical";
    const duplicateHash = hashContent(duplicateContent);

    rmSync(sourceRoot, { recursive: true, force: true });
    mkdirSync(path.join(sourceRoot, "papers"), { recursive: true });
    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    mkdirSync(path.join(projectDir, ".brain", "state"), { recursive: true });
    writeFileSync(path.join(sourceRoot, originalRelativePath), duplicateContent);
    writeFileSync(path.join(sourceRoot, duplicateRelativePath), duplicateContent);
    writeFileSync(path.join(projectDir, originalRelativePath), duplicateContent);
    writeFileSync(path.join(projectDir, duplicateRelativePath), duplicateContent);
    writeFileSync(
      path.join(projectDir, ".brain", "state", "import-source.json"),
      JSON.stringify({
        version: 1,
        project: projectId,
        folderPath: sourceRoot,
        source: "background-local-import",
        updatedAt: "2026-04-13T00:00:00.000Z",
      }, null, 2),
    );
    writeFileSync(
      path.join(projectDir, ".references.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            originalPath: path.join(sourceRoot, originalRelativePath),
            workspacePath: originalRelativePath,
            hash: duplicateHash,
            type: "pdf",
            size: duplicateContent.length,
            importedAt: "2026-04-13T00:00:00.000Z",
          },
          {
            originalPath: path.join(sourceRoot, duplicateRelativePath),
            workspacePath: duplicateRelativePath,
            hash: duplicateHash,
            type: "pdf",
            size: duplicateContent.length,
            importedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
      }, null, 2),
    );

    try {
      const { POST } = await importRoute();
      const res = await POST(
        new Request("http://localhost/api/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check-changes", projectId }),
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        changed: Array<{ workspacePath: string }>;
        updated: Array<{ workspacePath: string }>;
        missing: Array<{ workspacePath: string }>;
      };
      expect(body.changed).toEqual([]);
      expect(body.updated).toEqual([]);
      expect(body.missing).toEqual([]);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("upgrades legacy large-file fingerprints without flagging unchanged files as updated", async () => {
    const projectId = "project-alpha";
    const projectDir = path.join(ROOT, "projects", projectId);
    const sourceRoot = path.join(homedir(), "tmp", `scienceswarm-large-source-${Date.now()}`);
    const relativePath = path.join("papers", "large.pdf");
    const size = 10_000_128;
    const legacyHash = hashContent(`${relativePath}:${size}`);

    rmSync(sourceRoot, { recursive: true, force: true });
    mkdirSync(path.join(sourceRoot, "papers"), { recursive: true });
    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    mkdirSync(path.join(projectDir, ".brain", "state"), { recursive: true });
    writeSparseLargeFile(path.join(sourceRoot, relativePath), size, "stable");
    writeSparseLargeFile(path.join(projectDir, relativePath), size, "stable");
    writeFileSync(
      path.join(projectDir, ".brain", "state", "import-source.json"),
      JSON.stringify({
        version: 1,
        project: projectId,
        folderPath: sourceRoot,
        source: "background-local-import",
        updatedAt: "2026-04-13T00:00:00.000Z",
      }, null, 2),
    );
    writeFileSync(
      path.join(projectDir, ".references.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            originalPath: path.join(sourceRoot, relativePath),
            workspacePath: relativePath,
            hash: legacyHash,
            type: "pdf",
            size,
            importedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
      }, null, 2),
    );

    try {
      const { POST } = await importRoute();
      const res = await POST(
        new Request("http://localhost/api/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check-changes", projectId }),
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        changed: Array<{ workspacePath: string }>;
        updated: Array<{ workspacePath: string }>;
        missing: Array<{ workspacePath: string }>;
      };
      expect(body.changed).toEqual([]);
      expect(body.updated).toEqual([]);
      expect(body.missing).toEqual([]);

      const refs = JSON.parse(
        readFileSync(path.join(projectDir, ".references.json"), "utf-8"),
      ) as { files: Array<{ hash: string; workspacePath: string }> };
      expect(refs.files).toEqual([
        expect.objectContaining({
          workspacePath: relativePath,
          hash: expect.not.stringMatching(`^${legacyHash}$`),
        }),
      ]);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("detects same-size edits for large imported files during source sync", async () => {
    const projectId = "project-alpha";
    const projectDir = path.join(ROOT, "projects", projectId);
    const sourceRoot = path.join(homedir(), "tmp", `scienceswarm-large-edit-${Date.now()}`);
    const relativePath = path.join("papers", "large.pdf");
    const size = 10_000_128;
    const legacyHash = hashContent(`${relativePath}:${size}`);
    const unsampledOffset = 1_000_000;

    rmSync(sourceRoot, { recursive: true, force: true });
    mkdirSync(path.join(sourceRoot, "papers"), { recursive: true });
    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    mkdirSync(path.join(projectDir, ".brain", "state"), { recursive: true });
    writeSparseLargeFile(path.join(sourceRoot, relativePath), size, "stable");
    writeSparseLargeFile(path.join(projectDir, relativePath), size, "stable");
    writeFileSync(
      path.join(projectDir, ".brain", "state", "import-source.json"),
      JSON.stringify({
        version: 1,
        project: projectId,
        folderPath: sourceRoot,
        source: "background-local-import",
        updatedAt: "2026-04-13T00:00:00.000Z",
      }, null, 2),
    );
    writeFileSync(
      path.join(projectDir, ".references.json"),
      JSON.stringify({
        version: 1,
        files: [
          {
            originalPath: path.join(sourceRoot, relativePath),
            workspacePath: relativePath,
            hash: legacyHash,
            type: "pdf",
            size,
            importedAt: "2026-04-13T00:00:00.000Z",
          },
        ],
      }, null, 2),
    );
    const originalFingerprint = computeFileFingerprintSync(path.join(projectDir, relativePath), size);
    writeSparseLargeFile(path.join(sourceRoot, relativePath), size, "stable");
    const sourceFd = openSync(path.join(sourceRoot, relativePath), "r+");
    try {
      const delta = Buffer.from("updated-outside-legacy-samples", "utf-8");
      writeSync(sourceFd, delta, 0, delta.length, unsampledOffset);
    } finally {
      closeSync(sourceFd);
    }
    const updatedFingerprint = computeFileFingerprintSync(path.join(sourceRoot, relativePath), size);
    expect(updatedFingerprint).not.toBe(originalFingerprint);

    try {
      const { POST } = await importRoute();
      const res = await POST(
        new Request("http://localhost/api/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "check-changes", projectId }),
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json() as {
        changed: Array<{ workspacePath: string }>;
        updated: Array<{ workspacePath: string }>;
        missing: Array<{ workspacePath: string }>;
      };
      expect(body.changed.map((entry) => entry.workspacePath)).toEqual([relativePath]);
      expect(body.updated.map((entry) => entry.workspacePath)).toEqual([relativePath]);
      expect(body.missing).toEqual([]);
      expect(statSync(path.join(projectDir, relativePath)).size).toBe(size);
      expect(computeFileFingerprintSync(path.join(projectDir, relativePath), size)).toBe(updatedFingerprint);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects unsafe project slugs (path traversal)", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://localhost/api/workspace?action=tree&projectId=../etc"),
    );
    // assertSafeProjectSlug throws → caught by GET → mapped to 400 (client error).
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("maps invalid slugs to 400 on the async POST check-changes path", async () => {
    // check-changes is async — without `await` in the POST handler the
    // rejection escapes the try/catch entirely and surfaces as a 500.
    // This test guards against that regression.
    const { POST } = await importRoute();
    const res = await POST(
      new Request("http://localhost/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check-changes", projectId: "../etc" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("maps invalid slugs to 400 on the async POST list path", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      new Request("http://localhost/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list", projectId: "../etc" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("maps invalid slugs to 400 on the async POST upload path", async () => {
    const { POST } = await importRoute();
    const formData = new FormData();
    formData.append("files", new File(["hello"], "note.txt", { type: "text/plain" }));
    formData.append("projectId", "../etc");
    const res = await POST(
      new Request("http://localhost/api/workspace", {
        method: "POST",
        body: formData,
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("maps invalid slugs to 400 on GET ?action=meta", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        "http://localhost/api/workspace?action=meta&file=note.txt&projectId=../etc",
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("returns real text file content from the per-project workspace", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(path.join(projectDir, "papers"), { recursive: true });
    writeFileSync(path.join(projectDir, "papers", "paper_v3.tex"), "\\section{Intro}\nReal local content\n");

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=file&projectId=${projectId}&file=papers/paper_v3.tex`),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("Real local content");
  });

  it("returns notebook JSON source from GET ?action=file", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId, "notebooks");
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ cell_type: "code", source: ["print('raw json')"], outputs: [] }],
    };
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "analysis.ipynb"), JSON.stringify(notebook), "utf-8");

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=file&projectId=${projectId}&file=notebooks/analysis.ipynb`),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.parse(body.content)).toMatchObject({
      nbformat: 4,
      cells: [expect.objectContaining({ cell_type: "code" })],
    });
  });

  it("returns HTML source from GET ?action=file and serves raw HTML for sandboxed embeds", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId, "reports");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, "unsafe.html"),
      "<!doctype html><script>window.bad=true</script><h1>Report</h1>",
      "utf-8",
    );

    const { GET } = await importRoute();
    const fileRes = await GET(
      new Request(`http://localhost/api/workspace?action=file&projectId=${projectId}&file=reports/unsafe.html`),
    );
    expect(fileRes.status).toBe(200);
    await expect(fileRes.json()).resolves.toMatchObject({
      content: expect.stringContaining("<script>window.bad=true</script>"),
    });

    const rawRes = await GET(
      new Request(`http://localhost/api/workspace?action=raw&projectId=${projectId}&file=reports/unsafe.html`),
    );
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const rawHtml = await rawRes.text();
    expect(rawHtml).toContain("data-scienceswarm-html-preview-shim");
    expect(rawHtml).toContain("<script>window.bad=true</script>");
  });

  it("serves file, read, raw, and meta from gbrain file refs when no project folder exists", async () => {
    const projectId = "test-project";
    const fileStore = createGbrainFileStore({ brainRoot: path.join(ROOT, "brain") });
    const textObject = await seedWorkspaceFileObject(
      fileStore,
      projectId,
      "analysis.py",
      Buffer.from("print('from gbrain')\n", "utf-8"),
      "text/x-python",
    );
    const pdfObject = await seedWorkspaceFileObject(
      fileStore,
      projectId,
      "paper.pdf",
      Buffer.from("%PDF-1.4 from gbrain", "utf-8"),
      "application/pdf",
    );
    mockGbrainPages({
      code: [
        {
          path: "analysis-code",
          title: "Analysis Code",
          type: "code",
          content: "# Analysis Code\n\nConverted page",
          frontmatter: {
            type: "code",
            project: projectId,
            file_refs: [
              {
                role: "source",
                fileObjectId: textObject.id,
                sha256: textObject.sha256,
                filename: "analysis.py",
                mime: textObject.mime,
                sizeBytes: textObject.sizeBytes,
              },
            ],
          },
        },
      ],
      paper: [
        {
          path: "paper-page",
          title: "Paper Page",
          type: "paper",
          content: "# Paper Page\n\nConverted paper text",
          frontmatter: {
            type: "paper",
            project: projectId,
            file_refs: [
              {
                role: "source",
                fileObjectId: pdfObject.id,
                sha256: pdfObject.sha256,
                filename: "paper.pdf",
                mime: pdfObject.mime,
                sizeBytes: pdfObject.sizeBytes,
              },
            ],
          },
        },
      ],
    });

    const route = await importRoute();
    __setWorkspaceFileStoreOverride(fileStore);

    const projectDir = path.join(ROOT, "projects", projectId);
    expect(existsSync(projectDir)).toBe(false);

    const fileRes = await route.GET(
      new Request(`http://localhost/api/workspace?action=file&projectId=${projectId}&file=code/analysis.py`),
    );
    expect(fileRes.status).toBe(200);
    await expect(fileRes.json()).resolves.toMatchObject({
      content: "print('from gbrain')\n",
      source: "gbrain",
    });

    const readRes = await route.GET(
      new Request(`http://localhost/api/workspace?action=read&projectId=${projectId}&file=code/analysis.py`),
    );
    expect(readRes.status).toBe(200);
    await expect(readRes.json()).resolves.toMatchObject({
      content: "print('from gbrain')\n",
      source: "gbrain",
    });

    const rawRes = await route.GET(
      new Request(`http://localhost/api/workspace?action=raw&projectId=${projectId}&file=papers/paper.pdf`),
    );
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get("Content-Type")).toBe("application/pdf");
    expect(await rawRes.text()).toBe("%PDF-1.4 from gbrain");

    const metaRes = await route.GET(
      new Request(`http://localhost/api/workspace?action=meta&projectId=${projectId}&file=code/analysis.py`),
    );
    expect(metaRes.status).toBe(200);
    await expect(metaRes.json()).resolves.toMatchObject({
      companion: expect.stringContaining("Converted page"),
      source: "gbrain",
      pagePath: "analysis-code",
    });
    expect(existsSync(projectDir)).toBe(false);
  });

  it("cancels and releases gbrain stream readers when a text preview exceeds the cap", async () => {
    const projectId = "test-project";
    const sha = "a".repeat(64);
    const fileObjectId = `sha256:${sha}` as const;
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array((5 * 1024 * 1024) + 1) })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const stream = {
      getReader: vi.fn(() => ({ read, cancel, releaseLock })),
    } as unknown as ReadableStream<Uint8Array>;
    const metadata: GbrainFileObject = {
      id: fileObjectId,
      sha256: sha,
      sizeBytes: 1,
      mime: "text/plain",
      originalFilename: "huge.txt",
      project: projectId,
      uploadedAt: "2026-04-16T00:00:00.000Z",
      uploadedBy: "@tester",
      source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
      storagePath: `objects/files/${sha.slice(0, 2)}/${sha}`,
      contentEncoding: "raw",
    };
    const fileStore: GbrainFileStore = {
      putObject: vi.fn(async () => {
        throw new Error("unexpected putObject");
      }),
      getObject: vi.fn(async () => metadata),
      openObjectStream: vi.fn(async () => ({ metadata, stream })),
      hasObject: vi.fn(async () => true),
    };

    mockGbrainPages({
      note: [
        {
          path: "huge-note",
          title: "Huge Note",
          type: "note",
          content: "# Huge Note",
          frontmatter: {
            type: "note",
            project: projectId,
            file_refs: [
              {
                role: "source",
                fileObjectId,
                sha256: sha,
                filename: "huge.txt",
                mime: "text/plain",
                sizeBytes: 1,
              },
            ],
          },
        },
      ],
    });

    const route = await importRoute();
    __setWorkspaceFileStoreOverride(fileStore);

    const res = await route.GET(
      new Request(`http://localhost/api/workspace?action=file&projectId=${projectId}&file=docs/huge.txt`),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: "stream exceeded preview cap",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("cancels gbrain streams before oversized preview early returns", async () => {
    const projectId = "test-project";
    const records = new Map<
      string,
      { metadata: GbrainFileObject; cancel: ReturnType<typeof vi.fn> }
    >();
    const addObject = (
      sha: string,
      filename: string,
      mime: string,
      sizeBytes: number,
    ) => {
      const fileObjectId = `sha256:${sha}` as const;
      const cancel = vi.fn(async () => {});
      const metadata: GbrainFileObject = {
        id: fileObjectId,
        sha256: sha,
        sizeBytes,
        mime,
        originalFilename: filename,
        project: projectId,
        uploadedAt: "2026-04-16T00:00:00.000Z",
        uploadedBy: "@tester",
        source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
        storagePath: `objects/files/${sha.slice(0, 2)}/${sha}`,
        contentEncoding: "raw",
      };
      records.set(fileObjectId, { metadata, cancel });
      return {
        cancel,
        ref: {
          role: "source" as const,
          fileObjectId,
          sha256: sha,
          filename,
          mime,
          sizeBytes,
        },
      };
    };
    const parseable = addObject(
      "b".repeat(64),
      "oversize.pdf",
      "application/pdf",
      (50 * 1024 * 1024) + 1,
    );
    const textRead = addObject(
      "c".repeat(64),
      "oversize.txt",
      "text/plain",
      1_000_001,
    );
    const raw = addObject(
      "d".repeat(64),
      "oversize.png",
      "image/png",
      (50 * 1024 * 1024) + 1,
    );
    const textPreview = addObject(
      "e".repeat(64),
      "preview.md",
      "text/markdown",
      (5 * 1024 * 1024) + 1,
    );
    const fileStore: GbrainFileStore = {
      putObject: vi.fn(async () => {
        throw new Error("unexpected putObject");
      }),
      getObject: vi.fn(async (id) => records.get(id)?.metadata ?? null),
      openObjectStream: vi.fn(async (id) => {
        const record = records.get(id);
        if (!record) return null;
        return {
          metadata: record.metadata,
          stream: {
            cancel: record.cancel,
          } as unknown as ReadableStream<Uint8Array>,
        };
      }),
      hasObject: vi.fn(async (id) => records.has(id)),
    };

    mockGbrainPages({
      paper: [
        {
          path: "oversize-paper",
          title: "Oversize Paper",
          type: "paper",
          content: "# Oversize Paper",
          frontmatter: {
            type: "paper",
            project: projectId,
            file_refs: [parseable.ref],
          },
        },
      ],
      note: [
        {
          path: "oversize-text",
          title: "Oversize Text",
          type: "note",
          content: "# Oversize Text",
          frontmatter: {
            type: "note",
            project: projectId,
            file_refs: [textRead.ref, textPreview.ref],
          },
        },
      ],
      artifact: [
        {
          path: "oversize-image",
          title: "Oversize Image",
          type: "artifact",
          content: "# Oversize Image",
          frontmatter: {
            type: "artifact",
            project: projectId,
            file_refs: [raw.ref],
          },
        },
      ],
    });

    const route = await importRoute();
    __setWorkspaceFileStoreOverride(fileStore);

    const parseableReadRes = await route.GET(
      new Request(`http://localhost/api/workspace?action=read&projectId=${projectId}&file=papers/oversize.pdf`),
    );
    expect(parseableReadRes.status).toBe(200);
    await expect(parseableReadRes.json()).resolves.toMatchObject({ tooLarge: true });

    const textReadRes = await route.GET(
      new Request(`http://localhost/api/workspace?action=read&projectId=${projectId}&file=docs/oversize.txt`),
    );
    expect(textReadRes.status).toBe(200);
    await expect(textReadRes.json()).resolves.toMatchObject({ tooLarge: true });

    const rawRes = await route.GET(
      new Request(`http://localhost/api/workspace?action=raw&projectId=${projectId}&file=figures/oversize.png`),
    );
    expect(rawRes.status).toBe(413);

    const textPreviewRes = await route.GET(
      new Request(`http://localhost/api/workspace?action=file&projectId=${projectId}&file=docs/preview.md`),
    );
    expect(textPreviewRes.status).toBe(413);

    expect(parseable.cancel).toHaveBeenCalledTimes(1);
    expect(textRead.cancel).toHaveBeenCalledTimes(1);
    expect(raw.cancel).toHaveBeenCalledTimes(1);
    expect(textPreview.cancel).toHaveBeenCalledTimes(1);
  });

  it("counts nested project.json files as visible workspace files", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(path.join(projectDir, "code"), { recursive: true });
    writeFileSync(path.join(projectDir, "project.json"), JSON.stringify({ name: "Project Alpha" }), "utf-8");
    writeFileSync(path.join(projectDir, "code", "project.json"), JSON.stringify({ nested: true }), "utf-8");

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=tree&projectId=${projectId}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalFiles).toBe(1);
    const rootNames = (body.tree as Array<{ name: string }>).map((node) => node.name);
    expect(rootNames).not.toContain("project.json");
  });

  it("rejects unsafe project slugs on GET ?action=file", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        "http://localhost/api/workspace?action=file&file=note.txt&projectId=../etc",
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("rejects symlink escapes on GET ?action=file", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    const outsidePath = path.join(ROOT, "outside.txt");
    mkdirSync(path.join(projectDir, "code"), { recursive: true });
    writeFileSync(outsidePath, "outside", "utf-8");
    symlinkSync(outsidePath, path.join(projectDir, "code", "link.txt"));

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=file&projectId=${projectId}&file=code/link.txt`),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid file path");
  });

  it("rejects symlink escapes on GET ?action=meta", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    const outsidePath = path.join(ROOT, "outside.txt.md");
    mkdirSync(path.join(projectDir, "code"), { recursive: true });
    writeFileSync(outsidePath, "outside metadata", "utf-8");
    symlinkSync(outsidePath, path.join(projectDir, "code", "link.txt.md"));

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=meta&projectId=${projectId}&file=code/link.txt`),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid file path");
  });

  it("rejects oversized text previews on GET ?action=file", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(path.join(projectDir, "docs"), { recursive: true });
    writeFileSync(
      path.join(projectDir, "docs", "huge.md"),
      "a".repeat((5 * 1024 * 1024) + 1),
      "utf-8",
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=file&projectId=${projectId}&file=docs/huge.md`),
    );

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain("File too large");
  });

  it("treats ANSI-colored log output as text on GET ?action=file", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId);
    mkdirSync(path.join(projectDir, "logs"), { recursive: true });
    writeFileSync(
      path.join(projectDir, "logs", "worker.log"),
      "\u001b[31merror\u001b[0m pipeline stalled\n",
      "utf-8",
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request(`http://localhost/api/workspace?action=file&projectId=${projectId}&file=logs/worker.log`),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("\u001b[31merror\u001b[0m");
  });

  it("maps invalid slugs to 400 on POST update-meta", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      new Request("http://localhost/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-meta",
          file: "note.txt",
          summary: "anything",
          projectId: "../etc",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid project slug");
  });

  it("writes regenerated chart content back to the exact project workspace path", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId, "generated");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "summary-chart.svg"), "<svg><text>old</text></svg>", "utf-8");

    const { POST } = await importRoute();
    const res = await POST(
      new Request("http://localhost/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write-file",
          projectId,
          file: "generated/summary-chart.svg",
          content: "<svg><text>updated</text></svg>",
        }),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      written: true,
      file: "generated/summary-chart.svg",
    });
    expect(
      readFileSync(path.join(projectDir, "summary-chart.svg"), "utf-8"),
    ).toContain("updated");
  });

  it("rejects write-file requests with a non-string file field", async () => {
    const { POST } = await importRoute();
    const res = await POST(
      new Request("http://localhost/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "write-file",
          projectId: "test-project",
          file: { path: "generated/summary-chart.svg" },
          content: "<svg />",
        }),
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "file and content required",
    });
  });

  it("reads project-scoped file contents with GET ?action=read", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId, "docs");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "summary.md"), "# Summary\n\nScoped preview");

    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        `http://localhost/api/workspace?action=read&file=${encodeURIComponent("docs/summary.md")}&projectId=${projectId}`,
      ),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      file: "docs/summary.md",
      content: "# Summary\n\nScoped preview",
    });
  });

  it("serves raw PDF previews with an RFC 6266 filename header", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId, "papers");
    const filename = "résumé.pdf";
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, filename), "%PDF-1.4 fake");

    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        `http://localhost/api/workspace?action=raw&file=${encodeURIComponent(`papers/${filename}`)}&projectId=${projectId}`,
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("filename*=");
  });

  it("serves sandboxed raw preview for SVG uploads", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId, "figures");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, "plot.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
    );

    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        "http://localhost/api/workspace?action=raw&file=figures%2Fplot.svg&projectId=test-project",
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("serves raw OpenClaw canvas documents from the managed canvas state dir", async () => {
    const canvasDir = path.join(ROOT, "openclaw", "canvas", "documents", "cat-svg-preview");
    mkdirSync(canvasDir, { recursive: true });
    writeFileSync(path.join(canvasDir, "index.html"), "<!doctype html><title>Cat SVG</title>");

    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        "http://localhost/api/workspace?action=raw&file=__openclaw__%2Fcanvas%2Fdocuments%2Fcat-svg-preview%2Findex.html&projectId=test-project",
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("Cat SVG");
    expect(html).toContain("data-scienceswarm-html-preview-shim");
  });

  it("serves raw OpenClaw generated media from the managed state dir", async () => {
    const mediaDir = path.join(ROOT, "openclaw", "media", "tool-image-generation");
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(path.join(mediaDir, "cat-image.png"), "fake-image");

    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        "http://localhost/api/workspace?action=raw&file=__openclaw__%2Fmedia%2Ftool-image-generation%2Fcat-image.png&projectId=test-project",
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    await expect(res.text()).resolves.toBe("fake-image");
  });

  it("returns a generic parse error when a parseable preview fails", async () => {
    const projectId = "test-project";
    const projectDir = path.join(ROOT, "projects", projectId, "papers");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "broken.ipynb"), "{\"cells\":[]}", "utf-8");

    vi.doMock("@/lib/file-parser", () => ({
      parseFile: vi.fn(async () => {
        throw new Error("/private/tmp/secret.ipynb failed to parse");
      }),
    }));

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await importRoute();
    const res = await GET(
      new Request(
        `http://localhost/api/workspace?action=read&file=${encodeURIComponent("papers/broken.ipynb")}&projectId=${projectId}`,
      ),
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: "File preview parse failed",
    });
    expect(consoleError).toHaveBeenCalled();
  });
});
