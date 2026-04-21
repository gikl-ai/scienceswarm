/**
 * Audit-and-Revise gbrain page schema.
 *
 * Every artifact the audit-revise demo writes to gbrain lands under one of
 * the shapes defined here. The Zod schemas below are the single runtime
 * source of truth; the inferred TypeScript types are the single compile-time
 * source of truth. Consumer modules import the types (not the shapes), so a
 * schema change produces compile errors at every call site.
 *
 * See docs/demos/audit-revise-schema.md for the narrative and slug rules.
 */
import { z } from "zod";

/** Every artifact kind the audit-revise flow writes to gbrain. */
export const ArtifactTypeSchema = z.enum([
  "paper",
  "dataset",
  "code",
  "critique",
  "revision_plan",
  "translation",
  "stats_rerun",
  "figure",
  "revision",
  "cover_letter",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

/** Link relations between audit-revise artifacts. */
export const LinkRelationSchema = z.enum([
  "audited_by", // paper -> critique
  "addresses", // revision_plan -> critique
  "revises", // revision -> paper
  "cover_letter_for", // cover_letter -> revision
]);
export type LinkRelation = z.infer<typeof LinkRelationSchema>;

// ISO 8601 per RFC 3339 profile: YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM].
// `Date.parse` alone is too permissive — it accepts RFC 2822 headers,
// en-US locale strings, and implementation-defined formats. Pair the
// strict regex with Date.parse so every parseable value is also a
// realistic calendar instant ("2026-04-14T22:00:00Z" and
// "2026-04-14T22:00:00.123+00:00" pass, "Tue, 14 Apr 2026 22:00:00 GMT"
// and "April 14 2026" do not).
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const isoDateTime = z.string().refine(
  (value) =>
    ISO_8601_PATTERN.test(value) && !Number.isNaN(Date.parse(value)),
  { message: "must be an ISO 8601 timestamp (YYYY-MM-DDTHH:MM:SSZ)" },
);

// Slug pattern: hyphen-separated lowercase ASCII tokens with no leading,
// trailing, or consecutive hyphens. The optional `-v<n>` suffix is reserved
// for user iteration on the same artifact (plan v2, revision v3, ...).
// Rejects: `report-`, `-hubble`, `hubble--1929`, `a-v-b`.
// Accepts: `hubble-1929`, `hubble-1929-critique`, `hubble-1929-v2`.
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:-v\d+)?$/;
const slug = z
  .string()
  .regex(slugPattern, {
    message:
      "slug must be hyphen-separated lowercase ASCII tokens (no leading/trailing/consecutive hyphens); optional -v<n> suffix",
  });

const sha256Hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, { message: "sha256 must be 64 hex characters" });

export const BaseFrontmatterSchema = z.object({
  type: ArtifactTypeSchema,
  project: slug,
  source_filename: z.string().min(1).optional(),
  sha256: sha256Hex.optional(),
  uploaded_at: isoDateTime.optional(),
  uploaded_by: z.string().min(1).optional(),
});
export type BaseFrontmatter = z.infer<typeof BaseFrontmatterSchema>;

export const PaperFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("paper"),
  title: z.string().min(1).optional(),
  authors: z.array(z.string().min(1)).optional(),
  year: z.number().int().min(1500).max(3000).optional(),
  page_count: z.number().int().positive().optional(),
  word_count: z.number().int().nonnegative().optional(),
});
export type PaperFrontmatter = z.infer<typeof PaperFrontmatterSchema>;

export const DatasetFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("dataset"),
  parent: slug.optional(),
  row_count: z.number().int().nonnegative().optional(),
  columns: z.array(z.string().min(1)).optional(),
});
export type DatasetFrontmatter = z.infer<typeof DatasetFrontmatterSchema>;

export const CodeFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("code"),
  parent: slug.optional(),
  language: z.string().min(1).optional(),
  line_count: z.number().int().nonnegative().optional(),
});
export type CodeFrontmatter = z.infer<typeof CodeFrontmatterSchema>;

export const CritiqueStyleProfileSchema = z.enum([
  "professional",
  "referee",
  "internal_red_team",
]);
export type CritiqueStyleProfile = z.infer<typeof CritiqueStyleProfileSchema>;

