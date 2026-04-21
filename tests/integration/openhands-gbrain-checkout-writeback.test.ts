import { describe, expect, it } from "vitest";
import type { BrainPage, BrainStore, ImportResult } from "@/brain/store";
import type {
  GbrainFileObject,
  IngestBatchResult,
} from "@/brain/gbrain-data-contracts";
import type { ContentType } from "@/brain/types";
import type { GbrainClient } from "@/brain/gbrain-client";
import type { GbrainFileStore } from "@/brain/gbrain-file-store";
import type { IngestService } from "@/brain/ingest/service";
import { buildGbrainCheckoutManifest } from "@/lib/openhands/gbrain-checkout";
import { writeBackOpenHandsFiles } from "@/lib/openhands/gbrain-writeback";

class FakeStore implements BrainStore {
  readonly listFilters: Array<{ limit?: number; type?: ContentType } | undefined> = [];
  constructor(private readonly pages: BrainPage[]) {}
  async search() {
    return [];
  }
  async getPage() {
    return null;
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
    this.listFilters.push(filters);
    let pages = this.pages;
    if (filters?.type) {
      pages = pages.filter((page) => page.type === filters.type);
    }
    return pages.slice(0, filters?.limit);
  }
  async importCorpus(): Promise<ImportResult> {
    throw new Error("not implemented");
  }
  async health() {
    return { ok: true, pageCount: this.pages.length };
  }
  async dispose() {}
}

