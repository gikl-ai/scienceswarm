/**
 * Audit-revise plan + approval.
 *
 * Pure functions that turn a critique page into a well-formed
 * `revision_plan` artifact — and an approval helper that flips the status
 * machine from `draft` to `approved`. No gbrain I/O here; the MCP tool
 * wrappers live in `mcp-server.ts` and call these helpers with pages they
 * loaded through the injected `BrainStore`.
 *
 * v1 demo: single-shot plan per critique. `-v<n>` suffix is reserved for
 * future iteration per the A.0 slug rules; consumers never emit it in v1.
 */

import matter from "gray-matter";

import {
  RevisionPlanFrontmatterSchema,
  RevisionPlanScopeSchema,
  RevisionPlanStatusSchema,
  type RevisionPlanFrontmatter,
  type RevisionPlanScope,
  type RevisionPlanStatus,
} from "./audit-revise-schema";

export interface DraftPlanInput {
  paperSlug: string;
  project: string;
  critiqueSlug: string;
  /** Full parsed Descartes response, as persisted by the critique tool. */
  critiquePayload: unknown;
  /** Optional scope hint from the user ("text only", "full", ...). */
  scopeHints?: string;
  /** Author handle at draft time. */
  userHandle: string;
  /** Optional timestamp override for deterministic tests. */
  now?: Date;
}

export interface DraftPlanResult {
  slug: string;
  frontmatter: RevisionPlanFrontmatter;
  markdown: string;
  findingCount: number;
}

const DEFAULT_DRAFT_SCOPE: RevisionPlanScope = "text_only";

