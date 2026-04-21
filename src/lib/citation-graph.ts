/**
 * Citation graph builder.
 *
 * Walks a project's papers/ folder, turns every .pdf/.bib/.tex/.md file into a
 * node (collapsed by relative path stem so paper-one.pdf + paper-one.md dedupe
 * into one node, while subdirectory collisions stay distinct), and scans the
 * text contents for reference patterns:
 *
 *   - DOIs            (10.xxxx/...)
 *   - arXiv ids       (arxiv: 2401.12345)
 *   - BibTeX keys     (\cite{key1, key2})
 *
 * References that resolve to a scanned node become real edges. Unresolved
 * references surface as edges whose target is `external:<raw>` and get
 * counted in the `externalRefs` map (once per unique raw token).
 *
 * .pdf content is intentionally NOT text-scanned (no pdf-parse dep): PDFs
 * still become nodes but contribute no edges of their own. A companion .md
 * with the same basename can provide the paper metadata and references.
 *
 * Missing root → empty graph. Never throws on IO.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

// ── Public types ─────────────────────────────────────

export interface CitationNode {
  /** Paper identifier relative to papersRoot, without extension. */
  id: string;
  /** Relative path (from papersRoot) of the file that first introduced this node. */
  file: string;
  /** Title pulled from a companion .md frontmatter, if any. */
  title?: string;
  /** Publication year pulled from a companion .md frontmatter, if any. */
  year?: number;
  type: "paper";
}

export interface CitationEdge {
  /** Source node id. */
  source: string;
  /** Target node id, OR `external:<raw>` if the target isn't in the scan. */
  target: string;
  refType: "doi" | "arxiv" | "bibkey";
  /** The original matched token (normalised to lower-case for DOI/arXiv). */
  raw: string;
}

export interface CitationGraph {
  nodes: CitationNode[];
  edges: CitationEdge[];
  /** Refs that don't resolve to any node in the scan. Keyed by `external:<raw>`. */
  externalRefs: Record<string, { refType: string; count: number }>;
  scannedAt: string;
}

// ── Internal types ───────────────────────────────────

interface NodeDraft {
  id: string;
  basename: string;
  file: string;
  title?: string;
  year?: number;
  /** DOI from companion .md frontmatter (normalised to lower-case). */
  doi?: string;
  /** arXiv id from companion .md frontmatter. */
  arxivId?: string;
  /** Raw text content for reference scanning. Empty for .pdf files. */
  content: string;
  /** File extensions that contributed to this node (for "first wins" metadata). */
  seenExts: Set<string>;
}

// ── Constants ────────────────────────────────────────

const PAPER_EXTS = new Set([".pdf", ".bib", ".tex", ".md"]);

// DOI — conservative enough to match the vast majority without dragging in
// arbitrary text. Case-insensitive (some sources upper-case the prefix).
const DOI_RE = /\b(10\.\d{4,}\/[-._;()/:A-Z0-9]+)\b/gi;

// arXiv — requires an explicit "arxiv" prefix (colon or whitespace) to reduce
// the false-positive rate. The naked "YYYY.NNNNN" form is intentionally not
// matched because it collides with normal text (year + number refs).
const ARXIV_RE = /arxiv(?::|\s+)(\d{4}\.\d{4,5}(?:v\d+)?)/gi;

// LaTeX \cite{} (with optional [prefix] before the braces, e.g. \cite[p.4]{k}).
const CITE_RE = /\\cite(?:\[[^\]]*\])?\{([^}]+)\}/g;

function toNodeId(relativePath: string): string {
  const ext = path.extname(relativePath);
  const withoutExt = ext ? relativePath.slice(0, -ext.length) : relativePath;
  return withoutExt.split(path.sep).join("/");
}

function normalizeArxivId(raw: string): string {
  return raw.trim().replace(/v\d+$/i, "");
}

// ── Public API ───────────────────────────────────────

