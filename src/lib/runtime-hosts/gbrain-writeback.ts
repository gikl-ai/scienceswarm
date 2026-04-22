import path from "node:path";
import matter from "gray-matter";

import type { GbrainClient } from "@/brain/gbrain-client";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
// Presence-only lint gate: callers resolve the current user handle and thread
// it into `input.uploadedBy` before runtime writeback persists pages.
import { getCurrentUserHandle as _requireAttributionImport } from "@/lib/setup/gbrain-installer";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";

import type {
  RuntimeApprovalState,
  RuntimeHostId,
} from "./contracts";
import type { RuntimeEventStore } from "./events";
import type {
  RuntimeSessionStatus,
  RuntimeSessionStore,
} from "./sessions";
import type { RuntimeArtifactRecord } from "./artifacts";

export type { RuntimeArtifactRecord } from "./artifacts";
void _requireAttributionImport;

export interface RuntimeGbrainProvenance {
  runtimeSessionId: string;
  hostId: RuntimeHostId | string;
  sourceArtifactId: string | null;
  promptHash: string;
  inputFileRefs: string[];
  approvalState: RuntimeApprovalState;
}

export type RuntimeGbrainWritebackPhaseStatus =
  | "gbrain-writeback-pending"
  | "gbrain-writeback-failed"
  | "gbrain-writeback-complete";

export interface RuntimeGbrainWritebackError {
  artifactId: string | null;
  message: string;
}

export interface RuntimeGbrainWritebackResult {
  projectId: string;
  runtimeSessionId: string;
  hostId: RuntimeHostId | string;
  phaseStatus: RuntimeGbrainWritebackPhaseStatus;
  sessionStatus: RuntimeSessionStatus;
  created: Array<{
    artifactId: string;
    slug: string;
  }>;
  errors: RuntimeGbrainWritebackError[];
}

export interface WriteRuntimeArtifactsToGbrainInput {
  projectId: string;
  runtimeSessionId: string;
  hostId: RuntimeHostId | string;
  uploadedBy: string;
  artifacts: RuntimeArtifactRecord[];
  approvedSummary?: string;
  provenance: RuntimeGbrainProvenance;
  gbrain?: GbrainClient;
  sessionStore?: RuntimeSessionStore;
  eventStore?: RuntimeEventStore;
  now?: () => Date;
}

function slugSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    || "artifact";
}

function runtimeArtifactSlug(artifact: RuntimeArtifactRecord): string {
  return [
    "runtime",
    slugSegment(String(artifact.sourceHostId)),
    slugSegment(artifact.sourceSessionId),
    slugSegment(artifact.workspacePath),
  ].join("-");
}

function validateRuntimeGbrainProvenance(input: {
  provenance: RuntimeGbrainProvenance;
  runtimeSessionId: string;
  hostId: RuntimeHostId | string;
}): RuntimeGbrainWritebackError | null {
  if (
    input.provenance.runtimeSessionId !== input.runtimeSessionId
    || input.provenance.hostId !== input.hostId
    || input.provenance.promptHash.trim().length === 0
    || input.provenance.approvalState === "rejected"
  ) {
    return {
      artifactId: input.provenance.sourceArtifactId,
      message: "Invalid RuntimeGbrainProvenance for runtime writeback.",
    };
  }
  return null;
}

function pageBodyForArtifact(input: {
  artifact: RuntimeArtifactRecord;
  approvedSummary?: string;
}): string {
  const title = path.posix.basename(input.artifact.workspacePath);
  const lines = [
    `# ${title}`,
    "",
    input.approvedSummary
      ? input.approvedSummary
      : `Runtime artifact imported from \`${input.artifact.workspacePath}\`.`,
    "",
  ];
  return lines.join("\n");
}

function eventPayload(input: {
  phaseStatus: RuntimeGbrainWritebackPhaseStatus;
  status: RuntimeSessionStatus;
  created: RuntimeGbrainWritebackResult["created"];
  errors: RuntimeGbrainWritebackError[];
}): Record<string, unknown> {
  return {
    phase: "gbrain-writeback",
    phaseStatus: input.phaseStatus,
    status: input.status,
    created: input.created,
    errors: input.errors,
  };
}

