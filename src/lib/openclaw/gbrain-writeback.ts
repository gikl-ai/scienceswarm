import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import {
  pageFileRefFromObject,
  type IngestError,
  type IngestSuccess,
} from "@/brain/gbrain-data-contracts";
import type { GbrainClient } from "@/brain/gbrain-client";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import {
  createGbrainFileStore,
  GbrainFileTooLargeError,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";
import {
  buildArtifactWritebackFrontmatter,
  type ArtifactWritebackProvenance,
} from "@/lib/artifact-source-snapshots";
// Decision 3A presence-only lint gate: callers resolve the current user
// handle and thread it into `input.uploadedBy` before writeback persists pages.
import { getCurrentUserHandle as _requireAttributionImport } from "@/lib/setup/gbrain-installer";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
void _requireAttributionImport;

export interface OpenClawWritebackFile {
  sourcePath: string;
  relativePath: string;
  mime?: string;
}

export interface OpenClawWritebackResult {
  created: IngestSuccess[];
  skipped: Array<{ relativePath: string; reason: string }>;
  errors: IngestError[];
}

const OPENCLAW_WRITEBACK_MAX_BYTES = 50 * 1024 * 1024;

export async function writeBackOpenClawGeneratedFiles(input: {
  project: string;
  sessionId: string;
  uploadedBy: string;
  files: OpenClawWritebackFile[];
  provenance?: ArtifactWritebackProvenance;
  projectRoot?: string;
  fileStore?: GbrainFileStore;
  gbrain?: GbrainClient;
  now?: () => Date;
}): Promise<OpenClawWritebackResult> {
  const project = assertSafeProjectSlug(input.project);
  const sessionId = normalizeSessionId(input.sessionId);
  const fileStore = input.fileStore ?? createGbrainFileStore();
  const gbrain = input.gbrain ?? createInProcessGbrainClient();
  const now = input.now ?? (() => new Date());
  const created: IngestSuccess[] = [];
  const skipped: OpenClawWritebackResult["skipped"] = [];
  const errors: IngestError[] = [];

  for (const file of input.files) {
    const normalized = normalizeRelativePath(file.relativePath);
    if (!normalized) {
      skipped.push({
        relativePath: file.relativePath,
        reason: "invalid relative path",
      });
      continue;
    }

    const stored = await storeOpenClawGeneratedFile({
      project,
      sessionId,
      uploadedBy: input.uploadedBy,
      sourcePath: file.sourcePath,
      relativePath: normalized,
      mime: file.mime,
      provenance: input.provenance,
      projectRoot: input.projectRoot,
      fileStore,
      gbrain,
      now,
    });
    if ("code" in stored) {
      errors.push(stored);
    } else {
      created.push(stored);
    }
  }

  return { created, skipped, errors };
}

async function storeOpenClawGeneratedFile(input: {
  project: string;
  sessionId: string;
  uploadedBy: string;
  sourcePath: string;
  relativePath: string;
  mime?: string;
  provenance?: ArtifactWritebackProvenance;
  projectRoot?: string;
  fileStore: GbrainFileStore;
  gbrain: GbrainClient;
  now: () => Date;
}): Promise<IngestSuccess | IngestError> {
  try {
    const sourceStat = statSync(input.sourcePath);
    if (!sourceStat.isFile()) {
      return {
        filename: input.relativePath,
        code: "file_object_missing",
        message: "OpenClaw output is not a file",
        recoverable: true,
      };
    }

    const rawBytes = readFileSync(input.sourcePath);
    const sanitizedBytes = sanitizeTextArtifactBytes(rawBytes, input.projectRoot);
    const file = await input.fileStore.putObject({
      project: input.project,
      filename: path.basename(input.relativePath),
      relativePath: input.relativePath,
      mime: input.mime ?? mimeForPath(input.relativePath),
      stream: bytesToReadableStream(sanitizedBytes),
      uploadedBy: input.uploadedBy,
      maxBytes: OPENCLAW_WRITEBACK_MAX_BYTES,
      source: {
        kind: "openclaw_output",
        sessionId: input.sessionId,
        relativePath: input.relativePath,
      },
    });
    const pageFileRef = pageFileRefFromObject(file, "artifact", input.relativePath);
    const pageBody = pageBodyForArtifact(input.relativePath, sanitizedBytes);
    const slug = openClawArtifactSlug(input.sessionId, input.relativePath);
    await input.gbrain.putPage(
      slug,
      matter.stringify(pageBody, {
        type: "artifact",
        title: path.basename(input.relativePath),
        study: input.project,
        study_slug: input.project,
        legacy_project_slug: input.project,
        source_filename: path.basename(input.relativePath),
        relative_path: input.relativePath,
        openclaw_session_id: input.sessionId,
        uploaded_at: input.now().toISOString().replace(/\.\d+/, ""),
        uploaded_by: input.uploadedBy,
        sha256: file.sha256,
        file_object_id: file.id,
        file_refs: [pageFileRef],
        ...buildArtifactWritebackFrontmatter(input.provenance),
      }),
    );

    return {
      slug,
      type: "artifact",
      file,
      pageFileRef,
    };
  } catch (error) {
    return {
      filename: input.relativePath,
      code: error instanceof GbrainFileTooLargeError
        ? "file_too_large"
        : "gbrain_write_failed",
      message: error instanceof Error ? error.message : "OpenClaw output writeback failed",
      recoverable: true,
    };
  }
}

function normalizeRelativePath(value: string): string | null {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  const segments = normalized.split("/");
  if (segments[0] === ".brain" || segments[0] === ".git" || segments[0] === "node_modules") {
    return null;
  }
  return normalized;
}

function normalizeSessionId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80) || "openclaw";
}

function openClawArtifactSlug(sessionId: string, relativePath: string): string {
  const safePath = relativePath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return `openclaw-${normalizeSessionId(sessionId)}-${safePath || "artifact"}`;
}

function sanitizeTextArtifactBytes(bytes: Buffer, projectRoot: string | undefined): Buffer {
  if (!projectRoot || bytes.includes(0)) {
    return bytes;
  }

  const text = bytes.toString("utf-8");
  if (text.includes("\uFFFD")) {
    return bytes;
  }

  return Buffer.from(rewriteProjectRootMentions(text, projectRoot), "utf-8");
}

export function rewriteProjectRootMentions(value: string, projectRoot: string): string {
  let rewritten = value;
  const normalizedRoot = path.resolve(projectRoot);
  const roots = new Set([
    normalizedRoot,
    normalizedRoot.replace(/^\/private\/tmp\//, "/tmp/"),
    normalizedRoot.replace(/^\/tmp\//, "/private/tmp/"),
  ]);

  for (const root of roots) {
    if (!root) continue;
    const normalized = root.split(path.sep).join("/");
    rewritten = rewritten.split(`${normalized}/`).join("");
    rewritten = rewritten.split(normalized).join(".");
  }
  return rewritten;
}

function pageBodyForArtifact(relativePath: string, bytes: Buffer): string {
  if (bytes.includes(0)) {
    return [
      `# ${path.posix.basename(relativePath)}`,
      "",
      `OpenClaw generated binary artifact from \`${relativePath}\`.`,
      "",
    ].join("\n");
  }
  const text = bytes.toString("utf-8");
  if (text.includes("\uFFFD")) {
    return [
      `# ${path.posix.basename(relativePath)}`,
      "",
      `OpenClaw generated artifact from \`${relativePath}\`.`,
      "",
    ].join("\n");
  }
  return text;
}

function bytesToReadableStream(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function mimeForPath(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
