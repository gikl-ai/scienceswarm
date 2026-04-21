export function toPublicBrainSlug(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\.mdx?$/i, "");
}

export function toPublicBrainSlugKey(value: string): string {
  return toPublicBrainSlug(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function toPublicBrainLink<T extends {
  slug: string;
  fromSlug?: string;
  toSlug?: string;
}>(link: T): T {
  return {
    ...link,
    slug: toPublicBrainSlug(link.slug),
    ...(link.fromSlug ? { fromSlug: toPublicBrainSlug(link.fromSlug) } : {}),
    ...(link.toSlug ? { toSlug: toPublicBrainSlug(link.toSlug) } : {}),
  };
}
