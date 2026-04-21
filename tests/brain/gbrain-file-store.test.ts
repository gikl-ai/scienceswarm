import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createGbrainFileStore,
  GbrainFileTooLargeError,
} from "@/brain/gbrain-file-store";

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const response = new Response(stream);
  return response.text();
}

describe("GbrainFileStore", () => {
  it("writes a stream, hashes bytes, and streams them back without absolute paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scienceswarm-file-store-"));
    try {
      const store = createGbrainFileStore({
        brainRoot: root,
        now: () => new Date("2026-04-16T00:00:00.000Z"),
      });
      const metadata = await store.putObject({
        project: "project-alpha",
        filename: "notes.txt",
        mime: "text/plain",
        stream: streamFromBytes(new TextEncoder().encode("hello world")),
        uploadedBy: "@tester",
        maxBytes: 1024,
        source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
      });

      expect(metadata.id).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(metadata.sizeBytes).toBe(11);
      expect(path.isAbsolute(metadata.storagePath)).toBe(false);
      expect(metadata.uploadedAt).toBe("2026-04-16T00:00:00.000Z");

      const opened = await store.openObjectStream(metadata.id);
      expect(opened?.metadata).toEqual(metadata);
      expect(await streamToText(opened!.stream)).toBe("hello world");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dedupes identical bytes under different filenames", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scienceswarm-file-store-"));
    try {
      const store = createGbrainFileStore({ brainRoot: root });
      const first = await store.putObject({
        project: "project-alpha",
        filename: "a.txt",
        mime: "text/plain",
        stream: streamFromBytes(new TextEncoder().encode("same")),
        uploadedBy: "@tester",
        maxBytes: 1024,
        source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
      });
      const second = await store.putObject({
        project: "project-alpha",
        filename: "b.txt",
        mime: "text/plain",
        stream: streamFromBytes(new TextEncoder().encode("same")),
        uploadedBy: "@tester",
        maxBytes: 1024,
        source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
      });
      expect(second).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects over maxBytes and removes partial temp files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scienceswarm-file-store-"));
    try {
      const store = createGbrainFileStore({ brainRoot: root });
      await expect(
        store.putObject({
          project: "project-alpha",
          filename: "big.bin",
          mime: "application/octet-stream",
          stream: streamFromBytes(new Uint8Array([1, 2, 3, 4])),
          uploadedBy: "@tester",
          maxBytes: 3,
          source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
        }),
      ).rejects.toBeInstanceOf(GbrainFileTooLargeError);
      const tmpPath = path.join(root, "objects", "tmp");
      const entries = await readdir(tmpPath).catch(() => []);
      expect(entries).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a committed data file when metadata writing fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scienceswarm-file-store-"));
    const bytes = new TextEncoder().encode("metadata failure");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dataPath = path.join(root, "objects", "files", sha256.slice(0, 2), sha256);
    const metadataPath = `${dataPath}.json`;
    const circularSource: Record<string, unknown> = {
      kind: "dashboard_upload",
      route: "/api/workspace/upload",
    };
    circularSource.self = circularSource;

    try {
      const store = createGbrainFileStore({ brainRoot: root });
      await expect(
        store.putObject({
          project: "project-alpha",
          filename: "notes.txt",
          mime: "text/plain",
          stream: streamFromBytes(bytes),
          uploadedBy: "@tester",
          maxBytes: 1024,
          source: circularSource as {
            kind: "dashboard_upload";
            route: "/api/workspace/upload";
          },
        }),
      ).rejects.toThrow("circular");

      expect(existsSync(dataPath)).toBe(false);
      expect(existsSync(metadataPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null for missing objects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scienceswarm-file-store-"));
    try {
      const store = createGbrainFileStore({ brainRoot: root });
      expect(await store.openObjectStream(`sha256:${"a".repeat(64)}`)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
