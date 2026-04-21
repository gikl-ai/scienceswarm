import { appendAuditEvent } from "@/lib/state/audit-log";
import { buildArtifactContextBundle } from "@/lib/artifacts/context-bundle";
import { validateArtifactCreateRequest } from "@/lib/artifacts/intent";
import { isLocalRequest } from "@/lib/local-guard";
import {
  persistArtifact,
  reserveArtifactJob,
  writeArtifactJob,
  type ArtifactJobRecord,
} from "@/lib/artifacts/persist-artifact";
import { runArtifact } from "@/lib/artifacts/run-artifact";

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json(
      {
        error: "Forbidden",
        assumptions: [],
        reviewFirst: [],
      },
      { status: 403 },
    );
  }

  let jobContext:
    | {
        jobId: string;
        projectSlug: string;
        stateRoot: string;
        artifactType: string;
        intent: string;
        startedAt?: string;
      }
    | undefined;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          error: "Invalid JSON body",
          assumptions: [],
          reviewFirst: [],
        },
        { status: 400 },
      );
    }

    const validation = validateArtifactCreateRequest(body);
    if (!validation.ok || !validation.value) {
      return Response.json(
        {
          error: validation.error ?? "Invalid artifact create request",
          assumptions: [],
          reviewFirst: [],
        },
        { status: validation.status },
      );
    }

    const artifactRequest = validation.value;
    const bundle = await buildArtifactContextBundle(artifactRequest);
    const startedAt = new Date().toISOString();
    jobContext = {
      jobId: artifactRequest.idempotencyKey,
      projectSlug: bundle.projectSlug,
      stateRoot: bundle.stateRoot,
      artifactType: bundle.artifactType,
      intent: bundle.intent,
      startedAt,
    };

    if (bundle.privacy !== "execution-ok") {
      await appendAuditEvent(
        {
          ts: new Date().toISOString(),
          kind: "policy",
          action: "deny",
          project: bundle.projectSlug,
          route: "/api/artifacts/create",
          outcome: "blocked",
          privacy: bundle.privacy,
          details: {
            artifactType: bundle.artifactType,
            reason: "Artifact execution requires execution-ok privacy",
          },
        },
        bundle.stateRoot,
      );

      return Response.json(
        {
          error: `Project ${bundle.projectSlug} is ${bundle.privacy}; artifact execution requires execution-ok privacy`,
          assumptions: [],
          reviewFirst: [],
        },
        { status: 403 },
      );
    }

    const runningRecord: ArtifactJobRecord = {
      version: 1,
      idempotencyKey: artifactRequest.idempotencyKey,
      jobId: artifactRequest.idempotencyKey,
      project: bundle.projectSlug,
      artifactType: bundle.artifactType,
      intent: bundle.intent,
      status: "running",
      assumptions: [],
      reviewFirst: [],
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const reservation = await reserveArtifactJob(bundle.projectSlug, runningRecord, bundle.stateRoot);
    if (!reservation.created) {
      await appendAuditEvent(
        {
          ts: new Date().toISOString(),
          kind: "artifact",
          action: "reuse",
          project: bundle.projectSlug,
          route: "/api/artifacts/create",
          outcome: reservation.record.status,
          privacy: bundle.privacy,
          details: {
            jobId: reservation.record.jobId,
            artifactPage: reservation.record.artifactPage,
            savePath: reservation.record.savePath,
          },
        },
        bundle.stateRoot,
      );

      return Response.json(toArtifactResponse(reservation.record));
    }

    await appendAuditEvent(
      {
        ts: startedAt,
        kind: "artifact",
        action: "start",
        project: bundle.projectSlug,
        route: "/api/artifacts/create",
        outcome: "running",
        privacy: bundle.privacy,
        details: {
          jobId: artifactRequest.idempotencyKey,
          artifactType: bundle.artifactType,
        },
      },
      bundle.stateRoot,
    );

    const execution = await runArtifact(bundle);
    const persisted = await persistArtifact({
      bundle,
      execution,
      jobId: artifactRequest.idempotencyKey,
    });

    const finishedAt = new Date().toISOString();
    const record: ArtifactJobRecord = {
      version: 1,
      idempotencyKey: artifactRequest.idempotencyKey,
      jobId: artifactRequest.idempotencyKey,
      project: bundle.projectSlug,
      artifactType: bundle.artifactType,
      intent: bundle.intent,
      status: persisted.artifactPage ? "completed" : "failed",
      conversationId: execution.conversationId,
      title: execution.title,
      savePath: persisted.savePath,
      artifactPage: persisted.artifactPage,
      assumptions: execution.assumptions,
      reviewFirst: execution.reviewFirst,
      error: persisted.linkError,
      createdAt: startedAt,
      updatedAt: finishedAt,
    };

    await writeArtifactJob(bundle.projectSlug, record, bundle.stateRoot);
    await appendAuditEvent(
      {
        ts: finishedAt,
        kind: "artifact",
        action: persisted.artifactPage ? "complete" : "link-failed",
        project: bundle.projectSlug,
        route: "/api/artifacts/create",
        outcome: record.status,
        privacy: bundle.privacy,
        details: {
          jobId: record.jobId,
          savePath: record.savePath,
          artifactPage: record.artifactPage,
          error: record.error,
        },
      },
      bundle.stateRoot,
    );

    return Response.json(toArtifactResponse(record));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Artifact creation failed";
    const status = mapErrorStatus(message);

    if (jobContext) {
      const failedAt = new Date().toISOString();
      await writeArtifactJob(
        jobContext.projectSlug,
        {
          version: 1,
          idempotencyKey: jobContext.jobId,
          jobId: jobContext.jobId,
          project: jobContext.projectSlug,
          artifactType: jobContext.artifactType,
          intent: jobContext.intent,
          status: "failed",
          assumptions: [],
          reviewFirst: [],
          error: message,
          createdAt: jobContext.startedAt ?? failedAt,
          updatedAt: failedAt,
        },
        jobContext.stateRoot,
      );

      await appendAuditEvent(
        {
          ts: failedAt,
          kind: "artifact",
          action: "error",
          project: jobContext.projectSlug,
          route: "/api/artifacts/create",
          outcome: "failed",
          details: {
            jobId: jobContext.jobId,
            error: message,
          },
        },
        jobContext.stateRoot,
      );
    }

    return Response.json(
      {
        error: message,
        jobId: jobContext?.jobId,
        status: "failed",
        assumptions: [],
        reviewFirst: [],
      },
      { status },
    );
  }
}

function toArtifactResponse(record: ArtifactJobRecord) {
  return {
    jobId: record.jobId,
    status: record.status,
    savePath: record.savePath,
    artifactPage: record.artifactPage,
    assumptions: record.assumptions,
    reviewFirst: record.reviewFirst,
    error: record.error,
  };
}

function mapErrorStatus(message: string): number {
  if (
    message.includes("No brain configured") ||
    message.includes("No research brain is initialized yet")
  ) {
    return 503;
  }
  if (message.includes("Project manifest not found")) return 404;
  return 500;
}
