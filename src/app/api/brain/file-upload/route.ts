/**
 * POST /api/brain/file-upload
 *
 * Shared-token write path for the ScienceSwarm sandbox. The sandbox uploads
 * bytes to a gbrain-managed file object, then this route updates the target
 * page's artifact metadata. No project-folder write is performed. Test
 * overrides still resolve through createGbrainFileStore so the route stays on
 * the shared file adapter path.
 */

import path from "node:path";
import matter from "gray-matter";

import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";
import {
  isPageFileRef,
  pageFileRefFromObject,
  type GbrainPageFileRef,
} from "@/brain/gbrain-data-contracts";
import { GbrainFileTooLargeError } from "@/brain/gbrain-file-store";
import { requireSandboxToken } from "@/lib/sandbox-auth";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { getBrainFileUploadRouteFileStore } from "@/lib/testing/brain-file-upload-route-overrides";
import { readStudySlugFromFrontmatter } from "@/lib/studies/frontmatter";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const authError = requireSandboxToken(request);
  if (authError) return authError;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json(
      { error: "Request body must be multipart/form-data" },
      { status: 400 },
    );
  }

  const pageSlug = formData.get("page_slug");
  const filenameRaw = formData.get("filename");
  const file = formData.get("file");

  if (typeof pageSlug !== "string" || pageSlug.trim().length === 0) {
    return Response.json(
      { error: "Missing required field: page_slug" },
      { status: 400 },
    );
  }
  if (typeof filenameRaw !== "string" || filenameRaw.trim().length === 0) {
    return Response.json(
      { error: "Missing required field: filename" },
      { status: 400 },
    );
  }
  if (!(file instanceof File)) {
    return Response.json(
      { error: "Missing required field: file (binary upload)" },
      { status: 400 },
    );
  }

  const filename = filenameRaw.trim();
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    path.basename(filename) !== filename
  ) {
    return Response.json(
      { error: "filename must not contain path separators" },
      { status: 400 },
    );
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      {
        error: `file exceeds the 50 MB upload cap (got ${file.size} bytes)`,
      },
      { status: 413 },
    );
  }

  let uploadedBy: string;
  try {
    uploadedBy = getCurrentUserHandle();
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "SCIENCESWARM_USER_HANDLE is not set",
      },
      { status: 500 },
    );
  }

  try {
    await ensureBrainStoreReady();
    const slug = pageSlug.trim();
    const page = await getBrainStore().getPage(slug);
    if (!page) {
      return Response.json(
        { error: `No gbrain page for slug '${slug}'` },
        { status: 404 },
      );
    }

    const fm = (page.frontmatter ?? {}) as Record<string, unknown>;
    const projectRaw = readStudySlugFromFrontmatter(fm);
    if (!projectRaw) {
      return Response.json(
        { error: `Page '${slug}' has no study frontmatter` },
        { status: 400 },
      );
    }
    let project: string;
    try {
      project = assertSafeProjectSlug(projectRaw);
    } catch (error) {
      if (error instanceof InvalidSlugError) {
        return Response.json(
          { error: `Invalid study slug: ${error.message}` },
          { status: 400 },
        );
      }
      throw error;
    }

    const fileObject = await getBrainFileUploadRouteFileStore().putObject({
      project,
      filename,
      mime: file.type || "application/octet-stream",
      stream: file.stream(),
      uploadedBy,
      maxBytes: MAX_UPLOAD_BYTES,
      source: {
        kind: "sandbox_upload",
        route: "/api/brain/file-upload",
        pageSlug: slug,
      },
    });

    const existingFm = { ...(page.frontmatter ?? {}) } as Record<string, unknown>;
    const storedFm = { ...existingFm };
    const topLevelType =
      typeof existingFm.type === "string" ? existingFm.type : page.type;
    const topLevelTitle =
      typeof existingFm.title === "string" ? existingFm.title : page.title;
    delete storedFm.type;
    delete storedFm.title;

    const artifactFiles = normalizeArtifactFiles(existingFm.artifact_files);
    if (!artifactFiles.includes(fileObject.sha256)) {
      artifactFiles.push(fileObject.sha256);
    }

    const pageFileRef = pageFileRefFromObject(fileObject, "artifact", filename);
    const fileRefs = mergeFileRefs(existingFm.file_refs, pageFileRef);

    const nextFm = {
      type: topLevelType,
      title: topLevelTitle,
      ...storedFm,
      artifact_files: artifactFiles,
      file_refs: fileRefs,
    } as Record<string, unknown>;
    const nextMarkdown = matter.stringify(page.content, nextFm);
    const client = createInProcessGbrainClient();
    await client.putPage(slug, nextMarkdown);

    return Response.json({
      slug,
      filename,
      sha256: fileObject.sha256,
      fileObjectId: fileObject.id,
      size: fileObject.sizeBytes,
      path: fileObject.storagePath,
    });
  } catch (error) {
    if (error instanceof GbrainFileTooLargeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    const message =
      error instanceof Error ? error.message : "brain file-upload failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

function normalizeArtifactFiles(value: unknown): string[] {
  const existingSignatures = new Set<string>();
  const normalized: string[] = [];
  if (!Array.isArray(value)) return normalized;
  for (const entry of value) {
    const sha = normalizeShaEntry(entry);
    if (sha && !existingSignatures.has(sha)) {
      existingSignatures.add(sha);
      normalized.push(sha);
    }
  }
  return normalized;
}

function normalizeShaEntry(entry: unknown): string | null {
  if (typeof entry === "string" && /^[a-f0-9]{64}$/i.test(entry)) {
    return entry.toLowerCase();
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const legacySha = (entry as Record<string, unknown>).sha256;
    if (
      typeof legacySha === "string" &&
      /^[a-f0-9]{64}$/i.test(legacySha)
    ) {
      return legacySha.toLowerCase();
    }
  }
  return null;
}

function mergeFileRefs(
  existing: unknown,
  next: GbrainPageFileRef,
): GbrainPageFileRef[] {
  const refs = Array.isArray(existing)
    ? existing.filter(isPageFileRef)
    : [];
  const byId = new Map<string, GbrainPageFileRef>();
  for (const ref of refs) {
    byId.set(`${ref.role}:${ref.fileObjectId}:${ref.filename}`, ref);
  }
  byId.set(`${next.role}:${next.fileObjectId}:${next.filename}`, next);
  return Array.from(byId.values());
}
