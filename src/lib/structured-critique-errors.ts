export const STRUCTURED_CRITIQUE_INTERNAL_PIPELINE_ERROR =
  "Structured critique failed due to an internal pipeline error.";

export const HOSTED_DESCARTES_RECOVERY_MESSAGE =
  "The hosted Descartes critique pipeline failed before producing findings. Retry once; if it repeats, check /api/health for Descartes readiness/auth status and contact the service operator with the job trace id if one is shown.";

export function getStructuredCritiqueDisplayError(
  message?: string | null,
): string {
  const trimmed = message?.trim();
  if (!trimmed) return "The critique run failed.";
  if (trimmed === STRUCTURED_CRITIQUE_INTERNAL_PIPELINE_ERROR) {
    return HOSTED_DESCARTES_RECOVERY_MESSAGE;
  }
  return trimmed;
}
