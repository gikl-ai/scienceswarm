import { getScienceSwarmProjectRoot } from "@/lib/scienceswarm-paths";
import {
  createRuntimeArtifactRecord,
  validateRuntimeArtifactImport,
  type RuntimeArtifactImportReason,
} from "@/lib/runtime-hosts/artifacts";
import { createRuntimePathMapper } from "@/lib/runtime-hosts/path-mapping";
import type { RuntimePathNamespace } from "@/lib/runtime-hosts/path-mapping";

import {
  approvalStateFromBody,
  assertPreviewAllowed,
  assertRuntimeApiLocalRequest,
  computeRuntimeApiPreview,
  getRuntimeApiServices,
  optionalStringArrayField,
  optionalStringField,
  parseJsonObject,
  projectPolicyFromBody,
  requireSafeProjectId,
  requireStringField,
  runtimeErrorResponse,
  runtimeInvalidRequest,
} from "../_shared";

const PATH_KINDS = [
  "project-relative",
  "local-absolute",
  "host-native",
] as const satisfies readonly RuntimePathNamespace[];

const IMPORT_REASONS = [
  "host-declared-artifact",
  "workspace-output-scan",
  "user-selected-external-path",
] as const satisfies readonly RuntimeArtifactImportReason[];

function pathKindFromBody(
  body: Record<string, unknown>,
): RuntimePathNamespace {
  const value = requireStringField(body, "sourcePathKind");
  if (!PATH_KINDS.includes(value as RuntimePathNamespace)) {
    throw runtimeInvalidRequest("Invalid sourcePathKind.", { sourcePathKind: value });
  }
  return value as RuntimePathNamespace;
}

function importReasonFromBody(
  body: Record<string, unknown>,
): RuntimeArtifactImportReason {
  const value = requireStringField(body, "importReason");
  if (!IMPORT_REASONS.includes(value as RuntimeArtifactImportReason)) {
    throw runtimeInvalidRequest("Invalid importReason.", { importReason: value });
  }
  return value as RuntimeArtifactImportReason;
}

export async function POST(request: Request): Promise<Response> {
  try {
    await assertRuntimeApiLocalRequest(request);
    const body = await parseJsonObject(request);
    const services = getRuntimeApiServices();
    const action = optionalStringField(body, "action") ?? "validate";
    if (action !== "validate" && action !== "import" && action !== "retry") {
      throw runtimeInvalidRequest("Invalid artifact action.", { action });
    }

    const projectId = requireSafeProjectId(body.projectId);
    const hostId = requireStringField(body, "hostId");
    const sessionId = requireStringField(body, "sessionId");
    const approvalState = approvalStateFromBody(body);
    const preview = computeRuntimeApiPreview({
      services,
      hostId,
      projectPolicy: projectPolicyFromBody(body),
      mode: "artifact-import",
      dataIncluded: [
        {
          kind: "artifact",
          label: requireStringField(body, "sourcePath"),
        },
      ],
    });
    assertPreviewAllowed(preview, "approved");

    const allowedRoots = optionalStringArrayField(body, "allowedRoots") ?? [];
    const projectRoot =
      optionalStringField(body, "projectRoot")
      ?? getScienceSwarmProjectRoot(projectId);
    const mapper = createRuntimePathMapper({
      projectId,
      hostId,
      projectRoot,
      hostWorkspaceRoot: optionalStringField(body, "hostWorkspaceRoot"),
    });
    const validation = await validateRuntimeArtifactImport({
      projectId,
      sourceHostId: hostId,
      sourceSessionId: sessionId,
      sourcePath: requireStringField(body, "sourcePath"),
      sourcePathKind: pathKindFromBody(body),
      hostNativePath: optionalStringField(body, "hostNativePath"),
      allowedRoots,
      approvalState,
      importReason: importReasonFromBody(body),
      targetPath: optionalStringField(body, "targetPath"),
      requireFile: body.requireFile === true,
      pathMapper: mapper,
    });

    const shouldCreateArtifact = validation.ok
      && (action === "import" || action === "retry");
    const artifact = shouldCreateArtifact
      ? createRuntimeArtifactRecord({
          projectId,
          sourceHostId: hostId,
          sourceSessionId: sessionId,
          sourcePath: requireStringField(body, "sourcePath"),
          workspacePath: validation.mapping.projectRelativePath,
          promptHash: optionalStringField(body, "promptHash") ?? "runtime-api",
          inputFileRefs: optionalStringArrayField(body, "inputFileRefs") ?? [],
          generatedAt: optionalStringField(body, "generatedAt")
            ?? services.now().toISOString(),
          importedBy: optionalStringField(body, "importedBy") ?? "runtime-api",
          approvalState,
          gbrainSlug: optionalStringField(body, "gbrainSlug") ?? null,
        })
      : null;

    if (artifact) {
      services.eventStore.appendEvent({
        id: `${sessionId}:artifact:${artifact.artifactId}:${action}`,
        sessionId,
        hostId,
        type: "artifact",
        payload: {
          action,
          artifact,
          writebackPhaseStatus: "gbrain-writeback-pending",
        },
      });
    }

    return Response.json({
      action,
      validation,
      artifact,
      writeback: artifact
        ? {
            phaseStatus: "gbrain-writeback-pending",
            retry: action === "retry",
          }
        : null,
    });
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}
