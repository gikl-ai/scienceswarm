import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import matter from "gray-matter";

import {
  CodeFrontmatterSchema,
  DatasetFrontmatterSchema,
  PaperFrontmatterSchema,
  type CodeFrontmatter,
  type DatasetFrontmatter,
  type PaperFrontmatter,
} from "@/brain/audit-revise-schema";
import type { GbrainClient } from "@/brain/gbrain-client";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { getBrainStore, type BrainPage } from "@/brain/store";
import {
  type GbrainFileObject,
  type GbrainPageFileRef,
  type IngestBatchResult,
  type IngestError,
  type IngestInputFile,
  type IngestSuccess,
  pageFileRefFromObject,
} from "@/brain/gbrain-data-contracts";
import {
  createGbrainFileStore,
  GbrainFileTooLargeError,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";
import { ingestCodeFile } from "@/brain/ingest/code-to-page";
import { ingestCsvFile } from "@/brain/ingest/csv-to-page";
import { ingestPdfFromPath } from "@/brain/ingest/pdf-to-page";
// Decision 3A presence-only lint gate: route callers resolve the current
// user handle and thread it into `IngestInputFile.uploadedBy` before writes.
import { getCurrentUserHandle as _requireAttributionImport } from "@/lib/setup/gbrain-installer";
void _requireAttributionImport;

export interface IngestService {
  ingestFiles(files: IngestInputFile[]): Promise<IngestBatchResult>;
  attachSourceFile(
    input: IngestInputFile & {
      pageSlug: string;
    },
  ): Promise<IngestSuccess | IngestError>;
  attachArtifactFile(
    input: IngestInputFile & {
      pageSlug: string;
      role: "artifact";
    },
  ): Promise<IngestSuccess | IngestError>;
}

export interface IngestServiceOptions {
  fileStore?: GbrainFileStore;
  gbrain?: GbrainClient;
  maxBytes?: number;
  now?: () => Date;
  findExistingPage?: ExistingPageResolver;
}

type ExistingPageResolver = (
  slug: string,
) => Promise<Pick<BrainPage, "frontmatter" | "type"> | null>;

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const PDF_EXTENSIONS = new Set([".pdf"]);
const CSV_EXTENSIONS = new Set([".csv", ".tsv"]);
const CODE_EXTENSIONS = new Set([
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".r",
  ".jl",
  ".sh",
  ".bash",
  ".zsh",
  ".rb",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".hpp",
  ".java",
  ".kt",
  ".swift",
  ".m",
  ".lua",
  ".sql",
]);

export function isSupportedIngestExtension(extension: string): boolean {
  return (
    PDF_EXTENSIONS.has(extension) ||
    CSV_EXTENSIONS.has(extension) ||
    CODE_EXTENSIONS.has(extension)
  );
}

export function isSupportedIngestFilename(filename: string): boolean {
  return isSupportedIngestExtension(path.extname(filename).toLowerCase());
}

export function createIngestService(
  options: IngestServiceOptions = {},
): IngestService {
  const fileStore = options.fileStore ?? createGbrainFileStore();
  const gbrain = options.gbrain ?? createInProcessGbrainClient();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const findExistingPage = options.findExistingPage ?? findExistingPageFromBrainStore;

  async function putObject(input: IngestInputFile): Promise<GbrainFileObject> {
    return fileStore.putObject({
      ...input,
      maxBytes,
    });
  }

  return {
    async ingestFiles(files: IngestInputFile[]): Promise<IngestBatchResult> {
      const result: IngestBatchResult = { slugs: [], errors: [] };
      const reservedSlugs = new Set<string>();
      for (const file of files) {
        const extension = path.extname(file.filename).toLowerCase();
        if (!isSupportedIngestExtension(extension)) {
          result.errors.push(unsupportedType(file.filename, extension));
          continue;
        }

        try {
          const kind = PDF_EXTENSIONS.has(extension)
            ? "paper"
            : CSV_EXTENSIONS.has(extension)
              ? "dataset"
              : "code";
          const slug = await slugFromInput(
            file,
            kind,
            reservedSlugs,
            findExistingPage,
          );
          const success = PDF_EXTENSIONS.has(extension)
            ? await ingestPdf(file, slug, putObject, gbrain, now, maxBytes)
            : CSV_EXTENSIONS.has(extension)
              ? await ingestCsv(file, slug, putObject, gbrain, now, maxBytes)
              : await ingestCode(file, slug, putObject, gbrain, now, maxBytes);
          result.slugs.push(success);
        } catch (error) {
          result.errors.push(toIngestError(file.filename, error));
        }
      }
      return result;
    },

    async attachArtifactFile(input) {
      return attachFile(input, input.role, "artifact", putObject);
    },

    async attachSourceFile(input) {
      return attachFile(input, "source", "source", putObject);
    },
  };
}

async function attachFile(
  input: IngestInputFile & { pageSlug: string },
  role: GbrainPageFileRef["role"],
  type: IngestSuccess["type"],
  putObject: (input: IngestInputFile) => Promise<GbrainFileObject>,
): Promise<IngestSuccess | IngestError> {
  try {
    const file = await putObject(input);
    const pageFileRef = pageFileRefFromObject(file, role, input.relativePath ?? input.filename);
    return {
      slug: input.pageSlug,
      type,
      file,
      pageFileRef,
    };
  } catch (error) {
    return toIngestError(input.filename, error);
  }
}

async function ingestPdf(
  input: IngestInputFile,
  slug: string,
  putObject: (input: IngestInputFile) => Promise<GbrainFileObject>,
  gbrain: GbrainClient,
  now: () => Date,
  maxBytes: number,
): Promise<IngestSuccess> {
  const tempPath = await copyStreamToTempFile(input, maxBytes);
  try {
    const converted = await ingestPdfFromPath({
      pdfPath: tempPath,
      fileName: input.filename,
    });
    if (!converted.ok) {
      throw Object.assign(new Error(converted.message), { code: converted.code });
    }
    const file = await putObject({
      ...input,
      stream: Readable.toWeb(createReadStream(tempPath)) as ReadableStream<Uint8Array>,
    });
    const pageFileRef = pageFileRefFromInput(file, input);
    const parsedFrontmatter: PaperFrontmatter = PaperFrontmatterSchema.parse({
      type: "paper",
      project: input.project,
      source_filename: input.filename,
      sha256: file.sha256,
      uploaded_at: now().toISOString().replace(/\.\d+/, ""),
      uploaded_by: input.uploadedBy,
      title: converted.title,
      page_count: converted.pageCount,
      word_count: converted.wordCount,
    });
    const frontmatter = withFileRef(parsedFrontmatter, file, pageFileRef, input);
    await gbrain.putPage(slug, matter.stringify(converted.markdown, frontmatter));
    return {
      slug,
      type: "paper",
      file,
      pageFileRef,
      metrics: {
        pageCount: converted.pageCount,
        wordCount: converted.wordCount,
      },
    };
  } finally {
    await fs.rm(path.dirname(tempPath), { recursive: true, force: true }).catch(() => {});
  }
}

async function ingestCsv(
  input: IngestInputFile,
  slug: string,
  putObject: (input: IngestInputFile) => Promise<GbrainFileObject>,
  gbrain: GbrainClient,
  now: () => Date,
  maxBytes: number,
): Promise<IngestSuccess> {
  const tempPath = await copyStreamToTempFile(input, maxBytes);
  try {
    const result = await ingestCsvFile(tempPath, {
      delimiter: input.filename.endsWith(".tsv") ? "\t" : ",",
    });
    const file = await putObjectFromTempFile(input, tempPath, putObject);
    const pageFileRef = pageFileRefFromInput(file, input);
    const parsedFrontmatter: DatasetFrontmatter = DatasetFrontmatterSchema.parse({
      type: "dataset",
      project: input.project,
      source_filename: input.filename,
      sha256: file.sha256,
      uploaded_at: now().toISOString().replace(/\.\d+/, ""),
      uploaded_by: input.uploadedBy,
      row_count: result.rowCount,
      columns: result.columns,
    });
    const frontmatter = withFileRef(parsedFrontmatter, file, pageFileRef, input);
    await gbrain.putPage(
      slug,
      matter.stringify(`# ${input.filename}\n\n${result.markdown}\n`, frontmatter),
    );
    return {
      slug,
      type: "dataset",
      file,
      pageFileRef,
      metrics: {
        rowCount: result.rowCount,
        columnCount: result.columns.length,
      },
    };
  } finally {
    await fs.rm(path.dirname(tempPath), { recursive: true, force: true }).catch(() => {});
  }
}

async function ingestCode(
  input: IngestInputFile,
  slug: string,
  putObject: (input: IngestInputFile) => Promise<GbrainFileObject>,
  gbrain: GbrainClient,
  now: () => Date,
  maxBytes: number,
): Promise<IngestSuccess> {
  const tempPath = await copyStreamToTempFile(input, maxBytes);
  try {
    const result = await ingestCodeFile(tempPath, input.filename);
    const file = await putObjectFromTempFile(input, tempPath, putObject);
    const pageFileRef = pageFileRefFromInput(file, input);
    const parsedFrontmatter: CodeFrontmatter = CodeFrontmatterSchema.parse({
      type: "code",
      project: input.project,
      source_filename: input.filename,
      sha256: file.sha256,
      uploaded_at: now().toISOString().replace(/\.\d+/, ""),
      uploaded_by: input.uploadedBy,
      language: result.language,
      line_count: result.lineCount,
    });
    const frontmatter = withFileRef(parsedFrontmatter, file, pageFileRef, input);
    await gbrain.putPage(
      slug,
      matter.stringify(`# ${input.filename}\n\n${result.markdown}\n`, frontmatter),
    );
    return {
      slug,
      type: "code",
      file,
      pageFileRef,
      metrics: {
        lineCount: result.lineCount,
        language: result.language,
      },
    };
  } finally {
    await fs.rm(path.dirname(tempPath), { recursive: true, force: true }).catch(() => {});
  }
}

async function copyStreamToTempFile(
  input: IngestInputFile,
  maxBytes: number,
): Promise<string> {
  if (input.sizeBytes > maxBytes) {
    throw new GbrainFileTooLargeError(maxBytes, input.sizeBytes);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scienceswarm-ingest-"));
  const tempPath = path.join(dir, path.basename(input.filename) || "upload.bin");
  const handle = await fs.open(tempPath, "w");
  let total = 0;
  try {
    const reader = input.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new GbrainFileTooLargeError(maxBytes, total);
      }
      await handle.write(Buffer.from(value));
    }
    await handle.close();
    return tempPath;
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function putObjectFromTempFile(
  input: IngestInputFile,
  tempPath: string,
  putObject: (input: IngestInputFile) => Promise<GbrainFileObject>,
): Promise<GbrainFileObject> {
  return putObject({
    ...input,
    stream: Readable.toWeb(createReadStream(tempPath)) as ReadableStream<Uint8Array>,
  });
}

function unsupportedType(filename: string, extension: string): IngestError {
  return {
    filename,
    code: "unsupported_type",
    message: `Unsupported file type '${extension || "(no extension)"}'. Supported: PDF, CSV, and source code (.py, .ts, .r, .sh, etc.).`,
    recoverable: true,
  };
}

function withFileRef(
  frontmatter: PaperFrontmatter | DatasetFrontmatter | CodeFrontmatter,
  file: GbrainFileObject,
  pageFileRef: GbrainPageFileRef,
  input: IngestInputFile,
): Record<string, unknown> {
  const relativePath = input.relativePath?.trim();
  return {
    ...frontmatter,
    ...(relativePath && relativePath !== input.filename
      ? { source_path: relativePath }
      : {}),
    file_object_id: file.id,
    source_file_object_id: file.id,
    file_refs: [pageFileRef],
  };
}

function pageFileRefFromInput(
  file: GbrainFileObject,
  input: IngestInputFile,
): GbrainPageFileRef {
  return pageFileRefFromObject(file, "source", input.relativePath ?? input.filename);
}

async function slugFromInput(
  input: IngestInputFile,
  kind: keyof typeof TYPE_DISCRIMINATOR_SUFFIX,
  reservedSlugs: Set<string>,
  findExistingPage: ExistingPageResolver,
): Promise<string> {
  const canonical = slugFromFileName(input.relativePath ?? input.filename, kind);
  if (await canUseSlug(canonical, input, kind, reservedSlugs, findExistingPage)) {
    reservedSlugs.add(canonical);
    return canonical;
  }

  const suffix = TYPE_DISCRIMINATOR_SUFFIX[kind];
  let candidate = suffix ? `${canonical}${suffix}` : `${canonical}-${kind}`;
  let attempt = 2;
  while (!(await canUseSlug(candidate, input, kind, reservedSlugs, findExistingPage))) {
    candidate = suffix
      ? `${canonical}${suffix}-v${attempt}`
      : `${canonical}-${kind}-v${attempt}`;
    attempt += 1;
  }
  reservedSlugs.add(candidate);
  return candidate;
}

async function canUseSlug(
  slug: string,
  input: IngestInputFile,
  kind: keyof typeof TYPE_DISCRIMINATOR_SUFFIX,
  reservedSlugs: Set<string>,
  findExistingPage: ExistingPageResolver,
): Promise<boolean> {
  if (reservedSlugs.has(slug)) return false;
  const existing = await findExistingPage(slug);
  return !existing || existingPageMatchesInput(existing, input, kind);
}

function existingPageMatchesInput(
  existing: Pick<BrainPage, "frontmatter" | "type">,
  input: IngestInputFile,
  kind: keyof typeof TYPE_DISCRIMINATOR_SUFFIX,
): boolean {
  const frontmatter = existing.frontmatter ?? {};
  const existingType =
    typeof frontmatter.type === "string" ? frontmatter.type : existing.type;
  if (existingType !== kind) return false;

  const sourceFilename =
    typeof frontmatter.source_filename === "string"
      ? frontmatter.source_filename
      : "";
  const sourcePath =
    typeof frontmatter.source_path === "string" ? frontmatter.source_path : "";
  return (
    sourceFilename === input.filename ||
    (Boolean(input.relativePath) && sourcePath === input.relativePath)
  );
}

async function findExistingPageFromBrainStore(
  slug: string,
): Promise<Pick<BrainPage, "frontmatter" | "type"> | null> {
  try {
    return await getBrainStore().getPage(slug);
  } catch {
    return null;
  }
}

function toIngestError(filename: string, error: unknown): IngestError {
  if (error instanceof GbrainFileTooLargeError) {
    return {
      filename,
      code: "file_too_large",
      message: error.message,
      recoverable: true,
    };
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "text_layer_too_thin" || code === "invalid_pdf") {
    return {
      filename,
      code,
      message: error instanceof Error ? error.message : code,
      recoverable: true,
    };
  }
  return {
    filename,
    code: "conversion_failed",
    message: error instanceof Error ? error.message : "Unknown ingest error",
    recoverable: false,
  };
}

const TYPE_DISCRIMINATOR_SUFFIX = {
  paper: "",
  dataset: "-dataset",
  code: "-code",
} as const;

export function slugFromFileName(
  fileName: string,
  _kind: keyof typeof TYPE_DISCRIMINATOR_SUFFIX,
): string {
  // Canonical artifact slugs are filename-derived. The `kind`
  // parameter remains for callers compiled against the old helper
  // signature; collision suffixes are allocated by `slugFromInput`.
  const base = fileName.replace(/\.[^.]+$/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  const normalized = slug || "upload";
  return normalized;
}
