import path from "node:path";
import matter from "gray-matter";

import {
  pageFileRefFromObject,
  type IngestError,
  type IngestInputFile,
  type IngestSuccess,
  type OpenHandsWritebackResult,
} from "@/brain/gbrain-data-contracts";
import type { GbrainClient } from "@/brain/gbrain-client";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import {
  createGbrainFileStore,
  GbrainFileTooLargeError,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";
import {
  createIngestService,
  isSupportedIngestFilename,
  type IngestService,
} from "@/brain/ingest/service";
import {
  buildArtifactWritebackFrontmatter,
  type ArtifactWritebackProvenance,
} from "@/lib/artifact-source-snapshots";
// Decision 3A presence-only lint gate: callers resolve the current user
// handle and thread it into `input.uploadedBy` before writeback persists pages.
import { getCurrentUserHandle as _requireAttributionImport } from "@/lib/setup/gbrain-installer";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
void _requireAttributionImport;

export interface OpenHandsWritebackFile {
  relativePath: string;
  mime?: string;
  sizeBytes: number;
  stream: ReadableStream<Uint8Array>;
}

export async function writeBackOpenHandsFiles(input: {
  checkoutId: string;
  project: string;
  uploadedBy: string;
  files: OpenHandsWritebackFile[];
  provenance?: ArtifactWritebackProvenance;
  ingestService?: IngestService;
  fileStore?: GbrainFileStore;
  gbrain?: GbrainClient;
  now?: () => Date;
}): Promise<OpenHandsWritebackResult> {
  const project = assertSafeProjectSlug(input.project);
  const ingestService = input.ingestService ?? createIngestService();
  const fileStore = input.fileStore ?? createGbrainFileStore();
  const gbrain = input.gbrain ?? createInProcessGbrainClient();
  const now = input.now ?? (() => new Date());
  const uploadedBy = input.uploadedBy;
  const skipped: OpenHandsWritebackResult["skipped"] = [];
  const ingestFiles: IngestInputFile[] = [];
  const genericFiles: Array<{
    file: OpenHandsWritebackFile;
    normalized: string;
  }> = [];

  for (const file of input.files) {
    const normalized = file.relativePath.replace(/^\/+/, "");
    if (
      normalized.length === 0 ||
      normalized.includes("..") ||
      path.isAbsolute(normalized)
    ) {
      skipped.push({
        relativePath: file.relativePath,
        reason: "invalid relative path",
      });
      continue;
    }
    if (isSupportedIngestFilename(normalized)) {
      ingestFiles.push({
        project,
        filename: normalized,
        mime: file.mime ?? "application/octet-stream",
        sizeBytes: file.sizeBytes,
        stream: file.stream,
        uploadedBy,
        source: {
          kind: "openhands_writeback",
          checkoutId: input.checkoutId,
          relativePath: normalized,
        },
      });
    } else {
      genericFiles.push({ file, normalized });
    }
  }

  const result = ingestFiles.length > 0
    ? await ingestService.ingestFiles(ingestFiles)
    : { slugs: [], errors: [] };
  const genericCreated: IngestSuccess[] = [];
  const genericErrors: IngestError[] = [];
  for (const { file, normalized } of genericFiles) {
    const stored = await storeGenericWritebackFile({
      checkoutId: input.checkoutId,
      project,
      uploadedBy,
      file,
      normalized,
      provenance: input.provenance,
      fileStore,
      gbrain,
      now,
    });
    if ("code" in stored) {
      genericErrors.push(stored);
    } else {
      genericCreated.push(stored);
    }
  }

  return {
    checkoutId: input.checkoutId,
    project,
    created: [...result.slugs, ...genericCreated],
    updated: [],
    skipped,
    errors: [...result.errors, ...genericErrors],
  };
}

const GENERIC_WRITEBACK_MAX_BYTES = 50 * 1024 * 1024;

async function storeGenericWritebackFile(input: {
  checkoutId: string;
  project: string;
  uploadedBy: string;
  file: OpenHandsWritebackFile;
  normalized: string;
  provenance?: ArtifactWritebackProvenance;
  fileStore: GbrainFileStore;
  gbrain: GbrainClient;
  now: () => Date;
}): Promise<IngestSuccess | IngestError> {
  try {
    const file = await input.fileStore.putObject({
      project: input.project,
      filename: path.basename(input.normalized),
      mime: input.file.mime ?? "application/octet-stream",
      stream: input.file.stream,
      uploadedBy: input.uploadedBy,
      maxBytes: GENERIC_WRITEBACK_MAX_BYTES,
      source: {
        kind: "openhands_writeback",
        checkoutId: input.checkoutId,
        relativePath: input.normalized,
      },
    });
    const pageFileRef = pageFileRefFromObject(
      file,
      "checkout_output",
      input.normalized,
    );
    const slug = writebackArtifactSlug(input.checkoutId, input.normalized);
    await input.gbrain.putPage(
      slug,
      matter.stringify(
        [
          `# ${path.basename(input.normalized)}`,
          "",
          `OpenHands writeback artifact from \`${input.normalized}\`.`,
          "",
        ].join("\n"),
        {
          type: "artifact",
          title: path.basename(input.normalized),
          project: input.project,
          source_filename: path.basename(input.normalized),
          relative_path: input.normalized,
          checkout_id: input.checkoutId,
          uploaded_at: input.now().toISOString().replace(/\.\d+/, ""),
          uploaded_by: input.uploadedBy,
          sha256: file.sha256,
          file_object_id: file.id,
          file_refs: [pageFileRef],
          ...buildArtifactWritebackFrontmatter(input.provenance),
        },
      ),
    );
    return {
      slug,
      type: "artifact",
      file,
      pageFileRef,
    };
  } catch (error) {
    return {
      filename: input.normalized,
      code: error instanceof GbrainFileTooLargeError
        ? "file_too_large"
        : "gbrain_write_failed",
      message: error instanceof Error ? error.message : "writeback failed",
      recoverable: true,
    };
  }
}

function writebackArtifactSlug(checkoutId: string, relativePath: string): string {
  const safePath = relativePath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  const safeCheckout = checkoutId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return `openhands-${safeCheckout || "checkout"}-${safePath || "artifact"}`;
}
