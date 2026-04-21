import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  type GbrainFileObject,
  type GbrainFileObjectId,
  type IngestInputFile,
  parseFileObjectId,
  toFileObjectId,
} from "./gbrain-data-contracts";
import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";

export interface PutFileObjectInput extends Omit<IngestInputFile, "sizeBytes"> {
  maxBytes: number;
}

export interface GbrainFileStore {
  putObject(input: PutFileObjectInput): Promise<GbrainFileObject>;
  getObject(id: GbrainFileObjectId): Promise<GbrainFileObject | null>;
  openObjectStream(id: GbrainFileObjectId): Promise<{
    metadata: GbrainFileObject;
    stream: ReadableStream<Uint8Array>;
  } | null>;
  hasObject(id: GbrainFileObjectId): Promise<boolean>;
}

export interface GbrainFileStoreOptions {
  brainRoot?: string;
  now?: () => Date;
}

export class GbrainFileTooLargeError extends Error {
  readonly code = "file_too_large";
  constructor(
    readonly maxBytes: number,
    readonly observedBytes: number,
  ) {
    super(`file exceeds the ${formatBytes(maxBytes)} upload cap (got ${observedBytes} bytes)`);
    this.name = "GbrainFileTooLargeError";
  }
}

export function createGbrainFileStore(
  options: GbrainFileStoreOptions = {},
): GbrainFileStore {
  const root = path.resolve(options.brainRoot ?? getScienceSwarmBrainRoot());
  const now = options.now ?? (() => new Date());

  function objectRelativePath(sha256: string): string {
    return path.join("objects", "files", sha256.slice(0, 2), sha256);
  }

  function metadataRelativePath(sha256: string): string {
    return `${objectRelativePath(sha256)}.json`;
  }

  function absolute(relativePath: string): string {
    return path.join(root, relativePath);
  }

  async function readMetadata(
    id: GbrainFileObjectId,
  ): Promise<GbrainFileObject | null> {
    const parsed = parseFileObjectId(id);
    if (!parsed) return null;
    try {
      const raw = await fs.readFile(absolute(metadataRelativePath(parsed.sha256)), "utf-8");
      const metadata = JSON.parse(raw) as GbrainFileObject;
      if (metadata.id !== id || metadata.sha256.toLowerCase() !== parsed.sha256) {
        return null;
      }
      if (path.isAbsolute(metadata.storagePath)) {
        return null;
      }
      return {
        ...metadata,
        sha256: metadata.sha256.toLowerCase(),
        id,
      };
    } catch {
      return null;
    }
  }

  async function writeMetadata(metadata: GbrainFileObject): Promise<void> {
    const parsed = parseFileObjectId(metadata.id);
    if (!parsed) throw new Error("Invalid file object id");
    const target = absolute(metadataRelativePath(parsed.sha256));
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
      await fs.rename(temp, target);
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
  }

  return {
    async putObject(input: PutFileObjectInput): Promise<GbrainFileObject> {
      await fs.mkdir(absolute(path.join("objects", "tmp")), { recursive: true });
      const temp = absolute(path.join("objects", "tmp", `${randomUUID()}.upload`));
      const handle = await fs.open(temp, "w");
      const hash = createHash("sha256");
      let sizeBytes = 0;
      let committed = false;
      let committedTarget: string | null = null;

      try {
        const reader = input.stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          sizeBytes += chunk.byteLength;
          if (sizeBytes > input.maxBytes) {
            throw new GbrainFileTooLargeError(input.maxBytes, sizeBytes);
          }
          hash.update(chunk);
          await handle.write(chunk);
        }
        await handle.sync();
        await handle.close();

        const sha256 = hash.digest("hex");
        const id = toFileObjectId(sha256);
        const storagePath = objectRelativePath(sha256);
        const target = absolute(storagePath);
        await fs.mkdir(path.dirname(target), { recursive: true });

        const existing = await readMetadata(id);
        if (existing) {
          const stat = await fs.stat(absolute(existing.storagePath)).catch(() => null);
          if (stat?.isFile() && stat.size === existing.sizeBytes) {
            await fs.unlink(temp).catch(() => {});
            committed = true;
            return existing;
          }
        }

        try {
          await fs.rename(temp, target);
          committedTarget = target;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") throw error;
          await fs.unlink(temp).catch(() => {});
        }

        const metadata: GbrainFileObject = {
          id,
          sha256,
          sizeBytes,
          mime: input.mime || "application/octet-stream",
          originalFilename: input.relativePath ?? input.filename,
          project: input.project,
          uploadedAt: now().toISOString(),
          uploadedBy: input.uploadedBy,
          source: input.source,
          storagePath,
          contentEncoding: "raw",
        };
        await writeMetadata(metadata);
        committed = true;
        return metadata;
      } finally {
        await handle.close().catch(() => {});
        if (!committed) {
          await fs.unlink(temp).catch(() => {});
          if (committedTarget) {
            await fs.unlink(committedTarget).catch(() => {});
          }
        }
      }
    },

    async getObject(id: GbrainFileObjectId): Promise<GbrainFileObject | null> {
      const metadata = await readMetadata(id);
      if (!metadata) return null;
      const stat = await fs.stat(absolute(metadata.storagePath)).catch(() => null);
      if (!stat?.isFile() || stat.size !== metadata.sizeBytes) {
        return null;
      }
      return metadata;
    },

    async openObjectStream(id: GbrainFileObjectId) {
      const metadata = await this.getObject(id);
      if (!metadata) return null;
      const stream = Readable.toWeb(createReadStream(absolute(metadata.storagePath))) as ReadableStream<Uint8Array>;
      return { metadata, stream };
    },

    async hasObject(id: GbrainFileObjectId): Promise<boolean> {
      return (await this.getObject(id)) !== null;
    },
  };
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (Number.isInteger(mb)) return `${mb} MB`;
  return `${bytes} bytes`;
}
