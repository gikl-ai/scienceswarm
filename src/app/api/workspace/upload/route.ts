// POST /api/workspace/upload
//
// Canonical dashboard ingest entry point. The route owns multipart parsing,
// study/user validation, and response-shape compatibility; the shared
// IngestService owns byte storage, conversion, and gbrain page writes.
// Test overrides still resolve through createIngestService so this route stays
// on the shared gbrain adapter path.

import type { IngestService } from "@/brain/ingest/service";
import { compileAffectedConceptsForSource } from "@/brain/compile-affected";
import { loadBrainConfig } from "@/brain/config";
import type { IngestInputFile } from "@/brain/gbrain-data-contracts";
import type { BrainConfig } from "@/brain/types";
import { createLLMClient, type LLMClient } from "@/brain/llm";
import { resetBrainStore } from "@/brain/store";
import { isLocalRequest } from "@/lib/local-guard";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { getWorkspaceUploadRouteIngestService } from "@/lib/testing/workspace-upload-route-overrides";

export const runtime = "nodejs";

interface SuccessEntry {
  slug: string;
  type: "paper" | "dataset" | "code" | "artifact" | "source";
  path: string;
  sha256: string;
  fileObjectId: string;
  page_count?: number;
  word_count?: number;
  row_count?: number;
  column_count?: number;
  line_count?: number;
  language?: string;
  compilation?: UploadCompilationSummary;
}

interface ErrorEntry {
  filename: string;
  code: string;
  message: string;
}

interface UploadResponseBody {
  slugs: SuccessEntry[];
  errors: ErrorEntry[];
}

interface UploadCompilationSummary {
  ok: boolean;
  pagesCompiled: number;
  contradictionsFound: number;
  backlinksAdded: number;
  error?: string;
}

function readStudyScopedId(formData: FormData): string | null {
  const fields = ["studyId", "studySlug", "study", "projectId"] as const;
  for (const field of fields) {
    const value = formData.get(field);
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const formData = await readFormData(request);
  if (!formData) {
    return Response.json(
      { error: "Expected multipart/form-data body" },
      { status: 400 },
    );
  }

  const files = formData.getAll("files").filter(
    (value): value is File => value instanceof File,
  );
  if (files.length === 0) {
    return Response.json(
      { error: "No files provided. Attach files under the 'files' field." },
      { status: 400 },
    );
  }

  const projectId = readStudyScopedId(formData);
  if (!projectId) {
    return Response.json(
      { error: "studyId is required for workspace uploads." },
      { status: 400 },
    );
  }

  let safeProjectId: string;
  try {
    safeProjectId = assertSafeProjectSlug(projectId);
  } catch (error) {
    if (error instanceof InvalidSlugError) {
      return Response.json(
        { error: `Invalid studyId: ${error.message}` },
        { status: 400 },
      );
    }
    throw error;
  }

  let userHandle: string;
  try {
    userHandle = getCurrentUserHandle();
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

  const ingestFiles: IngestInputFile[] = files.map((file) => ({
    project: safeProjectId,
    filename: file.name,
    mime: file.type || "application/octet-stream",
    sizeBytes: file.size,
    stream: file.stream(),
    uploadedBy: userHandle,
    source: { kind: "dashboard_upload", route: "/api/workspace/upload" },
  }));

  const result = await getWorkspaceUploadRouteIngestService().ingestFiles(ingestFiles);
  const compilationBySlug = await compileUploadedSourcesWithTimeout(
    loadBrainConfig(),
    result.slugs,
    10_000,
  );
  const response: UploadResponseBody = {
    slugs: result.slugs.map((entry) => ({
      slug: entry.slug,
      type: entry.type,
      path: entry.file.storagePath,
      sha256: entry.file.sha256,
      fileObjectId: entry.file.id,
      page_count: entry.metrics?.pageCount,
      word_count: entry.metrics?.wordCount,
      row_count: entry.metrics?.rowCount,
      column_count: entry.metrics?.columnCount,
      line_count: entry.metrics?.lineCount,
      language: entry.metrics?.language,
      compilation: compilationBySlug.get(entry.slug),
    })),
    errors: result.errors.map((entry) => ({
      filename: entry.filename,
      code: entry.code,
      message: entry.message,
    })),
  };

  const anyOk = response.slugs.length > 0;
  const hasOversized = response.errors.some((entry) => entry.code === "file_too_large");
  if (!anyOk && hasOversized) {
    return Response.json(response, { status: 413 });
  }
  const hasFatal = response.errors.some(
    (entry) => entry.code === "text_layer_too_thin" || entry.code === "invalid_pdf",
  );
  if (!anyOk && hasFatal) {
    return Response.json(response, { status: 400 });
  }
  return Response.json(response);
}

async function readFormData(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

async function compileUploadedSources(
  config: BrainConfig | null,
  entries: Awaited<ReturnType<IngestService["ingestFiles"]>>["slugs"],
): Promise<Map<string, UploadCompilationSummary>> {
  const summaries = new Map<string, UploadCompilationSummary>();
  if (!config || entries.length === 0) return summaries;
  const llm = createBestEffortLLM(config);
  try {
    for (const entry of entries) {
      try {
        const result = await compileAffectedConceptsForSource({
          sourceSlug: entry.slug,
          sourceTitle: entry.file.originalFilename,
          sourceType: entry.type,
          config,
          llm,
          maxConcepts: 4,
        });
        summaries.set(entry.slug, {
          ok: true,
          pagesCompiled: result.pagesCompiled,
          contradictionsFound: result.contradictionsFound,
          backlinksAdded: result.backlinksAdded,
        });
      } catch {
        summaries.set(entry.slug, {
          ok: false,
          pagesCompiled: 0,
          contradictionsFound: 0,
          backlinksAdded: 0,
          error: "Compilation failed",
        });
      }
    }
  } finally {
    await resetBrainStore().catch(() => {});
  }
  return summaries;
}

async function compileUploadedSourcesWithTimeout(
  config: BrainConfig | null,
  entries: Awaited<ReturnType<IngestService["ingestFiles"]>>["slugs"],
  timeoutMs: number,
): Promise<Map<string, UploadCompilationSummary>> {
  const compilation = compileUploadedSources(config, entries);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Map<string, UploadCompilationSummary>>((resolve) => {
    timeout = setTimeout(() => resolve(new Map()), timeoutMs);
  });
  const result = await Promise.race([compilation, timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function createBestEffortLLM(config: BrainConfig): LLMClient {
  try {
    return createLLMClient(config);
  } catch (error) {
    return unavailableLLM(error);
  }
}

function unavailableLLM(reason: unknown): LLMClient {
  const error = reason instanceof Error ? reason : new Error("LLM unavailable");
  return {
    async complete() {
      throw error;
    },
  };
}