function updateOperationalState(input: {
  sessionStore?: RuntimeSessionStore;
  eventStore?: RuntimeEventStore;
  runtimeSessionId: string;
  hostId: RuntimeHostId | string;
  phaseStatus: RuntimeGbrainWritebackPhaseStatus;
  sessionStatus: RuntimeSessionStatus;
  created: RuntimeGbrainWritebackResult["created"];
  errors: RuntimeGbrainWritebackError[];
}): void {
  input.sessionStore?.trySetSessionStatus({
    sessionId: input.runtimeSessionId,
    status: input.sessionStatus,
    errorCode: input.sessionStatus === "failed"
      ? "RUNTIME_GBRAIN_WRITEBACK_FAILED"
      : undefined,
  });
  input.eventStore?.appendEvent({
    id: `${input.runtimeSessionId}:${input.phaseStatus}`,
    sessionId: input.runtimeSessionId,
    hostId: input.hostId,
    type: input.sessionStatus === "failed" ? "error" : "done",
    payload: eventPayload({
      phaseStatus: input.phaseStatus,
      status: input.sessionStatus,
      created: input.created,
      errors: input.errors,
    }),
  });
}

function markWritebackPending(input: {
  sessionStore?: RuntimeSessionStore;
  eventStore?: RuntimeEventStore;
  runtimeSessionId: string;
  hostId: RuntimeHostId | string;
}): void {
  input.sessionStore?.trySetSessionStatus({
    sessionId: input.runtimeSessionId,
    status: "running",
  });
  input.eventStore?.appendEvent({
    id: `${input.runtimeSessionId}:gbrain-writeback-pending`,
    sessionId: input.runtimeSessionId,
    hostId: input.hostId,
    type: "status",
    payload: eventPayload({
      phaseStatus: "gbrain-writeback-pending",
      status: "running",
      created: [],
      errors: [],
    }),
  });
}

export function runtimeSessionSupportsNativeWritebackStatuses(): false {
  return false;
}

export async function writeRuntimeArtifactsToGbrain(
  input: WriteRuntimeArtifactsToGbrainInput,
): Promise<RuntimeGbrainWritebackResult> {
  const projectId = assertSafeProjectSlug(input.projectId);
  const gbrain = input.gbrain ?? createInProcessGbrainClient();
  const now = input.now ?? (() => new Date());
  const created: RuntimeGbrainWritebackResult["created"] = [];
  const errors: RuntimeGbrainWritebackError[] = [];
  markWritebackPending({
    sessionStore: input.sessionStore,
    eventStore: input.eventStore,
    runtimeSessionId: input.runtimeSessionId,
    hostId: input.hostId,
  });
  const provenanceError = validateRuntimeGbrainProvenance({
    provenance: input.provenance,
    runtimeSessionId: input.runtimeSessionId,
    hostId: input.hostId,
  });

  if (provenanceError) {
    errors.push(provenanceError);
  }

  for (const artifact of errors.length === 0 ? input.artifacts : []) {
    const slug = artifact.gbrainSlug ?? runtimeArtifactSlug(artifact);
    try {
      await gbrain.putPage(
        slug,
        matter.stringify(
          pageBodyForArtifact({
            artifact,
            approvedSummary: input.approvedSummary,
          }),
          {
            type: "artifact",
            title: path.posix.basename(artifact.workspacePath),
            project: projectId,
            source_filename: path.posix.basename(artifact.workspacePath),
            relative_path: artifact.workspacePath,
            runtime_session_id: input.runtimeSessionId,
            runtime_host_id: input.hostId,
            runtime_source_artifact_id: artifact.artifactId,
            uploaded_at: now().toISOString().replace(/\.\d+/, ""),
            uploaded_by: input.uploadedBy,
            artifact_prompt_hash: artifact.provenance.promptHash,
            artifact_input_file_refs: artifact.provenance.inputFileRefs,
            artifact_approval_state: artifact.provenance.approvalState,
            runtime_gbrain_provenance: {
              runtimeSessionId: input.provenance.runtimeSessionId,
              hostId: input.provenance.hostId,
              sourceArtifactId: input.provenance.sourceArtifactId,
              promptHash: input.provenance.promptHash,
              inputFileRefs: input.provenance.inputFileRefs,
              approvalState: input.provenance.approvalState,
            },
          },
        ),
      );
      created.push({
        artifactId: artifact.artifactId,
        slug,
      });
    } catch (error) {
      errors.push({
        artifactId: artifact.artifactId,
        message: error instanceof Error ? error.message : "gbrain writeback failed",
      });
    }
  }

  const failed = errors.length > 0;
  const phaseStatus: RuntimeGbrainWritebackPhaseStatus = failed
    ? "gbrain-writeback-failed"
    : "gbrain-writeback-complete";
  const sessionStatus: RuntimeSessionStatus = failed ? "failed" : "completed";
  updateOperationalState({
    sessionStore: input.sessionStore,
    eventStore: input.eventStore,
    runtimeSessionId: input.runtimeSessionId,
    hostId: input.hostId,
    phaseStatus,
    sessionStatus,
    created,
    errors,
  });

  return {
    projectId,
    runtimeSessionId: input.runtimeSessionId,
    hostId: input.hostId,
    phaseStatus,
    sessionStatus,
    created,
    errors,
  };
}
