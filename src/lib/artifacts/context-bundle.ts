import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { loadBrainConfig } from "@/brain/config";
import type { PrivacyMode, ProjectManifest, SourceRef } from "@/brain/types";
import { readProjectManifest } from "@/lib/state/project-manifests";
import {
  getProjectBrainRootForBrainRoot,
  getProjectStateRootForBrainRoot,
} from "@/lib/state/project-storage";
import type { SupportedArtifactType, ValidatedArtifactRequest } from "./intent";

export interface ArtifactContextDocument {
  path: string;
  title: string;
  excerpt: string;
}

export interface ArtifactContextBundle {
  request: ValidatedArtifactRequest;
  project: string;
  projectSlug: string;
  projectTitle: string;
  artifactType: SupportedArtifactType;
  intent: string;
  privacy: PrivacyMode;
  sourceRefs: SourceRef[];
  projectPagePath: string;
  manifest: ProjectManifest;
  brainRoot: string;
  stateRoot: string;
  projectPage: ArtifactContextDocument | null;
  decisions: ArtifactContextDocument[];
  tasks: ArtifactContextDocument[];
  artifacts: ArtifactContextDocument[];
  prompt: string;
}

export async function buildArtifactContextBundle(
  request: ValidatedArtifactRequest,
): Promise<ArtifactContextBundle> {
  const config = loadBrainConfig();
  if (!config) {
    throw new Error("No research brain is initialized yet for artifact creation");
  }

  const canonicalStateRoot = getProjectStateRootForBrainRoot(request.projectSlug, config.root);
  const canonicalBrainRoot = getProjectBrainRootForBrainRoot(request.projectSlug, config.root);
  const legacyStateRoot = path.join(config.root, "state");

  let stateRoot = canonicalStateRoot;
  let brainRoot = canonicalBrainRoot;
  let manifest = await readProjectManifest(request.projectSlug, stateRoot);
  if (!manifest && stateRoot !== legacyStateRoot) {
    manifest = await readProjectManifest(request.projectSlug, legacyStateRoot);
    if (manifest) {
      stateRoot = legacyStateRoot;
      brainRoot = config.root;
    }
  }
  if (!manifest) {
    throw new Error(`Study manifest not found for ${request.projectSlug}`);
  }

  const privacy = restrictPrivacy(manifest.privacy, request.requestedPrivacy);
  const conversationRefs = buildConversationRefs(request);
  const sourceRefs = [...manifest.sourceRefs, ...conversationRefs];
  const projectPage = await readBrainDocument(brainRoot, manifest.projectPagePath);
  const decisions = await readBrainDocuments(brainRoot, manifest.decisionPaths.slice(-5));
  const tasks = await readBrainDocuments(brainRoot, manifest.taskPaths.slice(-5));
  const artifacts = await readBrainDocuments(brainRoot, manifest.artifactPaths.slice(-5));

  const bundle: ArtifactContextBundle = {
    request,
    project: request.project,
    projectSlug: manifest.slug,
    projectTitle: manifest.title,
    artifactType: request.artifactType,
    intent: request.intent,
    privacy,
    sourceRefs,
    projectPagePath: manifest.projectPagePath,
    manifest,
    brainRoot,
    stateRoot,
    projectPage,
    decisions,
    tasks,
    artifacts,
    prompt: "",
  };

  bundle.prompt = renderArtifactPrompt(bundle);
  return bundle;
}

export function restrictPrivacy(
  manifestPrivacy: PrivacyMode,
  requestedPrivacy?: PrivacyMode,
): PrivacyMode {
  const order: PrivacyMode[] = ["local-only", "cloud-ok", "execution-ok"];
  const manifestLevel = order.indexOf(manifestPrivacy);
  const requestLevel = requestedPrivacy ? order.indexOf(requestedPrivacy) : manifestLevel;
  return order[Math.min(manifestLevel, requestLevel)];
}

