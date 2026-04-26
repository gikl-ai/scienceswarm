import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendAuditEvent } from "@/lib/state/audit-log";
import { readJsonFile, updateJsonFile } from "@/lib/state/atomic-json";
import { updateProjectManifest } from "@/lib/state/project-manifests";
import { saveProjectArtifact, slugifyWorkspaceSegment } from "@/lib/workspace-manager";
import type { ArtifactStatus } from "@/brain/types";
import type { ArtifactContextBundle } from "./context-bundle";
import type { ArtifactExecutionResult } from "./run-artifact";

export interface ArtifactJobRecord {
  version: 1;
  idempotencyKey: string;
  jobId: string;
  study?: string;
  project: string;
  artifactType: string;
  intent: string;
  status: ArtifactStatus;
  conversationId?: string;
  title?: string;
  savePath?: string;
  artifactPage?: string;
  assumptions: string[];
  reviewFirst: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactJobStore {
  version: 1;
  jobs: Record<string, ArtifactJobRecord>;
}

export interface PersistArtifactResult {
  savePath: string;
  artifactPage?: string;
  linkError?: string;
}

export async function readArtifactJob(
  projectSlug: string,
  idempotencyKey: string,
  stateRoot: string,
): Promise<ArtifactJobRecord | null> {
  const store = await readArtifactJobStore(projectSlug, stateRoot);
  return store.jobs[idempotencyKey] ?? null;
}

export async function writeArtifactJob(
  projectSlug: string,
  record: ArtifactJobRecord,
  stateRoot: string,
): Promise<ArtifactJobRecord> {
  await updateJsonFile<ArtifactJobStore>(getArtifactJobStorePath(projectSlug, stateRoot), (current) => ({
    version: 1,
    jobs: {
      ...(current?.jobs ?? {}),
      [record.idempotencyKey]: record,
    },
  }));
  return record;
}

export async function reserveArtifactJob(
  projectSlug: string,
  record: ArtifactJobRecord,
  stateRoot: string,
): Promise<{ created: boolean; record: ArtifactJobRecord }> {
  let created = false;
  let existingRecord: ArtifactJobRecord | null = null;

  await updateJsonFile<ArtifactJobStore>(getArtifactJobStorePath(projectSlug, stateRoot), (current) => {
    const store = current ?? { version: 1, jobs: {} };
    const existing = store.jobs[record.idempotencyKey];
    if (existing) {
      existingRecord = existing;
      return store;
    }

    created = true;
    return {
      version: 1,
      jobs: {
        ...store.jobs,
        [record.idempotencyKey]: record,
      },
    };
  });

  return {
    created,
    record: existingRecord ?? record,
  };
}

export async function persistArtifact(params: {
  bundle: ArtifactContextBundle;
  execution: ArtifactExecutionResult;
  jobId: string;
}): Promise<PersistArtifactResult> {
  const { bundle, execution } = params;
  const saved = await saveProjectArtifact({
    project: bundle.projectSlug,
    artifactType: bundle.artifactType,
    title: execution.title,
    content: execution.content,
    fileName: execution.fileName,
  });

  try {
    const artifactPage = await writeArtifactPage(bundle, execution, params.jobId, saved.relativePath);
    await updateProjectPage(bundle, artifactPage, execution.title, saved.relativePath);
    await updateProjectManifest(bundle.projectSlug, (current) => {
      if (!current) throw new Error(`Study manifest not found for ${bundle.projectSlug}`);
      const artifactPaths = Array.from(new Set([...current.artifactPaths, artifactPage]));
      return {
        ...current,
        artifactPaths,
        updatedAt: new Date().toISOString(),
      };
    }, bundle.stateRoot);

    await appendAuditEvent(
      {
        ts: new Date().toISOString(),
        kind: "artifact",
        action: "persist",
        project: bundle.projectSlug,
        route: "/api/artifacts/create",
        outcome: "saved",
        privacy: bundle.privacy,
        details: {
          savePath: saved.relativePath,
          artifactPage,
          artifactType: bundle.artifactType,
        },
      },
      bundle.stateRoot,
    );

    return {
      savePath: saved.relativePath,
      artifactPage,
    };
  } catch (error) {
    return {
      savePath: saved.relativePath,
      linkError: error instanceof Error ? error.message : "Failed to link artifact into the brain",
    };
  }
}

export function getArtifactJobStorePath(projectSlug: string, stateRoot: string): string {
  return path.join(stateRoot, "projects", assertSafeProjectSlug(projectSlug), "artifact-jobs.json");
}

async function readArtifactJobStore(projectSlug: string, stateRoot: string): Promise<ArtifactJobStore> {
  const existing = await readJsonFile<ArtifactJobStore>(getArtifactJobStorePath(projectSlug, stateRoot));
  return existing ?? { version: 1, jobs: {} };
}

async function writeArtifactPage(
  bundle: ArtifactContextBundle,
  execution: ArtifactExecutionResult,
  jobId: string,
  savePath: string,
): Promise<string> {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10);
  const artifactSlug = slugifyWorkspaceSegment(`${bundle.projectSlug}-${bundle.artifactType}-${execution.title}`);
  const artifactPage = path.join(
    "wiki",
    "entities",
    "artifacts",
    `${stamp}-${artifactSlug}-${jobId.slice(0, 8)}.md`,
  );
  const artifactPagePath = path.join(bundle.brainRoot, artifactPage);
  await mkdir(path.dirname(artifactPagePath), { recursive: true });

