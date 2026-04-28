export type StudyFrontmatterLike = Record<string, unknown> | null | undefined;

export function frontmatterMatchesStudy(
  frontmatter: StudyFrontmatterLike,
  studySlug: string,
): boolean {
  if (!frontmatter) return false;
  return frontmatter.study === studySlug
    || frontmatter.study_slug === studySlug
    || frontmatter.legacy_project_slug === studySlug
    || frontmatter.project === studySlug
    || frontmatter.study_id === `study_${studySlug}`
    || (Array.isArray(frontmatter.studies) && frontmatter.studies.includes(studySlug))
    || (Array.isArray(frontmatter.study_slugs) && frontmatter.study_slugs.includes(studySlug))
    || (Array.isArray(frontmatter.legacy_project_slugs) && frontmatter.legacy_project_slugs.includes(studySlug))
    || (Array.isArray(frontmatter.projects) && frontmatter.projects.includes(studySlug));
}

export function readStudySlugFromFrontmatter(
  frontmatter: StudyFrontmatterLike,
): string | null {
  if (!frontmatter) return null;
  for (const key of ["study_slug", "study", "legacy_project_slug", "project"]) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}