async function readBrainDocuments(
  brainRoot: string,
  relativePaths: string[],
): Promise<ArtifactContextDocument[]> {
  const docs = await Promise.all(relativePaths.map((relativePath) => readBrainDocument(brainRoot, relativePath)));
  return docs.filter((value): value is ArtifactContextDocument => Boolean(value));
}

async function readBrainDocument(
  brainRoot: string,
  relativePath: string,
): Promise<ArtifactContextDocument | null> {
  const absolutePath = await resolveBrainDocumentPath(brainRoot, relativePath);
  if (!absolutePath) {
    return null;
  }

  try {
    const raw = await readFile(absolutePath, "utf-8");
    const parsed = matter(raw);
    return {
      path: relativePath,
      title: deriveTitle(relativePath, parsed.data.title, parsed.content),
      excerpt: truncateContent(parsed.content),
    };
  } catch {
    return null;
  }
}

async function resolveBrainDocumentPath(brainRoot: string, relativePath: string): Promise<string | null> {
  const resolvedRoot = path.resolve(brainRoot);
  const resolvedPath = path.resolve(brainRoot, relativePath);
  const relativeToRoot = path.relative(resolvedRoot, resolvedPath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return null;
  }

  try {
    const real = await realpath(resolvedPath);
    const realRoot = await realpath(resolvedRoot);
    if (!real.startsWith(`${realRoot}${path.sep}`) && real !== realRoot) {
      return null;
    }
    return real;
  } catch {
    return resolvedPath;
  }
}

function deriveTitle(relativePath: string, frontmatterTitle: unknown, content: string): string {
  if (typeof frontmatterTitle === "string" && frontmatterTitle.trim().length > 0) {
    return frontmatterTitle.trim();
  }

  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return path.basename(relativePath, ".md");
}

function truncateContent(content: string, maxLength = 1400): string {
  const cleaned = content.trim().replace(/\n{3,}/g, "\n\n");
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength).trimEnd()}\n...`;
}

function buildConversationRefs(request: ValidatedArtifactRequest): SourceRef[] {
  const refs: SourceRef[] = [];
  if (request.conversationId) {
    refs.push({ kind: "conversation", ref: request.conversationId });
  }

  for (const messageId of request.messageIds) {
    refs.push({ kind: "conversation", ref: messageId });
  }

  return refs;
}

function renderArtifactPrompt(bundle: ArtifactContextBundle): string {
  const sections = [
    "Create a first-pass research artifact from the provided ScienceSwarm study context.",
    `Study: ${bundle.projectTitle} (${bundle.projectSlug})`,
    `Artifact type: ${bundle.artifactType}`,
    `User intent: ${bundle.intent}`,
    "Return only JSON inside a ```json fenced block with keys:",
    `title, fileName, content, assumptions, reviewFirst`,
    "Use markdown for content. Keep assumptions and reviewFirst concrete and short.",
    "",
    "Context bundle",
    renderDocumentSection("Study page", bundle.projectPage),
    renderListSection("Recent decisions", bundle.decisions),
    renderListSection("Recent tasks", bundle.tasks),
    renderListSection("Recent artifacts", bundle.artifacts),
    renderSourceRefSection(bundle.sourceRefs),
  ];

  return sections.filter(Boolean).join("\n");
}

function renderDocumentSection(label: string, doc: ArtifactContextDocument | null): string {
  if (!doc) return `${label}: none`;
  return `${label}: ${doc.title} (${doc.path})\n${doc.excerpt}`;
}

function renderListSection(label: string, docs: ArtifactContextDocument[]): string {
  if (docs.length === 0) return `${label}: none`;

  return [
    `${label}:`,
    ...docs.map((doc, index) => `${index + 1}. ${doc.title} (${doc.path})\n${doc.excerpt}`),
  ].join("\n");
}

function renderSourceRefSection(sourceRefs: SourceRef[]): string {
  if (sourceRefs.length === 0) return "Source refs: none";
  return [
    "Source refs:",
    ...sourceRefs.map((ref) => `- ${ref.kind}: ${ref.ref}${ref.hash ? ` (${ref.hash})` : ""}`),
  ].join("\n");
}
