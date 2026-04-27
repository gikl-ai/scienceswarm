import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { GET } from "@/app/api/brain/file/route";
import * as storeModule from "@/brain/store";
import type { BrainPage, BrainStore, ImportResult } from "@/brain/store";
import {
  createGbrainFileStore,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";
import type { GbrainFileObject } from "@/brain/gbrain-data-contracts";
import { __setBrainFileRouteFileStoreOverride } from "@/lib/testing/brain-file-route-overrides";

class FakeBrainStore implements BrainStore {
  pages = new Map<string, BrainPage>();
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
  async importCorpus(_dirPath: string): Promise<ImportResult> {
    throw new Error("not implemented");
  }
  async listPages() {
    return Array.from(this.pages.values());
  }
  async health() {
    return { ok: true, pageCount: this.pages.size };
  }
  async dispose() {}
}

let tmpRoot = "";
let fakeStore: FakeBrainStore;
let fileStore: GbrainFileStore;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scienceswarm-file-test-"));
  process.env.SCIENCESWARM_DIR = tmpRoot;
  fileStore = createGbrainFileStore({ brainRoot: path.join(tmpRoot, "brain") });
  __setBrainFileRouteFileStoreOverride(fileStore);
  fakeStore = new FakeBrainStore();
  vi.spyOn(storeModule, "getBrainStore").mockReturnValue(fakeStore);
  vi.spyOn(storeModule, "ensureBrainStoreReady").mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  __setBrainFileRouteFileStoreOverride(null);
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.SCIENCESWARM_DIR;
});

function makeRequest(query: Record<string, string>): Request {
  const url = new URL("http://localhost:3001/api/brain/file");
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new Request(url, { method: "GET" });
}

function setPage(slug: string, frontmatter: Record<string, unknown>): void {
  fakeStore.pages.set(slug, {
    path: slug,
    title: "Test",
    type: "paper",
    content: `# ${slug}`,
    frontmatter,
  });
}

async function seedFileObject(
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

describe("GET /api/brain/file", () => {
  it("rejects without a slug param", async () => {
    const res = await GET(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("slug");
  });

  it("404s when the page is missing", async () => {
    const res = await GET(makeRequest({ slug: "nothing" }));
    expect(res.status).toBe(404);
  });

  it("rejects pages without a study", async () => {
    setPage("hubble-1929", {
      type: "paper",
      source_filename: "hubble-1929.pdf",
    });
    const res = await GET(makeRequest({ slug: "hubble-1929" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("study");
  });

  it("rejects pages without a file object reference", async () => {
    setPage("hubble-1929", {
      type: "paper",
      project: "hubble-1929",
    });
    const res = await GET(makeRequest({ slug: "hubble-1929" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("file object reference");
  });

  it("rejects legacy fallback filenames containing path separators", async () => {
    setPage("hubble-1929", {
      type: "paper",
      project: "hubble-1929",
      source_filename: "../../../etc/passwd",
    });
    const res = await GET(makeRequest({ slug: "hubble-1929" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("path separators");
  });

  it("allows gbrain-backed source filenames with relative paths", async () => {
    const bytes = Buffer.from("print('hello')\n", "utf8");
    const object = await seedFileObject(
      "demo",
      "outputs/summary.py",
      bytes,
      "text/x-python",
    );
    setPage("summary-code", {
      type: "code",
      project: "demo",
      source_filename: "outputs/summary.py",
      source_file_object_id: object.id,
    });

    const res = await GET(makeRequest({ slug: "summary-code" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-python");
    expect(await res.text()).toBe("print('hello')\n");
  });

  it("404s when the file object is missing", async () => {
    setPage("hubble-1929", {
      type: "paper",
      project: "hubble-1929",
      source_filename: "hubble-1929.pdf",
      source_file_object_id: `sha256:${"a".repeat(64)}`,
    });
    const res = await GET(makeRequest({ slug: "hubble-1929" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("File object missing");
  });

  it("falls back to legacy project-disk bytes for pages without file refs", async () => {
    await fs.mkdir(path.join(tmpRoot, "projects", "hubble-1929"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmpRoot, "projects", "hubble-1929", "legacy.pdf"),
      "%PDF-1.4 legacy",
    );
    setPage("hubble-1929", {
      type: "paper",
      project: "hubble-1929",
      source_filename: "legacy.pdf",
    });

    const meta = await GET(makeRequest({ slug: "hubble-1929", metadata: "1" }));
    expect(meta.status).toBe(200);
    await expect(meta.json()).resolves.toMatchObject({
      source_filename: "legacy.pdf",
      mime: "application/pdf",
      legacyDiskFallback: true,
    });

    const readFileSpy = vi.spyOn(fs, "readFile");
    const res = await GET(makeRequest({ slug: "hubble-1929" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(await res.text()).toBe("%PDF-1.4 legacy");
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("returns metadata when metadata=1 is set", async () => {
    const object = await seedFileObject(
      "hubble-1929",
      "hubble-1929.pdf",
      Buffer.from("%PDF-1.4\n"),
      "application/pdf",
    );
    setPage("hubble-1929", {
      type: "paper",
      project: "hubble-1929",
      source_filename: "hubble-1929.pdf",
      source_file_object_id: object.id,
    });
    const res = await GET(
      makeRequest({ slug: "hubble-1929", metadata: "1" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe("hubble-1929");
    expect(body.project).toBe("hubble-1929");
    expect(body.fileObjectId).toBe(object.id);
    expect(body.source_filename).toBe("hubble-1929.pdf");
    expect(body.mime).toBe("application/pdf");
    expect(body.size).toBeGreaterThan(0);
  });

  it("streams the file bytes when metadata is not requested", async () => {
    const bytes = Buffer.from("hello world", "utf8");
    const object = await seedFileObject("demo", "notes.txt", bytes);
    setPage("notes-code", {
      type: "code",
      project: "demo",
      source_filename: "notes.txt",
      source_file_object_id: object.id,
    });
    const res = await GET(makeRequest({ slug: "notes-code" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    const returnedText = await res.text();
    expect(returnedText).toBe("hello world");
  });
});
