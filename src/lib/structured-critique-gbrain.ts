import matter from "gray-matter";

import {
  CritiqueFrontmatterSchema,
  type CritiqueFrontmatter,
} from "@/brain/audit-revise-schema";
import type {
  StructuredCritiqueJob,
  StructuredCritiqueResult,
} from "@/lib/structured-critique-schema";
import { normalizeStructuredCritiqueResultPayload } from "@/lib/structured-critique-schema";

export interface BuildStructuredCritiquePageInput {
  job: StructuredCritiqueJob;
  parentSlug: string;
  projectSlug?: string;
  projectSlugs?: string[];
  sourceFilename?: string;
  uploadedAt: Date;
  uploadedBy: string;
}

export interface BuiltStructuredCritiquePage {
  markdown: string;
  brief: string;
  severityCounts: Record<string, number>;
  findingCount: number;
}

export function slugifyCritiqueParent(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "reasoning-audit";
}

export function deriveCritiqueParentSlug(
  job: StructuredCritiqueJob,
  sourceFilename?: string,
): string {
  const basis =
    sourceFilename?.trim() ||
    job.pdf_filename?.trim() ||
    job.result?.title?.trim() ||
    job.id;
  return slugifyCritiqueParent(basis);
}

export function isValidCritiqueSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*(?:-v\d+)?$/.test(value);
}

export function computeStructuredCritiqueSeverityCounts(
  findings: unknown[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of findings) {
    if (!entry || typeof entry !== "object") continue;
    const severity = (entry as { severity?: unknown }).severity;
    const normalized =
      typeof severity === "string" ? severity.trim().toLowerCase() : "";
    const key = normalized.length > 0 ? normalized : "unrated";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function buildStructuredCritiqueBrief(
  result: StructuredCritiqueResult,
): string {
  const overall = result.author_feedback?.overall_summary;
  if (typeof overall === "string" && overall.trim().length > 0) {
    return overall.trim().slice(0, 800);
  }
  const report = result.report_markdown;
  if (typeof report === "string" && report.trim().length > 0) {
    return report.trim().split("\n\n").slice(0, 2).join("\n\n").slice(0, 800);
  }
  return "Critique completed; see the full page for details.";
}

export function buildStructuredCritiquePageMarkdown(
  input: BuildStructuredCritiquePageInput,
): BuiltStructuredCritiquePage {
  const result = normalizeStructuredCritiqueResultPayload(input.job.result);
  const severityCounts = computeStructuredCritiqueSeverityCounts(result.findings);
  const brief = buildStructuredCritiqueBrief(result);
  const uploadedAt = input.uploadedAt.toISOString().replace(/\.\d+/, "");
  const styleProfile = input.job.style_profile || "professional";
  const explicitProjectSlugs = normalizeProjectSlugs([
    ...(input.projectSlugs ?? []),
    ...(input.projectSlug ? [input.projectSlug] : []),
  ]);
  const projectSlugs =
    explicitProjectSlugs.length > 0 ? explicitProjectSlugs : [input.parentSlug];
  const primaryProjectSlug = projectSlugs[0] ?? input.parentSlug;

  const parsedFrontmatter: CritiqueFrontmatter = CritiqueFrontmatterSchema.parse({
    type: "critique",
    project: primaryProjectSlug,
    projects: projectSlugs,
    parent: input.parentSlug,
    source_filename: input.sourceFilename || undefined,
    uploaded_at: uploadedAt,
    uploaded_by: input.uploadedBy,
    style_profile: styleProfile,
    finding_count: result.findings.length,
    raw_descartes_findings_count: result.findings.length,
  });

  const frontmatter = stripUndefinedValues({
    title: `Critique for ${input.parentSlug}`,
    ...parsedFrontmatter,
    descartes_job_id: input.job.id,
    ...(input.job.trace_id ? { descartes_trace_id: input.job.trace_id } : {}),
  });

  return {
    markdown: matter.stringify(
      buildStructuredCritiqueBody({
        parentSlug: input.parentSlug,
        result,
        brief,
        severityCounts,
      }),
      frontmatter,
    ),
    brief,
    severityCounts,
    findingCount: result.findings.length,
  };
}

function normalizeProjectSlugs(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const slug = value.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

function stripUndefinedValues<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}

function buildStructuredCritiqueBody(args: {
  parentSlug: string;
  result: StructuredCritiqueResult;
  brief: string;
  severityCounts: Record<string, number>;
}): string {
  const severityLines = Object.entries(args.severityCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([severity, count]) => `- **${severity}**: ${count}`);

  return [
    `# Critique for [[${args.parentSlug}]]`,
    "",
    "## Brief",
    "",
    args.brief,
    "",
    "## Severity counts",
    "",
    severityLines.length > 0 ? severityLines.join("\n") : "- unrated: 0",
    "",
    "## Raw Descartes response",
    "",
    "```json",
    JSON.stringify(args.result, null, 2),
    "```",
    "",
  ].join("\n");
}
