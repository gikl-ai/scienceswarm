import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import {
  defaultSyncTargetForHost,
  type SkillHost,
  type SkillVisibility,
  type WorkspacePublicSkillIndex,
  type WorkspaceSkillAdapterRecord,
  type WorkspaceSkillManifest,
  type WorkspaceSkillRecord,
  type WorkspaceSkillSource,
  SKILL_HOST_DEFINITIONS,
  SUPPORTED_SKILL_HOSTS,
  WORKSPACE_PUBLIC_INDEX,
  WORKSPACE_SKILL_HOSTS_DIR,
  WORKSPACE_SKILL_MANIFEST,
  WORKSPACE_SKILL_MARKDOWN,
  WORKSPACE_SKILLS_DIR,
} from "@/lib/skills/schema";

const CACHE_ROOT = path.join(os.homedir(), ".scienceswarm", "cache", "skills", "repos");

type ManifestUpdate = Partial<
  Pick<
    WorkspaceSkillManifest,
    "name" | "description" | "visibility" | "status" | "tags" | "hosts" | "owner" | "summary"
  >
>;

type CreateWorkspaceSkillInput = {
  slug: string;
  name: string;
  description: string;
  visibility?: SkillVisibility;
  hosts: SkillHost[];
  status?: WorkspaceSkillManifest["status"];
  tags?: string[];
  owner?: string | null;
  summary?: string | null;
};

type ImportWorkspaceSkillInput = {
  repo: string;
  ref?: string;
  path: string;
  host: SkillHost;
  slug?: string;
  visibility?: SkillVisibility;
  status?: WorkspaceSkillManifest["status"];
  owner?: string | null;
  tags?: string[];
  summary?: string | null;
};

export class WorkspaceSkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSkillValidationError";
  }
}

export class WorkspaceSkillNotFoundError extends Error {
  constructor(slug: string) {
    super(`Unknown workspace skill "${slug}".`);
    this.name = "WorkspaceSkillNotFoundError";
  }
}

export class WorkspaceSkillConflictError extends Error {
  constructor(slug: string) {
    super(`Workspace skill "${slug}" already exists.`);
    this.name = "WorkspaceSkillConflictError";
  }
}

export function listSupportedSkillHosts(): string[] {
  return [...SUPPORTED_SKILL_HOSTS];
}

