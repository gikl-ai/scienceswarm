import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

import type { PersistTransactionLinkInput, InProcessGbrainClient } from "@/brain/in-process-gbrain-client";

import type { PersistedResearchArtifact } from "./contract";

export async function persistResearchArtifactPage(input: {
  slug: string;
  title: string;
  type: "research_packet" | "overnight_journal";
  brainRoot: string;
  client: InProcessGbrainClient;
  userHandle: string;
  now: Date;
  compiledTruth: string;
  timelineEntry: string;
  frontmatter: Record<string, unknown>;
  links?: PersistTransactionLinkInput[];
}): Promise<PersistedResearchArtifact> {
  const relativePath = `${input.slug}.md`;
  const diskPath = resolvePathWithinRoot(input.brainRoot, relativePath);
  const nowIso = input.now.toISOString();
  let mergedFrontmatter: Record<string, unknown> = {};
  let mergedTimeline = input.timelineEntry.trim();

  await input.client.persistTransaction(input.slug, async (existing) => {
    mergedTimeline = appendTimeline(existing?.timeline ?? "", input.timelineEntry);
    const runCount = typeof existing?.frontmatter.run_count === "number"
      ? existing.frontmatter.run_count + 1
      : 1;
    mergedFrontmatter = cleanUndefined({
      ...(existing?.frontmatter ?? {}),
      ...input.frontmatter,
      created_at: existing?.frontmatter.created_at ?? nowIso,
      created_by: existing?.frontmatter.created_by ?? input.userHandle,
      updated_at: nowIso,
      updated_by: input.userHandle,
      run_count: runCount,
    }) as Record<string, unknown>;

    return {
      page: {
        type: input.type,
        title: input.title,
        compiledTruth: input.compiledTruth,
        timeline: mergedTimeline,
        frontmatter: mergedFrontmatter,
      },
      links: input.links,
    };
  });

  await writeDiskMirror(
    diskPath,
    {
      type: input.type,
      title: input.title,
      ...mergedFrontmatter,
    },
    input.compiledTruth,
    mergedTimeline,
  );

  return {
    slug: input.slug,
    diskPath,
    title: input.title,
    write_status: "persisted",
  };
}

function appendTimeline(existingTimeline: string, entry: string): string {
  const trimmedEntry = entry.trim();
  if (!trimmedEntry) return existingTimeline.trim();
  return existingTimeline.trim()
    ? `${existingTimeline.trim()}\n\n${trimmedEntry}`
    : trimmedEntry;
}

async function writeDiskMirror(
  absolutePath: string,
  frontmatter: Record<string, unknown>,
  compiledTruth: string,
  timeline: string,
): Promise<void> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const body = timeline.trim()
    ? `${compiledTruth.trim()}\n\n---\n\n${timeline.trim()}\n`
    : `${compiledTruth.trim()}\n`;
  await writeFile(
    absolutePath,
    matter.stringify(body, cleanUndefined(frontmatter) as Record<string, unknown>),
    "utf-8",
  );
}

function resolvePathWithinRoot(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Research artifact path must be a relative path within the brain root.");
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const relativeToRoot = path.relative(resolvedRoot, resolvedPath);
  if (
    relativeToRoot.startsWith("..")
    || path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Research artifact path escapes the configured brain root.");
  }

  return resolvedPath;
}

function cleanUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cleanUndefined).filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      cleaned[key] = cleanUndefined(entry);
    }
    return cleaned;
  }
  return value;
}
