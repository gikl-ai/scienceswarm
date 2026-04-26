import { join } from "node:path";

import { isPageFileRef, type GbrainPageFileRef } from "./gbrain-data-contracts";
import { ensureBrainStoreReady, getBrainStore, type BrainPage, type BrainStore } from "./store";
import type { BrainConfig, SourceRef } from "./types";
import { inferDuplicateGroupContentType } from "@/lib/import/preview-core";
import {
  readProjectImportSummary,
  type ProjectImportDuplicateGroupRecord,
  type ProjectImportSummary,
} from "@/lib/state/project-import-summary";
import { isDefaultScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

export interface ProjectImportRegistryEntry {
  pagePath: string;
  title: string;
  type: string;
  projectPath: string | null;
  sourceRefs: SourceRef[];
  fileRefs: GbrainPageFileRef[];
  pageCount: number | null;
  verificationState: "verified" | "partial" | "unavailable";
  missingFields: string[];
  observedAt?: string;
}

export interface ProjectImportRegistryDuplicateGroup {
  id: string;
  members: string[];
  reason: string;
  hashPrefix?: string;
  contentType: string;
}

export interface ProjectImportRegistry {
  project: string;
  generatedAt: string;
  detectedItemCount: number | null;
  registeredItemCount: number;
  duplicateGroupCount: number;
  entries: ProjectImportRegistryEntry[];
  duplicateGroups: ProjectImportRegistryDuplicateGroup[];
  warnings: string[];
}

const NON_IMPORT_PAGE_TYPES = new Set([
  "project",
  "task",
  "decision",
  "frontier_item",
  "experiment",
  "hypothesis",
]);

const GENERATED_ARTIFACT_PAGE_TYPES = new Set([
  "artifact",
  "critique",
  "revision_plan",
  "revision",
  "cover_letter",
]);
const IMPORT_REGISTRY_PAGE_SCAN_LIMIT = 5000;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeWorkspacePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
}

function normalizeSourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const candidate = entry as Partial<SourceRef>;
    if (
      (
        candidate.kind !== "import"
        && candidate.kind !== "capture"
        && candidate.kind !== "external"
        && candidate.kind !== "artifact"
        && candidate.kind !== "conversation"
      )
      || typeof candidate.ref !== "string"
    ) {
      return [];
    }
    return [{
      kind: candidate.kind,
      ref: candidate.ref,
      ...(typeof candidate.hash === "string" && candidate.hash.length > 0
        ? { hash: candidate.hash }
        : {}),
    }];
  });
}

function normalizePageFileRefs(value: unknown): GbrainPageFileRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPageFileRef);
}

function filterProjectPages(pages: BrainPage[], project: string): BrainPage[] {
  return pages.filter((page) => {
    const frontmatter = page.frontmatter ?? {};
    return frontmatter.project === project
      || (Array.isArray(frontmatter.projects) && frontmatter.projects.includes(project));
  });
}

export function isGeneratedArtifactPage(page: BrainPage): boolean {
  const frontmatter = page.frontmatter ?? {};
  if (
    typeof frontmatter.artifact_tool === "string"
    || typeof frontmatter.artifact_prompt === "string"
    || typeof frontmatter.openclaw_session_id === "string"
    || Array.isArray(frontmatter.artifact_source_snapshots)
    || Array.isArray(frontmatter.derived_from)
  ) {
    return true;
  }

  return GENERATED_ARTIFACT_PAGE_TYPES.has(page.type);
}

function isImportRegistryCandidatePage(page: BrainPage): boolean {
  const frontmatter = page.frontmatter ?? {};
  const hasImportMetadata =
    normalizeSourceRefs(frontmatter.source_refs).length > 0
    || normalizePageFileRefs(frontmatter.file_refs).length > 0
    || readNonEmptyString(frontmatter.relative_path) !== null
    || readNonEmptyString(frontmatter.source_path) !== null
    || readNonEmptyString(frontmatter.source_filename) !== null;

  if (isGeneratedArtifactPage(page)) return false;
  if (hasImportMetadata) return true;
  if (NON_IMPORT_PAGE_TYPES.has(page.type)) return false;
  return page.type === "paper" || page.type === "dataset" || page.type === "data" || page.type === "code";
}

