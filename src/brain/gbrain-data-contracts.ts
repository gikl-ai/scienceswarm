export type Sha256Hex = string;
export type StudySlug = string;
export type ProjectSlug = StudySlug;
export type GbrainSlug = string;
export type GbrainFileObjectId = `sha256:${Sha256Hex}`;

export interface GbrainFileObject {
  id: GbrainFileObjectId;
  sha256: Sha256Hex;
  sizeBytes: number;
  mime: string;
  originalFilename: string;
  study?: StudySlug;
  project: ProjectSlug;
  uploadedAt: string;
  uploadedBy: string;
  source:
    | { kind: "dashboard_upload"; route: "/api/workspace/upload" }
    | {
        kind: "sandbox_upload";
        route: "/api/brain/file-upload";
        pageSlug: GbrainSlug;
      }
    | { kind: "coldstart"; sourcePath: string }
    | { kind: "commit_import"; sourcePath: string }
    | {
        kind: "openhands_writeback";
        checkoutId: string;
        relativePath: string;
      }
    | {
        kind: "openclaw_output";
        sessionId: string;
        relativePath: string;
      };
  storagePath: string;
  contentEncoding: "raw";
}

export interface GbrainPageFileRef {
  role: "source" | "artifact" | "checkout_input" | "checkout_output";
  fileObjectId: GbrainFileObjectId;
  sha256: Sha256Hex;
  filename: string;
  mime: string;
  sizeBytes: number;
}

export interface StudyRecord {
  slug: StudySlug;
  name: string;
  description: string;
  createdAt: string;
  lastActive: string;
  status: "active" | "idle" | "paused" | "archived";
  studyPageSlug: GbrainSlug;
  legacyProjectSlug?: ProjectSlug;
}

export interface ProjectRecord {
  slug: ProjectSlug;
  name: string;
  description: string;
  createdAt: string;
  lastActive: string;
  status: "active" | "idle" | "paused" | "archived";
  projectPageSlug: GbrainSlug;
}

export interface IngestInputFile {
  project: ProjectSlug;
  filename: string;
  /**
   * Optional project-relative path for sources acquired from a folder,
   * checkout, or writeback. `filename` remains the display basename for
   * compatibility with consumers that reject path separators in legacy
   * source_filename fields; file refs and source metadata preserve this path.
   */
  relativePath?: string;
  mime: string;
  sizeBytes: number;
  stream: ReadableStream<Uint8Array>;
  uploadedBy: string;
  source: GbrainFileObject["source"];
}

export interface IngestSuccess {
  slug: GbrainSlug;
  type: "paper" | "dataset" | "code" | "artifact" | "source";
  file: GbrainFileObject;
  pageFileRef: GbrainPageFileRef;
  metrics?: {
    pageCount?: number;
    wordCount?: number;
    rowCount?: number;
    columnCount?: number;
    lineCount?: number;
    language?: string;
  };
}

export interface IngestError {
  filename: string;
  code:
    | "invalid_project"
    | "missing_user_handle"
    | "unsupported_type"
    | "text_layer_too_thin"
    | "invalid_pdf"
    | "file_too_large"
    | "file_object_missing"
    | "conversion_failed"
    | "gbrain_write_failed";
  message: string;
  recoverable: boolean;
}

export interface IngestBatchResult {
  slugs: IngestSuccess[];
  errors: IngestError[];
}

export interface GbrainFileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  project: ProjectSlug;
  slug?: GbrainSlug;
  fileObjectId?: GbrainFileObjectId;
  mime?: string;
  sizeBytes?: number;
  children?: GbrainFileTreeNode[];
}

export interface OpenHandsCheckoutManifest {
  checkoutId: string;
  project: ProjectSlug;
  createdAt: string;
  createdBy: string;
  rootName: string;
  files: Array<{
    relativePath: string;
    fileObjectId: GbrainFileObjectId;
    sourceSlug?: GbrainSlug;
    sha256: Sha256Hex;
    writable: boolean;
  }>;
}

export interface OpenHandsWritebackResult {
  checkoutId: string;
  project: ProjectSlug;
  created: IngestSuccess[];
  // IngestService currently reports successful page writes without
  // distinguishing creates from overwrites; writeback therefore exposes all
  // successes through `created` until that lower-level contract exists.
  updated: never[];
  skipped: Array<{ relativePath: string; reason: string }>;
  errors: IngestError[];
}

const SHA256_RE = /^[a-f0-9]{64}$/i;
const FILE_OBJECT_ID_RE = /^sha256:([a-f0-9]{64})$/i;

export function isSha256Hex(value: unknown): value is Sha256Hex {
  return typeof value === "string" && SHA256_RE.test(value);
}

export function assertSha256Hex(value: string): Sha256Hex {
  if (!isSha256Hex(value)) {
    throw new Error("Expected a 64-character sha256 hex string");
  }
  return value.toLowerCase();
}

export function toFileObjectId(sha256: string): GbrainFileObjectId {
  return `sha256:${assertSha256Hex(sha256)}`;
}

export function parseFileObjectId(
  value: unknown,
): { id: GbrainFileObjectId; sha256: Sha256Hex } | null {
  if (typeof value !== "string") return null;
  const match = value.match(FILE_OBJECT_ID_RE);
  if (!match) return null;
  const sha256 = match[1].toLowerCase();
  return { id: `sha256:${sha256}`, sha256 };
}

export function isGbrainFileObjectId(
  value: unknown,
): value is GbrainFileObjectId {
  return parseFileObjectId(value) !== null;
}

export function basenameOnly(filename: string): string | null {
  const trimmed = filename.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return null;
  }
  return trimmed;
}

export function pageFileRefFromObject(
  file: GbrainFileObject,
  role: GbrainPageFileRef["role"],
  filename = file.originalFilename,
): GbrainPageFileRef {
  return {
    role,
    fileObjectId: file.id,
    sha256: file.sha256,
    filename,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
  };
}

export function isPageFileRef(value: unknown): value is GbrainPageFileRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const ref = value as Partial<GbrainPageFileRef>;
  return (
    (ref.role === "source" ||
      ref.role === "artifact" ||
      ref.role === "checkout_input" ||
      ref.role === "checkout_output") &&
    isGbrainFileObjectId(ref.fileObjectId) &&
    isSha256Hex(ref.sha256) &&
    typeof ref.filename === "string" &&
    ref.filename.length > 0 &&
    typeof ref.mime === "string" &&
    typeof ref.sizeBytes === "number"
  );
}
