import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseOpenClawSkillMarkdown } from "@/lib/openclaw/skill-catalog";
import { runOpenClaw } from "@/lib/openclaw/runner";
import {
  getScienceSwarmCacheRoot,
  getScienceSwarmMarketPluginsRoot,
  getScienceSwarmOpenClawStateDir,
} from "@/lib/scienceswarm-paths";

const INSTALL_MANIFEST = "install.json";
const SNAPSHOT_DIR = "bundle";
const EXECUTABLE_EXTENSIONS = new Set([".bash", ".cjs", ".js", ".mjs", ".py", ".sh", ".ts", ".zsh"]);
const DEFAULT_MARKET_PLUGIN_REF = "main";

type InstallMarketPluginFromGitHubInput = {
  repo: string;
  ref?: string;
  path: string;
};

type MarketPluginHostStatus = "installed" | "partial" | "missing";
type MarketPluginHostProjectionMode = "direct" | "aliased";

export interface InstalledMarketPluginSkill {
  slug: string;
  description: string;
  runtime: string | null;
  emoji: string | null;
}

export interface MarketPluginHostProjection {
  sourceSlug: string;
  hostSlug: string;
  installPath: string;
  mode: MarketPluginHostProjectionMode;
}

export interface MarketPluginHostRecord {
  status: MarketPluginHostStatus;
  installRoot: string;
  projectedSkills: MarketPluginHostProjection[];
}

export interface MarketPluginTrustSummary {
  totalFiles: number;
  scriptFileCount: number;
  executableFileCount: number;
  agentFileCount: number;
  referenceFileCount: number;
  assetFileCount: number;
  scriptFiles: string[];
  detectedRuntimes: string[];
}

export interface MarketPluginInstallPreview {
  id: string;
  name: string;
  displayName: string;
  description: string;
  pluginVersion: string | null;
  bundleFormat: "codex";
  license: string | null;
  skillsPath: string;
  skills: InstalledMarketPluginSkill[];
  source: {
    kind: "github";
    repo: string;
    requestedRef: string;
    resolvedCommit: string;
    path: string;
  };
  trust: MarketPluginTrustSummary;
  hosts: {
    openclaw: Pick<MarketPluginHostRecord, "installRoot" | "projectedSkills">;
    codex: Pick<MarketPluginHostRecord, "installRoot" | "projectedSkills">;
    "claude-code": Pick<MarketPluginHostRecord, "installRoot" | "projectedSkills">;
  };
}

export interface InstalledMarketPluginRecord {
  id: string;
  name: string;
  displayName: string;
  description: string;
  pluginVersion: string | null;
  bundleFormat: "codex";
  license: string | null;
  skillsPath: string;
  skills: InstalledMarketPluginSkill[];
  bundlePath: string;
  pluginManifestPath: string;
  installedAt: string;
  updatedAt: string | null;
  source: {
    kind: "github";
    repo: string;
    requestedRef: string;
    resolvedCommit: string;
    path: string;
  };
  trust: MarketPluginTrustSummary;
  hosts: {
    openclaw: MarketPluginHostRecord;
    codex: MarketPluginHostRecord;
    "claude-code": MarketPluginHostRecord;
  };
}

type ParsedMarketPluginManifest = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  pluginVersion: string | null;
  license: string | null;
  skillsPath: string;
};

type ResolvedMarketPluginBundle = {
  bundleRoot: string;
  pluginManifestPath: string;
  manifest: ParsedMarketPluginManifest;
  skills: InstalledMarketPluginSkill[];
  trust: MarketPluginTrustSummary;
};

export class MarketPluginValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketPluginValidationError";
  }
}

export class MarketPluginConflictError extends Error {
  constructor(id: string) {
    super(`Market plugin "${id}" is already installed.`);
    this.name = "MarketPluginConflictError";
  }
}

export class MarketPluginNotFoundError extends Error {
  constructor(id: string) {
    super(`Unknown market plugin "${id}".`);
    this.name = "MarketPluginNotFoundError";
  }
}

export async function listInstalledMarketPlugins(
  repoRoot = process.cwd(),
): Promise<InstalledMarketPluginRecord[]> {
  const installsRoot = getScienceSwarmMarketPluginsRoot();
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(installsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const plugins = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => readInstalledMarketPlugin(entry.name, repoRoot).catch(() => null)),
  );

  return plugins
    .filter((plugin): plugin is InstalledMarketPluginRecord => plugin !== null)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function readInstalledMarketPlugin(
  id: string,
  repoRoot = process.cwd(),
): Promise<InstalledMarketPluginRecord> {
  const normalizedId = normalizePluginId(id);
  const manifestPath = path.join(resolvePluginMetadataRoot(normalizedId), INSTALL_MANIFEST);
  let rawJson: string;
  try {
    rawJson = await readFile(manifestPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new MarketPluginNotFoundError(normalizedId);
    }
    throw error;
  }

  return applyHostStatuses(parseInstalledMarketPluginRecord(rawJson, repoRoot), repoRoot);
}

