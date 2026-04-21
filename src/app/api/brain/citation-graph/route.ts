/**
 * GET /api/brain/citation-graph?root=<slug>&depth=2
 *
 * Returns citation graph data: nodes and edges built by walking brain wiki pages
 * starting from a root page, following wikilinks and citation references.
 * External references (papers mentioned but without a brain page) appear as
 * "ghost" nodes with isInBrain=false.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename, relative } from "path";
import matter from "gray-matter";
import { toPublicBrainSlug, toPublicBrainSlugKey } from "@/brain/public-slug";
import { ensureBrainStoreReady, getBrainStore, type BrainPage, type BrainStore } from "@/brain/store";
import { getBrainConfig, isErrorResponse } from "../_shared";

// ── Public types ─────────────────────────────────────

export interface CitationGraphNode {
  id: string;
  title: string;
  type: "paper" | "concept" | "person" | "project";
  citationCount?: number;
  isInBrain: boolean;
}

export interface CitationGraphEdge {
  source: string;
  target: string;
  type: "cites" | "cited-by" | "references" | "related" | "authored";
  from?: string;
  to?: string;
  relation?: string;
}

export interface CitationGraph {
  nodes: CitationGraphNode[];
  edges: CitationGraphEdge[];
  rootNode: string;
}

// ── Route handler ────────────────────────────────────

export async function GET(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  const url = new URL(request.url);
  const root = url.searchParams.get("root");
  const depthStr = url.searchParams.get("depth");
  const depth = depthStr ? Math.min(Math.max(parseInt(depthStr, 10), 1), 5) : 2;

  if (!root) {
    return Response.json(
      { error: "Missing required query parameter: root" },
      { status: 400 },
    );
  }

  const typedGraph = await buildTypedGbrainGraph(root, depth).catch((error) => {
    console.warn(
      "brain citation graph: typed gbrain graph unavailable; falling back to wiki graph",
      error,
    );
    return null;
  });
  if (typedGraph) {
    return Response.json(typedGraph);
  }

  const wikiDir = join(config.root, "wiki");
  if (!existsSync(wikiDir)) {
    return Response.json(
      { nodes: [], edges: [], rootNode: root } satisfies CitationGraph,
    );
  }

  // Build index of all brain pages
  const pageIndex = buildPageIndex(wikiDir, config.root);

  // Find the root page
  const rootPageId = findPageBySlug(root, pageIndex);
  if (!rootPageId) {
    return Response.json(
      { error: `Root page not found: ${root}` },
      { status: 404 },
    );
  }

  // BFS walk to build graph
  const graph = buildCitationGraph(rootPageId, depth, pageIndex);

  return Response.json(graph);
}

async function buildTypedGbrainGraph(
  root: string,
  maxDepth: number,
): Promise<CitationGraph | null> {
  await ensureBrainStoreReady();
  const store = getBrainStore();
  const pageCache = new Map<string, BrainPage>();
  const rootPage = await findTypedRootPage(store, root, pageCache);
  if (!rootPage) return null;

  const rootSlug = cachePage(pageCache, rootPage);
  const nodeMap = new Map<string, CitationGraphNode>();
  const edgeMap = new Map<string, CitationGraphEdge>();
  const visited = new Set<string>();
  const queue: Array<{ slug: string; depth: number }> = [{ slug: rootSlug, depth: 0 }];

  const addNode = (slug: string, page: BrainPage): void => {
    if (nodeMap.has(slug)) return;
    nodeMap.set(slug, {
      id: slug,
      title: page.title,
      type: mapToGraphType(String(page.frontmatter.type ?? page.type)),
      citationCount: 0,
      isInBrain: true,
    });
  };

  addNode(rootSlug, rootPage);

  while (queue.length > 0) {
    const { slug, depth } = queue.shift()!;
    if (visited.has(slug)) continue;
    visited.add(slug);

    const page = await getTypedPage(store, slug, pageCache);
    if (!page) continue;
    addNode(slug, page);

    const [outgoing, incoming] = await Promise.all([
      store.getLinks(page.path).catch(() => []),
      store.getBacklinks(page.path).catch(() => []),
    ]);
    const typedLinks = [
      ...outgoing.map((link) => ({
        from: toPublicBrainSlug(link.fromSlug ?? page.path),
        to: toPublicBrainSlug(link.toSlug ?? link.slug),
        relation: link.kind,
      })),
      ...incoming.map((link) => ({
        from: toPublicBrainSlug(link.fromSlug ?? link.slug),
        to: toPublicBrainSlug(link.toSlug ?? page.path),
        relation: link.kind,
      })),
    ];

    for (const link of typedLinks) {
      const [fromPage, toPage] = await Promise.all([
        getTypedPage(store, link.from, pageCache),
        getTypedPage(store, link.to, pageCache),
      ]);
      if (!fromPage || !toPage) continue;

      const fromSlug = cachePage(pageCache, fromPage);
      const toSlug = cachePage(pageCache, toPage);
      addNode(fromSlug, fromPage);
      addNode(toSlug, toPage);

      const edgeKey = `${fromSlug}->${toSlug}:${link.relation}`;
      if (!edgeMap.has(edgeKey)) {
        edgeMap.set(edgeKey, {
          source: fromSlug,
          target: toSlug,
          type: mapRelationToLegacyEdgeType(link.relation),
          from: fromSlug,
          to: toSlug,
          relation: link.relation,
        });
      }

      const nextSlug = fromSlug === slug ? toSlug : fromSlug;
      if (depth + 1 < maxDepth && !visited.has(nextSlug)) {
        queue.push({ slug: nextSlug, depth: depth + 1 });
      }
    }
  }

  const citationCounts = new Map<string, number>();
  for (const edge of edgeMap.values()) {
    citationCounts.set(edge.source, (citationCounts.get(edge.source) ?? 0) + 1);
    citationCounts.set(edge.target, (citationCounts.get(edge.target) ?? 0) + 1);
  }
  for (const [slug, node] of nodeMap.entries()) {
    node.citationCount = citationCounts.get(slug) ?? 0;
  }

  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    rootNode: rootSlug,
  };
}

async function findTypedRootPage(
  store: BrainStore,
  root: string,
  pageCache: Map<string, BrainPage>,
): Promise<BrainPage | null> {
  const direct = await getTypedPage(store, root, pageCache);
  if (direct) return direct;

  const normalized = toPublicBrainSlugKey(root);
  const results = await store.search({
    query: root,
    mode: "index",
    limit: 25,
  }).catch(() => []);
  for (const result of results) {
    if (
      toPublicBrainSlugKey(result.path) !== normalized
      && toPublicBrainSlugKey(result.title) !== normalized
    ) {
      continue;
    }
    const page = await getTypedPage(store, result.path, pageCache);
    if (page) return page;
  }
  return null;
}

async function getTypedPage(
  store: BrainStore,
  value: string,
  pageCache: Map<string, BrainPage>,
): Promise<BrainPage | null> {
  const publicSlug = toPublicBrainSlug(value);
  const cached = pageCache.get(publicSlug);
  if (cached) return cached;

  for (const candidate of pageLookupCandidates(publicSlug)) {
    const page = await store.getPage(candidate).catch(() => null);
    if (page) {
      cachePage(pageCache, page);
      return page;
    }
  }
  return null;
}

function cachePage(pageCache: Map<string, BrainPage>, page: BrainPage): string {
  const slug = toPublicBrainSlug(page.path);
  pageCache.set(slug, page);
  return slug;
}

function pageLookupCandidates(publicSlug: string): string[] {
  const candidates = [
    publicSlug,
    `${publicSlug}.md`,
  ];
  if (!publicSlug.startsWith("wiki/")) {
    candidates.push(`wiki/${publicSlug}`, `wiki/${publicSlug}.md`);
  }
  return [...new Set(candidates)];
}

function mapRelationToLegacyEdgeType(
  relation: string,
): CitationGraphEdge["type"] {
  if (relation === "cites") return "cites";
  if (relation === "authored") return "authored";
  if (relation === "references") return "references";
  return "related";
}

// ── Internal types ───────────────────────────────────

interface PageInfo {
  id: string;
  title: string;
  type: "paper" | "concept" | "person" | "project";
  content: string;
  wikilinks: string[];
  citations: string[];
  authors: string[];
}

// ── Graph building ───────────────────────────────────

function buildPageIndex(
  wikiDir: string,
  brainRoot: string,
): Map<string, PageInfo> {
  const index = new Map<string, PageInfo>();

  walkDir(wikiDir, (filePath) => {
    if (!filePath.endsWith(".md")) return;

    const content = readFileSync(filePath, "utf-8");
    const parsed = matter(content);
    const relPath = relative(brainRoot, filePath);
    const id = relPath;
    const rawType = (parsed.data.type as string) ?? inferType(relPath);
    const type = mapToGraphType(rawType);
    const title =
      (parsed.data.title as string) ??
      extractTitle(content) ??
      basename(filePath, ".md");

    // Extract wikilinks: [[target]] or [[target|display]]
    const wikilinks: string[] = [];
    const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = wikiRe.exec(content)) !== null) {
      wikilinks.push(m[1].trim());
    }

    // Extract citation references: @key or cite{key} patterns
    const citations: string[] = [];
    const citeRe = /(?:@([a-zA-Z][\w.-]+)|\\cite\{([^}]+)\})/g;
    while ((m = citeRe.exec(content)) !== null) {
      const keys = (m[1] ?? m[2]).split(",").map((k) => k.trim());
      citations.push(...keys);
    }

    // Extract authors from frontmatter
    const authors: string[] = Array.isArray(parsed.data.authors)
      ? parsed.data.authors
      : [];

    index.set(id, { id, title, type, content, wikilinks, citations, authors });
  });

  return index;
}

function buildCitationGraph(
  rootId: string,
  maxDepth: number,
  pageIndex: Map<string, PageInfo>,
): CitationGraph {
  const nodeMap = new Map<string, CitationGraphNode>();
  const edges: CitationGraphEdge[] = [];
  const edgeSet = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [
    { id: rootId, depth: 0 },
  ];

  // Add root node
  const rootPage = pageIndex.get(rootId)!;
  nodeMap.set(rootId, {
    id: rootId,
    title: rootPage.title,
    type: rootPage.type,
    citationCount: rootPage.wikilinks.length + rootPage.citations.length,
    isInBrain: true,
  });

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const page = pageIndex.get(id);
    if (!page) continue;

    // Process wikilinks
    for (const link of page.wikilinks) {
      const targetId = resolveWikilink(link, pageIndex);
      const edgeKey = `${id}->${targetId ?? `ghost:${link}`}`;

      if (targetId) {
        // Link to existing brain page
        if (!nodeMap.has(targetId)) {
          const targetPage = pageIndex.get(targetId)!;
          nodeMap.set(targetId, {
            id: targetId,
            title: targetPage.title,
            type: targetPage.type,
            citationCount:
              targetPage.wikilinks.length + targetPage.citations.length,
            isInBrain: true,
          });
        }

        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({
            source: id,
            target: targetId,
            type: inferEdgeType(page, pageIndex.get(targetId)!),
          });
        }

        if (depth + 1 < maxDepth) {
          queue.push({ id: targetId, depth: depth + 1 });
        }
      } else {
        // Ghost node: referenced but not in brain
        const ghostId = `ghost:${link}`;
        if (!nodeMap.has(ghostId)) {
          nodeMap.set(ghostId, {
            id: ghostId,
            title: link,
            type: "paper",
            isInBrain: false,
          });
        }
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({ source: id, target: ghostId, type: "references" });
        }
      }
    }

    // Process citations
    for (const cite of page.citations) {
      const ghostId = `ghost:${cite}`;
      const edgeKey = `${id}->cite:${cite}`;
      if (!nodeMap.has(ghostId)) {
        nodeMap.set(ghostId, {
          id: ghostId,
          title: cite,
          type: "paper",
          isInBrain: false,
        });
      }
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({ source: id, target: ghostId, type: "cites" });
      }
    }

    // Process authors
    for (const author of page.authors) {
      const authorId = resolveWikilink(author, pageIndex);
      const effectiveId = authorId ?? `ghost:${author}`;
      const edgeKey = `${effectiveId}->authored:${id}`;

      if (!nodeMap.has(effectiveId)) {
        nodeMap.set(effectiveId, {
          id: effectiveId,
          title: author,
          type: "person",
          isInBrain: !!authorId,
        });
      }
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({ source: effectiveId, target: id, type: "authored" });
      }
    }
  }

  return {
    nodes: [...nodeMap.values()],
    edges,
    rootNode: rootId,
  };
}

// ── Helpers ──────────────────────────────────────────

function findPageBySlug(
  slug: string,
  pageIndex: Map<string, PageInfo>,
): string | null {
  // Exact match
  if (pageIndex.has(slug)) return slug;

  // Match by slug in filename
  const normalized = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  for (const [id, page] of pageIndex) {
    const fileSlug = basename(id, ".md")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^\d{4}-\d{2}-\d{2}-/, ""); // strip date prefix
    if (fileSlug === normalized) return id;
    if (page.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") === normalized) {
      return id;
    }
  }

  return null;
}

function resolveWikilink(
  link: string,
  pageIndex: Map<string, PageInfo>,
): string | null {
  const normalized = link.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  for (const [id, page] of pageIndex) {
    const fileSlug = basename(id, ".md")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^\d{4}-\d{2}-\d{2}-/, "");
    if (fileSlug === normalized) return id;
    if (page.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") === normalized) {
      return id;
    }
  }
  return null;
}

function inferEdgeType(
  source: PageInfo,
  target: PageInfo,
): CitationGraphEdge["type"] {
  if (source.type === "person" || target.type === "person") return "authored";
  if (source.type === "paper" && target.type === "paper") return "cites";
  if (target.type === "concept") return "references";
  return "related";
}

function mapToGraphType(
  rawType: string,
): CitationGraphNode["type"] {
  switch (rawType) {
    case "paper":
      return "paper";
    case "concept":
      return "concept";
    case "person":
      return "person";
    case "project":
      return "project";
    case "hypothesis":
    case "experiment":
      return "concept";
    default:
      return "paper";
  }
}

function inferType(relPath: string): string {
  if (relPath.includes("paper")) return "paper";
  if (relPath.includes("project")) return "project";
  if (relPath.includes("person") || relPath.includes("people")) return "person";
  return "note";
}

function extractTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function walkDir(dir: string, callback: (path: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(fullPath, callback);
      } else {
        callback(fullPath);
      }
    } catch {
      // skip inaccessible
    }
  }
}

// Export internals for testing
