/**
 * GbrainEngineAdapter — wraps gbrain's BrainEngine behind ScienceSwarm's
 * BrainStore interface.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import matter from "gray-matter";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { BrainBackendUnavailableError } from "../store";
import type {
  BrainStore,
  BrainPage,
  BrainLink,
  BrainTimelineEntry,
  ImportResult,
  BrainStoreHealth,
} from "../store";
import type { SearchInput, SearchResult, ContentType, SearchDetail } from "../types";
import { chunkText } from "./gbrain-chunker";
import { createRuntimeEngine } from "./gbrain-runtime.mjs";

interface EngineConfig {
  engine?: "postgres" | "pglite";
  database_path?: string;
  database_url?: string;
}

interface GbrainRuntimeSearchResult {
  slug: string;
  title: string;
  type: string;
  chunk_text: string;
  chunk_id?: number;
  chunk_index?: number;
  score: number;
  source_id?: string;
}

interface GbrainRuntimePage {
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash?: string | null;
}

interface GbrainRuntimeTimelineEntry {
  date: string | Date;
  source?: string | null;
  summary: string;
  detail?: string | null;
}

interface GbrainRuntimeLink {
  from_slug: string;
  to_slug: string;
  link_type?: string | null;
  context?: string | null;
}

interface GbrainChunkInput {
  chunk_index: number;
  chunk_text: string;
  chunk_source: "compiled_truth" | "timeline";
}

interface GbrainStats {
  page_count?: number;
  chunk_count?: number;
  embedded_count?: number;
  link_count?: number;
  tag_count?: number;
  timeline_entry_count?: number;
}

interface GbrainHealth {
  page_count?: number;
  embed_coverage?: number;
  stale_pages?: number;
  orphan_pages?: number;
  dead_links?: number;
  missing_embeddings?: number;
  brain_score?: number;
}

export interface GbrainRuntimeEngine {
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: GbrainRuntimeEngine) => Promise<T>): Promise<T>;
  getPage(slug: string): Promise<GbrainRuntimePage | null>;
  putPage(
    slug: string,
    page: {
      type: string;
      title: string;
      compiled_truth: string;
      timeline?: string;
      frontmatter?: Record<string, unknown>;
      content_hash?: string;
    },
  ): Promise<GbrainRuntimePage>;
  searchKeyword(
    query: string,
    opts?: { limit?: number; detail?: SearchDetail },
  ): Promise<GbrainRuntimeSearchResult[]>;
  upsertChunks(slug: string, chunks: GbrainChunkInput[]): Promise<void>;
  addTimelineEntry(
    slug: string,
    entry: { date: string; source?: string; summary: string; detail?: string },
  ): Promise<void>;
  getTimeline(
    slug: string,
    opts?: { limit?: number },
  ): Promise<GbrainRuntimeTimelineEntry[]>;
  addLink(
    from: string,
    to: string,
    context?: string | null,
    linkType?: string,
  ): Promise<void>;
  getLinks(slug: string): Promise<GbrainRuntimeLink[]>;
  getBacklinks(slug: string): Promise<GbrainRuntimeLink[]>;
  getTags(slug: string): Promise<string[]>;
  addTag(slug: string, tag: string): Promise<void>;
  removeTag(slug: string, tag: string): Promise<void>;
  getStats(): Promise<GbrainStats>;
  getHealth(): Promise<GbrainHealth>;
  getConfig(key: string): Promise<string | null>;
  listPages(filters?: {
    type?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Promise<GbrainRuntimePage[]>;
}

interface ParsedMarkdown {
  compiledTruth: string;
  timeline: string;
  title: string;
  type: ContentType;
  tags: string[];
  frontmatter: Record<string, unknown>;
}

function toSearchResult(result: GbrainRuntimeSearchResult): SearchResult {
  return {
    path: toBrainPath(result.slug),
    title: result.title,
    snippet: result.chunk_text,
    relevance: Math.min(1, Math.max(0, result.score)),
    type: inferContentType(result.type, result.slug),
    chunkId: result.chunk_id,
    chunkIndex: result.chunk_index,
    sourceId: result.source_id,
  };
}

function toBrainPage(page: GbrainRuntimePage): BrainPage {
  // gbrain's parseMarkdown strips `type` and `title` from the YAML
  // frontmatter before inserting (they live in dedicated columns), and
  // its `serializeMarkdown` splices them back in on CLI reads. Code
  // calling BrainStore.getPage (e.g. audit-revise-tools) still reads
  // `frontmatter.type` to distinguish `paper` / `critique` /
  // `revision_plan` / `revision` — types that aren't in our
  // ContentType union and can't round-trip through `inferContentType`.
  // Splice the column values back into the returned frontmatter so the
  // reader contract matches the markdown the author wrote. We also
  // avoid overwriting an already-present value in case a test fixture
  // set it explicitly.
  const storedFrontmatter = page.frontmatter ?? {};
  return {
    path: toBrainPath(page.slug),
    title: page.title,
    type: inferContentType(page.type, page.slug),
    content: page.compiled_truth,
    frontmatter: {
      type: page.type,
      title: page.title,
      ...storedFrontmatter,
    },
  };
}

export class GbrainEngineAdapter implements BrainStore {
  private _engine: GbrainRuntimeEngine | null = null;
  private _initPromise: Promise<void> | null = null;

  get engine(): GbrainRuntimeEngine {
    if (!this._engine) {
      throw new BrainBackendUnavailableError(
        "GbrainEngineAdapter not initialized. Call initialize() first.",
      );
    }
    return this._engine;
  }

  async initialize(config?: Partial<EngineConfig>): Promise<void> {
    if (this._initPromise) {
      return this._initPromise;
    }

    const engineType = config?.engine || "pglite";
    const engineConfig: EngineConfig = {
      engine: engineType,
      database_path: config?.database_path,
      database_url: config?.database_url,
    };

    this._initPromise = (async () => {
      const engine = (await createRuntimeEngine(engineConfig)) as GbrainRuntimeEngine;
      this._engine = engine;
      try {
        await engine.connect(engineConfig);
        await engine.initSchema();
      } catch (error) {
        await engine.disconnect().catch(() => {});
        throw error;
      }
    })().catch((error) => {
      this._engine = null;
      this._initPromise = null;
      throw error;
    });

    await this._initPromise;
  }

  async search(input: SearchInput): Promise<SearchResult[]> {
    await this.ready();
    const limit = input.limit ?? 20;
    const results = await this.engine.searchKeyword(input.query, {
      limit,
      detail: input.detail,
    });
    return this.enrichCompiledSearchResults(results.map(toSearchResult));
  }

  async getPage(path: string): Promise<BrainPage | null> {
    await this.ready();
    const page = await this.engine.getPage(toStoreSlug(path));
    if (!page) return null;
    return toBrainPage(page);
  }

  async getTimeline(path: string, opts?: { limit?: number }): Promise<BrainTimelineEntry[]> {
    await this.ready();
    const entries = await this.engine.getTimeline(toStoreSlug(path), opts);
    return entries.map((entry) => ({
      date: normalizeTimelineDate(entry.date),
      source: entry.source ?? null,
      summary: entry.summary,
      detail: entry.detail ?? null,
    }));
  }

  async getLinks(path: string): Promise<BrainLink[]> {
    await this.ready();
    const sourceSlug = toStoreSlug(path);
    const links = await this.engine.getLinks(sourceSlug);
    return this.toBrainLinks(links, "outgoing");
  }

  async getBacklinks(path: string): Promise<BrainLink[]> {
    await this.ready();
    const targetSlug = toStoreSlug(path);
    const links = await this.engine.getBacklinks(targetSlug);
    return this.toBrainLinks(links, "incoming");
  }

  async listPages(filters?: { limit?: number; type?: ContentType }): Promise<BrainPage[]> {
    await this.ready();
    const pages = await this.engine.listPages({
      limit: filters?.limit ?? 200,
      type: filters?.type,
    });
    return pages.map(toBrainPage);
  }

  async importCorpus(dirPath: string): Promise<ImportResult> {
    await this.ready();
    const start = Date.now();

    // Attribution contract (decision 3A): every write site must thread
    // `getCurrentUserHandle()`. `importCorpus` is a user-triggered bulk
    // disk import, so we fail-loud rather than fail-soft — if the user
    // handle is unset there is no safe default to attribute the pages
    // to. `getCurrentUserHandle()` throws with the same error taxonomy
    // as the hot paths in task-extractor and materialize-memory.
    const userHandle = getCurrentUserHandle();

    if (!existsSync(dirPath)) {
      return {
        imported: 0,
        skipped: 0,
        errors: [{ path: dirPath, error: "Directory does not exist" }],
        durationMs: Date.now() - start,
      };
    }

    const contentDir = existsSync(join(dirPath, "wiki"))
      ? join(dirPath, "wiki")
      : dirPath;
    const files = collectMarkdownFiles(contentDir);
    const realContentDir = realpathSync(contentDir);
    const slugBaseDir = realpathSync(resolve(dirPath));

    let imported = 0;
    let skipped = 0;
    const errors: Array<{ path: string; error: string }> = [];

    for (const filePath of files) {
      try {
        const realFile = resolveImportFileWithinRoot(realContentDir, filePath);
        if (!realFile) {
          errors.push({
            path: filePath,
            error: "File not found, unresolvable, or outside import directory",
          });
          continue;
        }

        const raw = readFileSync(realFile, "utf-8");
        const relativePath = relative(slugBaseDir, realFile).replace(/\\/g, "/");
        const slug = toStoreSlug(relativePath);
        const parsed = parseMarkdown(raw, relativePath);
        // Stamp `captured_by` before hashing so re-imports by a
        // different user produce a distinct content_hash and don't get
        // short-circuited by the "same hash, skip" branch below.
        //
        // Importer-wins policy: if the source .md file carries its own
        // `captured_by` in frontmatter, we overwrite it with the handle
        // of the user running the import. This is deliberate under
        // decision 3A — the ScienceSwarm user who runs `importCorpus` is
        // responsible for the resulting brain contents, and every
        // authored field in the gbrain schema tracks "who wrote this
        // row", not "who originally authored this artifact". If you
        // need to preserve upstream authorship, add it as a separate
        // frontmatter key (e.g. `original_author`) in the source file.
        const attributedParsed: ParsedMarkdown = {
          ...parsed,
          frontmatter: {
            ...parsed.frontmatter,
            captured_by: userHandle,
          },
        };
        const contentHash = createContentHash(attributedParsed);

        const existing = await this.engine.getPage(slug);
        if (existing?.content_hash === contentHash) {
          skipped += 1;
          continue;
        }

        const chunks = buildChunks(attributedParsed);

        await this.engine.transaction(async (tx) => {
          await tx.putPage(slug, {
            type: attributedParsed.type,
            title: attributedParsed.title,
            compiled_truth: attributedParsed.compiledTruth,
            timeline: attributedParsed.timeline,
            frontmatter: attributedParsed.frontmatter,
            content_hash: contentHash,
          });

          const existingTags = await tx.getTags(slug);
          const desiredTags = new Set(parsed.tags);
          for (const tag of existingTags) {
            if (!desiredTags.has(tag)) {
              await tx.removeTag(slug, tag);
            }
          }
          for (const tag of parsed.tags) {
            await tx.addTag(slug, tag);
          }

          await tx.upsertChunks(slug, chunks);
        });

        imported += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ path: filePath, error: message });
      }
    }

    return {
      imported,
      skipped,
      errors,
      durationMs: Date.now() - start,
    };
  }

  async health(): Promise<BrainStoreHealth> {
    try {
      await this.ready();
      const [stats, health] = await Promise.all([
        this.engine.getStats(),
        this.engine.getHealth(),
      ]);
      const syncRepoPath = await this.engine
        .getConfig("sync.repo_path")
        .catch(() => null);
      return {
        ok: true,
        pageCount: health.page_count ?? stats.page_count ?? 0,
        brainScore: health.brain_score,
        embedCoverage: health.embed_coverage,
        stalePages: health.stale_pages,
        orphanPages: health.orphan_pages,
        deadLinks: health.dead_links,
        missingEmbeddings: health.missing_embeddings,
        chunkCount: stats.chunk_count,
        embeddedCount: stats.embedded_count,
        linkCount: stats.link_count,
        tagCount: stats.tag_count,
        timelineEntryCount: stats.timeline_entry_count,
        syncRepoPath,
      };
    } catch {
      return { ok: false, pageCount: 0 };
    }
  }

  async dispose(): Promise<void> {
    if (this._initPromise) {
      try {
        await this._initPromise;
      } catch {
        // Ignore init failures while tearing down.
      }
    }

    if (this._engine) {
      await this._engine.disconnect();
      this._engine = null;
    }
    this._initPromise = null;
  }

  private async ready(): Promise<void> {
    if (this._engine) return;
    if (this._initPromise) {
      await this._initPromise;
      return;
    }

    throw new BrainBackendUnavailableError(
      "GbrainEngineAdapter not initialized. Call initialize() first.",
    );
  }

  private async toBrainLinks(
    links: GbrainRuntimeLink[],
    direction: "incoming" | "outgoing",
  ): Promise<BrainLink[]> {
    if (links.length === 0) return [];
    const pages = await this.engine
      .listPages({ limit: Math.max(5000, links.length * 2) })
      .catch(() => []);
    const titleBySlug = new Map(pages.map((page) => [page.slug, page.title]));
    return links.map((link) => {
      const counterpartSlug =
        direction === "incoming" ? link.from_slug : link.to_slug;
      return {
        slug: toBrainPath(counterpartSlug),
        kind: link.link_type ?? "references",
        title: titleBySlug.get(counterpartSlug) ?? counterpartSlug,
        context: link.context ?? null,
        fromSlug: toBrainPath(link.from_slug),
        toSlug: toBrainPath(link.to_slug),
      };
    });
  }

  private async enrichCompiledSearchResults(
    results: SearchResult[],
  ): Promise<SearchResult[]> {
    const enriched: SearchResult[] = [];
    for (const result of results) {
      if (result.type !== "concept") {
        enriched.push(result);
        continue;
      }

      const slug = toStoreSlug(result.path);
      const page = await this.engine.getPage(slug).catch(() => null);
      if (!page) {
        enriched.push(result);
        continue;
      }

      const [links, backlinks, timeline] = await Promise.all([
        this.engine.getLinks(slug).catch(() => []),
        this.engine.getBacklinks(slug).catch(() => []),
        this.engine.getTimeline(slug, { limit: 50 }).catch(() => []),
      ]);
      const sourceSlugs = dedupeStrings([
        ...links.map((link) => link.to_slug),
        ...backlinks.map((link) => link.from_slug),
      ].filter((sourceSlug) => sourceSlug !== slug));
      const sourceCounts = {
        papers: 0,
        notes: 0,
        experiments: 0,
        datasets: 0,
        other: 0,
      };

      const sourcePages = await Promise.all(
        sourceSlugs.slice(0, 100).map(async (sourceSlug) => ({
          sourceSlug,
          sourcePage: await this.engine.getPage(sourceSlug).catch(() => null),
        })),
      );

      for (const { sourceSlug, sourcePage } of sourcePages) {
        const sourceType = inferContentType(sourcePage?.type ?? "", sourceSlug);
        if (sourceType === "paper") sourceCounts.papers += 1;
        else if (sourceType === "note" || sourceType === "web" || sourceType === "voice") {
          sourceCounts.notes += 1;
        } else if (sourceType === "experiment" || sourceType === "observation") {
          sourceCounts.experiments += 1;
        } else if (sourceType === "dataset" || sourceType === "data") {
          sourceCounts.datasets += 1;
        } else {
          sourceCounts.other += 1;
        }
      }

      enriched.push({
        ...result,
        snippet: page.compiled_truth || result.snippet,
        compiledView: {
          pagePath: toBrainPath(slug),
          summary: summarizeCompiledTruth(page.compiled_truth || result.snippet),
          sourceCounts,
          totalSources: sourceSlugs.length,
          lastUpdated: latestCompiledUpdate(page, timeline),
        },
      });
    }
    return enriched;
  }
}

function normalizeTimelineDate(date: string | Date): string {
  if (date instanceof Date) {
    return date.toISOString().slice(0, 10);
  }
  return String(date).slice(0, 10);
}

function toStoreSlug(pathOrSlug: string): string {
  return slugifyPath(pathOrSlug);
}

function toBrainPath(slug: string): string {
  return slug.endsWith(".md") ? slug : `${slug}.md`;
}

function summarizeCompiledTruth(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 320) return normalized;
  return `${normalized.slice(0, 317).trimEnd()}...`;
}

function latestCompiledUpdate(
  page: GbrainRuntimePage,
  timeline: GbrainRuntimeTimelineEntry[],
): string | null {
  const frontmatterDate = page.frontmatter?.compiled_truth_updated_at;
  if (typeof frontmatterDate === "string" && isFiniteDate(frontmatterDate)) {
    return new Date(frontmatterDate).toISOString();
  }
  const latestTimeline = timeline
    .map((entry) => new Date(entry.date))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((left, right) => right.getTime() - left.getTime())[0];
  return latestTimeline ? latestTimeline.toISOString() : null;
}

function isFiniteDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function slugifyPath(filePath: string): string {
  let normalized = filePath.replace(/\.mdx?$/i, "");
  normalized = normalized.replace(/\\/g, "/");
  normalized = normalized.replace(/^\.?\//, "");
  return normalized
    .split("/")
    .map(slugifySegment)
    .filter(Boolean)
    .join("/")
    .toLowerCase();
}

function slugifySegment(segment: string): string {
  return segment
    .normalize("NFKD")
    .replace(/[^\w.\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function createContentHash(parsed: ParsedMarkdown): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: parsed.title,
        type: parsed.type,
        compiled_truth: parsed.compiledTruth,
        timeline: parsed.timeline,
        frontmatter: parsed.frontmatter,
        tags: [...parsed.tags].sort(),
      }),
    )
    .digest("hex");
}

function parseMarkdown(raw: string, filePath: string): ParsedMarkdown {
  const { data, content } = matter(raw);
  const { compiledTruth, timeline } = splitBody(content);
  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : inferTitle(filePath, compiledTruth);
  const type = inferContentType(
    typeof data.type === "string" ? data.type : "",
    filePath,
  );

  const frontmatter = { ...(data as Record<string, unknown>) };
  delete frontmatter.title;
  delete frontmatter.type;
  delete frontmatter.tags;
  delete frontmatter.slug;

  return {
    compiledTruth: compiledTruth.trim(),
    timeline: timeline.trim(),
    title,
    type,
    tags: extractTags(data as Record<string, unknown>),
    frontmatter,
  };
}

function splitBody(body: string): { compiledTruth: string; timeline: string } {
  const lines = body.split("\n");
  let splitIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "---") continue;
    const beforeContent = lines.slice(0, index).join("\n").trim();
    if (beforeContent.length > 0) {
      splitIndex = index;
      break;
    }
  }

  if (splitIndex === -1) {
    return { compiledTruth: body, timeline: "" };
  }

  return {
    compiledTruth: lines.slice(0, splitIndex).join("\n"),
    timeline: lines.slice(splitIndex + 1).join("\n"),
  };
}

function extractTags(frontmatter: Record<string, unknown>): string[] {
  if (Array.isArray(frontmatter.tags)) {
    return frontmatter.tags.map(String);
  }
  if (typeof frontmatter.tags === "string") {
    return frontmatter.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function buildChunks(parsed: ParsedMarkdown): GbrainChunkInput[] {
  const chunks: GbrainChunkInput[] = [];

  if (parsed.compiledTruth) {
    for (const chunk of chunkText(parsed.compiledTruth)) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: chunk.text,
        chunk_source: "compiled_truth",
      });
    }
  }

  if (parsed.timeline) {
    for (const chunk of chunkText(parsed.timeline)) {
      chunks.push({
        chunk_index: chunks.length,
        chunk_text: chunk.text,
        chunk_source: "timeline",
      });
    }
  }

  return chunks;
}

function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectMarkdownFiles(fullPath));
    } else if (/\.mdx?$/i.test(entry)) {
      files.push(fullPath);
    }
  }

  return files;
}

function resolveImportFileWithinRoot(
  realContentDir: string,
  filePath: string,
): string | null {
  let realFile: string;
  try {
    realFile = realpathSync(filePath);
  } catch {
    return null;
  }

  const relativeToRoot = relative(realContentDir, realFile);
  if (
    relativeToRoot === ""
    || relativeToRoot.startsWith("..")
    || isAbsolute(relativeToRoot)
  ) {
    return null;
  }

  return realFile;
}

function inferTitle(filePath: string, compiledTruth: string): string {
  const heading = compiledTruth.match(/^# (.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return basename(filePath, ".md").replace(/[-_]/g, " ");
}

function matchesPathSegment(path: string, segment: string): boolean {
  return (
    path === segment ||
    path.startsWith(`${segment}/`) ||
    path.includes(`/${segment}/`)
  );
}

function inferContentType(type: string, slug: string): ContentType {
  const normalized = type as ContentType;
  const knownTypes: ContentType[] = [
    "paper",
    "dataset",
    "code",
    "note",
    "experiment",
    "observation",
    "hypothesis",
    "data",
    "web",
    "voice",
    "concept",
    "topic",
    "survey",
    "method",
    "project",
    "decision",
    "task",
    "artifact",
    "original_synthesis",
    "research_packet",
    "overnight_journal",
    "job_run",
    "frontier_item",
    "person",
  ];

  if (knownTypes.includes(normalized)) {
    return normalized;
  }

  const lower = slug.toLowerCase();
  if (matchesPathSegment(lower, "projects") || matchesPathSegment(lower, "project")) return "project";
  if (matchesPathSegment(lower, "papers")) return "paper";
  if (matchesPathSegment(lower, "experiments")) return "experiment";
  if (matchesPathSegment(lower, "hypotheses")) return "hypothesis";
  if (matchesPathSegment(lower, "topics")) return "topic";
  if (matchesPathSegment(lower, "decisions")) return "decision";
  if (matchesPathSegment(lower, "tasks")) return "task";
  if (matchesPathSegment(lower, "surveys")) return "survey";
  if (matchesPathSegment(lower, "methods")) return "method";
  if (matchesPathSegment(lower, "originals")) return "original_synthesis";
  if (matchesPathSegment(lower, "packets")) return "research_packet";
  if (matchesPathSegment(lower, "journals")) return "overnight_journal";
  if (matchesPathSegment(lower, "jobs")) return "job_run";
  if (matchesPathSegment(lower, "artifacts")) return "artifact";
  if (matchesPathSegment(lower, "frontier")) return "frontier_item";
  if (matchesPathSegment(lower, "observations")) return "observation";
  if (matchesPathSegment(lower, "people")) return "person";
  if (matchesPathSegment(lower, "data") || matchesPathSegment(lower, "datasets")) return "data";
  if (matchesPathSegment(lower, "web")) return "web";
  if (matchesPathSegment(lower, "voice")) return "voice";

  return "concept";
}
