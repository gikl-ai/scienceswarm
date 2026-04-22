/**
 * Second Brain — Contradiction Detection Engine
 *
 * Finds contradictions and tensions across the brain by comparing
 * observations vs hypotheses, paper claims vs project assumptions,
 * and conflicting timeline entries across entity pages.
 */

import { createHash } from "node:crypto";
import { search } from "./search";
import type { BrainConfig, ContradictionReport } from "./types";
import type { LLMClient } from "./llm";

export interface ContradictionScanScope {
  project?: string;
  since?: string;
}

/**
 * Scan the brain for contradictions and tensions.
 *
 * Uses the extraction model (cheaper) for scanning, and the synthesis
 * model (stronger) only for the final structured report.
 */
export async function scanForContradictions(
  config: BrainConfig,
  llm: LLMClient,
  scope?: ContradictionScanScope,
): Promise<ContradictionReport> {
  // Gather candidate pages in parallel.
  // Use single-word queries for grep mode — multi-word queries require
  // all words on the same line which misses frontmatter-only matches.
  const [hypothesisPages, observationPages, paperPages] = await Promise.all([
    search(config, {
      query: "hypothesis",
      mode: "grep",
      limit: 20,
      profile: "synthesis",
    }),
    search(config, {
      query: "observation",
      mode: "grep",
      limit: 20,
      profile: "synthesis",
    }),
    search(config, {
      query: "paper",
      mode: "grep",
      limit: 15,
      profile: "synthesis",
    }),
  ]);

  const scannedPages =
    hypothesisPages.length + observationPages.length + paperPages.length;

  if (scannedPages === 0) {
    return { contradictions: [], tensions: [], scannedPages: 0 };
  }

  // Build context from all gathered pages for the LLM
  const contextParts: string[] = [];

  if (hypothesisPages.length > 0) {
    contextParts.push(
      "## Hypotheses",
      ...hypothesisPages.map(
        (p) => `- [${p.path}] ${p.title}: ${p.snippet}`,
      ),
    );
  }

  if (observationPages.length > 0) {
    contextParts.push(
      "## Observations",
      ...observationPages.map(
        (p) => `- [${p.path}] ${p.title}: ${p.snippet}`,
      ),
    );
  }

  if (paperPages.length > 0) {
    contextParts.push(
      "## Papers",
      ...paperPages.map((p) => `- [${p.path}] ${p.title}: ${p.snippet}`),
    );
  }

  const sinceClause = scope?.since
    ? `Focus on content from ${scope.since} onward.`
    : "";

  const projectClause = scope?.project
    ? `Focus on contradictions relevant to the "${scope.project}" project.`
    : "";

  // Use extraction model for scanning — cheaper
  const response = await llm.complete({
    system: CONTRADICTION_SCAN_PROMPT,
    user: `${projectClause}\n${sinceClause}\n\n${contextParts.join("\n")}`,
    model: config.extractionModel,
  });

  return parseContradictionReport(response.content, scannedPages);
}

function parseContradictionReport(
  content: string,
  scannedPages: number,
): ContradictionReport {
  // Try to parse as JSON first
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<ContradictionReport>;
      return {
        contradictions: (parsed.contradictions ?? []).map((c, i) => ({
          id: c.id ?? generateId(c.claim1?.text ?? "", c.claim2?.text ?? "", i),
          severity: c.severity ?? "notable",
          claim1: {
            text: c.claim1?.text ?? "",
            source: c.claim1?.source ?? "",
            date: c.claim1?.date ?? "",
          },
          claim2: {
            text: c.claim2?.text ?? "",
            source: c.claim2?.source ?? "",
            date: c.claim2?.date ?? "",
          },
          implication: c.implication ?? "",
          suggestedResolution: c.suggestedResolution ?? "",
        })),
        tensions: (parsed.tensions ?? []).map((t) => ({
          description: t.description ?? "",
          sources: t.sources ?? [],
          resolution: t.resolution ?? "",
        })),
        scannedPages,
      };
    }
  } catch {
    // Fall through to empty report
  }

  return { contradictions: [], tensions: [], scannedPages };
}

function generateId(claim1: string, claim2: string, index: number): string {
  const hash = createHash("sha256")
    .update(`${claim1}|${claim2}|${index}`)
    .digest("hex");
  return `contradiction-${hash.slice(0, 12)}`;
}

const CONTRADICTION_SCAN_PROMPT = `You are a scientific contradiction detector for a research knowledge base.

Analyze the provided brain content and identify:

1. CONTRADICTIONS: Direct conflicts between claims in different pages
   - Observation vs hypothesis (observation data contradicts a hypothesis)
   - Paper claims vs project assumptions
   - Conflicting timeline entries across entity pages

2. TENSIONS: Indirect conflicts or unresolved tensions
   - Two approaches that cannot both be optimal
   - Evidence that weakens a key assumption without directly refuting it

Output valid JSON with this structure:
{
  "contradictions": [
    {
      "id": "unique-id",
      "severity": "critical" | "notable" | "minor",
      "claim1": { "text": "...", "source": "wiki/path/to/page.md", "date": "YYYY-MM-DD" },
      "claim2": { "text": "...", "source": "wiki/path/to/page.md", "date": "YYYY-MM-DD" },
      "implication": "What this means for the scientist's work",
      "suggestedResolution": "How to resolve this contradiction"
    }
  ],
  "tensions": [
    {
      "description": "...",
      "sources": ["wiki/path1.md", "wiki/path2.md"],
      "resolution": "Suggested path forward"
    }
  ]
}

Rules:
- Only report genuine contradictions backed by evidence from the provided content.
- Do not fabricate contradictions — if none exist, return empty arrays.
- Severity: "critical" = blocks current work, "notable" = should investigate, "minor" = worth noting.
- Be specific about which pages and claims are in conflict.`;