export async function inspectMarketPluginFromGitHub(
  input: InstallMarketPluginFromGitHubInput,
  repoRoot = process.cwd(),
): Promise<MarketPluginInstallPreview> {
  const source = await resolveGitHubPluginSource(input);
  const existing = await readInstalledMarketPluginIfPresent(source.bundle.manifest.id, repoRoot);
  const hosts = buildHostPlan(source.bundle, existing, repoRoot);

  return {
    id: source.bundle.manifest.id,
    name: source.bundle.manifest.name,
    displayName: source.bundle.manifest.displayName,
    description: source.bundle.manifest.description,
    pluginVersion: source.bundle.manifest.pluginVersion,
    bundleFormat: "codex",
    license: source.bundle.manifest.license,
    skillsPath: source.bundle.manifest.skillsPath,
    skills: source.bundle.skills,
    source: {
      kind: "github",
      repo: source.repo,
      requestedRef: source.ref,
      resolvedCommit: source.resolvedCommit,
      path: source.importPath,
    },
    trust: source.bundle.trust,
    hosts: {
      openclaw: {
        installRoot: hosts.openclaw.installRoot,
        projectedSkills: hosts.openclaw.projectedSkills,
      },
      codex: {
        installRoot: hosts.codex.installRoot,
        projectedSkills: hosts.codex.projectedSkills,
      },
      "claude-code": {
        installRoot: hosts["claude-code"].installRoot,
        projectedSkills: hosts["claude-code"].projectedSkills,
      },
    },
  };
}

export async function installMarketPluginFromGitHub(
  input: InstallMarketPluginFromGitHubInput,
  repoRoot = process.cwd(),
): Promise<InstalledMarketPluginRecord> {
  const source = await resolveGitHubPluginSource(input);
  const pluginId = source.bundle.manifest.id;
  const metadataRoot = resolvePluginMetadataRoot(pluginId);

  if (existsSync(metadataRoot) || existsSync(resolveOpenClawPluginInstallRoot(pluginId))) {
    throw new MarketPluginConflictError(pluginId);
  }

  const snapshotRoot = resolvePluginSnapshotRoot(pluginId);
  const plannedHosts = buildHostPlan(source.bundle, null, repoRoot);
  const now = new Date().toISOString();
  const draftRecord: InstalledMarketPluginRecord = {
    id: pluginId,
    name: source.bundle.manifest.name,
    displayName: source.bundle.manifest.displayName,
    description: source.bundle.manifest.description,
    pluginVersion: source.bundle.manifest.pluginVersion,
    bundleFormat: "codex",
    license: source.bundle.manifest.license,
    skillsPath: source.bundle.manifest.skillsPath,
    skills: source.bundle.skills,
    bundlePath: snapshotRoot,
    pluginManifestPath: path.join(snapshotRoot, ".codex-plugin", "plugin.json"),
    installedAt: now,
    updatedAt: null,
    source: {
      kind: "github",
      repo: source.repo,
      requestedRef: source.ref,
      resolvedCommit: source.resolvedCommit,
      path: source.importPath,
    },
    trust: source.bundle.trust,
    hosts: plannedHosts,
  };

  await mkdir(metadataRoot, { recursive: true });
  await copyDirectory(source.bundle.bundleRoot, snapshotRoot);
  await writeInstalledMarketPluginRecord(draftRecord);

  try {
    const activated = await activateInstalledMarketPlugin(
      draftRecord,
      {
        ...source.bundle,
        bundleRoot: snapshotRoot,
        pluginManifestPath: path.join(snapshotRoot, ".codex-plugin", "plugin.json"),
      },
      repoRoot,
      null,
    );
    await writeInstalledMarketPluginRecord(activated);
    return activated;
  } catch (error) {
    await uninstallMarketPlugin(pluginId, repoRoot).catch(() => undefined);
    throw error;
  }
}

export async function reinstallMarketPlugin(
  id: string,
  repoRoot = process.cwd(),
): Promise<InstalledMarketPluginRecord> {
  const existing = await readInstalledMarketPlugin(id, repoRoot);
  const bundle = await resolveInstalledBundle(existing);
  const nextRecord = buildInstalledRecordFromBundle(
    bundle,
    existing.source,
    existing,
    repoRoot,
    { preserveInstalledAt: true, updatedAt: new Date().toISOString() },
  );
  const activated = await activateInstalledMarketPlugin(nextRecord, bundle, repoRoot, existing);
  await writeInstalledMarketPluginRecord(activated);
  return activated;
}

