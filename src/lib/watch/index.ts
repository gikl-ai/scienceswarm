import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { BrainConfig, ProjectManifest, SourceRef } from "@/brain/types";
import { updateProjectManifest } from "@/lib/state/project-manifests";
import {
  getProjectBrainRootForBrainRoot,
  getProjectStateRootForBrainRoot,
} from "@/lib/state/project-storage";
import { hashContent } from "@/lib/workspace-manager";
import { fetchArxivWatchItems } from "./adapters/arxiv";
import { fetchDiscordWatchItems } from "./adapters/discord";
import { fetchRssWatchItems } from "./adapters/rss";
import { fetchSlackWatchItems } from "./adapters/slack";
import { fetchTwitterWatchItems } from "./adapters/twitter";
import { fetchWebSearchWatchItems } from "./adapters/web-search";
import { runOpenClawFrontierWatch } from "./openclaw-executor";
import { rankWatchItems } from "./ranking";
import { readProjectWatchConfig, writeProjectWatchConfig } from "./store";
import type { ProjectWatchConfig, ProjectWatchSource, RankedWatchItem, WatchCandidate } from "./types";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "frontier";
}

function frontierPagePath(item: RankedWatchItem, manifest: ProjectManifest): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const uniqueSuffix = hashContent(item.dedupeKey).slice(0, 8);
  return path.join(
    "wiki",
    "entities",
    "frontier",
    `${stamp}-${slugify(`${manifest.slug}-${item.title}`)}-${uniqueSuffix}.md`,
  ).replaceAll("\\", "/");
}

async function fetchWatchCandidates(input: {
  manifest: ProjectManifest;
  watchConfig: ProjectWatchConfig;
  source: ProjectWatchSource;
}): Promise<WatchCandidate[]> {
  const { manifest, watchConfig, source } = input;
  if (source.type === "web_search") {
    return fetchWebSearchWatchItems({ manifest, watchConfig, source });
  }

  if (source.type === "rss") {
    return fetchRssWatchItems(source);
  }

  if (source.type === "twitter") {
    return fetchTwitterWatchItems(source);
  }

  if (source.type === "discord") {
    return fetchDiscordWatchItems(source);
  }

  if (source.type === "slack") {
    return fetchSlackWatchItems(source);
  }

  return fetchArxivWatchItems(source);
}

async function writeFrontierPage(
  brainRoot: string,
  manifest: ProjectManifest,
  item: RankedWatchItem,
): Promise<string> {
  const pagePath = frontierPagePath(item, manifest);
  const absolutePath = path.join(brainRoot, pagePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  const sourceRef: SourceRef = {
    kind: "external",
    ref: item.url,
  };

  const content = matter.stringify(
    [
      `# ${item.title}`,
      "",
      item.summary || "External watch item.",
      "",
      "## Why It Matters",
      item.reasons.map((reason) => `- ${reason}`).join("\n"),
      "",
      `Source: ${item.url}`,
    ].join("\n"),
    {
      title: item.title,
      date: new Date().toISOString().slice(0, 10),
      type: "frontier_item",
      para: "projects",
      tags: [manifest.slug, "frontier"],
      project: manifest.slug,
      source_refs: [sourceRef],
      confidence: item.status === "promoted" ? "high" : "medium",
      privacy: manifest.privacy,
      status: item.status,
    },
  );

  await writeFile(absolutePath, content, "utf-8");
  return pagePath;
}

export async function refreshProjectWatchFrontier(
  config: BrainConfig,
  manifest: ProjectManifest,
): Promise<ProjectManifest> {
  const stateRoot = getProjectStateRootForBrainRoot(manifest.slug, config.root);
  const watchConfig = await readProjectWatchConfig(manifest.slug, stateRoot);
  if (!watchConfig) {
    return manifest;
  }

  if (shouldUseOpenClaw(watchConfig)) {
    try {
      const result = await runOpenClawFrontierWatch({
        config,
        manifest,
        watchConfig,
      });
      await writeProjectWatchConfig(
        manifest.slug,
        {
          ...watchConfig,
          lastRun: {
            at: new Date().toISOString(),
            mode: "openclaw",
            resultPath: result.resultPath,
          },
        },
        stateRoot,
      );
      return result.manifest;
    } catch (error) {
      await writeProjectWatchConfig(
        manifest.slug,
        {
          ...watchConfig,
          lastRun: {
            at: new Date().toISOString(),
            mode: "openclaw",
            error: error instanceof Error ? error.message : String(error),
          },
        },
        stateRoot,
      );
      if (watchConfig.executionMode === "openclaw") {
        throw error;
      }
      // Legacy configs without an explicit execution mode can still use the
      // deterministic adapters as a compatibility fallback.
    }
  }

  if (watchConfig.sources.length === 0) {
    return manifest;
  }

  const candidateResults = await Promise.allSettled(
    watchConfig.sources
      .filter((source) => source.enabled !== false)
      .map((source) => fetchWatchCandidates({ manifest, watchConfig, source })),
  );
  const candidates = candidateResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

  const ranked = rankWatchItems({
    manifest,
    watchConfig,
    items: candidates,
  });

  const fresh = ranked.filter((item) => !manifest.dedupeKeys.includes(item.dedupeKey));
  if (fresh.length === 0) {
    return manifest;
  }

  const createdPaths: string[] = [];
  const projectBrainRoot = getProjectBrainRootForBrainRoot(manifest.slug, config.root);
  for (const item of fresh) {
    createdPaths.push(await writeFrontierPage(projectBrainRoot, manifest, item));
  }

  const updatedManifest = await updateProjectManifest(
    manifest.slug,
    (current) => ({
      ...(current ?? manifest),
      frontierPaths: Array.from(new Set([...(current?.frontierPaths ?? manifest.frontierPaths), ...createdPaths])),
      dedupeKeys: Array.from(new Set([...(current?.dedupeKeys ?? manifest.dedupeKeys), ...fresh.map((item) => item.dedupeKey)])),
      updatedAt: new Date().toISOString(),
    }),
    stateRoot,
  );
  await writeProjectWatchConfig(
    manifest.slug,
    {
      ...watchConfig,
      lastRun: {
        at: new Date().toISOString(),
        mode: "native",
      },
    },
    stateRoot,
  );
  return updatedManifest;
}

function shouldUseOpenClaw(watchConfig: ProjectWatchConfig): boolean {
  return watchConfig.executionMode === "openclaw";
}
