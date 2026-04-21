/**
 * GET /api/brain/file
 *
 * Project-scoped binary read. gbrain page metadata identifies a managed
 * file object, and GbrainFileStore streams bytes from the content-addressed
 * object store. Project folders are materialized cache only and are never
 * used as the authoritative binary source for new uploads. Pages created
 * before file objects existed can still be served from the materialized cache
 * when they only carry legacy source_filename frontmatter. Test overrides
 * still resolve through createGbrainFileStore and the same GbrainFileStore
 * adapter boundary.
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";
import {
  type GbrainFileObjectId,
  isPageFileRef,
  parseFileObjectId,
} from "@/brain/gbrain-data-contracts";
import { getBrainFileRouteFileStore } from "@/lib/testing/brain-file-route-overrides";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".json": "application/json",
  ".py": "text/x-python",
  ".ts": "text/x-typescript",
  ".js": "application/javascript",
  ".md": "text/markdown",
  ".sh": "text/x-shellscript",
  ".r": "text/x-r-source",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function resolveMime(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  const metadataOnly = url.searchParams.get("metadata") === "1";
  if (!slug || typeof slug !== "string") {
    return Response.json(
      { error: "Missing required query parameter: slug" },
      { status: 400 },
    );
  }

  try {
    await ensureBrainStoreReady();
    const page = await getBrainStore().getPage(slug);
    if (!page) {
      return Response.json(
        { error: `No gbrain page for slug '${slug}'` },
        { status: 404 },
      );
    }
    const fm = (page.frontmatter ?? {}) as Record<string, unknown>;
    const projectRaw =
      typeof fm.project === "string" && fm.project.length > 0
        ? fm.project
        : null;
    if (!projectRaw) {
      return Response.json(
        { error: `Page '${slug}' has no project frontmatter` },
        { status: 400 },
      );
    }
    let project: string;
    try {
      project = assertSafeProjectSlug(projectRaw);
    } catch (error) {
      if (error instanceof InvalidSlugError) {
        return Response.json(
          { error: `Invalid project slug: ${error.message}` },
          { status: 400 },
        );
      }
      throw error;
    }

    const legacySourceFilename = sourceFilenameFromFrontmatter(fm);
    const resolved = resolveFileRef(fm);
    if (!resolved) {
      if (legacySourceFilename) {
        if (!isSafeLegacySourceFilename(legacySourceFilename)) {
          return Response.json(
            { error: "source_filename must not contain path separators" },
            { status: 400 },
          );
        }
        return await serveLegacyDiskFile({
          slug,
          project,
          sourceFilename: legacySourceFilename,
          pageType: page.type,
          pageTitle: page.title,
          metadataOnly,
        });
      }
      return Response.json(
        { error: `Page '${slug}' has no gbrain file object reference` },
        { status: 400 },
      );
    }

    const opened = await getBrainFileRouteFileStore().openObjectStream(resolved.fileObjectId);
    if (!opened) {
      return Response.json(
        {
          error: `File object missing for slug '${slug}' (project=${project}, fileObjectId=${resolved.fileObjectId})`,
        },
        { status: 404 },
      );
    }
    const { metadata, stream } = opened;
    const mime = metadata.mime || resolved.mime || resolveMime(resolved.filename);

    if (metadataOnly) {
      return Response.json({
        slug,
        project,
        fileObjectId: metadata.id,
        source_filename: resolved.filename,
        size: metadata.sizeBytes,
        mime,
        type: page.type,
        title: page.title,
      });
    }

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": mime,
        "content-length": String(metadata.sizeBytes),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "brain file read failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

async function serveLegacyDiskFile(input: {
  slug: string;
  project: string;
  sourceFilename: string;
  pageType: string;
  pageTitle: string;
  metadataOnly: boolean;
}): Promise<Response> {
  const fullPath = path.join(
    getScienceSwarmProjectsRoot(),
    input.project,
    input.sourceFilename,
  );
  let stats;
  try {
    stats = await fs.stat(fullPath);
  } catch {
    return Response.json(
      {
        error: `File not on disk for slug '${input.slug}' (project=${input.project}, source_filename=${input.sourceFilename})`,
      },
      { status: 404 },
    );
  }
  if (!stats.isFile()) {
    return Response.json(
      {
        error: `Resolved path for slug '${input.slug}' is not a regular file (source_filename=${input.sourceFilename})`,
      },
      { status: 400 },
    );
  }

  const mime = resolveMime(input.sourceFilename);
  if (input.metadataOnly) {
    return Response.json({
      slug: input.slug,
      project: input.project,
      source_filename: input.sourceFilename,
      size: stats.size,
      mime,
      type: input.pageType,
      title: input.pageTitle,
      legacyDiskFallback: true,
    });
  }

  const stream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(stats.size),
    },
  });
}

function sourceFilenameFromFrontmatter(
  fm: Record<string, unknown>,
): string | null {
  return typeof fm.source_filename === "string" && fm.source_filename.length > 0
    ? fm.source_filename
    : null;
}

function isSafeLegacySourceFilename(filename: string): boolean {
  return (
    !filename.includes("/") &&
    !filename.includes("\\") &&
    path.basename(filename) === filename &&
    filename !== "." &&
    filename !== ".."
  );
}

function resolveFileRef(fm: Record<string, unknown>): {
  fileObjectId: GbrainFileObjectId;
  filename: string;
  mime?: string;
} | null {
  const sourceFilename = sourceFilenameFromFrontmatter(fm);

  const direct = parseFileObjectId(fm.source_file_object_id) ?? parseFileObjectId(fm.file_object_id);
  if (direct) {
    return {
      fileObjectId: direct.id,
      filename: sourceFilename ?? direct.sha256,
    };
  }

  const refs = Array.isArray(fm.file_refs)
    ? fm.file_refs.filter(isPageFileRef)
    : [];
  const ref =
    refs.find((candidate) => candidate.role === "source") ??
    refs.find((candidate) => candidate.role === "artifact");
  if (!ref) return null;
  return {
    fileObjectId: ref.fileObjectId,
    filename: sourceFilename ?? ref.filename,
    mime: ref.mime,
  };
}
