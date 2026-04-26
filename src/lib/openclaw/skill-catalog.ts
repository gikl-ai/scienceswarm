import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

const SKILL_DIR_NAME = ".openclaw/skills";
const SKILL_FILENAME = "SKILL.md";

type SkillFrontmatter = Record<string, unknown>;

export interface OpenClawSkillRecord {
  slug: string;
  name: string;
  description: string;
  rawMarkdown: string;
  content: string;
  frontmatter: SkillFrontmatter;
  runtime: string | null;
  owner: string | null;
  tier: string | null;
  network: string | null;
  tools: string[];
  secrets: string[];
  outputs: string[];
  routes: string[];
  healthChecks: string[];
  networkDomains: string[];
  entityTypes: string[];
  emoji: string | null;
}

export class OpenClawSkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenClawSkillValidationError";
  }
}

export class OpenClawSkillNotFoundError extends Error {
  constructor(slug: string) {
    super(`Unknown OpenClaw skill "${slug}".`);
    this.name = "OpenClawSkillNotFoundError";
  }
}

export async function listOpenClawSkills(repoRoot = process.cwd()): Promise<OpenClawSkillRecord[]> {
  const skillsRoot = resolveSkillsRoot(repoRoot);
  let entries: Dirent[];
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const skills = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await readOpenClawSkill(entry.name, repoRoot);
          } catch (error) {
            if (
              error instanceof OpenClawSkillValidationError ||
              error instanceof OpenClawSkillNotFoundError
            ) {
              console.warn(
                `[openclaw] skipping invalid skill ${entry.name}: ${error.message}`,
              );
              return null;
            }
            throw error;
          }
        }),
    )
  ).filter((skill): skill is OpenClawSkillRecord => skill !== null);

  return skills.sort(compareOpenClawSkills);
}

export async function readOpenClawSkill(
  slug: string,
  repoRoot = process.cwd(),
): Promise<OpenClawSkillRecord> {
  const normalizedSlug = assertValidSkillSlug(slug);
  const filePath = await resolveExistingSkillFilePath(normalizedSlug, repoRoot);

  let rawMarkdown: string;
  try {
    rawMarkdown = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new OpenClawSkillNotFoundError(normalizedSlug);
    }
    throw error;
  }

  return parseOpenClawSkillMarkdown(normalizedSlug, rawMarkdown);
}

export async function saveOpenClawSkill(
  slug: string,
  markdown: string,
  repoRoot = process.cwd(),
): Promise<OpenClawSkillRecord> {
  const normalizedSlug = assertValidSkillSlug(slug);
  const filePath = await resolveExistingSkillFilePath(normalizedSlug, repoRoot);
  const parsed = parseOpenClawSkillMarkdown(normalizedSlug, markdown);

  try {
    await writeFile(filePath, normalizeMarkdown(markdown), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new OpenClawSkillNotFoundError(normalizedSlug);
    }
    throw error;
  }
  return parsed;
}

export function parseOpenClawSkillMarkdown(
  slug: string,
  rawMarkdown: string,
): OpenClawSkillRecord {
  if (!rawMarkdown.trimStart().startsWith("---")) {
    throw new OpenClawSkillValidationError("SKILL.md must start with YAML frontmatter.");
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(rawMarkdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid YAML frontmatter";
    throw new OpenClawSkillValidationError(`Invalid YAML frontmatter: ${message}`);
  }

  const frontmatter = parsed.data as SkillFrontmatter;
  const name = readRequiredString(frontmatter, "name");
  if (name !== slug) {
    throw new OpenClawSkillValidationError(
      `Frontmatter name must match the skill folder slug "${slug}".`,
    );
  }

  const description = readRequiredString(frontmatter, "description");

  return {
    slug,
    name,
    description,
    rawMarkdown: normalizeMarkdown(rawMarkdown),
    content: parsed.content,
    frontmatter,
    runtime: readOptionalString(frontmatter, "runtime"),
    owner: readOptionalString(frontmatter, "owner"),
    tier: readOptionalString(frontmatter, "tier"),
    network: readOptionalString(frontmatter, "network"),
    tools: readOptionalStringArray(frontmatter, "tools"),
    secrets: readOptionalStringArray(frontmatter, "secrets"),
    outputs: readOptionalStringArray(frontmatter, "outputs"),
    routes: readOptionalStringArray(frontmatter, "routes"),
    healthChecks: readOptionalStringArray(frontmatter, "health_checks"),
    networkDomains: readOptionalStringArray(frontmatter, "network_domains"),
    entityTypes: readOptionalStringArray(frontmatter, "entity_types"),
    emoji: readMetadataEmoji(frontmatter),
  };
}

function resolveSkillsRoot(repoRoot: string): string {
  return path.join(repoRoot, SKILL_DIR_NAME);
}

function resolveSkillFilePath(slug: string, repoRoot: string): string {
  return path.join(resolveSkillsRoot(repoRoot), slug, SKILL_FILENAME);
}

async function resolveExistingSkillFilePath(slug: string, repoRoot: string): Promise<string> {
  const declaredSkillsRoot = resolveSkillsRoot(repoRoot);
  const declaredFilePath = resolveSkillFilePath(slug, repoRoot);

  let realSkillsRoot: string;
  let realFilePath: string;
  try {
    [realSkillsRoot, realFilePath] = await Promise.all([
      realpath(declaredSkillsRoot),
      realpath(declaredFilePath),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new OpenClawSkillNotFoundError(slug);
    }
    throw error;
  }

  if (!isPathWithinRoot(realSkillsRoot, realFilePath)) {
    throw new OpenClawSkillValidationError(
      `OpenClaw skill "${slug}" resolves outside ${SKILL_DIR_NAME}.`,
    );
  }

  return realFilePath;
}

function assertValidSkillSlug(slug: string): string {
  const normalized = slug.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new OpenClawSkillValidationError("Invalid skill slug.");
  }
  return normalized;
}

function normalizeMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function readRequiredString(frontmatter: SkillFrontmatter, key: string): string {
  const value = readOptionalString(frontmatter, key);
  if (!value) {
    throw new OpenClawSkillValidationError(`Frontmatter must include a non-empty ${key}.`);
  }
  return value;
}

function readOptionalString(frontmatter: SkillFrontmatter, key: string): string | null {
  const value = frontmatter[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalStringArray(frontmatter: SkillFrontmatter, key: string): string[] {
  const value = frontmatter[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function readMetadataEmoji(frontmatter: SkillFrontmatter): string | null {
  const metadata = frontmatter.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const openclaw = (metadata as Record<string, unknown>).openclaw;
  if (!openclaw || typeof openclaw !== "object") return null;
  const emoji = (openclaw as Record<string, unknown>).emoji;
  return typeof emoji === "string" && emoji.trim().length > 0 ? emoji.trim() : null;
}

function compareOpenClawSkills(left: OpenClawSkillRecord, right: OpenClawSkillRecord): number {
  const leftRank = left.tier === "database" ? 1 : 0;
  const rightRank = right.tier === "database" ? 1 : 0;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.name.localeCompare(right.name);
}
