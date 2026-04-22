import { stat } from "node:fs/promises";
import path from "node:path";

import type {
  RuntimeApprovalState,
  RuntimeHostId,
} from "./contracts";
import { RuntimeHostError } from "./errors";
import {
  isLocalPathWithinRoot,
  normalizeRuntimeProjectRelativePath,
  type RuntimePathMapper,
  type RuntimePathMapping,
  type RuntimePathNamespace,
} from "./path-mapping";

export type RuntimeArtifactImportReason =
  | "host-declared-artifact"
  | "workspace-output-scan"
  | "user-selected-external-path";

export interface RuntimeArtifactImportRequest {
  projectId: string;
  sourceHostId: RuntimeHostId | string;
  sourceSessionId: string;
  sourcePath: string;
  sourcePathKind: RuntimePathNamespace;
  hostNativePath?: string;
  allowedRoots: string[];
  approvalState: RuntimeApprovalState;
  importReason: RuntimeArtifactImportReason;
  targetPath?: string;
}

export interface RuntimeArtifactRecord {
  artifactId: string;
  projectId: string;
  sourceHostId: RuntimeHostId | string;
  sourceSessionId: string;
  sourcePath: string;
  workspacePath: string;
  gbrainSlug: string | null;
  provenance: {
    promptHash: string;
    inputFileRefs: string[];
    generatedAt: string;
    importedBy: string;
    approvalState: RuntimeApprovalState;
  };
}

export type RuntimeArtifactImportValidation =
  | {
      ok: true;
      approvalRequired: false;
      mapping: RuntimePathMapping;
      request: RuntimeArtifactImportRequest;
    }
  | {
      ok: false;
      approvalRequired: boolean;
      reason:
        | "approval-required"
        | "outside-allowed-roots"
        | "invalid-path"
        | "not-a-file";
      detail: string;
      request: RuntimeArtifactImportRequest;
    };

export interface ValidateRuntimeArtifactImportInput
  extends RuntimeArtifactImportRequest {
  pathMapper: RuntimePathMapper;
  requireFile?: boolean;
}

export interface CreateRuntimeArtifactRecordInput {
  projectId: string;
  sourceHostId: RuntimeHostId | string;
  sourceSessionId: string;
  sourcePath: string;
  workspacePath: string;
  promptHash: string;
  inputFileRefs: string[];
  generatedAt: string;
  importedBy: string;
  approvalState: RuntimeApprovalState;
  gbrainSlug?: string | null;
}

function sanitizeIdSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    || "artifact";
}

function rootsContainingPath(
  candidate: string,
  roots: readonly string[],
): string[] {
  return roots
    .map((root) => path.resolve(root))
    .filter((root) =>
      isLocalPathWithinRoot({
        root,
        candidate,
      })
    )
    .sort((left, right) => right.length - left.length);
}

function mappingFromExternalRoot(input: {
  request: RuntimeArtifactImportRequest;
  root: string;
  localAbsolutePath: string;
  targetPath?: string;
}): RuntimePathMapping {
  const relativeToRoot = path.relative(
    path.resolve(input.root),
    path.resolve(input.localAbsolutePath),
  );
  const projectRelativePath = normalizeRuntimeProjectRelativePath(
    input.targetPath ?? relativeToRoot.split(path.sep).join("/"),
  );
  return {
    projectId: input.request.projectId,
    hostId: input.request.sourceHostId,
    projectRelativePath,
    localAbsolutePath: path.resolve(input.localAbsolutePath),
    hostNativePath: input.request.hostNativePath ?? input.request.sourcePath,
  };
}

