/**
 * Second Brain — Research Enrichment Pipeline
 *
 * Uses deterministic collectors (Semantic Scholar, arXiv) for data
 * and LLMs for judgment (what to update, what cross-references to create).
 *
 * Architecture: gbrain pattern — deterministic collectors for data,
 * LLMs for judgment.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import matter from "gray-matter";
import type { BrainConfig, IngestCost } from "./types";
import type { LLMClient } from "./llm";
import type { EnrichmentTarget } from "./dream-state";
import { aggregateCosts, logEvent } from "./cost";
import { search } from "./search";
import {
  resolvePaper,
  type SemanticScholarPaper,
  type SemanticScholarQuery,
} from "../../scripts/research-enrichment/semantic-scholar";
import {
  fetchById as fetchArxivById,
  type ArxivPaper,
} from "../../scripts/research-enrichment/arxiv-collector";

// ── Types ─────────────────────────────────────────────

export interface EnrichmentResult {
  pagesCreated: string[];
  pagesUpdated: string[];
  timelineEntries: number;
  crossLinksCreated: number;
  cost: IngestCost;
  durationMs: number;
}

function emptyResult(): EnrichmentResult {
  return {
    pagesCreated: [],
    pagesUpdated: [],
    timelineEntries: 0,
    crossLinksCreated: 0,
    cost: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, model: "none" },
    durationMs: 0,
  };
}

function mergeResults(a: EnrichmentResult, b: EnrichmentResult): EnrichmentResult {
  return {
    pagesCreated: [...a.pagesCreated, ...b.pagesCreated],
    pagesUpdated: [...a.pagesUpdated, ...b.pagesUpdated],
    timelineEntries: a.timelineEntries + b.timelineEntries,
    crossLinksCreated: a.crossLinksCreated + b.crossLinksCreated,
    cost: aggregateCosts([a.cost, b.cost]),
    durationMs: a.durationMs + b.durationMs,
  };
}

// ── Paper Enrichment ──────────────────────────────────

/**
 * Enrich a paper page with Semantic Scholar + arXiv data.
 *
 * 1. Call Semantic Scholar to get metadata
 * 2. If arXiv paper, also call arXiv collector for abstract + categories
 * 3. Update the paper's brain page with full metadata
 * 4. Create author pages for new authors
 * 5. Create concept pages for key topics
 * 6. Add timeline entries
 * 7. Cross-link paper <-> authors, paper <-> concepts
 */
export async function enrichPaper(
  config: BrainConfig,
  llm: LLMClient,
  target: EnrichmentTarget,
): Promise<EnrichmentResult> {
  const startTime = Date.now();
  const result = emptyResult();
  const costs: IngestCost[] = [];

  // Step 1: Resolve paper via Semantic Scholar
  const query = buildSemanticScholarQuery(target);
  const ssResult = await resolvePaper(query, 500);

  if (!ssResult.ok || !ssResult.paper) {
    result.durationMs = Date.now() - startTime;
    return result;
  }

  const paper = ssResult.paper;

  // Step 2: If arXiv paper, fetch additional data
  let arxivPaper: ArxivPaper | null = null;
  if (paper.arxivId) {
    try {
      const arxivResult = await fetchArxivById(paper.arxivId, 500);
      if (arxivResult.ok && arxivResult.papers.length > 0) {
        arxivPaper = arxivResult.papers[0];
      }
    } catch {
      // arXiv fetch failed — continue with Semantic Scholar data only
    }
  }

  // Step 3: Update or create the paper's brain page
  const paperPagePath = target.brainPath ?? findOrCreatePaperPath(config, paper);
  const paperPageUpdated = updatePaperPage(config, paperPagePath, paper, arxivPaper);

  if (paperPageUpdated.created) {
    result.pagesCreated.push(paperPagePath);
  } else {
    result.pagesUpdated.push(paperPagePath);
  }
  result.timelineEntries++;

  // Step 4: Create author pages for new authors
  for (const author of paper.authors.slice(0, 5)) {
    const authorSlug = slugify(author.name);
    const authorPath = `wiki/entities/people/${authorSlug}.md`;
    const absAuthorPath = join(config.root, authorPath);

    if (!existsSync(absAuthorPath)) {
      mkdirSync(join(config.root, "wiki/entities/people"), { recursive: true });
      const authorContent = buildAuthorStub(author.name, paper);
      writeFileSync(absAuthorPath, authorContent);
      result.pagesCreated.push(authorPath);
      result.crossLinksCreated++;
    }
  }

  // Step 5: Use LLM to identify key concepts and create pages
  const conceptResponse = await llm.complete({
    system: `You are a research knowledge extraction agent. Given a paper's metadata, identify 2-3 key scientific concepts or methods that deserve their own wiki page. Output a JSON array of objects with fields: name (string), definition (one sentence).`,
    user: `Title: ${paper.title}\nAbstract: ${paper.abstract ?? "N/A"}\nVenue: ${paper.venue}\nYear: ${paper.year}`,
    model: config.extractionModel,
  });
  costs.push(conceptResponse.cost);

  const concepts = parseConcepts(conceptResponse.content);
  for (const concept of concepts) {
    const conceptSlug = slugify(concept.name);
    const conceptPath = `wiki/concepts/${conceptSlug}.md`;
    const absConceptPath = join(config.root, conceptPath);

    if (!existsSync(absConceptPath)) {
      mkdirSync(join(config.root, "wiki/concepts"), { recursive: true });
      const conceptContent = buildConceptStub(concept.name, concept.definition, paperPagePath);
      writeFileSync(absConceptPath, conceptContent);
      result.pagesCreated.push(conceptPath);
      result.crossLinksCreated++;
    }
  }

  // Step 6: Log enrichment event
  result.cost = aggregateCosts(costs);
  result.durationMs = Date.now() - startTime;

  logEvent(config, {
    ts: new Date().toISOString(),
    type: "compile",
    contentType: "paper",
    created: result.pagesCreated,
    updated: result.pagesUpdated,
    cost: result.cost,
    durationMs: result.durationMs,
  });

  return result;
}

