import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { GbrainClient } from "@/brain/gbrain-client";
import {
  type GbrainFileObject,
  type IngestInputFile,
  toFileObjectId,
} from "@/brain/gbrain-data-contracts";
import type { GbrainFileStore } from "@/brain/gbrain-file-store";
import { createIngestService } from "@/brain/ingest/service";

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function createRecordingFileStore(records: Uint8Array[] = []): GbrainFileStore {
  return {
    async putObject(input) {
      const bytes = await readBytes(input.stream);
      records.push(bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return {
        id: toFileObjectId(sha256),
        sha256,
        sizeBytes: bytes.byteLength,
        mime: input.mime,
        originalFilename: input.relativePath ?? input.filename,
        project: input.project,
        uploadedAt: "2026-04-16T00:00:00.000Z",
        uploadedBy: input.uploadedBy,
        source: input.source,
        storagePath: `objects/files/${sha256}`,
        contentEncoding: "raw",
      } satisfies GbrainFileObject;
    },
    async getObject() {
      return null;
    },
    async openObjectStream() {
      return null;
    },
    async hasObject() {
      return false;
    },
  };
}

function createGbrainRecorder(pages: Array<{ slug: string; content: string }> = []): GbrainClient {
  return {
    putPage: vi.fn(async (slug: string, content: string) => {
      pages.push({ slug, content });
      return { stdout: "", stderr: "" };
    }),
    linkPages: vi.fn(async () => ({ stdout: "", stderr: "" })),
  };
}

function baseInput(
  filename: string,
  mime: string,
  content: string,
): IngestInputFile {
  const bytes = new TextEncoder().encode(content);
  return {
    project: "project-alpha",
    filename,
    mime,
    sizeBytes: bytes.byteLength,
    stream: streamFromBytes(bytes),
    uploadedBy: "@tester",
    source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
  };
}

describe("IngestService", () => {
  it.each([
    ["CSV", "too-big.csv", "text/csv"],
    ["code", "too-big.py", "text/x-python"],
  ])(
    "rejects oversized %s uploads before storing bytes",
    async (_label, filename, mime) => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);

      const putObject = vi.fn();
      const fileStore: GbrainFileStore = {
        putObject,
        async getObject() {
          return null;
        },
        async openObjectStream() {
          return null;
        },
        async hasObject() {
          return false;
        },
      };
      const gbrain = createGbrainRecorder();
      const service = createIngestService({ fileStore, gbrain, maxBytes: 3 });

      try {
        const result = await service.ingestFiles([
          {
            project: "project-alpha",
            filename,
            mime,
            sizeBytes: 4,
            stream: streamFromBytes(new TextEncoder().encode("data")),
            uploadedBy: "@tester",
            source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
          },
        ]);
        await delay(10);

        expect(putObject).not.toHaveBeenCalled();
        expect(result.slugs).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].code).toBe("file_too_large");
        expect(unhandled).toEqual([]);
        expect(gbrain.putPage).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    },
  );

  it.each([
    ["CSV", "data.csv", "text/csv", "x,y\n1,2\n3,4\n"],
    ["code", "analysis.py", "text/x-python", "print('hello')\nprint('world')\n"],
  ])(
    "ingests %s without depending on ReadableStream.tee",
    async (_label, filename, mime, content) => {
      const input = baseInput(filename, mime, content);
      Object.defineProperty(input.stream, "tee", {
        value: () => {
          throw new Error("tee must not be called");
        },
      });
      const stored: Uint8Array[] = [];
      const pages: Array<{ slug: string; content: string }> = [];
      const service = createIngestService({
        fileStore: createRecordingFileStore(stored),
        gbrain: createGbrainRecorder(pages),
      });

      const result = await service.ingestFiles([input]);

      expect(result.errors).toEqual([]);
      expect(result.slugs).toHaveLength(1);
      expect(new TextDecoder().decode(stored[0])).toBe(content);
      expect(pages).toHaveLength(1);
      expect(pages[0].content).toContain("file_refs:");
    },
  );

  it("parses large CSVs with bounded rows while storing the full source object", async () => {
    const lines = ["gene,score"];
    for (let i = 0; i < 1_020; i += 1) {
      lines.push(`gene-${i},${i}`);
    }
    const content = `${lines.join("\n")}\n`;
    const stored: Uint8Array[] = [];
    const pages: Array<{ slug: string; content: string }> = [];
    const service = createIngestService({
      fileStore: createRecordingFileStore(stored),
      gbrain: createGbrainRecorder(pages),
    });

    const result = await service.ingestFiles([
      baseInput("data/results.csv", "text/csv", content),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.slugs[0].metrics?.rowCount).toBe(1000);
    expect(result.slugs[0].metrics?.columnCount).toBe(2);
    expect(new TextDecoder().decode(stored[0])).toBe(content);
    expect(pages[0].content).toContain("row_count: 1000");
    expect(pages[0].content).toContain("**Truncated:** yes");
  });

  it("attaches imported source files with source file refs", async () => {
    const service = createIngestService({
      fileStore: createRecordingFileStore(),
      gbrain: createGbrainRecorder(),
    });

    const result = await service.attachSourceFile({
      ...baseInput("notes/summary.md", "text/markdown", "# Summary\n"),
      pageSlug: "resources/imports/project-alpha/summary",
      source: { kind: "commit_import", sourcePath: "notes/summary.md" },
    });

    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.type).toBe("source");
    expect(result.slug).toBe("resources/imports/project-alpha/summary");
    expect(result.pageFileRef.role).toBe("source");
    expect(result.file.uploadedBy).toBe("@tester");
    expect(result.file.source).toEqual({
      kind: "commit_import",
      sourcePath: "notes/summary.md",
    });
  });

  it("preserves local-folder relative paths in source metadata and file refs", async () => {
    const pages: Array<{ slug: string; content: string }> = [];
    const service = createIngestService({
      fileStore: createRecordingFileStore(),
      gbrain: createGbrainRecorder(pages),
    });

    const result = await service.ingestFiles([
      {
        ...baseInput("results.csv", "text/csv", "gene,score\nabc,1\n"),
        relativePath: "data/results.csv",
        source: { kind: "commit_import", sourcePath: "data/results.csv" },
      },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.slugs[0].slug).toBe("data-results");
    expect(result.slugs[0].file.originalFilename).toBe("data/results.csv");
    expect(result.slugs[0].pageFileRef.filename).toBe("data/results.csv");
    expect(pages[0].content).toContain("source_filename: results.csv");
    expect(pages[0].content).toContain("source_path: data/results.csv");
    expect(pages[0].content).toContain("filename: data/results.csv");
  });

  it("adds a type suffix when a canonical slug already belongs to another artifact type", async () => {
    const service = createIngestService({
      fileStore: createRecordingFileStore(),
      gbrain: createGbrainRecorder(),
      findExistingPage: async (slug) =>
        slug === "analysis"
          ? {
              type: "dataset",
              frontmatter: {
                type: "dataset",
                source_filename: "analysis.csv",
              },
            }
          : null,
    });

    const result = await service.ingestFiles([
      baseInput("analysis.py", "text/x-python", "print('ok')\n"),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.slugs[0].slug).toBe("analysis-code");
  });

  it("reuses a canonical slug for an idempotent same-source upload", async () => {
    const service = createIngestService({
      fileStore: createRecordingFileStore(),
      gbrain: createGbrainRecorder(),
      findExistingPage: async (slug) =>
        slug === "analysis"
          ? {
              type: "dataset",
              frontmatter: {
                type: "dataset",
                source_filename: "analysis.csv",
              },
            }
          : null,
    });

    const result = await service.ingestFiles([
      baseInput("analysis.csv", "text/csv", "gene,score\nabc,1\n"),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.slugs[0].slug).toBe("analysis");
  });
});
