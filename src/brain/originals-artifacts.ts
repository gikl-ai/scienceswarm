/**
 * Second Brain — Originals to Artifact Compiler
 *
 * When a scientist has 3+ original ideas on a theme, this module
 * offers to compile them into a blog post draft, memo, evidence
 * summary, paper outline, or thread. Turns fleeting thinking into
 * durable writing.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join } from "path";
import type { BrainConfig } from "./types";
import type { LLMClient } from "./llm";
import { search } from "./search";

// ── Public Types ─────────────────────────────────────

export interface OriginalClusterForArtifact {
  theme: string;
  originals: Array<{
    path: string;
    verbatim: string;
    kind: string;
    date: string;
  }>;
  relatedPapers: string[];
  relatedConcepts: string[];
}

export type ArtifactFormat =
  | "blog-post"
  | "memo"
  | "evidence-summary"
  | "paper-outline"
  | "thread";

export interface CompiledArtifact {
  title: string;
  format: ArtifactFormat;
  content: string; // full markdown
  sourcePaths: string[]; // originals used
  relatedPages: string[]; // papers, concepts linked
  wordCount: number;
}

// ── Core Functions ───────────────────────────────────

/**
 * Scan originals folder, cluster by keyword/topic similarity
 * (Jaccard on word sets, threshold 0.4), return clusters with
 * 3+ originals. For each cluster, also find related papers
 * and concepts via brain search.
 */
export async function findCompilableThemes(
  config: BrainConfig
): Promise<OriginalClusterForArtifact[]> {
  const originalsDir = join(config.root, "wiki/originals");
  if (!existsSync(originalsDir)) return [];

  const files = readdirSync(originalsDir).filter((f) => f.endsWith(".md"));
  if (files.length < 3) return [];

  // Parse all originals
  const originals = files.map((file) => {
    const absPath = join(originalsDir, file);
    const content = readFileSync(absPath, "utf-8");
    return {
      path: `wiki/originals/${file}`,
      verbatim: extractVerbatim(content),
      kind: extractKind(content),
      date: extractDate(content),
      words: extractContentWords(content),
    };
  });

  // Cluster by Jaccard similarity on word sets (threshold 0.3)
  // Originals are short texts so 0.3 is a practical threshold
  const clusters = clusterBySimilarity(originals, 0.3);

  // Only keep clusters with 3+ originals
  const compilable = clusters.filter((c) => c.members.length >= 3);

  // Enrich each cluster with related papers and concepts
  const results: OriginalClusterForArtifact[] = [];
  for (const cluster of compilable) {
    const theme = deriveTheme(cluster.members);
    const { papers, concepts } = await findRelated(config, theme);

    results.push({
      theme,
      originals: cluster.members.map((m) => ({
        path: m.path,
        verbatim: m.verbatim,
        kind: m.kind,
        date: m.date,
      })),
      relatedPapers: papers,
      relatedConcepts: concepts,
    });
  }

  return results;
}

/**
 * Use LLM to compile originals into a structured artifact.
 */
export async function compileOriginals(
  config: BrainConfig,
  llm: LLMClient,
  cluster: OriginalClusterForArtifact,
  format: ArtifactFormat
): Promise<CompiledArtifact> {
  const prompt = buildCompilationPrompt(cluster, format);

  const response = await llm.complete({
    system: prompt.system,
    user: prompt.user,
    model: config.synthesisModel,
  });

  const content = response.content;
  const title = extractTitle(content) ?? `${cluster.theme} — ${formatLabel(format)}`;
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  return {
    title,
    format,
    content,
    sourcePaths: cluster.originals.map((o) => o.path),
    relatedPages: [...cluster.relatedPapers, ...cluster.relatedConcepts],
    wordCount,
  };
}

/**
 * Save a compiled artifact to wiki/entities/artifacts/ with proper
 * frontmatter and back-links to source originals.
 */