export async function updateMarketPluginFromGitHub(
  id: string,
  repoRoot = process.cwd(),
): Promise<InstalledMarketPluginRecord> {
  const existing = await readInstalledMarketPlugin(id, repoRoot);
  const source = await resolveGitHubPluginSource({
    repo: existing.source.repo,
    ref: existing.source.requestedRef,
    path: existing.source.path,
  });

  if (source.bundle.manifest.id !== existing.id) {
    throw new MarketPluginValidationError(
      `Upstream source now resolves to "${source.bundle.manifest.id}", not "${existing.id}".`,
    );
  }

  const tempSnapshotRoot = resolvePluginTempSnapshotRoot(existing.id);
  await rm(tempSnapshotRoot, { recursive: true, force: true });
  await copyDirectory(source.bundle.bundleRoot, tempSnapshotRoot);

  try {
    const nextRecord = buildInstalledRecordFromBundle(
      {
        ...source.bundle,
        bundleRoot: tempSnapshotRoot,
        pluginManifestPath: path.join(tempSnapshotRoot, ".codex-plugin", "plugin.json"),
      },
      {
        kind: "github",
        repo: source.repo,
        requestedRef: source.ref,
        resolvedCommit: source.resolvedCommit,
        path: source.importPath,
      },
      existing,
      repoRoot,
      { preserveInstalledAt: true, updatedAt: new Date().toISOString() },
    );
    const activated = await activateInstalledMarketPlugin(
      nextRecord,
      {
        ...source.bundle,
        bundleRoot: tempSnapshotRoot,
        pluginManifestPath: path.join(tempSnapshotRoot, ".codex-plugin", "plugin.json"),
      },
      repoRoot,
      existing,
    );

    await rm(existing.bundlePath, { recursive: true, force: true });
    await rename(tempSnapshotRoot, existing.bundlePath);
    const persistedRecord = {
      ...activated,
      bundlePath: existing.bundlePath,
      pluginManifestPath: path.join(existing.bundlePath, ".codex-plugin", "plugin.json"),
    } satisfies InstalledMarketPluginRecord;
    await writeInstalledMarketPluginRecord(persistedRecord);
    return persistedRecord;
  } finally {
    await rm(tempSnapshotRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function uninstallMarketPlugin(id: string, repoRoot = process.cwd()): Promise<void> {
  const plugin = await readInstalledMarketPlugin(id, repoRoot);

  await removeRepoHostProjection(plugin.hosts.codex);
  await removeRepoHostProjection(plugin.hosts["claude-code"]);

  if (existsSync(plugin.hosts.openclaw.installRoot)) {
    const uninstallResult = await runOpenClaw(
      ["plugins", "uninstall", plugin.id, "--force"],
      { timeoutMs: 120_000 },
    );
    if (!uninstallResult.ok) {
      throw new MarketPluginValidationError(
        formatOpenClawFailure(
          uninstallResult.stderr,
          uninstallResult.stdout,
          `OpenClaw could not uninstall "${plugin.id}".`,
        ),
      );
    }
  }

  await rm(resolvePluginMetadataRoot(plugin.id), { recursive: true, force: true });
}

function parseInstalledMarketPluginRecord(
  rawJson: string,
  repoRoot: string,
): InstalledMarketPluginRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new MarketPluginValidationError(`Invalid market plugin manifest: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MarketPluginValidationError("Market plugin manifest must contain an object.");
  }
  const record = parsed as Record<string, unknown>;
  const source = readRecord(record.source, "source");
  const hosts = readRecord(record.hosts, "hosts");
  const id = normalizePluginId(assertNonEmpty(record.id, "id"));
  const skillsPath = assertNonEmpty(record.skillsPath, "skillsPath");
  const skills = normalizeInstalledSkills(record.skills);

  return {
    id,
    name: assertNonEmpty(record.name, "name"),
    displayName: assertNonEmpty(record.displayName, "displayName"),
    description: assertNonEmpty(record.description, "description"),
    pluginVersion: normalizeNullableString(record.pluginVersion),
    bundleFormat: "codex",
    license: normalizeNullableString(record.license),
    skillsPath,
    skills,
    bundlePath: normalizeNullableString(record.bundlePath) ?? resolvePluginSnapshotRoot(id),
    pluginManifestPath:
      normalizeNullableString(record.pluginManifestPath) ??
      path.join(resolvePluginSnapshotRoot(id), ".codex-plugin", "plugin.json"),
    installedAt: assertNonEmpty(record.installedAt, "installedAt"),
    updatedAt: normalizeNullableString(record.updatedAt),
    source: {
      kind: "github",
      repo: assertNonEmpty(source.repo, "source.repo"),
      requestedRef: assertNonEmpty(source.requestedRef, "source.requestedRef"),
      resolvedCommit: assertNonEmpty(source.resolvedCommit, "source.resolvedCommit"),
      path: assertNonEmpty(source.path, "source.path"),
    },
    trust: normalizeTrustSummary(record.trust),
    hosts: {
      openclaw: normalizeHostRecord(
        "openclaw",
        hosts.openclaw,
        {
          installRoot: resolveOpenClawPluginInstallRoot(id),
          skills,
          skillsPath,
        },
      ),
      codex: normalizeHostRecord(
        "codex",
        hosts.codex,
        {
          installRoot: resolveRepoSkillHostRoot("codex", repoRoot),
          skills,
          skillsPath,
        },
      ),
      "claude-code": normalizeHostRecord(
        "claude-code",
        hosts["claude-code"],
        {
          installRoot: resolveRepoSkillHostRoot("claude-code", repoRoot),
          skills,
          skillsPath,
        },
      ),
    },
  };
}

function normalizeTrustSummary(value: unknown): MarketPluginTrustSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      totalFiles: 0,
      scriptFileCount: 0,
      executableFileCount: 0,
      agentFileCount: 0,
      referenceFileCount: 0,
      assetFileCount: 0,
      scriptFiles: [],
      detectedRuntimes: [],
    };
  }

  const record = value as Record<string, unknown>;
  return {
    totalFiles: normalizeNonNegativeNumber(record.totalFiles),
    scriptFileCount: normalizeNonNegativeNumber(record.scriptFileCount),
    executableFileCount: normalizeNonNegativeNumber(record.executableFileCount),
    agentFileCount: normalizeNonNegativeNumber(record.agentFileCount),
    referenceFileCount: normalizeNonNegativeNumber(record.referenceFileCount),
    assetFileCount: normalizeNonNegativeNumber(record.assetFileCount),
    scriptFiles: normalizeStringArray(record.scriptFiles),
    detectedRuntimes: normalizeStringArray(record.detectedRuntimes),
  };
}

function normalizeHostRecord(
  host: "openclaw" | "codex" | "claude-code",
  value: unknown,
  input: {
    installRoot: string;
    skills: InstalledMarketPluginSkill[];
    skillsPath: string;
  },
): MarketPluginHostRecord {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};

  const installRoot = input.installRoot;

  const projectedSkills = normalizeProjectedSkills(
    record.projectedSkills,
    input.skills,
    installRoot,
    input.skillsPath,
    host,
  );

  return {
    status:
      record.status === "installed"
        ? "installed"
        : record.status === "partial"
          ? "partial"
          : "missing",
    installRoot,
    projectedSkills,
  };
}

function normalizeProjectedSkills(
  value: unknown,
  skills: InstalledMarketPluginSkill[],
  installRoot: string,
  skillsPath: string,
  host: "openclaw" | "codex" | "claude-code",
): MarketPluginHostProjection[] {
  if (!Array.isArray(value)) {
    return skills.map((skill) => {
      const installPath = host === "openclaw"
        ? path.join(installRoot, skillsPath, skill.slug)
        : path.join(installRoot, skill.slug);
      return {
        sourceSlug: skill.slug,
        hostSlug: skill.slug,
        installPath,
        mode: "direct",
      } satisfies MarketPluginHostProjection;
    });
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new MarketPluginValidationError("Projected host skills must contain objects.");
    }
    const record = entry as Record<string, unknown>;
    const sourceSlug = assertValidSkillSlug(assertNonEmpty(record.sourceSlug, "projectedSkills[].sourceSlug"));
    const hostSlug = assertValidHostSkillSlug(assertNonEmpty(record.hostSlug, "projectedSkills[].hostSlug"));
    return {
      sourceSlug,
      hostSlug,
      installPath: host === "openclaw"
        ? path.join(installRoot, skillsPath, sourceSlug)
        : path.join(installRoot, hostSlug),
      mode: record.mode === "aliased" ? "aliased" : "direct",
    } satisfies MarketPluginHostProjection;
  });
}

function normalizeInstalledSkills(value: unknown): InstalledMarketPluginSkill[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new MarketPluginValidationError("Installed skills must contain objects.");
      }
      const record = entry as Record<string, unknown>;
      return {
        slug: assertValidSkillSlug(assertNonEmpty(record.slug, "skills[].slug")),
        description: assertNonEmpty(record.description, "skills[].description"),
        runtime: normalizeNullableString(record.runtime),
        emoji: normalizeNullableString(record.emoji),
      };
    });
}

async function resolveGitHubPluginSource(input: InstallMarketPluginFromGitHubInput): Promise<{
  repo: string;
  ref: string;
  importPath: string;
  resolvedCommit: string;
  bundle: ResolvedMarketPluginBundle;
}> {
  const repo = validateRepositorySlug(assertNonEmpty(input.repo, "repo"));
  const ref = normalizeNullableString(input.ref) ?? DEFAULT_MARKET_PLUGIN_REF;
  const importPath = normalizeImportPath(input.path);
  const cacheDir = ensureRepoCache(repo, ref);
  refreshRepoCache(cacheDir, ref);

  return {
    repo,
    ref,
    importPath,
    resolvedCommit: runGit(["-C", cacheDir, "rev-parse", "HEAD"]).trim(),
    bundle: await resolveMarketPluginBundle(cacheDir, importPath),
  };
}

async function resolveInstalledBundle(
  plugin: InstalledMarketPluginRecord,
): Promise<ResolvedMarketPluginBundle> {
  if (existsSync(plugin.pluginManifestPath) && existsSync(plugin.bundlePath)) {
    const manifest = parseMarketPluginManifest(await readFile(plugin.pluginManifestPath, "utf-8"));
    const skillsRoot = await resolvePluginSkillsRoot(plugin.bundlePath, manifest.skillsPath);
    return {
      bundleRoot: plugin.bundlePath,
      pluginManifestPath: plugin.pluginManifestPath,
      manifest,
      skills: await readInstalledPluginSkills(skillsRoot),
      trust: await scanBundleTrustSummary(plugin.bundlePath),
    };
  }

  const source = await resolveGitHubPluginSource({
    repo: plugin.source.repo,
    ref: plugin.source.requestedRef,
    path: plugin.source.path,
  });
  return source.bundle;
}

async function resolveMarketPluginBundle(
  cacheDir: string,
  importPath: string,
): Promise<ResolvedMarketPluginBundle> {
  const normalizedPath = normalizeImportPath(importPath);
  const candidate = path.join(cacheDir, normalizedPath);
  const pluginManifestPath = normalizedPath.endsWith(".codex-plugin/plugin.json")
    ? candidate
    : path.join(candidate, ".codex-plugin", "plugin.json");
  const bundleRoot = normalizedPath.endsWith(".codex-plugin/plugin.json")
    ? path.dirname(path.dirname(candidate))
    : candidate;

  if (!existsSync(pluginManifestPath)) {
    throw new MarketPluginValidationError(
      `Could not find .codex-plugin/plugin.json at ${normalizedPath}.`,
    );
  }

  const [realRoot, realBundleRoot, realPluginManifestPath] = await Promise.all([
    realpath(cacheDir),
    realpath(bundleRoot),
    realpath(pluginManifestPath),
  ]);
  if (!isPathWithinRoot(realRoot, realBundleRoot) || !isPathWithinRoot(realRoot, realPluginManifestPath)) {
    throw new MarketPluginValidationError(
      `Import path "${normalizedPath}" resolves outside the repo cache.`,
    );
  }

  const manifest = parseMarketPluginManifest(await readFile(realPluginManifestPath, "utf-8"));
  const skillsRoot = await resolvePluginSkillsRoot(realBundleRoot, manifest.skillsPath);
  const skills = await readInstalledPluginSkills(skillsRoot);

  return {
    bundleRoot: realBundleRoot,
    pluginManifestPath: realPluginManifestPath,
    manifest,
    skills,
    trust: await scanBundleTrustSummary(realBundleRoot),
  };
}

async function resolvePluginSkillsRoot(bundleRoot: string, skillsPath: string): Promise<string> {
  const candidate = path.join(bundleRoot, skillsPath);
  if (!existsSync(candidate)) {
    throw new MarketPluginValidationError(`Could not find skills directory at ${skillsPath}.`);
  }
  const [realBundleRoot, realSkillsRoot] = await Promise.all([
    realpath(bundleRoot),
    realpath(candidate),
  ]);
  if (!isPathWithinRoot(realBundleRoot, realSkillsRoot)) {
    throw new MarketPluginValidationError(
      `Plugin skills path "${skillsPath}" resolves outside the bundle root.`,
    );
  }
  return realSkillsRoot;
}

async function readInstalledPluginSkills(skillsRoot: string): Promise<InstalledMarketPluginSkill[]> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const slug = assertValidSkillSlug(entry.name);
        const markdownPath = path.join(skillsRoot, slug, "SKILL.md");
        if (!existsSync(markdownPath)) {
          throw new MarketPluginValidationError(`Expected ${slug}/SKILL.md inside the plugin bundle.`);
        }
        const parsed = parseOpenClawSkillMarkdown(
          slug,
          await readFile(markdownPath, "utf-8"),
        );
        return {
          slug,
          description: parsed.description,
          runtime: parsed.runtime,
          emoji: parsed.emoji,
        } satisfies InstalledMarketPluginSkill;
      }),
  );

  if (skills.length === 0) {
    throw new MarketPluginValidationError("Plugin bundle does not contain any installable skills.");
  }
  return skills.sort((left, right) => left.slug.localeCompare(right.slug));
}

async function scanBundleTrustSummary(bundleRoot: string): Promise<MarketPluginTrustSummary> {
  const runtimes = new Set<string>();
  const scriptFiles: string[] = [];
  const summary: MarketPluginTrustSummary = {
    totalFiles: 0,
    scriptFileCount: 0,
    executableFileCount: 0,
    agentFileCount: 0,
    referenceFileCount: 0,
    assetFileCount: 0,
    scriptFiles,
    detectedRuntimes: [],
  };

  await walkBundle(bundleRoot, "", async (relativePath, entry) => {
    if (!entry.isFile()) return;
    summary.totalFiles += 1;

    const normalized = relativePath.replace(/\\/g, "/");
    const segments = normalized.split("/");
    const extension = path.extname(normalized).toLowerCase();
    const executable = EXECUTABLE_EXTENSIONS.has(extension);
    const insideScriptsDir = segments.includes("scripts");

    if (segments.includes("agents")) {
      summary.agentFileCount += 1;
    }
    if (segments.includes("references")) {
      summary.referenceFileCount += 1;
    }
    if (segments.includes("assets")) {
      summary.assetFileCount += 1;
    }
    if (executable) {
      summary.executableFileCount += 1;
    }
    if (insideScriptsDir || executable) {
      summary.scriptFileCount += 1;
      scriptFiles.push(normalized);
    }

    const runtime = runtimeForExtension(extension);
    if (runtime) {
      runtimes.add(runtime);
    }
  });

  summary.scriptFiles = [...new Set(scriptFiles)].sort();
  summary.detectedRuntimes = [...runtimes].sort();
  return summary;
}

async function walkBundle(
  root: string,
  relativePath: string,
  visitor: (
    relativePath: string,
    entry: { isFile: () => boolean; isDirectory: () => boolean },
  ) => Promise<void>,
): Promise<void> {
  const currentPath = relativePath ? path.join(root, relativePath) : root;
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relativePath ? path.join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await walkBundle(root, childRelative, visitor);
      continue;
    }
    await visitor(childRelative, entry);
  }
}

function runtimeForExtension(extension: string): string | null {
  switch (extension) {
    case ".py":
      return "python";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "shell";
    case ".js":
    case ".cjs":
    case ".mjs":
    case ".ts":
      return "node";
    default:
      return null;
  }
}

function buildInstalledRecordFromBundle(
  bundle: ResolvedMarketPluginBundle,
  source: InstalledMarketPluginRecord["source"],
  existing: InstalledMarketPluginRecord | null,
  repoRoot: string,
  input: {
    preserveInstalledAt: boolean;
    updatedAt: string | null;
  },
): InstalledMarketPluginRecord {
  const pluginId = bundle.manifest.id;
  const now = new Date().toISOString();

  return {
    id: pluginId,
    name: bundle.manifest.name,
    displayName: bundle.manifest.displayName,
    description: bundle.manifest.description,
    pluginVersion: bundle.manifest.pluginVersion,
    bundleFormat: "codex",
    license: bundle.manifest.license,
    skillsPath: bundle.manifest.skillsPath,
    skills: bundle.skills,
    bundlePath: resolvePluginSnapshotRoot(pluginId),
    pluginManifestPath: path.join(resolvePluginSnapshotRoot(pluginId), ".codex-plugin", "plugin.json"),
    installedAt: input.preserveInstalledAt && existing ? existing.installedAt : now,
    updatedAt: input.updatedAt,
    source,
    trust: bundle.trust,
    hosts: buildHostPlan(bundle, existing, repoRoot),
  };
}

function buildHostPlan(
  bundle: ResolvedMarketPluginBundle,
  existing: InstalledMarketPluginRecord | null,
  repoRoot: string,
): InstalledMarketPluginRecord["hosts"] {
  const pluginId = bundle.manifest.id;
  const openclawRoot = resolveOpenClawPluginInstallRoot(pluginId);
  const codexRoot = resolveRepoSkillHostRoot("codex", repoRoot);
  const claudeRoot = resolveRepoSkillHostRoot("claude-code", repoRoot);

  return {
    openclaw: {
      status: "missing",
      installRoot: openclawRoot,
      projectedSkills: bundle.skills.map((skill) => ({
        sourceSlug: skill.slug,
        hostSlug: skill.slug,
        installPath: path.join(openclawRoot, bundle.manifest.skillsPath, skill.slug),
        mode: "direct" as const,
      })),
    },
    codex: {
      status: "missing",
      installRoot: codexRoot,
      projectedSkills: planRepoHostProjectedSkills(
        pluginId,
        codexRoot,
        bundle.skills,
        existing?.hosts.codex.projectedSkills ?? [],
      ),
    },
    "claude-code": {
      status: "missing",
      installRoot: claudeRoot,
      projectedSkills: planRepoHostProjectedSkills(
        pluginId,
        claudeRoot,
        bundle.skills,
        existing?.hosts["claude-code"].projectedSkills ?? [],
      ),
    },
  };
}

function planRepoHostProjectedSkills(
  pluginId: string,
  installRoot: string,
  skills: InstalledMarketPluginSkill[],
  existingProjectedSkills: MarketPluginHostProjection[],
): MarketPluginHostProjection[] {
  const existingBySourceSlug = new Map(
    existingProjectedSkills.map((projection) => [projection.sourceSlug, projection]),
  );
  const nextSkillSlugs = new Set(skills.map((skill) => skill.slug));
  const stalePaths = new Set(
    existingProjectedSkills
      .filter((projection) => !nextSkillSlugs.has(projection.sourceSlug))
      .map((projection) => projection.installPath),
  );
  const reservedHostSlugs = new Set<string>();
  const projections: MarketPluginHostProjection[] = [];

  for (const skill of skills) {
    const existing = existingBySourceSlug.get(skill.slug);
    if (existing) {
      const hostSlug = assertValidHostSkillSlug(existing.hostSlug);
      projections.push({
        sourceSlug: skill.slug,
        hostSlug,
        installPath: path.join(installRoot, hostSlug),
        mode: hostSlug === skill.slug ? "direct" : "aliased",
      });
      reservedHostSlugs.add(hostSlug);
      continue;
    }

    const directSlug = skill.slug;
    const directPath = path.join(installRoot, directSlug);
    if (
      !reservedHostSlugs.has(directSlug) &&
      isHostProjectionPathAvailable(directPath, stalePaths)
    ) {
      projections.push({
        sourceSlug: skill.slug,
        hostSlug: directSlug,
        installPath: directPath,
        mode: "direct",
      });
      reservedHostSlugs.add(directSlug);
      continue;
    }

    const aliasBase = `${pluginId}--${skill.slug}`;
    let aliasSlug = aliasBase;
    let counter = 2;
    while (
      reservedHostSlugs.has(aliasSlug) ||
      !isHostProjectionPathAvailable(path.join(installRoot, aliasSlug), stalePaths)
    ) {
      aliasSlug = `${aliasBase}-${counter++}`;
    }

    projections.push({
      sourceSlug: skill.slug,
      hostSlug: aliasSlug,
      installPath: path.join(installRoot, aliasSlug),
      mode: "aliased",
    });
    reservedHostSlugs.add(aliasSlug);
  }

  return projections;
}

function isHostProjectionPathAvailable(targetPath: string, stalePaths: Set<string>): boolean {
  return !existsSync(targetPath) || stalePaths.has(targetPath);
}

async function activateInstalledMarketPlugin(
  record: InstalledMarketPluginRecord,
  bundle: ResolvedMarketPluginBundle,
  repoRoot: string,
  previous: InstalledMarketPluginRecord | null,
): Promise<InstalledMarketPluginRecord> {
  const openClawArgs = [
    "plugins",
    "install",
    "--force",
    bundle.bundleRoot,
  ];
  const installResult = await runOpenClaw(openClawArgs, { timeoutMs: 120_000 });
  if (!installResult.ok) {
    throw new MarketPluginValidationError(
      formatOpenClawFailure(
        installResult.stderr,
        installResult.stdout,
        "OpenClaw could not install the plugin bundle.",
      ),
    );
  }

  if (!existsSync(record.hosts.openclaw.installRoot)) {
    throw new MarketPluginValidationError(
      `OpenClaw reported success but no installed bundle was found at ${record.hosts.openclaw.installRoot}.`,
    );
  }

  await materializeRepoHostProjection(
    "codex",
    record,
    bundle,
    previous?.hosts.codex ?? null,
    repoRoot,
  );
  await materializeRepoHostProjection(
    "claude-code",
    record,
    bundle,
    previous?.hosts["claude-code"] ?? null,
    repoRoot,
  );

  return applyHostStatuses(record, repoRoot);
}

async function materializeRepoHostProjection(
  host: "codex" | "claude-code",
  record: InstalledMarketPluginRecord,
  bundle: ResolvedMarketPluginBundle,
  previous: MarketPluginHostRecord | null,
  repoRoot: string,
): Promise<void> {
  const nextHost = record.hosts[host];
  const skillsRoot = path.join(bundle.bundleRoot, bundle.manifest.skillsPath);
  await mkdir(nextHost.installRoot, { recursive: true });

  for (const projection of nextHost.projectedSkills) {
    const sourceRoot = path.join(skillsRoot, projection.sourceSlug);
    if (!existsSync(sourceRoot)) {
      throw new MarketPluginValidationError(
        `Expected ${projection.sourceSlug} inside ${bundle.manifest.skillsPath}.`,
      );
    }

    await rm(projection.installPath, { recursive: true, force: true });
    await copyDirectory(sourceRoot, projection.installPath);
  }

  const stalePaths = new Set(
    (previous?.projectedSkills ?? [])
      .map((projection) => projection.installPath)
      .filter((installPath) => !nextHost.projectedSkills.some((entry) => entry.installPath === installPath)),
  );

  for (const stalePath of stalePaths) {
    await rm(stalePath, { recursive: true, force: true });
  }

  await ensureRepoHostIgnoreFile(host, repoRoot);
}

function applyHostStatuses(
  plugin: InstalledMarketPluginRecord,
  repoRoot: string,
): InstalledMarketPluginRecord {
  const openclawRoot = resolveOpenClawPluginInstallRoot(plugin.id);
  const codexRoot = resolveRepoSkillHostRoot("codex", repoRoot);
  const claudeRoot = resolveRepoSkillHostRoot("claude-code", repoRoot);

  return {
    ...plugin,
    bundlePath: resolvePluginSnapshotRoot(plugin.id),
    pluginManifestPath: path.join(resolvePluginSnapshotRoot(plugin.id), ".codex-plugin", "plugin.json"),
    hosts: {
      openclaw: {
        ...plugin.hosts.openclaw,
        installRoot: openclawRoot,
        projectedSkills: plugin.hosts.openclaw.projectedSkills.map((projection) => ({
          ...projection,
          installPath: path.join(openclawRoot, plugin.skillsPath, projection.sourceSlug),
          hostSlug: projection.sourceSlug,
          mode: "direct",
        })),
        status: existsSync(openclawRoot) ? "installed" : "missing",
      },
      codex: applyRepoHostStatus(plugin.hosts.codex, codexRoot),
      "claude-code": applyRepoHostStatus(plugin.hosts["claude-code"], claudeRoot),
    },
  };
}

function applyRepoHostStatus(
  host: MarketPluginHostRecord,
  installRoot: string,
): MarketPluginHostRecord {
  const projectedSkills = host.projectedSkills.map((projection) => ({
    ...projection,
    installPath: path.join(installRoot, projection.hostSlug),
  }));
  const installedCount = projectedSkills.filter((projection) => existsSync(projection.installPath)).length;
  const status: MarketPluginHostStatus =
    installedCount === 0
      ? "missing"
      : installedCount === projectedSkills.length
        ? "installed"
        : "partial";

  return {
    ...host,
    installRoot,
    projectedSkills,
    status,
  };
}

async function removeRepoHostProjection(host: MarketPluginHostRecord): Promise<void> {
  for (const projection of host.projectedSkills) {
    await rm(projection.installPath, { recursive: true, force: true });
  }
}

async function ensureRepoHostIgnoreFile(
  host: "codex" | "claude-code",
  repoRoot: string,
): Promise<void> {
  const hostRoot = path.join(repoRoot, host === "codex" ? ".codex" : ".claude");
  const ignorePath = path.join(hostRoot, ".gitignore");
  const line = "skills/\n";

  await mkdir(hostRoot, { recursive: true });
  if (!existsSync(ignorePath)) {
    await writeFile(ignorePath, line, "utf-8");
    return;
  }

  const current = await readFile(ignorePath, "utf-8");
  if (current.includes("skills/")) {
    return;
  }
  const normalized = current.endsWith("\n") ? current : `${current}\n`;
  await writeFile(ignorePath, `${normalized}${line}`, "utf-8");
}

async function writeInstalledMarketPluginRecord(plugin: InstalledMarketPluginRecord): Promise<void> {
  await mkdir(resolvePluginMetadataRoot(plugin.id), { recursive: true });
  await writeFile(
    path.join(resolvePluginMetadataRoot(plugin.id), INSTALL_MANIFEST),
    JSON.stringify(plugin, null, 2) + "\n",
    "utf-8",
  );
}

function parseMarketPluginManifest(rawJson: string): ParsedMarketPluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new MarketPluginValidationError(`Invalid plugin.json: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MarketPluginValidationError("plugin.json must contain an object.");
  }
  const record = parsed as Record<string, unknown>;
  const pluginInterface =
    record.interface && typeof record.interface === "object" && !Array.isArray(record.interface)
      ? record.interface as Record<string, unknown>
      : {};

  return {
    id: normalizePluginId(assertNonEmpty(record.name, "name")),
    name: assertNonEmpty(record.name, "name"),
    displayName: normalizeNullableString(pluginInterface.displayName) ?? assertNonEmpty(record.name, "name"),
    description: assertNonEmpty(record.description, "description"),
    pluginVersion: normalizeNullableString(record.version),
    license: normalizeNullableString(record.license),
    skillsPath: normalizePluginSkillsPath(record.skills),
  };
}

function normalizePluginSkillsPath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MarketPluginValidationError("plugin.json must include a non-empty string skills path.");
  }
  const normalized = value.trim().replace(/^\.\/+/, "");
  if (!normalized) {
    throw new MarketPluginValidationError("plugin.json skills path cannot be empty.");
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new MarketPluginValidationError("plugin.json skills path cannot contain '..'.");
  }
  return normalized.replace(/\/+$/, "");
}

