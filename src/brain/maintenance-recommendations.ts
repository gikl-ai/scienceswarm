import type { BrainHealthReport } from "./brain-health";
import type { GbrainCapabilities } from "./gbrain-capabilities";
import type { ResearchLayoutMigrationPreview } from "./research-migration";

export type MaintenancePriority = "critical" | "high" | "medium" | "low";

export type MaintenanceCategory =
  | "search"
  | "links"
  | "timeline"
  | "citations"
  | "freshness"
  | "operations";

export type MaintenanceActionId =
  | "refresh-embeddings"
  | "repair-dead-links"
  | "extract-links"
  | "extract-timeline"
  | "bridge-research-layout"
  | "configure-integrations"
  | "configure-sync"
  | "sync-from-repo"
  | "compile-stale-pages"
  | "audit-citations"
  | "no-action";

export interface BrainMaintenanceIntegrationSignal {
  id: string;
  label: string;
  configured: boolean;
}

export interface BrainMaintenanceContext {
  integrations?: BrainMaintenanceIntegrationSignal[];
  syncConfigured?: boolean;
  researchLayout?: ResearchLayoutMigrationPreview;
  gbrainCapabilities?: GbrainCapabilities;
}

export interface BrainMaintenanceSignals {
  score: number;
  brainScore?: number;
  embedCoverage?: number;
  totalPages: number;
  chunkCount?: number;
  embeddedCount?: number;
  linkCount?: number;
  timelineEntryCount?: number;
  stalePages: number;
  orphanPages: number;
  deadLinks: number;
  missingEmbeddings: number;
  missingLinkCandidates: number;
  legacyResearchHomes: number;
  legacyResearchPages: number;
  unconfiguredIntegrations: string[];
  syncConfigured?: boolean;
  source: BrainHealthReport["source"];
  gbrainCapabilities?: GbrainCapabilities;
}

export interface BrainMaintenanceRecommendation {
  id: MaintenanceActionId;
  priority: MaintenancePriority;
  category: MaintenanceCategory;
  title: string;
  rationale: string;
  action: string;
  approvalRequired: boolean;
  automatable: boolean;
}

export interface BrainMaintenancePlan {
  generatedAt: string;
  source: BrainHealthReport["source"];
  score: number;
  signals: BrainMaintenanceSignals;
  recommendations: BrainMaintenanceRecommendation[];
}

export function buildBrainMaintenancePlan(
  report: BrainHealthReport,
  context: BrainMaintenanceContext = {},
): BrainMaintenancePlan {
  const signals = buildSignals(report, context);
  const recommendations = rankRecommendations([
    embeddingRecommendation(signals),
    deadLinkRecommendation(signals),
    linkExtractionRecommendation(signals),
    timelineExtractionRecommendation(signals),
    researchLayoutRecommendation(signals),
    integrationRecommendation(signals),
    syncRecommendation(signals),
    stalePageRecommendation(signals),
    citationRecommendation(report, signals),
  ].filter((item): item is BrainMaintenanceRecommendation => item != null));

  return {
    generatedAt: report.generatedAt,
    source: report.source,
    score: report.score,
    signals,
    recommendations:
      recommendations.length > 0 ? recommendations : [healthyRecommendation(signals)],
  };
}

function redactGbrainCapabilitiesForSignals(
  capabilities: GbrainCapabilities | undefined,
): GbrainCapabilities | undefined {
  if (!capabilities) return undefined;
  return {
    ...capabilities,
    package: {
      ...capabilities.package,
      binPath: "[redacted]",
    },
  };
}

