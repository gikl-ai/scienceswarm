import crypto from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FingerprintStrength, PaperLibraryFileSnapshot } from "./contracts";

export interface PathSafetyProblem {
  code:
    | "invalid_root"
    | "unsafe_path"
    | "path_too_long"
    | "case_collision"
    | "source_changed_since_approval"
    | "permission_denied";
  message: string;
  path?: string;
}

export interface PathSafetyResult {
  ok: boolean;
  problems: PathSafetyProblem[];
}

export function isPathInsideRoot(rootRealpath: string, candidatePath: string): boolean {
  const root = path.resolve(rootRealpath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function validateRelativeDestination(
  relativePath: string,
  options: {
    maxPathLength?: number;
    existingDestinations?: string[];
  } = {},
): PathSafetyResult {
  const problems: PathSafetyProblem[] = [];
  const normalized = relativePath.replace(/\\/g, "/");
  if (
    !normalized
    || normalized.startsWith("/")
    || normalized.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
  ) {
    problems.push({ code: "unsafe_path", message: "Destination must be a safe relative path.", path: relativePath });
  }

  if (normalized.length > (options.maxPathLength ?? 240)) {
    problems.push({ code: "path_too_long", message: "Destination path exceeds maximum length.", path: relativePath });
  }

  const caseFolded = normalized.toLowerCase();
  if ((options.existingDestinations ?? []).some((destination) => destination.toLowerCase() === caseFolded)) {
    problems.push({ code: "case_collision", message: "Destination collides by case-folded path.", path: relativePath });
  }

  return { ok: problems.length === 0, problems };
}

async function updateHashFromRange(
  hasher: crypto.Hash,
  filePath: string,
  position: number,
  length: number,
): Promise<void> {
  if (length <= 0) return;
  const handle = await open(filePath, "r");
  const buffer = Buffer.alloc(length);
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead > 0) hasher.update(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export async function computeQuickFileFingerprint(
  filePath: string,
  size: number,
  sampleBytes = 64 * 1024,
): Promise<{ fingerprint: string; strength: FingerprintStrength }> {
  const hasher = crypto.createHash("sha256");
  hasher.update(`quick-v1:${size}:`);

  if (size <= sampleBytes * 3) {
    const handle = await open(filePath, "r");
    const buffer = Buffer.alloc(Math.max(1, size));
    try {
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      if (bytesRead > 0) hasher.update(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    return { fingerprint: hasher.digest("hex"), strength: "sha256" };
  }

  await updateHashFromRange(hasher, filePath, 0, sampleBytes);
  await updateHashFromRange(hasher, filePath, Math.max(0, Math.floor(size / 2) - Math.floor(sampleBytes / 2)), sampleBytes);
  await updateHashFromRange(hasher, filePath, Math.max(0, size - sampleBytes), sampleBytes);
  return { fingerprint: hasher.digest("hex"), strength: "quick" };
}

export async function snapshotFile(
  rootPath: string,
  absoluteFilePath: string,
): Promise<{ ok: true; snapshot: PaperLibraryFileSnapshot } | { ok: false; problems: PathSafetyProblem[] }> {
  let rootRealpath: string;
  let fileRealpath: string;
  try {
    rootRealpath = await realpath(rootPath);
    fileRealpath = await realpath(absoluteFilePath);
  } catch {
    return { ok: false, problems: [{ code: "invalid_root", message: "Root or file cannot be resolved." }] };
  }

  if (!isPathInsideRoot(rootRealpath, fileRealpath)) {
    return { ok: false, problems: [{ code: "unsafe_path", message: "File is outside the approved root.", path: absoluteFilePath }] };
  }

  let fileStat;
  try {
    fileStat = await stat(fileRealpath);
  } catch {
    return { ok: false, problems: [{ code: "source_changed_since_approval", message: "Source file disappeared.", path: absoluteFilePath }] };
  }

  if (!fileStat.isFile()) {
    return { ok: false, problems: [{ code: "unsafe_path", message: "Snapshot target must be a file.", path: absoluteFilePath }] };
  }

  const { fingerprint, strength } = await computeQuickFileFingerprint(fileRealpath, fileStat.size);
  return {
    ok: true,
    snapshot: {
      relativePath: path.relative(rootRealpath, fileRealpath),
      rootRealpath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      fingerprint,
      fingerprintStrength: strength,
      inode: fileStat.ino,
      dev: fileStat.dev,
      symlink: fileRealpath !== path.resolve(absoluteFilePath),
    },
  };
}

export function compareSnapshot(
  approved: PaperLibraryFileSnapshot,
  current: PaperLibraryFileSnapshot,
): PathSafetyResult {
  const problems: PathSafetyProblem[] = [];
  if (approved.rootRealpath !== current.rootRealpath || approved.relativePath !== current.relativePath) {
    problems.push({ code: "source_changed_since_approval", message: "Source path changed since approval." });
  }
  if (approved.size !== current.size || approved.mtimeMs !== current.mtimeMs) {
    problems.push({ code: "source_changed_since_approval", message: "Source stat changed since approval." });
  }
  if (
    approved.fingerprintStrength === current.fingerprintStrength
    && approved.fingerprint !== current.fingerprint
  ) {
    problems.push({ code: "source_changed_since_approval", message: "Source fingerprint changed since approval." });
  }
  return { ok: problems.length === 0, problems };
}