function resolvePluginMetadataRoot(id: string): string {
  return path.join(getScienceSwarmMarketPluginsRoot(), normalizePluginId(id));
}

function resolvePluginSnapshotRoot(id: string): string {
  return path.join(resolvePluginMetadataRoot(id), SNAPSHOT_DIR);
}

function resolvePluginTempSnapshotRoot(id: string): string {
  return path.join(resolvePluginMetadataRoot(id), `${SNAPSHOT_DIR}.next`);
}

function resolveOpenClawPluginInstallRoot(id: string): string {
  return path.join(getScienceSwarmOpenClawStateDir(), "extensions", normalizePluginId(id));
}

function resolveRepoSkillHostRoot(
  host: "codex" | "claude-code",
  repoRoot: string,
): string {
  return path.join(repoRoot, host === "codex" ? ".codex" : ".claude", "skills");
}

function getGitHubRepoCacheRoot(): string {
  return path.join(getScienceSwarmCacheRoot(), "skills", "repos");
}

function ensureRepoCache(repo: string, ref: string): string {
  const repoSlug = repo.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const refSlug = ref.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const cacheDir = path.join(getGitHubRepoCacheRoot(), `${repoSlug}__${refSlug}`);
  if (!existsSync(cacheDir)) {
    runGit(
      [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        `https://github.com/${repo}.git`,
        cacheDir,
      ],
      undefined,
      "Failed to clone the upstream GitHub repository.",
    );
  }
  return cacheDir;
}