export async function listWorkspaceSkills(repoRoot = process.cwd()): Promise<WorkspaceSkillRecord[]> {
  const workspaceRoot = resolveWorkspaceRoot(repoRoot);
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readWorkspaceSkill(entry.name, repoRoot)),
  );

  return skills.sort((left, right) => {
    if (left.visibility !== right.visibility) {
      return left.visibility === "public" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export async function listPublicWorkspaceSkills(repoRoot = process.cwd()): Promise<WorkspaceSkillRecord[]> {
  const skills = await listWorkspaceSkills(repoRoot);
  return skills.filter((skill) => skill.visibility === "public");
}

export async function readWorkspaceSkill(
  slug: string,
  repoRoot = process.cwd(),
): Promise<WorkspaceSkillRecord> {
  const normalizedSlug = assertValidSkillSlug(slug);
  const manifestPath = await resolveExistingWorkspaceManifestPath(normalizedSlug, repoRoot);
  const manifest = parseWorkspaceManifest(
    normalizedSlug,
    await readFile(manifestPath, "utf-8"),
  );
  const adapters = await readWorkspaceSkillAdapters(manifest, repoRoot);
  return { ...manifest, adapters };
}

export async function createWorkspaceSkill(
  input: CreateWorkspaceSkillInput,
  repoRoot = process.cwd(),
): Promise<WorkspaceSkillRecord> {
  const slug = assertValidSkillSlug(input.slug);
  const skillRoot = resolveWorkspaceSkillRoot(slug, repoRoot);
  if (existsSync(skillRoot)) {
    throw new WorkspaceSkillConflictError(slug);
  }

  const now = new Date().toISOString();
  const hosts = normalizeHosts(input.hosts);
  if (hosts.length === 0) {
    throw new WorkspaceSkillValidationError("Select at least one host.");
  }

  const manifest: WorkspaceSkillManifest = {
    slug,
    name: assertNonEmpty(input.name, "name"),
    description: assertNonEmpty(input.description, "description"),
    visibility: input.visibility ?? "private",
    status: input.status ?? "draft",
    tags: normalizeStringArray(input.tags ?? []),
    hosts,
    owner: normalizeNullableString(input.owner ?? null),
    summary: normalizeNullableString(input.summary ?? null),
    source: { kind: "local" },
    createdAt: now,
    updatedAt: now,
  };

  await mkdir(path.join(skillRoot, WORKSPACE_SKILL_HOSTS_DIR), { recursive: true });
  await writeWorkspaceManifest(manifest, repoRoot);

  await Promise.all(
    hosts.map(async (host) => {
      const adapterPath = resolveWorkspaceAdapterPath(slug, host, repoRoot);
      await mkdir(path.dirname(adapterPath), { recursive: true });
      await writeFile(
        adapterPath,
        buildStarterSkillMarkdown({ slug, name: manifest.name, description: manifest.description, host }),
        "utf-8",
      );
    }),
  );

  await writeWorkspacePublicIndex(repoRoot);
  return readWorkspaceSkill(slug, repoRoot);
}

export async function saveWorkspaceSkill(
  slug: string,
  input: { manifest?: ManifestUpdate; adapterHost?: SkillHost; markdown?: string },
  repoRoot = process.cwd(),
): Promise<WorkspaceSkillRecord> {
  const existing = await readWorkspaceSkill(slug, repoRoot);
  const { adapters: _existingAdapters, ...existingManifest } = existing;
  const manifest = {
    ...existingManifest,
    ...(input.manifest ?? {}),
    tags:
      input.manifest && "tags" in input.manifest
        ? normalizeStringArray(input.manifest.tags ?? [])
        : existing.tags,
    hosts:
      input.manifest && "hosts" in input.manifest
        ? normalizeHosts(input.manifest.hosts ?? [])
        : existing.hosts,
    name:
      input.manifest && "name" in input.manifest
        ? assertNonEmpty(input.manifest.name ?? "", "name")
        : existing.name,
    description:
      input.manifest && "description" in input.manifest
        ? assertNonEmpty(input.manifest.description ?? "", "description")
        : existing.description,
    visibility:
      input.manifest && "visibility" in input.manifest
        ? normalizeVisibility(input.manifest.visibility ?? existing.visibility)
        : existing.visibility,
    status:
      input.manifest && "status" in input.manifest
        ? normalizeStatus(input.manifest.status ?? existing.status)
        : existing.status,
    owner:
      input.manifest && "owner" in input.manifest
        ? normalizeNullableString(input.manifest.owner ?? null)
        : existing.owner,
    summary:
      input.manifest && "summary" in input.manifest
        ? normalizeNullableString(input.manifest.summary ?? null)
        : existing.summary,
    source: existing.source,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  } satisfies WorkspaceSkillManifest;

  if (manifest.hosts.length === 0) {
    throw new WorkspaceSkillValidationError("Select at least one host.");
  }

  await writeWorkspaceManifest(manifest, repoRoot);

  for (const host of manifest.hosts) {
    const adapterPath = resolveWorkspaceAdapterPath(slug, host, repoRoot);
    if (!existsSync(adapterPath)) {
      await mkdir(path.dirname(adapterPath), { recursive: true });
      await writeFile(
        adapterPath,
        buildStarterSkillMarkdown({
          slug,
          name: manifest.name,
          description: manifest.description,
          host,
        }),
        "utf-8",
      );
    }
  }

  if (input.adapterHost) {
    const host = assertValidHost(input.adapterHost);
    if (!manifest.hosts.includes(host)) {
      throw new WorkspaceSkillValidationError(`Host "${host}" is not enabled for ${slug}.`);
    }
    if (!input.markdown) {
      throw new WorkspaceSkillValidationError("Adapter saves require markdown.");
    }
    const normalizedMarkdown = normalizeSkillMarkdown(input.markdown);
    validateSkillMarkdown(slug, normalizedMarkdown);
    const adapterPath = resolveWorkspaceAdapterPath(slug, host, repoRoot);
    await mkdir(path.dirname(adapterPath), { recursive: true });
    await writeFile(adapterPath, normalizedMarkdown, "utf-8");
  }

  await writeWorkspacePublicIndex(repoRoot);
  return readWorkspaceSkill(slug, repoRoot);
}

export async function importWorkspaceSkillFromGitHub(
  input: ImportWorkspaceSkillInput,
  repoRoot = process.cwd(),
): Promise<WorkspaceSkillRecord> {
  const repo = validateRepositorySlug(assertNonEmpty(input.repo, "repo"));
  const ref = normalizeNullableString(input.ref) ?? "main";
  const host = assertValidHost(input.host);
  const cacheDir = ensureRepoCache(repo, ref);
  refreshRepoCache(cacheDir, ref);

  const { sourceDir, markdown } = await resolveImportedSkillSource(cacheDir, input.path);
  const importedSlug = assertValidSkillSlug(input.slug ?? validateSkillMarkdown(null, markdown).name);
  const parsed = validateSkillMarkdown(importedSlug, markdown);
  const slug = importedSlug;
  const skillRoot = resolveWorkspaceSkillRoot(slug, repoRoot);
  if (existsSync(skillRoot)) {
    throw new WorkspaceSkillConflictError(slug);
  }

  const now = new Date().toISOString();
  const manifest: WorkspaceSkillManifest = {
    slug,
    name: parsed.name,
    description: input.summary?.trim() || parsed.description,
    visibility: input.visibility ?? "private",
    status: input.status ?? "draft",
    tags: normalizeStringArray(input.tags ?? []),
    hosts: [host],
    owner: normalizeNullableString(input.owner ?? repo.split("/")[0] ?? null),
    summary: normalizeNullableString(input.summary ?? parsed.description),
    source: {
      kind: "imported",
      repo,
      ref,
      path: normalizeImportPath(input.path),
      importedAt: now,
    } satisfies WorkspaceSkillSource,
    createdAt: now,
    updatedAt: now,
  };

  await mkdir(path.join(skillRoot, WORKSPACE_SKILL_HOSTS_DIR, host), { recursive: true });
  await writeWorkspaceManifest(manifest, repoRoot);
  await writeFile(
    resolveWorkspaceAdapterPath(slug, host, repoRoot),
    normalizeSkillMarkdown(markdown),
    "utf-8",
  );

  const referencesDir = path.join(sourceDir, "references");
  if (existsSync(referencesDir)) {
    await copyDirectory(
      referencesDir,
      path.join(skillRoot, "references", host),
    );
  }

  await writeWorkspacePublicIndex(repoRoot);
  return readWorkspaceSkill(slug, repoRoot);
}

export async function syncWorkspaceSkill(
  slug: string,
  hosts: SkillHost[] | undefined,
  repoRoot = process.cwd(),
): Promise<WorkspaceSkillRecord> {
  const skill = await readWorkspaceSkill(slug, repoRoot);
  const selectedHosts = hosts && hosts.length > 0 ? normalizeHosts(hosts) : skill.hosts;

  for (const host of selectedHosts) {
    const adapter = skill.adapters.find((entry) => entry.host === host);
    if (!adapter) {
      throw new WorkspaceSkillValidationError(`Skill "${slug}" has no ${host} adapter.`);
    }
    if (adapter.syncState === "missing-adapter" || adapter.rawMarkdown.trim().length === 0) {
      throw new WorkspaceSkillValidationError(
        `Skill "${slug}" has an invalid ${host} adapter. Fix the workspace adapter before syncing.`,
      );
    }
    if (!adapter.syncTargetPath) {
      continue;
    }
    const targetPath = path.join(repoRoot, adapter.syncTargetPath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, normalizeSkillMarkdown(adapter.rawMarkdown), "utf-8");
  }

  await writeWorkspacePublicIndex(repoRoot);
  return readWorkspaceSkill(slug, repoRoot);
}

export async function promoteWorkspaceSkill(
  slug: string,
  repoRoot = process.cwd(),
): Promise<WorkspaceSkillRecord> {
  const skill = await readWorkspaceSkill(slug, repoRoot);
  if (skill.visibility === "public") {
    return syncWorkspaceSkill(slug, skill.hosts, repoRoot);
  }

  const issues = collectPromotionIssues(skill);
  if (issues.length > 0) {
    throw new WorkspaceSkillValidationError(
      [
        `Skill "${skill.slug}" is not ready for public promotion:`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );
  }

  const { adapters: _adapters, ...manifest } = skill;
  await writeWorkspaceManifest(
    {
      ...manifest,
      visibility: "public",
      updatedAt: new Date().toISOString(),
    },
    repoRoot,
  );

  return syncWorkspaceSkill(slug, skill.hosts, repoRoot);
}

export async function writeWorkspacePublicIndex(repoRoot = process.cwd()): Promise<WorkspacePublicSkillIndex> {
  const skills = await listPublicWorkspaceSkills(repoRoot);
  const index: WorkspacePublicSkillIndex = {
    generatedAt: new Date().toISOString(),
    skills: skills.map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      hosts: skill.hosts,
      owner: skill.owner,
      status: skill.status,
      summary: skill.summary,
    })),
  };
  const indexPath = path.join(resolveWorkspaceRoot(repoRoot), WORKSPACE_PUBLIC_INDEX);
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  return index;
}

async function readWorkspaceSkillAdapters(
  manifest: WorkspaceSkillManifest,
  repoRoot: string,
): Promise<WorkspaceSkillAdapterRecord[]> {
  const skillsRoot = resolveWorkspaceSkillRoot(manifest.slug, repoRoot);
  const hostsOnDisk = await listHostsOnDisk(skillsRoot);
  const hostSet = new Set<string>([...manifest.hosts, ...hostsOnDisk]);
  const adapters: WorkspaceSkillAdapterRecord[] = [];

  for (const host of [...hostSet].sort()) {
    const adapterPath = resolveWorkspaceAdapterPath(manifest.slug, host, repoRoot);
    const relativePath = path.relative(repoRoot, adapterPath);
    if (!existsSync(adapterPath)) {
      adapters.push({
        host,
        relativePath,
        syncTargetPath: defaultSyncTargetForHost(host, manifest.slug),
        syncState: "missing-adapter",
        rawMarkdown: "",
      });
      continue;
    }
    try {
      const rawMarkdown = normalizeSkillMarkdown(await readFile(adapterPath, "utf-8"));
      validateSkillMarkdown(manifest.slug, rawMarkdown);
      const syncTargetPath = defaultSyncTargetForHost(host, manifest.slug);
      const syncState = await computeSyncState(syncTargetPath, rawMarkdown, repoRoot);
      adapters.push({
        host,
        relativePath,
        syncTargetPath,
        syncState,
        rawMarkdown,
      });
    } catch (error) {
      if (!(error instanceof WorkspaceSkillValidationError)) {
        throw error;
      }
      adapters.push({
        host,
        relativePath,
        syncTargetPath: defaultSyncTargetForHost(host, manifest.slug),
        syncState: "missing-adapter",
        rawMarkdown: "",
      });
    }
  }

  return adapters;
}

async function computeSyncState(
  syncTargetPath: string | null,
  rawMarkdown: string,
  repoRoot: string,
): Promise<WorkspaceSkillAdapterRecord["syncState"]> {
  if (!syncTargetPath) return "no-target";
  const targetPath = path.join(repoRoot, syncTargetPath);
  if (!existsSync(targetPath)) return "pending";
  const current = normalizeSkillMarkdown(await readFile(targetPath, "utf-8"));
  return current === normalizeSkillMarkdown(rawMarkdown) ? "synced" : "pending";
}

async function listHostsOnDisk(skillRoot: string): Promise<string[]> {
  const hostsRoot = path.join(skillRoot, WORKSPACE_SKILL_HOSTS_DIR);
  try {
    const entries = await readdir(hostsRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function resolveWorkspaceRoot(repoRoot: string): string {
  return path.join(repoRoot, WORKSPACE_SKILLS_DIR);
}

function resolveWorkspaceSkillRoot(slug: string, repoRoot: string): string {
  return path.join(resolveWorkspaceRoot(repoRoot), slug);
}

function resolveWorkspaceManifestPath(slug: string, repoRoot: string): string {
  return path.join(resolveWorkspaceSkillRoot(slug, repoRoot), WORKSPACE_SKILL_MANIFEST);
}

function resolveWorkspaceAdapterPath(slug: string, host: SkillHost, repoRoot: string): string {
  return path.join(
    resolveWorkspaceSkillRoot(slug, repoRoot),
    WORKSPACE_SKILL_HOSTS_DIR,
    host,
    WORKSPACE_SKILL_MARKDOWN,
  );
}

async function resolveExistingWorkspaceManifestPath(slug: string, repoRoot: string): Promise<string> {
  const declaredRoot = resolveWorkspaceRoot(repoRoot);
  const declaredPath = resolveWorkspaceManifestPath(slug, repoRoot);

  let realRoot: string;
  let realPath: string;
  try {
    [realRoot, realPath] = await Promise.all([realpath(declaredRoot), realpath(declaredPath)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new WorkspaceSkillNotFoundError(slug);
    }
    throw error;
  }

  if (!isPathWithinRoot(realRoot, realPath)) {
    throw new WorkspaceSkillValidationError(
      `Workspace skill "${slug}" resolves outside ${WORKSPACE_SKILLS_DIR}.`,
    );
  }
  return realPath;
}

function parseWorkspaceManifest(slug: string, rawJson: string): WorkspaceSkillManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new WorkspaceSkillValidationError(`Invalid skill.json: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkspaceSkillValidationError("skill.json must contain an object.");
  }
  const record = parsed as Record<string, unknown>;

  const name = assertNonEmpty(record.name, "name");
  const description = assertNonEmpty(record.description, "description");
  const hosts = normalizeHosts(record.hosts);
  if (hosts.length === 0) {
    throw new WorkspaceSkillValidationError(`Skill "${slug}" must declare at least one host.`);
  }

  return {
    slug,
    name,
    description,
    visibility: normalizeVisibility(record.visibility),
    status: normalizeStatus(record.status),
    tags: normalizeStringArray(record.tags),
    hosts,
    owner: normalizeNullableString(record.owner ?? null),
    summary: normalizeNullableString(record.summary ?? null),
    source: normalizeSource(record.source),
    createdAt: assertIsoString(record.createdAt, "createdAt"),
    updatedAt: assertIsoString(record.updatedAt, "updatedAt"),
  };
}

function normalizeSource(value: unknown): WorkspaceSkillSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "local" };
  }
  const source = value as Record<string, unknown>;
  return {
    kind: source.kind === "imported" ? "imported" : "local",
    repo: normalizeNullableString(source.repo ?? null) ?? undefined,
    ref: normalizeNullableString(source.ref ?? null) ?? undefined,
    path: normalizeNullableString(source.path ?? null) ?? undefined,
    importedAt: normalizeNullableString(source.importedAt ?? null) ?? undefined,
  };
}

function normalizeHosts(value: unknown): SkillHost[] {
  if (!Array.isArray(value)) return [];
  const hosts = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => assertValidHost(entry));
  return [...new Set(hosts)];
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
}

function normalizeVisibility(value: unknown): SkillVisibility {
  return value === "public" ? "public" : "private";
}

function normalizeStatus(value: unknown): WorkspaceSkillManifest["status"] {
  return value === "ready" ? "ready" : "draft";
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function assertIsoString(value: unknown, field: string): string {
  const normalized = normalizeNullableString(value);
  if (!normalized) {
    throw new WorkspaceSkillValidationError(`skill.json must include ${field}.`);
  }
  return normalized;
}

function assertValidSkillSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new WorkspaceSkillValidationError("Invalid skill slug.");
  }
  return normalized;
}

function assertValidHost(host: string): SkillHost {
  const normalized = host.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new WorkspaceSkillValidationError(`Invalid host "${host}".`);
  }
  return normalized;
}

function assertNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkspaceSkillValidationError(`Expected a non-empty ${field}.`);
  }
  return value.trim();
}

function normalizeSkillMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function validateSkillMarkdown(expectedSlug: string | null, rawMarkdown: string): { name: string; description: string } {
  if (!rawMarkdown.trimStart().startsWith("---")) {
    throw new WorkspaceSkillValidationError("SKILL.md must start with YAML frontmatter.");
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(rawMarkdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid YAML frontmatter";
    throw new WorkspaceSkillValidationError(`Invalid YAML frontmatter: ${message}`);
  }

  const name = assertNonEmpty(parsed.data.name, "frontmatter name");
  const description = assertNonEmpty(parsed.data.description, "frontmatter description");
  if (expectedSlug && name !== expectedSlug) {
    throw new WorkspaceSkillValidationError(
      `Frontmatter name must match the skill slug "${expectedSlug}".`,
    );
  }
  return { name, description };
}

async function writeWorkspaceManifest(manifest: WorkspaceSkillManifest, repoRoot: string): Promise<void> {
  const manifestPath = resolveWorkspaceManifestPath(manifest.slug, repoRoot);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

function collectPromotionIssues(skill: WorkspaceSkillRecord): string[] {
  const issues: string[] = [];

  if (skill.status !== "ready") {
    issues.push('mark the skill status as "ready"');
  }
  if (skill.tags.length === 0) {
    issues.push("add at least one catalog tag");
  }
  if (!skill.summary || skill.summary.trim().length === 0) {
    issues.push("add a public summary");
  }

  for (const host of skill.hosts) {
    const adapter = skill.adapters.find((entry) => entry.host === host);
    if (!adapter || adapter.syncState === "missing-adapter" || adapter.rawMarkdown.trim().length === 0) {
      issues.push(`add a ${host} adapter before promoting`);
    }
  }

  return issues;
}

function buildStarterSkillMarkdown(input: {
  slug: string;
  name: string;
  description: string;
  host: SkillHost;
}): string {
  const hostLabel = SKILL_HOST_DEFINITIONS.find((entry) => entry.host === input.host)?.label ?? input.host;
  return `---
name: ${input.slug}
description: ${input.description}
---

# ${input.name}

Use this skill when the user needs a repeatable ${hostLabel} workflow.

## Workflow

1. Restate the user goal in one sentence before doing work.
2. Gather the minimum context needed from the current repo, workspace, or sources.
3. Execute the task with clear assumptions and explicit verification.
4. Report what changed, what remains risky, and which host-specific follow-up is needed.
`;
}

function ensureRepoCache(repo: string, ref: string): string {
  const repoSlug = repo.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const refSlug = ref.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const cacheDir = path.join(CACHE_ROOT, `${repoSlug}__${refSlug}`);
  if (!existsSync(cacheDir)) {
    mkdirSyncCompat(CACHE_ROOT);
    execFileSync(
      "git",
      ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${repo}.git`, cacheDir],
      { stdio: "inherit" },
    );
  }
  return cacheDir;
}

function refreshRepoCache(cacheDir: string, ref: string): void {
  execFileSync("git", ["-C", cacheDir, "fetch", "--depth", "1", "origin", ref], {
    stdio: "inherit",
  });
  execFileSync("git", ["-C", cacheDir, "checkout", "--force", "FETCH_HEAD"], {
    stdio: "inherit",
  });
}

async function resolveImportedSkillSource(
  cacheDir: string,
  importPath: string,
): Promise<{ sourceDir: string; markdown: string }> {
  const normalized = normalizeImportPath(importPath);
  const candidate = path.join(cacheDir, normalized);
  let sourceDir = candidate;
  let skillPath = candidate;

  if (!candidate.endsWith(WORKSPACE_SKILL_MARKDOWN)) {
    skillPath = path.join(candidate, WORKSPACE_SKILL_MARKDOWN);
  } else {
    sourceDir = path.dirname(candidate);
  }

  if (!existsSync(skillPath)) {
    throw new WorkspaceSkillValidationError(`Could not find SKILL.md at ${normalized}.`);
  }

  const [realRoot, realSkillPath, realSourceDir] = await Promise.all([
    realpath(cacheDir),
    realpath(skillPath),
    realpath(sourceDir),
  ]);
  if (!isPathWithinRoot(realRoot, realSkillPath) || !isPathWithinRoot(realRoot, realSourceDir)) {
    throw new WorkspaceSkillValidationError(`Import path "${normalized}" resolves outside the repo cache.`);
  }

  return {
    sourceDir: realSourceDir,
    markdown: await readFile(realSkillPath, "utf-8"),
  };
}

function normalizeImportPath(importPath: string): string {
  const normalized = importPath.trim().replace(/^\/+/, "");
  if (!normalized) {
    throw new WorkspaceSkillValidationError("Import path cannot be empty.");
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new WorkspaceSkillValidationError("Import path cannot contain '..'.");
  }
  return normalized;
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile()) {
      await writeFile(targetPath, await readFile(sourcePath));
    }
  }
}

function mkdirSyncCompat(dirPath: string): void {
  if (!existsSync(dirPath)) {
    execFileSync("mkdir", ["-p", dirPath]);
  }
}

function validateRepositorySlug(repo: string): string {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    throw new WorkspaceSkillValidationError(`Invalid repo format "${repo}". Expected "owner/name".`);
  }
  return repo;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
