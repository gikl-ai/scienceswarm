/**
 * GET /api/brain/health-report
 *
 * Returns a BrainHealthReport with coverage metrics, orphan detection,
 * stale page identification, missing links, and actionable suggestions.
 */

import { generateHealthReportWithGbrain } from "@/brain/brain-health";
import { getBrainConfig, isErrorResponse } from "../_shared";

export async function GET() {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  try {
    const report = await generateHealthReportWithGbrain(config);
    return Response.json(report);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Health report generation failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
