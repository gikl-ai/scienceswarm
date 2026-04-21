import type { BrainHealthReport } from "./brain-health";
import type { BrainMaintenanceContext } from "./maintenance-recommendations";

type EnvLike = Record<string, string | undefined>;

export function buildScienceSwarmMaintenanceContext(
  report: BrainHealthReport,
  env: EnvLike = process.env,
): BrainMaintenanceContext {
  const syncRepoPath = report.stats?.syncRepoPath;

  return {
    integrations: [
      {
        id: "google-calendar",
        label: "Google Calendar",
        configured: Boolean(env.GOOGLE_CALENDAR_CREDENTIALS?.trim()),
      },
      {
        id: "gmail",
        label: "Gmail",
        configured: Boolean(env.GMAIL_CREDENTIALS?.trim()),
      },
      {
        id: "zotero",
        label: "Zotero",
        configured: Boolean(
          env.ZOTERO_API_KEY?.trim() && env.ZOTERO_USER_ID?.trim(),
        ),
      },
    ],
    syncConfigured:
      report.source === "gbrain"
        ? typeof syncRepoPath === "string"
          ? syncRepoPath.trim().length > 0
          : undefined
        : undefined,
  };
}
