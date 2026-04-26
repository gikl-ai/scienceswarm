/**
 * GET /api/brain/maintenance
 * POST /api/brain/maintenance
 *
 * Returns ScienceSwarm-native gbrain maintenance recommendations and a
 * host-owned maintenance job surface. Mutating jobs require a completed
 * dry-run preview and never install upstream daemons.
 */

import { generateHealthReportWithGbrain } from "@/brain/brain-health";
import { probeGbrainCapabilities } from "@/brain/gbrain-capabilities";
import { buildScienceSwarmMaintenanceContext } from "@/brain/maintenance-context";
import {
  MaintenanceJobConflictError,
  MaintenanceJobNotFoundError,
  MaintenanceJobValidationError,
  readMaintenanceJob,
  startMaintenanceJob,
  type MaintenanceJobRecord,
} from "@/brain/maintenance-jobs";
import { buildBrainMaintenancePlan } from "@/brain/maintenance-recommendations";
import { isLocalRequest } from "@/lib/local-guard";
import { getBrainConfig, isErrorResponse } from "../_shared";

export async function GET(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  try {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId") ?? url.searchParams.get("id");
    if (jobId?.trim()) {
      const job = await readMaintenanceJob(jobId.trim(), config.root);
      if (!job) {
        return Response.json({ error: "Maintenance job not found" }, { status: 404 });
      }
      return Response.json(serializeMaintenanceJob(job));
    }

    const report = await generateHealthReportWithGbrain(config);
    const gbrainCapabilities = report.source === "gbrain"
      ? await probeGbrainCapabilities()
      : undefined;
    return Response.json(
      buildBrainMaintenancePlan(
        report,
        buildScienceSwarmMaintenanceContext(
          report,
          process.env,
          config.root,
          gbrainCapabilities,
        ),
      ),
    );
  } catch (err) {
    const status = maintenanceErrorStatus(err) ?? 500;
    const message =
      status === 500
        ? "Maintenance plan generation failed"
        : err instanceof Error
          ? err.message
          : "Maintenance plan generation failed";
    return Response.json({ error: message }, { status });
  }
}

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: {
    action?: unknown;
    mode?: unknown;
    previewJobId?: unknown;
    repoPath?: unknown;
  };

  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.action !== "string" || body.action.trim().length === 0) {
    return Response.json({ error: "action is required" }, { status: 400 });
  }

  try {
    const job = await startMaintenanceJob({
      config,
      action: body.action,
      mode: typeof body.mode === "string" ? body.mode : undefined,
      previewJobId:
        typeof body.previewJobId === "string" ? body.previewJobId : undefined,
      repoPath: typeof body.repoPath === "string" ? body.repoPath : undefined,
    });
    return Response.json({ ok: true, job: serializeMaintenanceJob(job) }, { status: 202 });
  } catch (err) {
    const status = maintenanceErrorStatus(err) ?? 500;
    const message =
      status === 500
        ? "Maintenance job request failed"
        : err instanceof Error
          ? err.message
          : "Maintenance job request failed";
    return Response.json({ ok: false, error: message }, { status });
  }
}

function serializeMaintenanceJob(job: MaintenanceJobRecord): MaintenanceJobRecord {
  if (!job.error) {
    return job;
  }
  return {
    ...job,
    error: "Maintenance job failed. Check server logs for details.",
  };
}

function maintenanceErrorStatus(error: unknown): number | null {
  if (
    error instanceof MaintenanceJobValidationError ||
    error instanceof MaintenanceJobConflictError ||
    error instanceof MaintenanceJobNotFoundError
  ) {
    return error.status;
  }
  return null;
}
