export interface ArtifactSourceSnapshot {
  slug: string;
  title: string;
  type: string;
  workspacePath?: string;
  fingerprint: string;
  fingerprintKind: "file_sha256" | "content_sha256";
  observedAt?: string;
}

export interface ArtifactProvenanceEntry {
  projectPath: string;
  artifactSlug?: string;
  sourceFiles: string[];
  sourceSnapshots?: ArtifactSourceSnapshot[];
  prompt: string;
  tool: string;
  createdAt: string;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeSourceFiles(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function normalizeArtifactSourceSnapshot(
  value: unknown,
): ArtifactSourceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<ArtifactSourceSnapshot>;
  const slug = readNonEmptyString(candidate.slug);
  const title = readNonEmptyString(candidate.title);
  const type = readNonEmptyString(candidate.type);
  const fingerprint = readNonEmptyString(candidate.fingerprint);

  if (
    !slug
    || !title
    || !type
    || !fingerprint
    || (
      candidate.fingerprintKind !== "file_sha256"
      && candidate.fingerprintKind !== "content_sha256"
    )
  ) {
    return null;
  }

  return {
    slug,
    title,
    type,
    ...(readNonEmptyString(candidate.workspacePath)
      ? { workspacePath: readNonEmptyString(candidate.workspacePath) }
      : {}),
    fingerprint,
    fingerprintKind: candidate.fingerprintKind,
    ...(readNonEmptyString(candidate.observedAt)
      ? { observedAt: readNonEmptyString(candidate.observedAt) }
      : {}),
  };
}

export function normalizeArtifactSourceSnapshots(value: unknown): ArtifactSourceSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeArtifactSourceSnapshot(entry))
    .filter((entry): entry is ArtifactSourceSnapshot => entry !== null);
}

export function normalizeArtifactProvenanceEntry(
  value: unknown,
): ArtifactProvenanceEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ArtifactProvenanceEntry>;
  if (
    typeof candidate.projectPath !== "string"
    || candidate.projectPath.trim().length === 0
    || typeof candidate.prompt !== "string"
    || typeof candidate.tool !== "string"
    || typeof candidate.createdAt !== "string"
  ) {
    return null;
  }

  const artifactSlug = readNonEmptyString(candidate.artifactSlug);

  return {
    projectPath: candidate.projectPath,
    ...(artifactSlug ? { artifactSlug } : {}),
    sourceFiles: normalizeSourceFiles(candidate.sourceFiles),
    ...(normalizeArtifactSourceSnapshots(candidate.sourceSnapshots).length > 0
      ? { sourceSnapshots: normalizeArtifactSourceSnapshots(candidate.sourceSnapshots) }
      : {}),
    prompt: candidate.prompt,
    tool: candidate.tool,
    createdAt: candidate.createdAt,
  };
}

export function normalizeArtifactProvenanceEntries(value: unknown): ArtifactProvenanceEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeArtifactProvenanceEntry(entry))
    .filter((entry): entry is ArtifactProvenanceEntry => entry !== null);
}

export function mergeArtifactProvenanceEntries(
  current: ArtifactProvenanceEntry[],
  incoming: ArtifactProvenanceEntry[],
): ArtifactProvenanceEntry[] {
  const merged = new Map<string, ArtifactProvenanceEntry>();

  for (const entry of [...current, ...incoming]) {
    const key = entry.projectPath.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, entry);
      continue;
    }

    merged.set(key, {
      projectPath: entry.projectPath,
      artifactSlug: entry.artifactSlug ?? existing.artifactSlug,
      sourceFiles: entry.sourceFiles.length > 0 ? entry.sourceFiles : existing.sourceFiles,
      sourceSnapshots: entry.sourceSnapshots?.length
        ? entry.sourceSnapshots
        : existing.sourceSnapshots,
      prompt: entry.prompt.trim().length > 0 ? entry.prompt : existing.prompt,
      tool: entry.tool.trim().length > 0 ? entry.tool : existing.tool,
      createdAt: Date.parse(entry.createdAt) >= Date.parse(existing.createdAt)
        ? entry.createdAt
        : existing.createdAt,
    });
  }

  return Array.from(merged.values()).sort((left, right) => {
    const rightTime = Date.parse(right.createdAt);
    const leftTime = Date.parse(left.createdAt);
    if (Number.isNaN(rightTime) || Number.isNaN(leftTime)) {
      return left.projectPath.localeCompare(right.projectPath);
    }
    return rightTime - leftTime;
  });
}
