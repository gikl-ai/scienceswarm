import * as fs from "fs/promises";
import * as path from "path";
import matter from "gray-matter";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";

// ---------------------------------------------------------------------------
// Markdown file store — read/write .md files with YAML frontmatter
// ---------------------------------------------------------------------------

export interface MdDocument {
  frontmatter: Record<string, unknown>;
  content: string;
}

/**
 * Read a markdown file from a project's directory.
 * Returns parsed frontmatter + body content.
 */
export async function readMdStore(
  projectSlug: string,
  filename: string,
): Promise<MdDocument> {
  const filePath = path.join(getScienceSwarmProjectsRoot(), projectSlug, filename);
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = matter(raw);
  return {
    frontmatter: parsed.data as Record<string, unknown>,
    content: parsed.content,
  };
}

/**
 * Write a markdown file to a project's directory.
 * Serializes frontmatter as YAML + body content.
 */
export async function writeMdStore(
  projectSlug: string,
  filename: string,
  frontmatter: Record<string, unknown>,
  content: string,
): Promise<void> {
  const dir = path.join(getScienceSwarmProjectsRoot(), projectSlug);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  const output = matter.stringify(content, frontmatter);
  await fs.writeFile(filePath, output, "utf-8");
}
