import crypto from "node:crypto";
import fs from "node:fs";
import { open, readFile } from "node:fs/promises";

export const LARGE_FILE_FINGERPRINT_THRESHOLD_BYTES = 10_000_000;
const LARGE_FILE_HASH_CHUNK_BYTES = 256 * 1024;

function createHasher() {
  return crypto.createHash("sha256");
}

function updateHasherWithLargeFileSync(hasher: crypto.Hash, filePath: string, size: number): void {
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(Math.max(1, Math.min(LARGE_FILE_HASH_CHUNK_BYTES, size)));
  try {
    let position = 0;
    while (position < size) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead <= 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function updateHasherWithLargeFile(hasher: crypto.Hash, filePath: string, size: number): Promise<void> {
  const handle = await open(filePath, "r");
  const buffer = Buffer.alloc(Math.max(1, Math.min(LARGE_FILE_HASH_CHUNK_BYTES, size)));
  try {
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead <= 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

export function computeLegacyPathSizeFingerprint(relativePath: string, size: number): string {
  return createHasher().update(`${relativePath}:${size}`).digest("hex");
}

export function computeFileFingerprintSync(filePath: string, size: number): string {
  if (size <= LARGE_FILE_FINGERPRINT_THRESHOLD_BYTES) {
    return createHasher().update(fs.readFileSync(filePath)).digest("hex");
  }

  const hasher = createHasher();
  updateHasherWithLargeFileSync(hasher, filePath, size);
  return hasher.digest("hex");
}

export async function computeFileFingerprint(filePath: string, size: number): Promise<string> {
  if (size <= LARGE_FILE_FINGERPRINT_THRESHOLD_BYTES) {
    return createHasher().update(await readFile(filePath)).digest("hex");
  }

  const hasher = createHasher();
  await updateHasherWithLargeFile(hasher, filePath, size);
  return hasher.digest("hex");
}