function buildSignals(
  report: BrainHealthReport,
  context: BrainMaintenanceContext,
): BrainMaintenanceSignals {
  const issueCounts = report.issueCounts;
  const stats = report.stats;
  const unconfiguredIntegrations =
    context.integrations
      ?.filter((integration) => !integration.configured)
      .map((integration) => integration.label) ?? [];
  const syncConfigured =
    context.syncConfigured ??
    (typeof stats?.syncRepoPath === "string" ? stats.syncRepoPath.trim().length > 0 : undefined);
  return {
    score: report.score,
    brainScore: report.brainScore,
    embedCoverage: report.embedCoverage,
    totalPages: report.coverage.totalPages,
    chunkCount: stats?.chunkCount,
    embeddedCount: stats?.embeddedCount,
    linkCount: stats?.linkCount,
    timelineEntryCount: stats?.timelineEntryCount,
    stalePages: issueCounts?.stalePages ?? report.stalePages.length,
    orphanPages: issueCounts?.orphanPages ?? report.orphans.length,
    deadLinks: issueCounts?.deadLinks ?? report.missingLinks.length,
    missingEmbeddings:
      issueCounts?.missingEmbeddings ?? report.embeddingGaps,
    missingLinkCandidates: report.missingLinks.length,
    legacyResearchHomes: context.researchLayout?.legacyHomesDetected ?? 0,
    legacyResearchPages: context.researchLayout?.legacyPagesDetected ?? 0,
    unconfiguredIntegrations,
    syncConfigured,
    source: report.source,
    gbrainCapabilities: redactGbrainCapabilitiesForSignals(
      context.gbrainCapabilities,
    ),
  };
}

function embeddingRecommendation(
  signals: BrainMaintenanceSignals,
): BrainMaintenanceRecommendation | null {
  const coverage = signals.embedCoverage;
  if (signals.missingEmbeddings <= 0 && (coverage == null || coverage >= 0.9)) {
    return null;
  }

  const percent = coverage == null ? null : Math.round(coverage * 100);
  const rationale = percent == null
    ? `${signals.missingEmbeddings} chunk(s) are missing embeddings.`
    : `Embedding coverage is ${percent}% with ${signals.missingEmbeddings} missing chunk(s).`;

  return {
    id: "refresh-embeddings",
    priority: coverage != null && coverage < 0.7 ? "high" : "medium",
    category: "search",
    title: "Refresh missing embeddings",
    rationale,
    action:
      "Run a ScienceSwarm-owned embedding refresh before relying on semantic search or evidence-heavy briefs.",
    approvalRequired: true,
    automatable: true,
  };
}

function deadLinkRecommendation(
  signals: BrainMaintenanceSignals,
): BrainMaintenanceRecommendation | null {
  if (signals.deadLinks <= 0) return null;

  return {
    id: "repair-dead-links",
    priority: signals.deadLinks >= 10 ? "high" : "medium",
    category: "links",
    title: "Repair dead links",
    rationale: `${signals.deadLinks} link(s) point to missing pages.`,
    action:
      "Review renamed or missing targets, then repair links instead of deleting context by default.",
    approvalRequired: true,
    automatable: false,
  };
}

function linkExtractionRecommendation(
  signals: BrainMaintenanceSignals,
): BrainMaintenanceRecommendation | null {
  const needsExtraction =
    signals.orphanPages > 0 ||
    signals.missingLinkCandidates > 0 ||
    (signals.totalPages > 5 && signals.linkCount === 0);
  if (!needsExtraction) return null;

  const parts = [];
  if (signals.linkCount === 0 && signals.totalPages > 5) {
    parts.push(`${signals.totalPages} page(s) but no structured links`);
  }
  if (signals.orphanPages > 0) {
    parts.push(`${signals.orphanPages} orphan page(s)`);
  }
  if (signals.missingLinkCandidates > 0) {
    parts.push(`${signals.missingLinkCandidates} missing-link candidate(s)`);
  }

  return {
    id: "extract-links",
    priority: signals.orphanPages >= 10 ? "high" : "medium",
    category: "links",
    title: "Extract and connect links",
    rationale: parts.join(" and ") + " need graph attention.",
    action:
      "Run a targeted link extraction pass around active projects, papers, and concepts; ask before a whole-brain pass.",
    approvalRequired: true,
    automatable: true,
  };
}

function timelineExtractionRecommendation(
  signals: BrainMaintenanceSignals,
): BrainMaintenanceRecommendation | null {
  if (!(signals.totalPages > 5 && signals.timelineEntryCount === 0)) {
    return null;
  }

  return {
    id: "extract-timeline",
    priority: "medium",
    category: "timeline",
    title: "Extract timeline entries",
    rationale:
      `${signals.totalPages} page(s) exist but gbrain reports no structured timeline entries.`,
    action:
      "Run a ScienceSwarm dry-run timeline extraction first, then start the approved maintenance job if the preview looks right.",
    approvalRequired: true,
    automatable: true,
  };
}

