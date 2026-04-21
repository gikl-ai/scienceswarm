import path from "node:path";

export function titleFromFilename(filename: string): string {
  const basename = path.basename(filename);
  const base = basename.replace(/\.[^.]+$/, "");
  return base.replace(/_+/g, " ").replace(/\s+/g, " ").trim() || basename || filename;
}

export function isUsefulBrainTitle(title: string | null | undefined): boolean {
  const trimmed = title?.trim();
  if (!trimmed) return false;
  if (!/\p{L}/u.test(trimmed)) return false;
  if (trimmed.length <= 2) return false;
  return true;
}

export function displayTitleForBrainPage(input: {
  title?: string | null;
  path?: string | null;
  frontmatter?: Record<string, unknown> | null;
}): string {
  const title = input.title?.trim();
  if (isUsefulBrainTitle(title)) return title ?? "Untitled";

  const sourceFilename = input.frontmatter?.source_filename;
  if (typeof sourceFilename === "string" && sourceFilename.trim()) {
    return titleFromFilename(sourceFilename);
  }

  if (input.path?.trim()) {
    return titleFromFilename(input.path);
  }

  return title || "Untitled";
}