export function saveArtifact(
  config: BrainConfig,
  artifact: CompiledArtifact
): string {
  const artifactsDir = join(config.root, "wiki/entities/artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const slug = artifact.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  const filename = `${date}-${slug}.md`;
  const pagePath = `wiki/entities/artifacts/${filename}`;
  const absPath = join(config.root, pagePath);

  const sourceLinks = artifact.sourcePaths
    .map((p) => `  - [[${p}]]`)
    .join("\n");
  const relatedLinks = artifact.relatedPages
    .map((p) => `  - [[${p}]]`)
    .join("\n");

  const frontmatter = [
    "---",
    `date: ${date}`,
    "type: artifact",
    "para: resources",
    `tags: [artifact, ${artifact.format}, compiled]`,
    `title: "${escapeYaml(artifact.title)}"`,
    `format: ${artifact.format}`,
    `word_count: ${artifact.wordCount}`,
    "---",
  ].join("\n");

  const backLinks = [
    "",
    "## Sources",
    "",
    "Compiled from these originals:",
    sourceLinks,
    "",
    ...(relatedLinks
      ? ["## Related", "", relatedLinks, ""]
      : []),
  ].join("\n");

  const fullContent = `${frontmatter}\n\n${artifact.content}\n${backLinks}`;
  writeFileSync(absPath, fullContent);

  return pagePath;
}

// ── Clustering ───────────────────────────────────────

interface ParsedOriginal {
  path: string;
  verbatim: string;
  kind: string;
  date: string;
  words: Set<string>;
}

interface Cluster {
  members: ParsedOriginal[];
}

/**
 * Cluster originals by Jaccard similarity on word sets.
 * Uses single-linkage: an original joins a cluster if it
 * is similar to ANY existing member.
 */
function clusterBySimilarity(
  originals: ParsedOriginal[],
  threshold: number
): Cluster[] {
  const clusters: Cluster[] = [];

  for (const original of originals) {
    let bestCluster: Cluster | null = null;

    for (const cluster of clusters) {
      for (const member of cluster.members) {
        if (jaccardSimilarity(original.words, member.words) >= threshold) {
          bestCluster = cluster;
          break;
        }
      }
      if (bestCluster) break;
    }

    if (bestCluster) {
      bestCluster.members.push(original);
    } else {
      clusters.push({ members: [original] });
    }
  }

  return clusters;
}

/**
 * Jaccard similarity: |A intersect B| / |A union B|
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;

  for (const word of smaller) {
    if (larger.has(word)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Prompt Building ──────────────────────────────────

function buildCompilationPrompt(
  cluster: OriginalClusterForArtifact,
  format: ArtifactFormat
): { system: string; user: string } {
  const originalsText = cluster.originals
    .map(
      (o, i) =>
        `${i + 1}. [${o.kind}] "${o.verbatim}" (${o.date})`
    )
    .join("\n");

  const relatedText = [
    ...(cluster.relatedPapers.length > 0
      ? [`Related papers: ${cluster.relatedPapers.join(", ")}`]
      : []),
    ...(cluster.relatedConcepts.length > 0
      ? [`Related concepts: ${cluster.relatedConcepts.join(", ")}`]
      : []),
  ].join("\n");

  const formatInstructions = FORMAT_INSTRUCTIONS[format];

  const system = `You are a science writing assistant. You compile a researcher's original thoughts into polished artifacts.

RULES:
- Preserve the researcher's EXACT phrasing when quoting their originals (use > blockquotes)
- Every original must appear in the output
- Add connective tissue and context between originals
- Output pure Markdown

FORMAT: ${format}
${formatInstructions}`;

  const user = `Theme: ${cluster.theme}

Originals:
${originalsText}

${relatedText}

Compile these originals into a ${formatLabel(format)}.`;

  return { system, user };
}

const FORMAT_INSTRUCTIONS: Record<ArtifactFormat, string> = {
  "blog-post": `Structure:
# Title
## Introduction (why this matters)
## Sections (one per original, expanded with context)
## Conclusion
## References`,

  memo: `Structure:
# Title
## Executive Summary (2-3 sentences)
## Key Insights (one per original)
## Evidence
## Implications`,

  "evidence-summary": `Structure:
# Claim
## Supporting Originals (verbatim quotes with analysis)
## Related Papers
## Confidence Assessment (low/medium/high with reasoning)`,

  "paper-outline": `Structure:
# Title
## Abstract Draft (150 words)
## Section Headers with Key Arguments
## Citations
## Open Questions`,

  thread: `Structure:
Numbered posts (1/N format), each under 280 characters.
Each post builds on the last. First post hooks the reader.
Last post has a takeaway or call to action.`,
};

// ── Helpers ──────────────────────────────────────────

/** Stop words excluded from similarity computation */
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "because", "but", "and",
  "or", "if", "while", "about", "up", "this", "that", "these", "those",
  "it", "its", "i", "me", "my", "we", "our", "you", "your", "he", "she",
  "they", "them", "their", "what", "which", "who", "whom",
]);