function mapRequestPath(input: ValidateRuntimeArtifactImportInput):
  | { mapping: RuntimePathMapping; external: false }
  | { mapping: RuntimePathMapping; external: true }
  | { error: RuntimeArtifactImportValidation } {
  try {
    if (input.sourcePathKind === "project-relative") {
      return {
        mapping: input.pathMapper.fromProjectRelative(input.sourcePath),
        external: false,
      };
    }
    if (input.sourcePathKind === "host-native") {
      return {
        mapping: input.pathMapper.fromHostNative(input.sourcePath),
        external: false,
      };
    }
    const localAbsolutePath = path.resolve(input.sourcePath);
    try {
      return {
        mapping: input.pathMapper.fromLocalAbsolute(localAbsolutePath),
        external: false,
      };
    } catch {
      const matchingRoots = rootsContainingPath(
        localAbsolutePath,
        input.allowedRoots,
      );
      if (input.approvalState !== "approved") {
        return {
          error: {
            ok: false,
            approvalRequired: true,
            reason: "approval-required",
            detail: "External artifact imports require explicit approval.",
            request: input,
          },
        };
      }
      if (matchingRoots.length === 0) {
        return {
          error: {
            ok: false,
            approvalRequired: false,
            reason: "outside-allowed-roots",
            detail: "Approved external artifact path is outside declared roots.",
            request: input,
          },
        };
      }
      return {
        mapping: mappingFromExternalRoot({
          request: input,
          root: matchingRoots[0],
          localAbsolutePath,
          targetPath: input.targetPath,
        }),
        external: true,
      };
    }
  } catch (error) {
    return {
      error: {
        ok: false,
        approvalRequired: false,
        reason: "invalid-path",
        detail: error instanceof Error ? error.message : "Invalid artifact path.",
        request: input,
      },
    };
  }
}

export async function validateRuntimeArtifactImport(
  input: ValidateRuntimeArtifactImportInput,
): Promise<RuntimeArtifactImportValidation> {
  const mapped = mapRequestPath(input);
  if ("error" in mapped) return mapped.error;

  if (mapped.external && input.importReason !== "user-selected-external-path") {
    return {
      ok: false,
      approvalRequired: false,
      reason: "outside-allowed-roots",
      detail: "External artifacts must be imported through the explicit user-selection path.",
      request: input,
    };
  }

  if (input.requireFile) {
    try {
      const fileStat = await stat(mapped.mapping.localAbsolutePath);
      if (!fileStat.isFile()) {
        return {
          ok: false,
          approvalRequired: false,
          reason: "not-a-file",
          detail: "Artifact path does not point to a file.",
          request: input,
        };
      }
    } catch (error) {
      return {
        ok: false,
        approvalRequired: false,
        reason: "not-a-file",
        detail: error instanceof Error ? error.message : "Artifact file was not found.",
        request: input,
      };
    }
  }

  return {
    ok: true,
    approvalRequired: false,
    mapping: mapped.mapping,
    request: input,
  };
}

export function createRuntimeArtifactRecord(
  input: CreateRuntimeArtifactRecordInput,
): RuntimeArtifactRecord {
  const workspacePath = normalizeRuntimeProjectRelativePath(input.workspacePath);
  if (
    workspacePath.startsWith(".brain/")
    || workspacePath === ".brain"
    || workspacePath.startsWith(".git/")
    || workspacePath === ".git"
    || workspacePath.startsWith("node_modules/")
    || workspacePath === "node_modules"
  ) {
    throw new RuntimeHostError({
      code: "RUNTIME_INVALID_REQUEST",
      status: 400,
      message: "Artifact workspace path uses a reserved project directory.",
      userMessage: "Artifact path must not target reserved project directories.",
      recoverable: true,
      context: {
        workspacePath,
      },
    });
  }

  return {
    artifactId: [
      "runtime-artifact",
      sanitizeIdSegment(input.sourceHostId),
      sanitizeIdSegment(input.sourceSessionId),
      sanitizeIdSegment(workspacePath),
    ].join("-"),
    projectId: input.projectId,
    sourceHostId: input.sourceHostId,
    sourceSessionId: input.sourceSessionId,
    sourcePath: input.sourcePath,
    workspacePath,
    gbrainSlug: input.gbrainSlug ?? null,
    provenance: {
      promptHash: input.promptHash,
      inputFileRefs: [...input.inputFileRefs],
      generatedAt: input.generatedAt,
      importedBy: input.importedBy,
      approvalState: input.approvalState,
    },
  };
}
