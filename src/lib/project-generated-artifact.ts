import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { SourceRef } from "@/brain/types";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { updateProjectManifest } from "@/lib/state/project-manifests";
import { saveProjectArtifact, slugifyWorkspaceSegment } from "@/lib/workspace-manager";
import type { ArtifactProvenanceEntry } from "@/lib/artifact-provenance";
import type { ProjectManifest } from "@/brain/types";

export interface PersistGeneratedProjectArtifactInput {
  brainRoot: string;
  stateRoot: string;
  projectSlug: string;
  projectTitle: string;
  artifactType: string;
  title: string;
  content: string;
  workspaceFileName?: string;
  sourceRefs?: SourceRef[];
  tags?: string[];
  prompt: string;
  tool: string;
}

export interface PersistGeneratedProjectArtifactResult {
  savePath: string;
  artifactPage: string;
  title: string;
  provenance: ArtifactProvenanceEntry;
}

export async function persistGeneratedProjectArtifact(
  input: PersistGeneratedProjectArtifactInput,
): Promise<PersistGeneratedProjectArtifactResult> {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10);
  const saveResult = await saveProjectArtifact({
    project: input.projectSlug,
    artifactType: input.artifactType,
    title: input.title,
    content: input.content,
    fileName: input.workspaceFileName,
    timestamp: now,
  });

  const artifactBase = slugifyWorkspaceSegment(
    `${input.projectSlug}-${input.artifactType}-${input.title}`,
  );
  const artifactPage = path.join(
    "wiki",
    "entities",
    "artifacts",
    `${stamp}-${artifactBase}-${Math.random().toString(16).slice(2, 8)}.md`,
  );
  const artifactSlug = artifactPage.replace(/\.md$/i, "");

  const pageMarkdown = buildArtifactPageMarkdown({
    title: input.title,
    content: input.content,
    projectSlug: input.projectSlug,
    artifactType: input.artifactType,
    savePath: saveResult.relativePath,
    sourceRefs: input.sourceRefs ?? [],
    tags: input.tags ?? [],
    date: stamp,
    uploadedBy: getCurrentUserHandle(),
  });

  // Keep a disk mirror for project-linked provenance and future disk readers.
  const artifactAbsolutePath = path.join(input.brainRoot, artifactPage);
  await mkdir(path.dirname(artifactAbsolutePath), { recursive: true });
  await writeFile(artifactAbsolutePath, pageMarkdown, "utf-8");

  // Persist into gbrain so the page shows up immediately in Brain Artifacts.
  const client = createInProcessGbrainClient();
  await client.putPage(artifactSlug, pageMarkdown);

  await updateProjectPage({
    brainRoot: input.brainRoot,
    projectPagePath: path.join("wiki", "projects", `${input.projectSlug}.md`),
    projectTitle: input.projectTitle,
    artifactPage,
    title: input.title,
    savePath: saveResult.relativePath,
  });

  await updateProjectManifest(
    input.projectSlug,
    (current) => {
      const manifest = current ?? buildProjectManifestShell(input);

      return {
        ...manifest,
        artifactPaths: Array.from(
          new Set([...manifest.artifactPaths, artifactPage]),
        ),
        updatedAt: new Date().toISOString(),
      };
    },
    input.stateRoot,
  );

  return {
    savePath: saveResult.relativePath,
    artifactPage,
    title: input.title,
    provenance: {
      projectPath: saveResult.relativePath,
      artifactSlug: artifactPage,
      sourceFiles: [],
      prompt: input.prompt,
      tool: input.tool,
      createdAt: now.toISOString(),
    },
  };
}

function buildProjectManifestShell(
  input: Pick<
    PersistGeneratedProjectArtifactInput,
    "projectSlug" | "projectTitle"
  >,
): ProjectManifest {
  return {
    version: 1,
    projectId: input.projectSlug,
    slug: input.projectSlug,
    title: input.projectTitle,
    privacy: "cloud-ok",
    status: "active",
    projectPagePath: path.join("wiki", "projects", `${input.projectSlug}.md`),
    sourceRefs: [],
    decisionPaths: [],
    taskPaths: [],
    artifactPaths: [],
    frontierPaths: [],
    activeThreads: [],
    dedupeKeys: [],
    updatedAt: new Date().toISOString(),
  };
}

function buildArtifactPageMarkdown(input: {
  title: string;
  content: string;
  projectSlug: string;
  artifactType: string;
  savePath: string;
  sourceRefs: SourceRef[];
  tags: string[];
  date: string;
  uploadedBy: string;
}): string {
  const parsed = matter(input.content);
  const tags = Array.from(
    new Set([
      input.projectSlug,
      input.artifactType,
      "artifact",
      ...input.tags.map((tag) => slugifyWorkspaceSegment(tag)),
    ]),
  );

  const frontmatter = {
    date: input.date,
    title: input.title,
    type: "artifact",
    para: "projects",
    project: input.projectSlug,
    status: "completed",
    tags,
    artifact_type: input.artifactType,
    workspace_path: input.savePath,
    source_refs: input.sourceRefs,
    uploaded_by: input.uploadedBy,
    ...parsed.data,
  };

  const sections = [
    parsed.content.trim(),
    "",
    "## Workspace Path",
    `- \`${input.savePath}\``,
  ];

  if (input.sourceRefs.length > 0) {
    sections.push("", "## Source Refs");
    for (const ref of input.sourceRefs) {
      sections.push(`- ${ref.kind}: \`${ref.ref}\``);
    }
  }

  return matter.stringify(`${sections.join("\n")}\n`, frontmatter);
}

async function updateProjectPage(input: {
  brainRoot: string;
  projectPagePath: string;
  projectTitle: string;
  artifactPage: string;
  title: string;
  savePath: string;
}): Promise<void> {
  const absolutePath = path.join(input.brainRoot, input.projectPagePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  let content = "";
  try {
    content = await readFile(absolutePath, "utf-8");
  } catch {
    content = [
      `# ${input.projectTitle}`,
      "",
      "## Summary",
      "",
      "## Status",
      "",
      "## Sources",
      "",
      "## Active Threads",
      "",
    ].join("\n");
  }

  const entry = `- [[${input.artifactPage}|${input.title}]] -> \`${input.savePath}\``;
  const updated = upsertSectionEntry(content, "## Artifacts", entry);
  await writeFile(absolutePath, updated, "utf-8");
}

function upsertSectionEntry(content: string, heading: string, entry: string): string {
  if (content.includes(entry)) return content;

  if (!content.includes(heading)) {
    return `${content.trimEnd()}\n\n${heading}\n${entry}\n`;
  }

  const sectionStart = content.indexOf(heading);
  const lineBreak = content.indexOf("\n", sectionStart);
  const insertAt = lineBreak === -1 ? content.length : lineBreak + 1;
  return `${content.slice(0, insertAt)}${entry}\n${content.slice(insertAt)}`;
}