/** Map a free-text scope hint to the locked enum value. */
export function resolveScope(
  hint: string | undefined,
  fallback: RevisionPlanScope = DEFAULT_DRAFT_SCOPE,
): RevisionPlanScope {
  if (!hint) return fallback;
  const lowered = hint.toLowerCase();
  if (/\bfull\b|\ball\b|\bboth\b/.test(lowered)) return "full";
  if (
    /\btranslate\b|\btranslation\b|\blanguage\b/.test(lowered)
  )
    return "translation";
  if (/\bdata\b|\bstats?\b|\banalysis\b|\bfigure\b|\btable\b/.test(lowered))
    return "data_and_text";
  if (/\btext\b|\bprose\b|\bcitation\b|\bwrite\b/.test(lowered))
    return "text_only";
  const parsed = RevisionPlanScopeSchema.safeParse(lowered);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Build a draft revision plan from a critique payload. Every finding
 * becomes one row in the body table with a default `keep` disposition;
 * the user (or the audit-revise skill) is expected to edit before
 * approval. The plan is always emitted with `status: draft` and
 * `version: 1`.
 */
export function draftRevisionPlan(input: DraftPlanInput): DraftPlanResult {
  const findings = extractFindings(input.critiquePayload);
  const scope = resolveScope(input.scopeHints);
  const slug = `${input.paperSlug}-revision-plan`;
  const now = (input.now ?? new Date()).toISOString().replace(/\.\d+/, "");
  const frontmatter: RevisionPlanFrontmatter =
    RevisionPlanFrontmatterSchema.parse({
      type: "revision_plan",
      project: input.project,
      parent: input.paperSlug,
      critique: input.critiqueSlug,
      status: "draft",
      version: 1,
      scope,
      uploaded_at: now,
      uploaded_by: input.userHandle,
    });

  const body = renderBody({
    paperSlug: input.paperSlug,
    critiqueSlug: input.critiqueSlug,
    scope,
    findings,
  });
  const markdown = matter.stringify(body, frontmatter);

  return {
    slug,
    frontmatter,
    markdown,
    findingCount: findings.length,
  };
}

export interface ApprovePlanInput {
  slug: string;
  markdown: string;
  /** Author handle at approval time. */
  userHandle: string;
  now?: Date;
}

export interface ApprovePlanResult {
  slug: string;
  frontmatter: RevisionPlanFrontmatter;
  markdown: string;
  previousStatus: RevisionPlanStatus;
}

/** Flip a plan page from draft to approved and stamp `approved_at`. */
export function approveRevisionPlan(
  input: ApprovePlanInput,
): ApprovePlanResult {
  const parsed = matter(input.markdown);
  const frontmatter = RevisionPlanFrontmatterSchema.parse({
    ...(parsed.data as Record<string, unknown>),
  });

  if (frontmatter.status !== "draft") {
    throw new Error(
      `approveRevisionPlan: slug '${input.slug}' has status '${frontmatter.status}', expected 'draft'`,
    );
  }

  const approvedAt = (input.now ?? new Date())
    .toISOString()
    .replace(/\.\d+/, "");
  const nextFrontmatter: RevisionPlanFrontmatter =
    RevisionPlanFrontmatterSchema.parse({
      ...frontmatter,
      status: "approved",
      approved_at: approvedAt,
      uploaded_by: input.userHandle,
      uploaded_at: approvedAt,
    });

  const markdown = matter.stringify(parsed.content, nextFrontmatter);
  return {
    slug: input.slug,
    frontmatter: nextFrontmatter,
    markdown,
    previousStatus: frontmatter.status,
  };
}

/**
 * In-memory cancel registry. A job handle is just a string; calling
 * `cancelJob` sets a flag the job runtime consults. v1 is in-memory; a
 * gbrain page per handle is the v2 upgrade path (tracked in the plan).
 */
const cancelRegistry = new Map<string, { cancelledAt: string; reason?: string }>();

export function cancelJob(handle: string, reason?: string): {
  ok: true;
  handle: string;
  cancelledAt: string;
} {
  if (!handle || handle.trim().length === 0) {
    throw new Error("cancelJob: handle is required");
  }
  const cancelledAt = new Date().toISOString();
  cancelRegistry.set(handle, { cancelledAt, reason });
  return { ok: true, handle, cancelledAt };
}

export function isJobCancelled(handle: string): boolean {
  return cancelRegistry.has(handle);
}

export function __resetCancelRegistry(): void {
  cancelRegistry.clear();
}

// ---------------------------------------------------------------------------
// Finding extraction — resilient to Descartes response shape drift.
// ---------------------------------------------------------------------------

export interface ExtractedFinding {
  id: string;
  severity: string;
  description: string;
  suggestedFix: string;
}

export function extractFindings(payload: unknown): ExtractedFinding[] {
  if (!payload || typeof payload !== "object") return [];
  const candidate =
    (payload as { findings?: unknown; synthesized_findings?: unknown })
      .synthesized_findings ??
    (payload as { findings?: unknown }).findings;
  if (!Array.isArray(candidate)) return [];
  return candidate.map((entry, idx) => {
    const record = entry as Record<string, unknown>;
    return {
      id: coerceString(record.id ?? record.finding_id ?? `F${idx + 1}`),
      severity: coerceString(record.severity ?? "unrated"),
      description: coerceString(record.description ?? record.summary ?? ""),
      suggestedFix: coerceString(
        record.suggested_fix ?? record.recommendation ?? "",
      ),
    };
  });
}

function coerceString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

interface BodyArgs {
  paperSlug: string;
  critiqueSlug: string;
  scope: RevisionPlanScope;
  findings: ExtractedFinding[];
}

function renderBody(args: BodyArgs): string {
  const { paperSlug, critiqueSlug, scope, findings } = args;
  const expectedOutputs = expectedOutputsForScope(paperSlug, scope);
  const lines: string[] = [
    `# Revision plan for [[${paperSlug}]]`,
    "",
    "## Intent",
    "",
    `Address the findings in [[${critiqueSlug}]] for [[${paperSlug}]] with scope \`${scope}\` while preserving the source artifact's scientific claims unless a finding explicitly requires a change.`,
    "",
    "## Findings in scope",
    "",
  ];
  if (findings.length === 0) {
    lines.push(
      "_No findings extracted from the critique payload. Edit this plan before approving._",
    );
  } else {
    lines.push("| # | ID | Severity | Finding | Disposition | Rationale | Required change |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    findings.forEach((finding, idx) => {
      const summary = finding.description.replace(/\|/g, "\\|").slice(0, 200);
      const fix = finding.suggestedFix.replace(/\|/g, "\\|").slice(0, 200);
      const disposition = defaultDispositionForSeverity(finding.severity);
      const rationale =
        disposition === "fix"
          ? "Finding affects correctness or presentation and should be addressed."
          : "Finding is informational; acknowledge it without expanding scope.";
      lines.push(
        `| ${idx + 1} | ${finding.id} | ${finding.severity} | ${summary || "No description provided."} | ${disposition} | ${rationale} | ${fix || summary || "Review and apply the minimal necessary edit."} |`,
      );
    });
  }
  lines.push(
    "",
    "## Required inputs",
    `- paper: \`${paperSlug}\``,
    `- critique: \`${critiqueSlug}\``,
    "",
    "## Expected outputs",
    ...expectedOutputs.map((output) => `- \`${output}\``),
    "",
    "## Assumptions and non-goals",
    "- Keep rejected or out-of-scope findings unchanged unless the user revises this plan.",
    "- Keep changed-line ratio under 30% unless the approved scope explicitly requires broader edits.",
    "- Preserve original numeric values unless the critique or approved scope calls for a correction.",
    "",
    `This is plan [[${paperSlug}-revision-plan]] (status: draft). Reply approve to run it, or tell me what to change.`,
  );
  return lines.join("\n");
}

function defaultDispositionForSeverity(severity: string): "fix" | "acknowledge" {
  const normalized = severity.toLowerCase();
  if (
    normalized.includes("critical") ||
    normalized.includes("error") ||
    normalized.includes("warning") ||
    normalized.includes("major")
  ) {
    return "fix";
  }
  return "acknowledge";
}

function expectedOutputsForScope(
  paperSlug: string,
  scope: RevisionPlanScope,
): string[] {
  const base = [`${paperSlug}-revision`, `${paperSlug}-revision-cover-letter`];
  if (scope === "translation") {
    return [`${paperSlug}-translation-en`, ...base];
  }
  if (scope === "data_and_text") {
    return [
      `${paperSlug}-stats-rerun`,
      `${paperSlug}-stats-rerun-code`,
      `${paperSlug}-stats-rerun-figure.png`,
      ...base,
    ];
  }
  if (scope === "full") {
    return [
      `${paperSlug}-translation-en`,
      `${paperSlug}-stats-rerun`,
      `${paperSlug}-stats-rerun-code`,
      `${paperSlug}-stats-rerun-figure.png`,
      ...base,
    ];
  }
  return base;
}

export { RevisionPlanStatusSchema, RevisionPlanScopeSchema };
