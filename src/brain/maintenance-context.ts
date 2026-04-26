import type { BrainHealthReport } from "./brain-health";
import type { GbrainCapabilities } from "./gbrain-capabilities";
import type { BrainMaintenanceContext } from "./maintenance-recommendations";
import { previewResearchLayoutMigration } from "./research-migration";

type EnvLike = Record<string, string | undefined>;

export function buildScienceSwarmMaintenanceContext(
  report: BrainHealthReport,
  env: EnvLike = process.env,
  brainRoot = process.env.BRAIN_ROOT,
  gbrainCapabilities?: GbrainCapabilities,
): BrainMaintenanceContext {
  const syncRepoPath = report.stats?.syncRepoPath;
  const researchLayout =
    typeof brainRoot === "string" && brainRoot.trim().length > 0
      ? previewResearchLayoutMigration(brainRoot)
      : undefined;

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
    researchLayout:
      researchLayout && researchLayout.legacyHomesDetected > 0
        ? researchLayout
        : undefined,
    gbrainCapabilities:
      report.source === "gbrain" ? gbrainCapabilities : undefined,
  };
}