export async function buildCitationGraph(
  papersRoot: string,
): Promise<CitationGraph> {
  const scannedAt = new Date().toISOString();
  const empty: CitationGraph = {
    nodes: [],
    edges: [],
    externalRefs: {},
    scannedAt,
  };

  let rootStat;
  try {
    rootStat = await fs.stat(papersRoot);
  } catch {
    // Missing root → empty graph, never throw.
    return empty;
  }
  if (!rootStat.isDirectory()) {
    return empty;
  }

  // Walk and collect every candidate file path (relative to the root).
  const files: string[] = [];
  await walk(papersRoot, papersRoot, files);

  // First pass: build NodeDraft per relative-path stem. Each file contributes its
  // content (for .md/.bib/.tex) and its frontmatter metadata (for .md).
  const drafts = new Map<string, NodeDraft>();
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!PAPER_EXTS.has(ext)) continue;
    const id = toNodeId(rel);
    const basename = path.basename(id);

    let draft = drafts.get(id);
    if (!draft) {
      draft = {
        id,
        basename,
        file: rel,
        content: "",
        seenExts: new Set<string>(),
      };
      drafts.set(id, draft);
    }
    draft.seenExts.add(ext);

    // Skip any text read for .pdf — we don't have pdf-parse wired here.
    if (ext === ".pdf") {
      continue;
    }

    let text: string;
    try {
      text = await fs.readFile(path.join(papersRoot, rel), "utf-8");
    } catch {
      continue;
    }

    // .md files may carry frontmatter (title/year/doi/arxivId). "First seen
    // wins" for metadata: only fill fields that are still undefined.
    if (ext === ".md") {
      try {
        const parsed = matter(text);
        const data = parsed.data as Record<string, unknown>;
        if (draft.title === undefined && typeof data.title === "string") {
          draft.title = data.title;
        }
        if (draft.year === undefined) {
          const y = data.year;
          if (typeof y === "number" && Number.isFinite(y)) {
            draft.year = y;
          } else if (typeof y === "string" && /^\d{4}$/.test(y.trim())) {
            draft.year = Number.parseInt(y.trim(), 10);
          }
        }
        if (draft.doi === undefined && typeof data.doi === "string") {
          draft.doi = data.doi.trim().toLowerCase();
        }
        if (
          draft.arxivId === undefined &&
          typeof data.arxivId === "string"
        ) {
          draft.arxivId = normalizeArxivId(data.arxivId);
        }
        // Use the stripped body for content scanning so we don't match refs
        // that live inside the frontmatter block itself.
        draft.content += `\n${parsed.content}`;
      } catch {
        draft.content += `\n${text}`;
      }
    } else {
      // .bib / .tex — scan the whole file verbatim.
      draft.content += `\n${text}`;
    }
  }

  // Build lookup tables for reference resolution.
  const byId = new Map<string, NodeDraft>();
  const byLowerId = new Map<string, NodeDraft>();
  const byUniqueBasename = new Map<string, NodeDraft>();
  const ambiguousBasenames = new Set<string>();
  const byDoi = new Map<string, NodeDraft>();
  const byArxiv = new Map<string, NodeDraft>();
  for (const draft of drafts.values()) {
    byId.set(draft.id, draft);
    byLowerId.set(draft.id.toLowerCase(), draft);
    const lowerBasename = draft.basename.toLowerCase();
    if (ambiguousBasenames.has(lowerBasename)) {
      // Keep basename lookups disabled once a collision is detected.
    } else if (byUniqueBasename.has(lowerBasename)) {
      byUniqueBasename.delete(lowerBasename);
      ambiguousBasenames.add(lowerBasename);
    } else {
      byUniqueBasename.set(lowerBasename, draft);
    }
    if (draft.doi) byDoi.set(draft.doi, draft);
    if (draft.arxivId) byArxiv.set(draft.arxivId, draft);
  }

  // Second pass: scan references out of each draft's content.
  const edges: CitationEdge[] = [];
  const edgeKeys = new Set<string>();
  const externalRefs: Record<string, { refType: string; count: number }> = {};
  const externalSeen = new Set<string>(); // per-unique-raw dedupe

  const addEdge = (edge: CitationEdge) => {
    const key = `${edge.source}|${edge.target}|${edge.refType}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };

  const countExternal = (externalKey: string, raw: string, refType: string) => {
    const seenKey = `${refType}:${raw}`;
    if (externalSeen.has(seenKey)) return;
    externalSeen.add(seenKey);
    externalRefs[externalKey] = { refType, count: 1 };
  };

  for (const draft of drafts.values()) {
    if (!draft.content) continue;
    const sourceId = draft.id;

    // DOIs.
    for (const match of draft.content.matchAll(DOI_RE)) {
      const raw = match[1].toLowerCase();
      // Don't count self-edges: a paper referencing its own DOI.
      if (draft.doi === raw) continue;
      const target = byDoi.get(raw);
      if (target) {
        if (target.id === sourceId) continue;
        addEdge({
          source: sourceId,
          target: target.id,
          refType: "doi",
          raw,
        });
      } else {
        const externalKey = `external:${raw}`;
        addEdge({
          source: sourceId,
          target: externalKey,
          refType: "doi",
          raw,
        });
        countExternal(externalKey, raw, "doi");
      }
    }

    // arXiv ids.
    for (const match of draft.content.matchAll(ARXIV_RE)) {
      const raw = normalizeArxivId(match[1]!);
      if (draft.arxivId === raw) continue;
      const target = byArxiv.get(raw);
      if (target) {
        if (target.id === sourceId) continue;
        addEdge({
          source: sourceId,
          target: target.id,
          refType: "arxiv",
          raw,
        });
      } else {
        const externalKey = `external:${raw}`;
        addEdge({
          source: sourceId,
          target: externalKey,
          refType: "arxiv",
          raw,
        });
        countExternal(externalKey, raw, "arxiv");
      }
    }

    // BibTeX \cite{} keys.
    for (const match of draft.content.matchAll(CITE_RE)) {
      const keys = match[1]
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      for (const raw of keys) {
        if (raw === sourceId) continue;
        const target =
          byId.get(raw)
          ?? byLowerId.get(raw.toLowerCase())
          ?? byUniqueBasename.get(raw.toLowerCase());
        if (target) {
          if (target.id === sourceId) continue;
          addEdge({
            source: sourceId,
            target: target.id,
            refType: "bibkey",
            raw,
          });
        } else {
          const externalKey = `external:${raw}`;
          addEdge({
            source: sourceId,
            target: externalKey,
            refType: "bibkey",
            raw,
          });
          countExternal(externalKey, raw, "bibkey");
        }
      }
    }
  }

  const nodes: CitationNode[] = [...drafts.values()]
    .map((draft) => ({
      id: draft.id,
      file: draft.file,
      title: draft.title,
      year: draft.year,
      type: "paper" as const,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes,
    edges,
    externalRefs,
    scannedAt,
  };
}

// ── Helpers ──────────────────────────────────────────

async function walk(
  root: string,
  dir: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Skip hidden files / dotfiles to avoid noise like .DS_Store or .git.
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full));
    }
  }
}