// ── Author Enrichment ─────────────────────────────────

/**
 * Create or update an author page by searching their papers
 * on Semantic Scholar.
 */
export async function enrichAuthor(
  config: BrainConfig,
  llm: LLMClient,
  target: EnrichmentTarget,
): Promise<EnrichmentResult> {
  const startTime = Date.now();
  const result = emptyResult();
  const costs: IngestCost[] = [];

  // Search for the author's papers via title search
  const ssResult = await resolvePaper({ query: target.identifier }, 500);
  if (!ssResult.ok || !ssResult.paper) {
    result.durationMs = Date.now() - startTime;
    return result;
  }

  const paper = ssResult.paper;

  // Find the author in the paper's author list
  const authorMatch = paper.authors.find(
    (a) => a.name.toLowerCase().includes(target.identifier.toLowerCase()),
  );
  const authorName = authorMatch?.name ?? target.identifier;
  const authorSlug = slugify(authorName);
  const authorPath = target.brainPath ?? `wiki/entities/people/${authorSlug}.md`;
  const absAuthorPath = join(config.root, authorPath);

  mkdirSync(join(config.root, "wiki/entities/people"), { recursive: true });

  // Use LLM to compile author page from available data
  const compileResponse = await llm.complete({
    system: `You are a research knowledge base agent. Create a person/author page in markdown with YAML frontmatter. Include sections: ## Affiliation, ## Key Papers, ## Research Areas, ## Timeline. Use wikilinks [[paper-path]] for cross-references.`,
    user: `Author: ${authorName}\nKnown paper: "${paper.title}" (${paper.year}, ${paper.venue})\nCo-authors: ${paper.authors.map((a) => a.name).join(", ")}\nCitation count: ${paper.citationCount}`,
    model: config.extractionModel,
  });
  costs.push(compileResponse.cost);

  const dateStr = new Date().toISOString().slice(0, 10);
  const frontmatter = [
    "---",
    `date: ${dateStr}`,
    "type: note",
    "para: resources",
    `title: ${authorName}`,
    "tags: [person, author]",
    "---",
  ].join("\n");

  const content = `${frontmatter}\n\n${compileResponse.content}\n\n## Enrichment Log\n- ${dateStr}: Enriched from Semantic Scholar\n`;

  if (existsSync(absAuthorPath)) {
    // Append timeline entry to existing page
    const existing = readFileSync(absAuthorPath, "utf-8");
    const updatedContent = existing.trimEnd() + `\n- ${dateStr}: Updated from Semantic Scholar (paper: "${paper.title}")\n`;
    writeFileSync(absAuthorPath, updatedContent);
    result.pagesUpdated.push(authorPath);
  } else {
    writeFileSync(absAuthorPath, content);
    result.pagesCreated.push(authorPath);
  }

  result.timelineEntries++;
  result.cost = aggregateCosts(costs);
  result.durationMs = Date.now() - startTime;

  logEvent(config, {
    ts: new Date().toISOString(),
    type: "compile",
    contentType: "note",
    created: result.pagesCreated,
    updated: result.pagesUpdated,
    cost: result.cost,
    durationMs: result.durationMs,
  });

  return result;
}

// ── Batch Enrichment ──────────────────────────────────

/**
 * Process multiple enrichment targets respecting rate limits.
 * Resilient: if one enrichment fails, continues with the next.
 */