  const frontmatterLines = [
    "---",
    `date: ${stamp}`,
    "type: artifact",
    "para: projects",
    `title: ${JSON.stringify(execution.title)}`,
    `study: ${JSON.stringify(bundle.projectSlug)}`,
    `study_slug: ${JSON.stringify(bundle.projectSlug)}`,
    `legacy_project_slug: ${JSON.stringify(bundle.projectSlug)}`,
    `privacy: ${bundle.privacy}`,
    "status: completed",
    `tags: [${[bundle.projectSlug, bundle.artifactType, "artifact"].map((tag) => slugifyWorkspaceSegment(tag)).join(", ")}]`,
    "source_refs:",
    ...bundle.sourceRefs.map((sourceRef) => `  - kind: ${sourceRef.kind}\n    ref: ${JSON.stringify(sourceRef.ref)}`),
    `  - kind: artifact\n    ref: ${JSON.stringify(savePath)}`,
    "---",
  ];

  const bodyLines = [
    `# ${execution.title}`,
    "",
    "## Artifact Type",
    bundle.artifactType,
    "",
    "## Workspace Path",
    `- \`${savePath}\``,
    "",
    "## Purpose",
    bundle.intent,
    "",
    "## Provenance",
    `- [[${bundle.projectPagePath}|${bundle.projectTitle}]]`,
    ...bundle.sourceRefs.map((sourceRef) => `- ${sourceRef.kind}: \`${sourceRef.ref}\``),
    `- artifact: \`${savePath}\``,
    "",
    "## Assumptions",
    ...renderBulletLines(execution.assumptions),
    "",
    "## Review First",
    ...renderBulletLines(execution.reviewFirst),
    "",
    "## Content Snapshot",
    "```md",
    execution.content.slice(0, 4000),
    execution.content.length > 4000 ? "..." : "",
    "```",
    "",
    "## Raw Agent Response",
    "```text",
    execution.rawResponse.slice(0, 4000),
    execution.rawResponse.length > 4000 ? "..." : "",
    "```",
  ];

  await writeFile(artifactPagePath, `${frontmatterLines.join("\n")}\n${bodyLines.join("\n")}\n`, "utf-8");
  await updateBrainIndex(bundle.brainRoot, artifactPage, execution.title);
  return artifactPage;
}

async function updateProjectPage(
  bundle: ArtifactContextBundle,
  artifactPage: string,
  title: string,
  savePath: string,
): Promise<void> {
  const resolvedBrainRoot = path.resolve(bundle.brainRoot);
  const projectPageAbsolutePath = path.resolve(bundle.brainRoot, bundle.projectPagePath);
  if (
    projectPageAbsolutePath !== resolvedBrainRoot
    && !projectPageAbsolutePath.startsWith(`${resolvedBrainRoot}${path.sep}`)
  ) {
    throw new Error("Invalid study page path");
  }
  await mkdir(path.dirname(projectPageAbsolutePath), { recursive: true });
  let content = "";

  try {
    content = await readFile(projectPageAbsolutePath, "utf-8");
  } catch {
    const heading = `# ${bundle.projectTitle}`;
    content = `${heading}\n\n## Summary\n\n## Status\n\n## Sources\n\n## Active Threads\n\n`;
  }

  const entry = `- [[${artifactPage}|${title}]] -> \`${savePath}\``;
  const updated = upsertSectionEntry(content, "## Artifacts", entry);
  await writeFile(projectPageAbsolutePath, updated, "utf-8");
}

async function updateBrainIndex(
  brainRoot: string,
  artifactPage: string,
  title: string,
): Promise<void> {
  const indexPath = path.join(brainRoot, "wiki", "index.md");

  try {
    const content = await readFile(indexPath, "utf-8");
    const entry = `- [[${artifactPage}|${title}]]`;
    const updated = upsertSectionEntry(content, "## Artifacts", entry);
    await writeFile(indexPath, updated, "utf-8");
  } catch {
    // Ignore missing index during artifact persistence; the study linkage is the source of truth.
  }
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

function renderBulletLines(items: string[]): string[] {
  if (items.length === 0) return ["- none"];
  return items.map((item) => `- ${item}`);
}

function assertSafeProjectSlug(projectSlug: string): string {
  if (!/^[a-z0-9-]+$/.test(projectSlug)) {
    throw new Error("Invalid project slug");
  }

  return projectSlug;
}