function projectPathForPage(page: BrainPage): string | null {
  const frontmatter = page.frontmatter ?? {};
  const candidates = [
    readNonEmptyString(frontmatter.relative_path),
    readNonEmptyString(frontmatter.source_path),
    readNonEmptyString(frontmatter.source_filename),
    ...normalizePageFileRefs(frontmatter.file_refs).map((ref) => readNonEmptyString(ref.filename)),
    ...normalizeSourceRefs(frontmatter.source_refs).map((ref) => readNonEmptyString(ref.ref)),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.startsWith("gbrain:")) continue;
    return normalizeWorkspacePath(candidate);
  }
  return null;
}

function observedAtForPage(page: BrainPage): string | undefined {
  const frontmatter = page.frontmatter ?? {};
  const value = readNonEmptyString(frontmatter.updated_at)
    ?? readNonEmptyString(frontmatter.uploaded_at)
    ?? readNonEmptyString(frontmatter.created_at)
    ?? readNonEmptyString(frontmatter.date);
  return value ?? undefined;
}

function pageCountForPage(page: BrainPage): number | null {
  const raw = page.frontmatter?.page_count;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

function verificationStateForEntry(entry: {
  projectPath: string | null;
  sourceRefs: SourceRef[];
  fileRefs: GbrainPageFileRef[];
  pageCount: number | null;
}): Pick<ProjectImportRegistryEntry, "verificationState" | "missingFields"> {
  const missingFields = [
    entry.projectPath === null ? "projectPath" : null,
    entry.sourceRefs.length === 0 ? "sourceRefs" : null,
    entry.fileRefs.length === 0 ? "fileRefs" : null,
    entry.pageCount === null ? "pageCount" : null,
  ].filter((value): value is string => value !== null);

  if (missingFields.length === 0) {
    return { verificationState: "verified", missingFields };
  }
  return {
    verificationState: missingFields.length >= 3 ? "unavailable" : "partial",
    missingFields,
  };
}

function buildRegistryEntry(page: BrainPage): ProjectImportRegistryEntry {
  const frontmatter = page.frontmatter ?? {};
  const sourceRefs = normalizeSourceRefs(frontmatter.source_refs);
  const fileRefs = normalizePageFileRefs(frontmatter.file_refs);
  const projectPath = projectPathForPage(page);
  const pageCount = pageCountForPage(page);
  const observedAt = observedAtForPage(page);
  const verification = verificationStateForEntry({
    projectPath,
    sourceRefs,
    fileRefs,
    pageCount,
  });

  return {
    pagePath: page.path,
    title: page.title,
    type: page.type,
    projectPath,
    sourceRefs,
    fileRefs,
    pageCount,
    verificationState: verification.verificationState,
    missingFields: verification.missingFields,
    ...(observedAt ? { observedAt } : {}),
  };
}

function duplicateGroupFromRecord(
  group: ProjectImportDuplicateGroupRecord,
): ProjectImportRegistryDuplicateGroup {
  return {
    id: group.id,
    members: [...group.paths],
    reason: group.reason,
    ...(typeof group.hashPrefix === "string" && group.hashPrefix.length > 0
      ? { hashPrefix: group.hashPrefix }
      : {}),
    contentType: group.contentType && group.contentType.length > 0
      ? group.contentType
      : inferDuplicateGroupContentType(group.paths),
  };
}

function parseDuplicateGroupsFromProjectPage(projectPage: BrainPage | null): ProjectImportRegistryDuplicateGroup[] {
  if (!projectPage) return [];
  const lines = projectPage.content.split(/\r?\n/);
  const groups: ProjectImportRegistryDuplicateGroup[] = [];
  let inSection = false;
  let index = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^##\s+Duplicate Groups\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^##\s+/.test(line)) {
      break;
    }
    if (!line.startsWith("- ")) {
      continue;
    }
    const match = /^-\s+(.+?):\s+(.+)$/.exec(line);
    if (!match) continue;
    const reason = match[1].trim();
    const members = match[2]
      .split(",")
      .map((entry) => normalizeWorkspacePath(entry))
      .filter(Boolean);
    if (members.length === 0) continue;
    index += 1;
    const hashMatch = reason.match(/\bhash\s+([a-f0-9]{6,64})\b/i);
    groups.push({
      id: `project-page-dup-${index}`,
      members,
      reason,
      ...(hashMatch ? { hashPrefix: hashMatch[1] } : {}),
      contentType: inferDuplicateGroupContentType(members),
    });
  }

  return groups;
}