export async function batchEnrich(
  config: BrainConfig,
  llm: LLMClient,
  targets: EnrichmentTarget[],
): Promise<EnrichmentResult> {
  let combined = emptyResult();
  const startTime = Date.now();

  // Sort by priority: high first, then medium, then low
  const sorted = [...targets].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.priority] - order[b.priority];
  });

  for (const target of sorted) {
    try {
      let result: EnrichmentResult;

      switch (target.type) {
        case "paper":
          result = await enrichPaper(config, llm, target);
          break;
        case "author":
          result = await enrichAuthor(config, llm, target);
          break;
        case "concept":
        case "method":
          result = await enrichConcept(config, target);
          break;
        default:
          continue;
      }

      combined = mergeResults(combined, result);
    } catch (err) {
      // Log error but continue with next target
      logEvent(config, {
        ts: new Date().toISOString(),
        type: "error",
        error: `Enrichment failed for ${target.type}:${target.identifier}: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    }
  }

  combined.durationMs = Date.now() - startTime;
  return combined;
}

// ── Concept Enrichment (no LLM needed) ───────────────

async function enrichConcept(
  config: BrainConfig,
  target: EnrichmentTarget,
): Promise<EnrichmentResult> {
  const result = emptyResult();
  const startTime = Date.now();

  const conceptSlug = slugify(target.identifier);
  const conceptPath = target.brainPath ?? `wiki/concepts/${conceptSlug}.md`;
  const absPath = join(config.root, conceptPath);

  if (existsSync(absPath)) {
    result.durationMs = Date.now() - startTime;
    return result;
  }

  mkdirSync(join(config.root, "wiki/concepts"), { recursive: true });

  const content = buildConceptStub(target.identifier, "", "");
  writeFileSync(absPath, content);

  result.pagesCreated.push(conceptPath);
  result.timelineEntries++;
  result.durationMs = Date.now() - startTime;

  // Find related pages to add cross-links
  const related = await search(config, {
    query: target.identifier,
    mode: "grep",
    limit: 5,
  });

  if (related.length > 0) {
    const links = related
      .map((r) => `- [[${r.path}|${r.title}]]`)
      .join("\n");
    const existing = readFileSync(absPath, "utf-8");
    writeFileSync(
      absPath,
      existing.replace(
        "## Evidence From Our Work\n",
        `## Evidence From Our Work\n${links}\n`,
      ),
    );
    result.crossLinksCreated += related.length;
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────

function buildSemanticScholarQuery(
  target: EnrichmentTarget,
): SemanticScholarQuery {
  const id = target.identifier;

  // Check if it's a DOI
  if (id.match(/^10\.\d{4,9}\//)) {
    return { doi: id };
  }

  // Check if it's an arXiv ID
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(id)) {
    return { arxivId: id };
  }

  // Otherwise, search by title
  return { query: id };
}

function findOrCreatePaperPath(
  config: BrainConfig,
  paper: SemanticScholarPaper,
): string {
  const firstAuthor = paper.authors[0]?.name ?? "unknown";
  const lastName = firstAuthor.split(/\s+/).pop()?.toLowerCase() ?? "unknown";
  const year = paper.year ?? new Date().getFullYear();
  const words = paper.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join("-");
  const slug = `${lastName}-${year}-${words}`;
  const paperPath = `wiki/entities/papers/${slug}.md`;

  mkdirSync(join(config.root, "wiki/entities/papers"), { recursive: true });
  return paperPath;
}

function updatePaperPage(
  config: BrainConfig,
  paperPath: string,
  paper: SemanticScholarPaper,
  arxivPaper: ArxivPaper | null,
): { created: boolean } {
  const absPath = join(config.root, paperPath);
  const dateStr = new Date().toISOString().slice(0, 10);
  const created = !existsSync(absPath);

  const abstract = paper.abstract ?? arxivPaper?.abstract ?? "N/A";
  const categories = arxivPaper?.categories?.join(", ") ?? "";

  if (created) {
    // Build a new paper page
    const authorNames = paper.authors.map((a) => a.name);
    const authorLinks = paper.authors
      .slice(0, 5)
      .map((a) => `[[entities/people/${slugify(a.name)}|${a.name}]]`)
      .join(", ");

    const citations = paper.citations
      .slice(0, 5)
      .map((c) => `- ${c.title} (${c.year ?? "?"}) — ${c.authors.map((a) => a.name).join(", ")}`)
      .join("\n");

    const references = paper.references
      .slice(0, 5)
      .map((r) => `- ${r.title} (${r.year ?? "?"}) — ${r.authors.map((a) => a.name).join(", ")}`)
      .join("\n");

    const content = [
      "---",
      `date: ${dateStr}`,
      "type: paper",
      "para: resources",
      `title: "${paper.title.replace(/"/g, '\\"')}"`,
      `authors: [${authorNames.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(", ")}]`,
      `year: ${paper.year ?? new Date().getFullYear()}`,
      `venue: "${paper.venue.replace(/"/g, '\\"')}"`,
      paper.doi ? `doi: "${paper.doi}"` : null,
      paper.arxivId ? `arxiv: "${paper.arxivId}"` : null,
      `citation_count: ${paper.citationCount}`,
      `reference_count: ${paper.referenceCount}`,
      categories ? `categories: [${categories}]` : null,
      "tags: [paper, enriched]",
      "---",
      "",
      `# ${paper.title}`,
      "",
      `**Authors**: ${authorLinks}`,
      `**Year**: ${paper.year ?? "?"}`,
      `**Venue**: ${paper.venue}`,
      paper.doi ? `**DOI**: ${paper.doi}` : null,
      paper.arxivId ? `**arXiv**: ${paper.arxivId}` : null,
      `**Citations**: ${paper.citationCount} | **References**: ${paper.referenceCount}`,
      "",
      "## Abstract",
      abstract,
      "",
      "## Key Citations (cited by)",
      citations || "- No citations data available",
      "",
      "## Key References",
      references || "- No references data available",
      "",
      "## Relevance to Our Work",
      "{To be filled by researcher or dream cycle}",
      "",
      "## Timeline",
      `- ${dateStr}: Enriched from Semantic Scholar`,
    ]
      .filter((line) => line !== null)
      .join("\n");

    writeFileSync(absPath, content + "\n");
    return { created: true };
  }

  // Update existing page: add citation count, timeline entry
  const existing = readFileSync(absPath, "utf-8");
  const parsed = matter(existing);

  // Update frontmatter with new data
  let updated = false;
  if (!parsed.data.doi && paper.doi) {
    parsed.data.doi = paper.doi;
    updated = true;
  }
  if (!parsed.data.arxiv && paper.arxivId) {
    parsed.data.arxiv = paper.arxivId;
    updated = true;
  }
  if (paper.citationCount > 0) {
    parsed.data.citation_count = paper.citationCount;
    updated = true;
  }

  if (updated) {
    const rebuilt = matter.stringify(parsed.content, parsed.data);
    // Append timeline entry
    const timelineEntry = `\n- ${dateStr}: Updated from Semantic Scholar (citations: ${paper.citationCount})\n`;
    writeFileSync(absPath, rebuilt.trimEnd() + timelineEntry);
  }

  return { created: false };
}

function buildAuthorStub(
  name: string,
  paper: SemanticScholarPaper,
): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  const paperSlug = findOrCreatePaperSlug(paper);
  return [
    "---",
    `date: ${dateStr}`,
    "type: note",
    "para: resources",
    `title: "${name.replace(/"/g, '\\"')}"`,
    "tags: [person, author]",
    "---",
    "",
    `# ${name}`,
    "",
    "## Known Papers",
    `- [[entities/papers/${paperSlug}|${paper.title}]] (${paper.year ?? "?"})`,
    "",
    "## Timeline",
    `- ${dateStr}: Created during paper enrichment`,
  ].join("\n") + "\n";
}

function findOrCreatePaperSlug(paper: SemanticScholarPaper): string {
  const firstAuthor = paper.authors[0]?.name ?? "unknown";
  const lastName = firstAuthor.split(/\s+/).pop()?.toLowerCase() ?? "unknown";
  const year = paper.year ?? new Date().getFullYear();
  const words = paper.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join("-");
  return `${lastName}-${year}-${words}`;
}

function buildConceptStub(
  name: string,
  definition: string,
  paperPath: string,
): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  return [
    "---",
    `date: ${dateStr}`,
    "type: concept",
    "para: resources",
    `title: "${name.replace(/"/g, '\\"')}"`,
    "tags: [concept, auto-created]",
    "---",
    "",
    `# ${name}`,
    "",
    "## Definition",
    definition || "{Definition to be filled}",
    "",
    "## Related Concepts",
    "",
    "## Evidence From Our Work",
    paperPath ? `- [[${paperPath}]]` : "",
    "",
    "## Timeline",
    `- ${dateStr}: Created during enrichment`,
  ].join("\n") + "\n";
}

function parseConcepts(
  llmOutput: string,
): Array<{ name: string; definition: string }> {
  try {
    const jsonMatch = llmOutput.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      name?: string;
      definition?: string;
    }>;
    return parsed
      .filter((c) => c.name && typeof c.name === "string")
      .map((c) => ({
        name: c.name!,
        definition: c.definition ?? "",
      }));
  } catch {
    return [];
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/-+$/g, "");
}