function integrationRecommendation(
  signals: BrainMaintenanceSignals,
): BrainMaintenanceRecommendation | null {
  if (signals.totalPages <= 5 || signals.unconfiguredIntegrations.length === 0) {
    return null;
  }

  return {
    id: "configure-integrations",
    priority: "low",
    category: "operations",
    title: "Connect missing research integrations",
    rationale:
      `${signals.unconfiguredIntegrations.length} integration(s) are not configured: ${signals.unconfiguredIntegrations.join(", ")}.`,
    action:
      "Configure only the integrations that match the user's workflow, then use /api/brain/integrations for explicit sync.",
    approvalRequired: true,
    automatable: false,
  };
}

function researchLayoutRecommendation(
  signals: BrainMaintenanceSignals,
): BrainMaintenanceRecommendation | null {
  if (signals.legacyResearchHomes <= 0) {
    return null;
  }

  return {
    id: "bridge-research-layout",
    priority: signals.legacyResearchHomes >= 3 ? "medium" : "low",
    category: "operations",
    title: "Bridge legacy research homes into the research-first layout",
    rationale:
      `${signals.legacyResearchHomes} legacy research home(s) still hold ${signals.legacyResearchPages} markdown page(s).`,
    action:
      "Run a ScienceSwarm dry-run research-layout bridge preview, then optionally create canonical README bridges without moving existing pages.",
    approvalRequired: true,
    automatable: true,
  };
}

function syncRecommendation(
  signals: BrainMaintenanceSignals,
): BrainMaintenanceRecommendation | null {
  if (signals.totalPages <= 5 || signals.syncConfigured !== false) {
    return null;
  }

  return {
    id: "configure-sync",
    priority: "low",
    category: "operations",
    title: "Configure a brain sync source",
    rationale:
      "gbrain does not report a configured sync repository for this brain.",
    action:
      "Choose a git-backed research folder, run a dry-run sync-from-repo maintenance job, then start sync only after reviewing the preview.",
    approvalRequired: true,
    automatable: false,
  };
}

function stalePageRecommendation(
  signals: BrainMaintenanceSignals,
): BrainMaintenanceRecommendation | null {
  if (signals.stalePages <= 0) return null;

  return {
    id: "compile-stale-pages",
    priority: signals.stalePages >= 10 ? "high" : "medium",
    category: "freshness",
    title: "Compile stale pages",
    rationale: `${signals.stalePages} page(s) have newer evidence than their Compiled-Truth summary.`,
    action:
      "Read each page timeline, update Compiled-Truth with cited recent evidence, and preserve the original timeline.",
    approvalRequired: true,
    automatable: true,
  };
}

function citationRecommendation(
  report: BrainHealthReport,
  signals: BrainMaintenanceSignals,
): BrainMaintenanceRecommendation | null {
  if (signals.source === "gbrain" && signals.score >= 90) return null;
  const hasCitationSuggestion = report.suggestions.some((suggestion) =>
    /citation|source/i.test(suggestion),
  );
  if (!hasCitationSuggestion) return null;

  return {
    id: "audit-citations",
    priority: "low",
    category: "citations",
    title: "Audit citations on high-value pages",
    rationale:
      "The health report flagged source or citation coverage as an improvement area.",
    action:
      "Review papers, critiques, and project summaries first; fix formatting only when the source already exists.",
    approvalRequired: true,
    automatable: false,
  };
}

function healthyRecommendation(
  signals: BrainMaintenanceSignals,
): BrainMaintenanceRecommendation {
  return {
    id: "no-action",
    priority: "low",
    category: "operations",
    title: "No urgent maintenance",
    rationale: `Brain health is ${signals.score}/100 with no urgent gbrain maintenance signals.`,
    action:
      "Keep capturing linked, sourced research context and re-check after large imports or gbrain upgrades.",
    approvalRequired: false,
    automatable: false,
  };
}

function rankRecommendations(
  recommendations: BrainMaintenanceRecommendation[],
): BrainMaintenanceRecommendation[] {
  const priorityRank: Record<MaintenancePriority, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  return recommendations.sort((a, b) => {
    const priorityDiff = priorityRank[a.priority] - priorityRank[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return a.title.localeCompare(b.title);
  });
}
