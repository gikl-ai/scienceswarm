import { normalizeSlug } from "@/brain/compile-affected";

export function sourceSlugFromMaterializedPath(
  materializedPath: string,
  brainRoot: string,
): string {
  const normalizedRoot = brainRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = materializedPath.replace(/\\/g, "/");
  const relativePath = normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
  return normalizeSlug(relativePath);
}
