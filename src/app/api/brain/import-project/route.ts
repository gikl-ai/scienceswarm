/**
 * POST /api/brain/import-project
 *
 * Commit an approved import preview into the configured brain.
 * Body: { folder, preview, projectSlug? }
 */

import type { ImportPreview } from "@/brain/types";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { createIngestService } from "@/brain/ingest/service";
import { commitImportedProject } from "@/lib/import/commit-import";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { getBrainConfig, isErrorResponse } from "../_shared";

interface ImportedFileRecord {
  path: string;
  name: string;
  type: string;
  size: number;
  content?: string;
  hash?: string;
  metadata?: Record<string, unknown>;
}

interface ImportFolderPayload {
  name: string;
  basePath?: string;
  backend?: string;
  totalFiles: number;
  detectedItems?: number;
  detectedBytes?: number;
  files: ImportedFileRecord[];
  tree?: unknown[];
  analysis?: string;
  projects?: ImportPreview["projects"];
  duplicateGroups?: ImportPreview["duplicateGroups"];
  warnings?: ImportPreview["warnings"];
}

interface ImportCommitBody {
  folder?: ImportFolderPayload;
  preview?: ImportPreview;
  projectSlug?: string;
}

export async function POST(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  let body: ImportCommitBody;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as ImportCommitBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { folder, preview, projectSlug } = body;
  if (!isValidFolder(folder)) {
    return Response.json({ error: "Missing or invalid folder payload" }, { status: 400 });
  }
  if (!isValidPreview(preview)) {
    return Response.json({ error: "Missing or invalid preview payload" }, { status: 400 });
  }
  if (projectSlug !== undefined) {
    if (typeof projectSlug !== "string") {
      return Response.json({ error: "projectSlug must be a string" }, { status: 400 });
    }

    try {
      assertSafeProjectSlug(projectSlug);
    } catch {
      return Response.json({ error: "projectSlug must be a safe bare slug" }, { status: 400 });
    }
  }

  let uploadedBy: string;
  try {
    uploadedBy = getCurrentUserHandle();
  } catch {
    return Response.json(
      { error: "Server attribution is not configured" },
      { status: 500 },
    );
  }

  try {
    const gbrain = createInProcessGbrainClient();
    const result = await commitImportedProject(
      {
        folder: sanitizeFolderPayload(folder),
        preview,
        projectSlug,
      },
      undefined,
      {
        enableGbrain: true,
        gbrain,
        ingestService: createIngestService({ gbrain }),
        uploadedBy,
      },
    );

    return Response.json({
      ...result,
      indexing: {
        ok: true,
        imported: result.sourcePagePaths.length + 1,
        skipped: 0,
        errors: [],
        durationMs: 0,
        mode: "gbrain-direct",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import commit failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

function isValidFolder(folder: ImportCommitBody["folder"]): folder is ImportFolderPayload {
  return Boolean(
    folder &&
      typeof folder.name === "string" &&
      typeof folder.totalFiles === "number" &&
      Array.isArray(folder.files),
  );
}

function isValidPreview(preview: ImportCommitBody["preview"]): preview is ImportPreview {
  return Boolean(
    preview &&
      typeof preview.analysis === "string" &&
      typeof preview.backend === "string" &&
      Array.isArray(preview.files) &&
      Array.isArray(preview.projects) &&
      Array.isArray(preview.duplicateGroups) &&
      Array.isArray(preview.warnings),
  );
}

function sanitizeFolderPayload(folder: ImportFolderPayload): ImportFolderPayload {
  return {
    ...folder,
    files: folder.files.map((file) => ({
      path: file.path,
      name: file.name,
      type: file.type,
      size: file.size,
      content: file.content,
      hash: file.hash,
      metadata: file.metadata,
    })),
  };
}