export const CritiqueFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("critique"),
  parent: slug,
  style_profile: CritiqueStyleProfileSchema,
  finding_count: z.number().int().nonnegative(),
  raw_descartes_findings_count: z.number().int().nonnegative().optional(),
  descartes_wall_time_s: z.number().nonnegative().optional(),
});
export type CritiqueFrontmatter = z.infer<typeof CritiqueFrontmatterSchema>;

export const RevisionPlanStatusSchema = z.enum([
  "draft",
  "approved",
  "rejected",
  "superseded",
]);
export type RevisionPlanStatus = z.infer<typeof RevisionPlanStatusSchema>;

export const RevisionPlanScopeSchema = z.enum([
  "text_only",
  "data_and_text",
  "translation",
  "full",
]);
export type RevisionPlanScope = z.infer<typeof RevisionPlanScopeSchema>;

export const RevisionPlanFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("revision_plan"),
  parent: slug,
  critique: slug,
  status: RevisionPlanStatusSchema,
  version: z.number().int().min(1),
  scope: RevisionPlanScopeSchema,
  approved_at: isoDateTime.optional(),
});
export type RevisionPlanFrontmatter = z.infer<
  typeof RevisionPlanFrontmatterSchema
>;

export const TranslationFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("translation"),
  translation_of: slug,
  language: z.string().min(1),
  back_translation_similarity: z.number().min(0).max(1),
});
export type TranslationFrontmatter = z.infer<
  typeof TranslationFrontmatterSchema
>;

const statsInput = z.object({
  slug,
  sha256: sha256Hex,
});

export const StatsRerunFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("stats_rerun"),
  parent: slug,
  plan: slug.optional(),
  inputs: z.array(statsInput).min(1),
  code: sha256Hex,
  results: z.record(z.unknown()),
  seed: z.number().int(),
  env: z.record(z.string().min(1)),
});
export type StatsRerunFrontmatter = z.infer<
  typeof StatsRerunFrontmatterSchema
>;

export const FigureFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("figure"),
  parent: slug,
  fileObjectId: z.string().min(1),
  mime: z.literal("image/png"),
  size: z.number().int().positive(),
});
export type FigureFrontmatter = z.infer<typeof FigureFrontmatterSchema>;

export const RevisionFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("revision"),
  parent: slug,
  plan: slug,
  job_handle: z.string().min(1).optional(),
  artifact_files: z.array(sha256Hex).optional(),
});
export type RevisionFrontmatter = z.infer<typeof RevisionFrontmatterSchema>;

export const CoverLetterFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal("cover_letter"),
  revision: slug,
  target_journal: z.string().min(1).optional(),
});
export type CoverLetterFrontmatter = z.infer<
  typeof CoverLetterFrontmatterSchema
>;

/** Discriminated union over every artifact shape the flow writes. */
export const ArtifactFrontmatterSchema = z.discriminatedUnion("type", [
  PaperFrontmatterSchema,
  DatasetFrontmatterSchema,
  CodeFrontmatterSchema,
  CritiqueFrontmatterSchema,
  RevisionPlanFrontmatterSchema,
  TranslationFrontmatterSchema,
  StatsRerunFrontmatterSchema,
  FigureFrontmatterSchema,
  RevisionFrontmatterSchema,
  CoverLetterFrontmatterSchema,
]);
export type ArtifactFrontmatter = z.infer<typeof ArtifactFrontmatterSchema>;

/**
 * Build the canonical child slug for a derived artifact.
 *
 * Derived artifacts (critique, revision_plan, revision, cover_letter)
 * use `<parent-slug>-<kebab-suffix>` so the child is reachable from its
 * parent by a deterministic rule. v1 demo never emits the `-v<n>` suffix;
 * that is for iteration only.
 */
export function buildChildSlug(
  parentSlug: string,
  kind:
    | "critique"
    | "revision-plan"
    | "revision"
    | "cover-letter",
): string {
  if (!slugPattern.test(parentSlug)) {
    throw new Error(
      `buildChildSlug: parent slug "${parentSlug}" is not a valid audit-revise slug`,
    );
  }
  return `${parentSlug}-${kind}`;
}

/**
 * Parse and validate arbitrary frontmatter against the audit-revise schema.
 * Consumers should use this (not the individual schemas) so a schema change
 * surfaces as one typed error path instead of seven.
 */
export function parseArtifactFrontmatter(
  input: unknown,
): ArtifactFrontmatter {
  return ArtifactFrontmatterSchema.parse(input);
}
