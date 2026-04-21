import type { BrainPage, BrainStore } from "@/brain/store";
import type { ContentType } from "@/brain/types";

export const GBRAIN_FILE_REF_PAGE_TYPES: readonly ContentType[] = [
  "paper",
  "dataset",
  "code",
  "note",
  "experiment",
  "observation",
  "hypothesis",
  "data",
  "web",
  "voice",
  "concept",
  "project",
  "decision",
  "task",
  "artifact",
  "frontier_item",
  "person",
];

export async function listGbrainFileRefPages(
  store: BrainStore,
  limitPerType = 5000,
): Promise<BrainPage[]> {
  const pagesByPath = new Map<string, BrainPage>();
  const pagesByType = await Promise.all(
    GBRAIN_FILE_REF_PAGE_TYPES.map((type) =>
      store.listPages({ type, limit: limitPerType }),
    ),
  );
  for (const pages of pagesByType) {
    for (const page of pages) {
      pagesByPath.set(page.path, page);
    }
  }
  return Array.from(pagesByPath.values());
}
