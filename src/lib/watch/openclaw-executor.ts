import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { BrainConfig, ProjectManifest, SourceRef } from "@/brain/types";
import { healthCheck, sendAgentMessage } from "@/lib/openclaw";
import { updateProjectManifest } from "@/lib/state/project-manifests";
import {
  getProjectBrainRootForBrainRoot,
  getProjectStateRootForBrainRoot,
} from "@/lib/state/project-storage";
import { hashContent } from "@/lib/workspace-manager";
import { buildWatchOutputSectionLines } from "./briefing";
import type { ProjectWatchConfig, WatchDeliveryChannel } from "./types";

export interface OpenClawWatchResult {
  response: string;
  resultPath: string;
  manifest: ProjectManifest;
  delivered: boolean;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "openclaw-frontier-brief";
}

function formatQueryList(queries: string[] | undefined): string {
  if (!queries || queries.length === 0) {
    return "- Use your judgment to construct current, high-signal web searches.";
  }

  return queries.map((query) => `- ${query}`).join("\n");
}

export function buildOpenClawWatchTask(input: {
  manifest: ProjectManifest;
  watchConfig: ProjectWatchConfig;
  adhoc?: boolean;
}): string {
  const { manifest, watchConfig } = input;
  const prompt = watchConfig.compiledPrompt || watchConfig.objective || "Find the most important current frontier news for this project.";

  return [
    "You are ScienceSwarm's OpenClaw frontier-news agent.",
    "",
    `Project: ${manifest.title} (${manifest.slug})`,
    `Mode: ${input.adhoc ? "adhoc run now" : "scheduled recurring watch"}`,
    "",
    "User's watch request:",
    prompt,
    "",
    "Search/query plan:",
    formatQueryList(watchConfig.searchQueries),
    "",
    "Execution requirements:",
    "- Use OpenClaw's existing web/search/browser capabilities; do not depend on ScienceSwarm's native RSS/arXiv/web_search adapters unless explicitly needed.",
    "- Search the live web for current, high-signal items.",
    "- Prefer primary sources, credible reporting, release notes, papers, and stable URLs.",
    "- Deduplicate repeated coverage and ignore low-signal SEO/newswire duplicates.",
    "- Explain why each item matters for this project.",
    "- Include source links for every substantive claim.",
    "",
    ...buildWatchOutputSectionLines(watchConfig.objective, watchConfig.compiledPrompt),
  ].join("\n");
}

async function writeOpenClawBrief(input: {
  brainRoot: string;
  manifest: ProjectManifest;
  response: string;
  taskPrompt: string;
}): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10);
  const suffix = hashContent(`${input.manifest.slug}:${input.response}:${input.taskPrompt}`).slice(0, 8);
  const relativePath = path.join(
    "wiki",
    "entities",
    "frontier",
    `${stamp}-${slugify(`${input.manifest.slug}-openclaw-frontier-brief`)}-${suffix}.md`,
  ).replaceAll("\\", "/");
  const absolutePath = path.join(input.brainRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  const content = matter.stringify(
    [
      `# OpenClaw Frontier Brief: ${input.manifest.title}`,
      "",
      input.response,
      "",
      "## Agent Task",
      "",
      "```text",
      input.taskPrompt,
      "```",
    ].join("\n"),
    {
      title: `OpenClaw Frontier Brief: ${input.manifest.title}`,
      date: stamp,
      type: "frontier_item",
      para: "projects",
      tags: [input.manifest.slug, "frontier", "openclaw"],
      project: input.manifest.slug,
      source_refs: [{ kind: "conversation", ref: `openclaw:watch:${input.manifest.slug}` }],
      confidence: "medium",
      privacy: input.manifest.privacy,
      status: "promoted",
    },
  );

  await writeFile(absolutePath, content, "utf-8");
  return relativePath;
}

export async function runOpenClawFrontierWatch(input: {
  config: BrainConfig;
  manifest: ProjectManifest;
  watchConfig: ProjectWatchConfig;
  deliveryChannel?: WatchDeliveryChannel;
  adhoc?: boolean;
}): Promise<OpenClawWatchResult> {
  const status = await healthCheck();
  if (status.status !== "connected") {
    throw new Error("OpenClaw is not connected");
  }

  const taskPrompt = buildOpenClawWatchTask({
    manifest: input.manifest,
    watchConfig: input.watchConfig,
    adhoc: input.adhoc,
  });
  const deliveryChannel = input.deliveryChannel;
  const response = await sendAgentMessage(taskPrompt, {
    agent: "main",
    session: `watch:${input.manifest.slug}`,
    // ScienceSwarm does not yet persist per-channel reply targets for scheduled
    // watches, so direct delivery is unsafe here. Keep the channel context when
    // available only when the caller provides it, and always let the run
    // complete by saving the briefing locally.
    channel: deliveryChannel && deliveryChannel !== "web" ? deliveryChannel : undefined,
  });

  const resultPath = await writeOpenClawBrief({
    brainRoot: getProjectBrainRootForBrainRoot(input.manifest.slug, input.config.root),
    manifest: input.manifest,
    response,
    taskPrompt,
  });
  const sourceRef: SourceRef = {
    kind: "conversation",
    ref: `openclaw:watch:${input.manifest.slug}`,
    hash: hashContent(response),
  };
  const stateRoot = getProjectStateRootForBrainRoot(input.manifest.slug, input.config.root);
  const manifest = await updateProjectManifest(
    input.manifest.slug,
    (current) => ({
      ...(current ?? input.manifest),
      sourceRefs: dedupeSourceRefs([...(current?.sourceRefs ?? input.manifest.sourceRefs), sourceRef]),
      frontierPaths: Array.from(new Set([...(current?.frontierPaths ?? input.manifest.frontierPaths), resultPath])),
      dedupeKeys: Array.from(new Set([...(current?.dedupeKeys ?? input.manifest.dedupeKeys), `openclaw:${sourceRef.hash}`])),
      updatedAt: new Date().toISOString(),
    }),
    stateRoot,
  );

  return {
    response,
    resultPath,
    manifest,
    delivered: false,
  };
}

function dedupeSourceRefs(sourceRefs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const deduped: SourceRef[] = [];

  for (const sourceRef of sourceRefs) {
    const key = `${sourceRef.kind}:${sourceRef.ref}:${sourceRef.hash ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(sourceRef);
  }

  return deduped;
}
