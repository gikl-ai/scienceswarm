import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { SourceRef } from "@/brain/types";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { updateProjectManifest } from "@/lib/state/project-manifests";
import { saveProjectArtifact, slugifyWorkspaceSegment } from "@/lib/workspace-manager";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
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
  const projectSlug = slugifyWorkspaceSegment(input.projectSlug);
  const artifactTypeSlug = slugifyWorkspaceSegment(input.artifactType);
  const saveResult = await saveProjectArtifact({
    project: projectSlug,
    artifactType: artifactTypeSlug,
    title: input.title,
    content: input.content,
    fileName: input.workspaceFileName,
    root: getScienceSwarmProjectsRoot(),
    returnPathBase: "project",
    timestamp: now,
  });

  const artifactBase = slugifyWorkspaceSegment(
    `${projectSlug}-${artifactTypeSlug}-${input.title}`,
  );
  const artifactPage = path.posix.join(
    "wiki",
    "entities",
    "artifacts",
    `${stamp}-${artifactBase}-${randomUUID()}.md`,
  );
  const artifactSlug = artifactPage.replace(/\.md$/i, "");

  const pageMarkdown = buildArtifactPageMarkdown({
    title: input.title,
    content: input.content,
    projectSlug,
    artifactType: artifactTypeSlug,
    savePath: saveResult.relativePath,
    sourceRefs: input.sourceRefs ?? [],
    tags: input.tags ?? [],
    date: stamp,
    uploadedBy: getCurrentUserHandle(),
  });

  // Keep a disk mirror for project-linked provenance and future disk readers.
  const artifactAbsolutePath = resolveBrainMirrorPath(input.brainRoot, artifactPage);
  await mkdir(path.dirname(artifactAbsolutePath), { recursive: true });
  await writeFile(artifactAbsolutePath, pageMarkdown, "utf-8");

  // Persist into gbrain so the page shows up immediately in Brain Artifacts.
  const client = createInProcessGbrainClient();
  await client.putPage(artifactSlug, pageMarkdown);

  await updateProjectPage({
    brainRoot: input.brainRoot,
    projectPagePath: path.posix.join("wiki", "projects", `${projectSlug}.md`),
    projectTitle: input.projectTitle,
    artifactPage,
    title: input.title,
    savePath: saveResult.relativePath,
  });

  await updateProjectManifest(
    projectSlug,
    (current) => {
      const manifest = current ?? buildProjectManifestShell({
        projectSlug,
        projectTitle: input.projectTitle,
      });

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
    projectPagePath: path.posix.join("wiki", "projects", `${slugifyWorkspaceSegment(input.projectSlug)}.md`),
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

export function buildArtifactPageMarkdown(input: {
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
  const {
    project: _legacyProject,
    projects: _legacyProjects,
    ...parsedFrontmatter
  } = parsed.data;
  const tags = Array.from(
    new Set([
      input.projectSlug,
      input.artifactType,
      "artifact",
      ...input.tags.map((tag) => slugifyWorkspaceSegment(tag)),
    ]),
  );

  const frontmatter = {
    ...parsedFrontmatter,
    date: input.date,
    title: input.title,
    type: "artifact",
    para: "projects",
    study: input.projectSlug,
    study_slug: input.projectSlug,
    legacy_project_slug: input.projectSlug,
    status: "completed",
    tags,
    artifact_type: input.artifactType,
    workspace_path: input.savePath,
    source_refs: input.sourceRefs,
    uploaded_by: input.uploadedBy,
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
  const absolutePath = resolveBrainMirrorPath(input.brainRoot, input.projectPagePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  let content = "";
  try {
    const currentContent = await readFile(absolutePath, "utf-8");
    content = typeof currentContent === "string" ? currentContent : "";
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

export function resolveBrainMirrorPath(root: string, relativePath: string): string {
  const normalizedRelativePath = path.normalize(relativePath);

  if (
    path.isAbsolute(normalizedRelativePath)
    || normalizedRelativePath === ".."
    || normalizedRelativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Generated artifact paths must stay inside the configured brain root.");
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(resolvedRoot, resolvedPath);

  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("Generated artifact paths must stay inside the configured brain root.");
  }

  return resolvedPath;
}