describe("OpenHands gbrain checkout/writeback", () => {
  it("builds checkout manifests from gbrain file refs", async () => {
    const store = new FakeStore([
      {
        path: "paper-alpha",
        title: "Paper Alpha",
        type: "paper",
        content: "paper body",
        frontmatter: {
          project: "project-alpha",
          file_refs: [
            {
              role: "source",
              fileObjectId: `sha256:${"a".repeat(64)}`,
              sha256: "a".repeat(64),
              filename: "paper.pdf",
              mime: "application/pdf",
              sizeBytes: 12,
            },
          ],
        },
      },
      {
        path: "project-alpha",
        title: "Project Alpha",
        type: "project",
        content: "project body",
        frontmatter: {
          project: "project-alpha",
          file_refs: [
            {
              role: "source",
              fileObjectId: `sha256:${"c".repeat(64)}`,
              sha256: "c".repeat(64),
              filename: "project.json",
              mime: "application/json",
              sizeBytes: 12,
            },
          ],
        },
      },
    ]);
    const manifest = await buildGbrainCheckoutManifest({
      project: "project-alpha",
      createdBy: "@tester",
      checkoutId: "checkout-1",
      now: () => new Date("2026-04-16T00:00:00.000Z"),
      store,
    });

    expect(manifest).toMatchObject({
      checkoutId: "checkout-1",
      project: "project-alpha",
      rootName: "project-alpha",
      files: [
        {
          relativePath: "paper.pdf",
          fileObjectId: `sha256:${"a".repeat(64)}`,
          sourceSlug: "paper-alpha",
          writable: true,
        },
        {
          relativePath: "project.json",
          fileObjectId: `sha256:${"c".repeat(64)}`,
          sourceSlug: "project-alpha",
          writable: true,
        },
      ],
    });
    expect(store.listFilters).toContainEqual({ type: "paper", limit: 5000 });
    expect(
      store.listFilters.some((filters) => filters?.type === "project"),
    ).toBe(true);
  });

  it("deduplicates checkout manifest paths before materialization", async () => {
    const store = new FakeStore([
      {
        path: "paper-alpha-old",
        title: "Paper Alpha Old",
        type: "paper",
        content: "old paper body",
        frontmatter: {
          project: "project-alpha",
          file_refs: [
            {
              role: "source",
              fileObjectId: `sha256:${"a".repeat(64)}`,
              sha256: "a".repeat(64),
              filename: "paper.pdf",
              mime: "application/pdf",
              sizeBytes: 12,
            },
          ],
        },
      },
      {
        path: "paper-alpha-new",
        title: "Paper Alpha New",
        type: "paper",
        content: "new paper body",
        frontmatter: {
          project: "project-alpha",
          file_refs: [
            {
              role: "source",
              fileObjectId: `sha256:${"b".repeat(64)}`,
              sha256: "b".repeat(64),
              filename: "paper.pdf",
              mime: "application/pdf",
              sizeBytes: 24,
            },
          ],
        },
      },
    ]);

    const manifest = await buildGbrainCheckoutManifest({
      project: "project-alpha",
      createdBy: "@tester",
      checkoutId: "checkout-duplicate",
      store,
    });

    expect(manifest.files).toEqual([
      expect.objectContaining({
        relativePath: "paper.pdf",
        fileObjectId: `sha256:${"b".repeat(64)}`,
        sourceSlug: "paper-alpha-new",
      }),
    ]);
  });

  it("writes OpenHands output files back through the ingest service", async () => {
    const calls: string[] = [];
    const uploadedBy: string[] = [];
    const ingestService: IngestService = {
      async ingestFiles(files): Promise<IngestBatchResult> {
        calls.push(...files.map((file) => file.filename));
        uploadedBy.push(...files.map((file) => file.uploadedBy));
        return {
          slugs: files.map((file) => ({
            slug: file.filename.replace(/\W+/g, "-"),
            type: "artifact",
            file: {
              id: `sha256:${"b".repeat(64)}`,
              sha256: "b".repeat(64),
              sizeBytes: file.sizeBytes,
              mime: file.mime,
              originalFilename: file.filename,
              project: file.project,
              uploadedAt: "2026-04-16T00:00:00.000Z",
              uploadedBy: file.uploadedBy,
              source: file.source,
              storagePath: `objects/files/bb/${"b".repeat(64)}`,
              contentEncoding: "raw",
            },
            pageFileRef: {
              role: "checkout_output",
              fileObjectId: `sha256:${"b".repeat(64)}`,
              sha256: "b".repeat(64),
              filename: file.filename,
              mime: file.mime,
              sizeBytes: file.sizeBytes,
            },
          })),
          errors: [],
        };
      },
      async attachArtifactFile() {
        throw new Error("not used");
      },
      async attachSourceFile() {
        throw new Error("not used");
      },
    };

    const result = await writeBackOpenHandsFiles({
      checkoutId: "checkout-1",
      project: "project-alpha",
      uploadedBy: "@tester",
      ingestService,
      files: [
        {
          relativePath: "outputs/summary.py",
          mime: "text/x-python",
          sizeBytes: 7,
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("summary"));
              controller.close();
            },
          }),
        },
        {
          relativePath: "../escape.txt",
          sizeBytes: 1,
          stream: new ReadableStream(),
        },
      ],
    });

    expect(calls).toEqual(["outputs/summary.py"]);
    expect(uploadedBy).toEqual(["@tester"]);
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toEqual([
      { relativePath: "../escape.txt", reason: "invalid relative path" },
    ]);
  });

  it("stores non-convertible OpenHands output files as artifact pages", async () => {
    const fileObject: GbrainFileObject = {
      id: `sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
      sizeBytes: 7,
      mime: "image/png",
      originalFilename: "plot.png",
      project: "project-alpha",
      uploadedAt: "2026-04-16T00:00:00.000Z",
      uploadedBy: "@tester",
      source: {
        kind: "openhands_writeback",
        checkoutId: "checkout-1",
        relativePath: "figures/plot.png",
      },
      storagePath: `objects/files/dd/${"d".repeat(64)}`,
      contentEncoding: "raw",
    };
    const putFilenames: string[] = [];
    const putUploadedBy: string[] = [];
    const fileStore: GbrainFileStore = {
      async putObject(input) {
        putFilenames.push(input.filename);
        putUploadedBy.push(input.uploadedBy);
        return fileObject;
      },
      async getObject() {
        return fileObject;
      },
      async openObjectStream() {
        return null;
      },
      async hasObject() {
        return true;
      },
    };
    const pageWrites: Array<{ slug: string; content: string }> = [];
    const gbrain: GbrainClient = {
      async putPage(slug, content) {
        pageWrites.push({ slug, content });
        return { stdout: "ok", stderr: "" };
      },
      async linkPages() {
        return { stdout: "ok", stderr: "" };
      },
    };
    const ingestService: IngestService = {
      async ingestFiles(): Promise<IngestBatchResult> {
        throw new Error("not used");
      },
      async attachArtifactFile() {
        throw new Error("not used");
      },
      async attachSourceFile() {
        throw new Error("not used");
      },
    };

    const result = await writeBackOpenHandsFiles({
      checkoutId: "checkout-1",
      project: "project-alpha",
      uploadedBy: "@tester",
      ingestService,
      fileStore,
      gbrain,
      now: () => new Date("2026-04-16T00:00:00.000Z"),
      provenance: {
        prompt: "Regenerate the figure from the latest assay note.",
        tool: "OpenHands",
        sourceFiles: ["gbrain:wiki/notes/assay-summary"],
        sourceSnapshots: [
          {
            slug: "wiki/notes/assay-summary",
            title: "Assay summary",
            type: "note",
            workspacePath: "notes/assay-summary.md",
            fingerprint: "e".repeat(64),
            fingerprintKind: "content_sha256",
            observedAt: "2026-04-16T00:00:00.000Z",
          },
        ],
      },
      files: [
        {
          relativePath: "figures/plot.png",
          mime: "image/png",
          sizeBytes: 7,
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          }),
        },
      ],
    });

    expect(putFilenames).toEqual(["plot.png"]);
    expect(putUploadedBy).toEqual(["@tester"]);
    expect(result.errors).toEqual([]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({
      slug: "openhands-checkout-1-figures-plot-png",
      type: "artifact",
      pageFileRef: {
        filename: "figures/plot.png",
        fileObjectId: fileObject.id,
      },
    });
    expect(pageWrites[0].content).toContain("relative_path: figures/plot.png");
    expect(pageWrites[0].content).toContain("artifact_prompt: Regenerate the figure from the latest assay note.");
    expect(pageWrites[0].content).toContain("artifact_tool: OpenHands");
    expect(pageWrites[0].content).toContain("artifact_source_snapshots:");
    expect(pageWrites[0].content).toContain("- wiki/notes/assay-summary");
  });
});