export function buildProjectImportDuplicateGroups(
  projectPages: BrainPage[],
  importSummary: ProjectImportSummary | null,
  project: string,
): ProjectImportRegistryDuplicateGroup[] {
  const projectPage = projectPages.find((page) => page.path === `wiki/projects/${project}.md`)
    ?? projectPages.find((page) => page.type === "project")
    ?? null;

  if (Array.isArray(importSummary?.duplicateGroupDetails)) {
    return importSummary.duplicateGroupDetails.map((group) => duplicateGroupFromRecord(group));
  }
  return parseDuplicateGroupsFromProjectPage(projectPage);
}

async function loadProjectImportSummaryForConfig(
  config: BrainConfig,
  project: string,
): Promise<ProjectImportSummary | null> {
  try {
    if (isDefaultScienceSwarmBrainRoot(config.root)) {
      const canonicalSummaryRecord = await readProjectImportSummary(project);
      if (canonicalSummaryRecord) {
        return canonicalSummaryRecord.lastImport;
      }
    }

    const summaryRecord = await readProjectImportSummary(
      project,
      getProjectStateRootForBrainRoot(project, config.root),
    );
    if (summaryRecord) {
      return summaryRecord.lastImport;
    }
    const legacyRecord = await readProjectImportSummary(project, join(config.root, "state"));
    return legacyRecord?.lastImport ?? null;
  } catch {
    return null;
  }
}

export async function buildProjectImportRegistry(input: {
  config: BrainConfig;
  project: string;
  store?: BrainStore;
}): Promise<ProjectImportRegistry> {
  if (!input.store) {
    await ensureBrainStoreReady();
  }
  const store = input.store ?? getBrainStore();
  const [pages, importSummary] = await Promise.all([
    store.listPages({ limit: IMPORT_REGISTRY_PAGE_SCAN_LIMIT }),
    loadProjectImportSummaryForConfig(input.config, input.project),
  ]);

  const projectPages = filterProjectPages(pages, input.project);
  const entries = projectPages
    .filter(isImportRegistryCandidatePage)
    .map((page) => buildRegistryEntry(page))
    .sort((left, right) => left.pagePath.localeCompare(right.pagePath));
  const duplicateGroups = buildProjectImportDuplicateGroups(projectPages, importSummary, input.project);

  const warnings: string[] = [];
  if (
    typeof importSummary?.detectedItems === "number"
    && importSummary.detectedItems > entries.length
  ) {
    warnings.push(
      `Import summary detected ${importSummary.detectedItems} item(s), but only ${entries.length} registered import page(s) are currently visible in gbrain.`,
    );
  }
  if (pages.length >= IMPORT_REGISTRY_PAGE_SCAN_LIMIT) {
    warnings.push(
      `Import registry scanned ${IMPORT_REGISTRY_PAGE_SCAN_LIMIT} page(s), so project results may be truncated if the brain currently holds additional pages.`,
    );
  }

  return {
    project: input.project,
    generatedAt: new Date().toISOString(),
    detectedItemCount: importSummary?.detectedItems ?? null,
    registeredItemCount: entries.length,
    duplicateGroupCount: duplicateGroups.length,
    entries,
    duplicateGroups,
    warnings,
  };
}

export function formatProjectImportRegistryForPrompt(
  registry: ProjectImportRegistry,
): string {
  const payload = {
    project: registry.project,
    detected_item_count: registry.detectedItemCount,
    registered_item_count: registry.registeredItemCount,
    duplicate_group_count: registry.duplicateGroupCount,
    warnings: registry.warnings,
    items: registry.entries.map((entry) => ({
      page_path: entry.pagePath,
      title: entry.title,
      type: entry.type,
      project_path: entry.projectPath,
      source_refs: entry.sourceRefs,
      file_refs: entry.fileRefs.map((ref) => ({
        role: ref.role,
        filename: ref.filename,
        sha256: ref.sha256,
        mime: ref.mime,
        size_bytes: ref.sizeBytes,
      })),
      page_count: entry.pageCount,
      verification_state: entry.verificationState,
      missing_fields: entry.missingFields,
      observed_at: entry.observedAt ?? null,
    })),
    duplicate_groups: registry.duplicateGroups.map((group) => ({
      id: group.id,
      content_type: group.contentType,
      hash_prefix: group.hashPrefix ?? null,
      members: group.members,
      reason: group.reason,
    })),
  };

  return [
    "## Authoritative Import Registry",
    "Authority: gbrain project-linked pages and the persisted project import summary.",
    "If a field is null or listed in missing_fields, treat it as unavailable instead of guessing.",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}
