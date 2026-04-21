import { createHash } from "node:crypto";

import { isPageFileRef } from "@/brain/gbrain-data-contracts";
import type { BrainPage } from "@/brain/store";
import type { ArtifactSourceSnapshot } from "@/lib/artifact-provenance";

export interface ArtifactWritebackProvenance {
  prompt?: string;
  tool?: string;
  sourceFiles?: string[];
  sourceSnapshots?: ArtifactSourceSnapshot[];
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeWorkspacePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
}

function workspacePathCandidates(page: BrainPage): string[] {
  const frontmatter = page.frontmatter ?? {};
  const candidates = [
    readNonEmptyString(frontmatter.relative_path),
    readNonEmptyString(frontmatter.source_path),
    readNonEmptyString(frontmatter.source_filename),
  ];

  const fileRefs = Array.isArray(frontmatter.file_refs)
    ? frontmatter.file_refs.filter(isPageFileRef)
    : [];
  for (const ref of fileRefs) {
    if (ref.filename.trim().length > 0) {
      candidates.push(ref.filename);
    }
  }

  const normalized = new Set<string>();
  const values: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalizedCandidate = normalizeWorkspacePath(candidate);
    if (!normalizedCandidate) continue;
    const key = normalizedCandidate.toLowerCase();
    if (normalized.has(key)) continue;
    normalized.add(key);
    values.push(normalizedCandidate);
  }
  return values;
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableNormalize(record[key])]),
  );
}

function pageObservedAt(page: BrainPage): string | undefined {
  const frontmatter = page.frontmatter ?? {};
  return (
    readNonEmptyString(frontmatter.updated_at)
    ?? readNonEmptyString(frontmatter.uploaded_at)
    ?? readNonEmptyString(frontmatter.created_at)
    ?? readNonEmptyString(frontmatter.compiled_truth_updated_at)
    ?? readNonEmptyString(frontmatter.date)
  );
}

function pageFingerprint(page: BrainPage): {
  fingerprint: string;
  fingerprintKind: ArtifactSourceSnapshot["fingerprintKind"];
} {
  const frontmatter = page.frontmatter ?? {};
  const fileRefs = Array.isArray(frontmatter.file_refs)
    ? frontmatter.file_refs.filter(isPageFileRef)
    : [];
  const preferredFileRef = fileRefs.find((ref) => ref.role === "source")
    ?? fileRefs.find((ref) => ref.role === "checkout_input")
    ?? fileRefs[0];
  if (preferredFileRef) {
    return {
      fingerprint: preferredFileRef.sha256,
      fingerprintKind: "file_sha256",
    };
  }

  const sha256 = readNonEmptyString(frontmatter.sha256);
  if (sha256) {
    return {
      fingerprint: sha256,
      fingerprintKind: "file_sha256",
    };
  }

  const contentHash = createHash("sha256")
    .update(JSON.stringify(stableNormalize({
      path: page.path,
      title: page.title,
      type: page.type,
      content: page.content,
      frontmatter,
    })))
    .digest("hex");
  return {
    fingerprint: contentHash,
    fingerprintKind: "content_sha256",
  };
}

export function artifactSourceWorkspaceKeysForPage(page: BrainPage): string[] {
  return workspacePathCandidates(page).map((candidate) => candidate.toLowerCase());
}

export function buildArtifactSourceSnapshotFromPage(page: BrainPage): ArtifactSourceSnapshot {
  const { fingerprint, fingerprintKind } = pageFingerprint(page);
  const workspacePath = workspacePathCandidates(page)[0];

  return {
    slug: page.path,
    title: page.title,
    type: page.type,
    ...(workspacePath ? { workspacePath } : {}),
    fingerprint,
    fingerprintKind,
    ...(pageObservedAt(page) ? { observedAt: pageObservedAt(page) } : {}),
  };
}

export function buildArtifactWritebackFrontmatter(
  provenance: ArtifactWritebackProvenance | undefined,
): Record<string, unknown> {
  if (!provenance) {
    return {};
  }

  const prompt = readNonEmptyString(provenance.prompt);
  const tool = readNonEmptyString(provenance.tool);
  const sourceFiles = Array.isArray(provenance.sourceFiles)
    ? provenance.sourceFiles
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim())
    : [];
  const sourceSnapshots = Array.isArray(provenance.sourceSnapshots)
    ? provenance.sourceSnapshots.filter((entry) => typeof entry?.slug === "string" && entry.slug.trim().length > 0)
    : [];

  return {
    ...(prompt ? { artifact_prompt: prompt } : {}),
    ...(tool ? { artifact_tool: tool } : {}),
    ...(sourceFiles.length > 0 ? { artifact_source_files: sourceFiles } : {}),
    ...(sourceSnapshots.length > 0 ? { artifact_source_snapshots: sourceSnapshots } : {}),
    ...(sourceSnapshots.length > 0
      ? { derived_from: Array.from(new Set(sourceSnapshots.map((entry) => entry.slug))) }
      : {}),
  };
}
