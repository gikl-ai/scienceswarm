const MIRRORED_BRAIN_PAGE_DIRECTORIES: Record<string, string> = {
  note: "wiki/resources",
  observation: "wiki/observations",
  decision: "wiki/decisions",
  hypothesis: "wiki/hypotheses",
  task: "wiki/tasks",
  project: "wiki/projects",
};

export function buildMirroredBrainPagePath(
  slug: string,
  pageType?: string | null,
): string | null {
  const normalizedSlug = slug.trim().replace(/^gbrain:/, "").replace(/\.md$/i, "");
  const normalizedType = pageType?.trim().toLowerCase();
  if (!normalizedSlug || !normalizedType) {
    return null;
  }

  const directory = MIRRORED_BRAIN_PAGE_DIRECTORIES[normalizedType];
  if (!directory) {
    return null;
  }

  return `${directory}/${normalizedSlug}.md`;
}