function extractContentWords(content: string): Set<string> {
  // Extract only the meaningful parts: verbatim quote + additional context
  // Skip frontmatter, section headers, and structural boilerplate
  const parts: string[] = [];

  // Get the blockquote (verbatim)
  const quoteMatch = content.match(/^>\s+(.+)$/m);
  if (quoteMatch) parts.push(quoteMatch[1]);

  // Get additional context section (user-written content below Timeline)
  const contextMatch = content.match(/Additional context:\s*(.+)/);
  if (contextMatch) parts.push(contextMatch[1]);

  // Get the title line (first H1)
  const titleMatch = content.match(/^# (.+)$/m);
  if (titleMatch) parts.push(titleMatch[1]);

  const text = parts.join(" ");
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

function extractVerbatim(content: string): string {
  // Look for the blockquote in the Compiled Truth section
  const match = content.match(/^>\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function extractKind(content: string): string {
  const match = content.match(/\*\*Kind\*\*:\s*(\w+)/);
  return match ? match[1] : "observation";
}

function extractDate(content: string): string {
  const match = content.match(/^date:\s*(.+)$/m);
  return match ? match[1].trim() : new Date().toISOString().slice(0, 10);
}

function extractTitle(content: string): string | null {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1].trim() : null;
}

function escapeYaml(text: string): string {
  return text.replace(/"/g, '\\"').replace(/\n/g, " ");
}

/**
 * Derive a theme label from the most frequent content words
 * across a cluster's members.
 */
function deriveTheme(members: ParsedOriginal[]): string {
  const freq = new Map<string, number>();
  for (const m of members) {
    for (const word of m.words) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  // Take the top 3 words that appear in at least 2 members
  const sorted = [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => word);

  return sorted.length > 0 ? sorted.join(" + ") : "mixed themes";
}

function formatLabel(format: ArtifactFormat): string {
  const labels: Record<ArtifactFormat, string> = {
    "blog-post": "Blog Post",
    memo: "Memo",
    "evidence-summary": "Evidence Summary",
    "paper-outline": "Paper Outline",
    thread: "Thread",
  };
  return labels[format];
}

/**
 * Find related papers and concepts in the brain for a given theme.
 */
async function findRelated(
  config: BrainConfig,
  theme: string
): Promise<{ papers: string[]; concepts: string[] }> {
  try {
    const results = await search(config, {
      query: theme.replace(/\s*\+\s*/g, " "),
      mode: "grep",
      limit: 10,
    });

    const papers = results
      .filter((r) => r.type === "paper")
      .slice(0, 5)
      .map((r) => r.path);

    const concepts = results
      .filter((r) => r.type === "concept")
      .slice(0, 5)
      .map((r) => r.path);

    return { papers, concepts };
  } catch {
    return { papers: [], concepts: [] };
  }
}