function refreshRepoCache(cacheDir: string, ref: string): void {
  runGit(
    ["-C", cacheDir, "fetch", "--depth", "1", "origin", ref],
    undefined,
    `Failed to fetch ref "${ref}" from the upstream GitHub repository.`,
  );
  runGit(
    ["-C", cacheDir, "checkout", "--force", "FETCH_HEAD"],
    undefined,
    `Failed to check out ref "${ref}" from the upstream GitHub repository.`,
  );
}

function runGit(args: string[], cwd?: string, message?: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error
      ? String((error as { stderr?: string | Buffer }).stderr ?? "")
      : "";
    throw new MarketPluginValidationError(
      [message ?? "GitHub source resolution failed.", stderr.trim()].filter(Boolean).join(" "),
    );
  }
}

function validateRepositorySlug(repo: string): string {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    throw new MarketPluginValidationError(`Invalid repo format "${repo}". Expected "owner/name".`);
  }
  return repo;
}

function normalizeImportPath(importPath: string): string {
  const normalized = importPath.trim().replace(/^\/+/, "");
  if (!normalized) {
    throw new MarketPluginValidationError("Import path cannot be empty.");
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new MarketPluginValidationError("Import path cannot contain '..'.");
  }
  return normalized;
}

function normalizePluginId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new MarketPluginValidationError(`Invalid plugin id "${id}".`);
  }
  return normalized;
}

function assertValidSkillSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new MarketPluginValidationError(`Invalid skill slug "${slug}" in plugin bundle.`);
  }
  return normalized;
}

function assertValidHostSkillSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new MarketPluginValidationError(`Invalid projected host skill slug "${slug}".`);
  }
  return normalized;
}

function assertNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MarketPluginValidationError(`Expected a non-empty ${field}.`);
  }
  return value.trim();
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function normalizeNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketPluginValidationError(`Expected ${field} to contain an object.`);
  }
  return value as Record<string, unknown>;
}

function formatOpenClawFailure(stderr: string, stdout: string, fallback: string): string {
  return [stderr.trim(), stdout.trim(), fallback].filter(Boolean)[0] ?? fallback;
}

function isPathWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function copyDirectory(source: string, target: string): Promise<void> {
  const realSource = await realpath(source);
  if (existsSync(target)) {
    await rm(target, { recursive: true, force: true });
  }

  const entries = await readdir(realSource, { withFileTypes: true });
  await mkdir(target, { recursive: true });

  for (const entry of entries) {
    const sourcePath = path.join(realSource, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new MarketPluginValidationError(
        `Unsupported symlink "${path.relative(realSource, sourcePath)}" in plugin bundle.`,
      );
    }
    await copyFile(sourcePath, targetPath);
    const metadata = await stat(sourcePath);
    await chmod(targetPath, metadata.mode);
  }
}

async function readInstalledMarketPluginIfPresent(
  id: string,
  repoRoot: string,
): Promise<InstalledMarketPluginRecord | null> {
  try {
    return await readInstalledMarketPlugin(id, repoRoot);
  } catch (error) {
    if (error instanceof MarketPluginNotFoundError) {
      return null;
    }
    throw error;
  }
}
