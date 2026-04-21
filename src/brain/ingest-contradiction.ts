/**
 * Second Brain — Real-Time Contradiction Detection During Ingest
 *
 * After a page is ingested, checks the new content against:
 * 1. Active hypothesis pages — does new content support or contradict?
 * 2. Existing observation pages — do claims conflict?
 * 3. Annotated paper claims
 *
 * Uses the extraction LLM (cheap/fast) for the check.
 * Only flags contradictions where the new evidence is substantive.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { BrainConfig, Contradiction } from "./types";
import type { LLMClient } from "./llm";
import { search } from "./search";

// ── Types ─────────────────────────────────────────────

export interface IngestContradiction {
  newClaim: string;
  newSource: string;
  existingClaim: string;
  existingSource: string;
  severity: "critical" | "notable" | "minor";
  hypothesis?: string;
}

// ── Contradiction Check ───────────────────────────────

/**
 * Check newly ingested content against existing brain knowledge
 * for contradictions. Runs alongside ripple (step 7 of the pipeline).
 */
export async function checkForContradictions(
  config: BrainConfig,
  llm: LLMClient,
  newPagePath: string,
  newContent: string,
): Promise<IngestContradiction[]> {
  // Gather candidate pages to check against
  const [hypothesisPages, observationPages] = await Promise.all([
    search(config, { query: "hypothesis", mode: "grep", limit: 15 }),
    search(config, { query: "observation", mode: "grep", limit: 10 }),
  ]);

  // Filter to only active hypotheses
  const activeHypotheses = hypothesisPages.filter((p) => {
    if (p.path === newPagePath) return false;
    try {
      const content = readFileSync(join(config.root, p.path), "utf-8");
      return (
        content.includes("status: active") ||
        content.includes("status: supported")
      );
    } catch {
      return false;
    }
  });

  // Filter out the new page itself from observations
  const existingObservations = observationPages.filter(
    (p) => p.path !== newPagePath,
  );

  const candidateCount =
    activeHypotheses.length + existingObservations.length;
  if (candidateCount === 0) {
    return [];
  }

  // Build context for the LLM
  const contextParts: string[] = [];

  for (const h of activeHypotheses) {
    try {
      const content = readFileSync(join(config.root, h.path), "utf-8");
      contextParts.push(`--- HYPOTHESIS: ${h.path} ---\n${content}\n`);
    } catch {
      // Skip unreadable pages
    }
  }

  for (const o of existingObservations.slice(0, 10)) {
    try {
      const content = readFileSync(join(config.root, o.path), "utf-8");
      contextParts.push(`--- OBSERVATION: ${o.path} ---\n${content}\n`);
    } catch {
      // Skip unreadable pages
    }
  }

  if (contextParts.length === 0) {
    return [];
  }

  const response = await llm.complete({
    system: CONTRADICTION_CHECK_PROMPT,
    user: `NEW CONTENT (${newPagePath}):\n${newContent}\n\nEXISTING KNOWLEDGE:\n${contextParts.join("\n")}`,
    model: config.extractionModel,
  });

  return parseContradictionResponse(response.content, newPagePath);
}

/**
 * Convert IngestContradiction[] to the standard Contradiction[] format
 * used by IngestResult.
 */
export function toStandardContradictions(
  ingestContradictions: IngestContradiction[],
): Contradiction[] {
  return ingestContradictions.map((ic) => ({
    claim: `${ic.newClaim} vs. ${ic.existingClaim}`,
    existingPage: ic.existingSource,
    newSource: ic.newSource,
  }));
}

// ── Response Parsing ──────────────────────────────────

function parseContradictionResponse(
  response: string,
  newPagePath: string,
): IngestContradiction[] {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as {
      contradictions?: Array<{
        new_claim?: string;
        existing_claim?: string;
        existing_source?: string;
        severity?: string;
        hypothesis?: string;
      }>;
    };

    if (!parsed.contradictions || !Array.isArray(parsed.contradictions)) {
      return [];
    }

    return parsed.contradictions
      .filter(
        (c) =>
          c.new_claim &&
          c.existing_claim &&
          c.existing_source &&
          c.new_claim.length > 0 &&
          c.existing_claim.length > 0,
      )
      .map((c) => ({
        newClaim: c.new_claim!,
        newSource: newPagePath,
        existingClaim: c.existing_claim!,
        existingSource: c.existing_source!,
        severity: validateSeverity(c.severity) ?? "notable",
        hypothesis: sanitizePath(c.hypothesis),
      }));
  } catch {
    return [];
  }
}

/**
 * Sanitize an LLM-provided path to prevent path traversal.
 * Only allow relative wiki/ paths without ".." segments.
 */
function sanitizePath(p?: string): string | undefined {
  if (!p) return undefined;
  // Reject absolute paths and traversal attempts
  if (p.startsWith("/") || p.includes("..")) return undefined;
  // Must be within wiki/ directory
  if (!p.startsWith("wiki/")) return undefined;
  // Strip any null bytes or control characters
  const clean = p.replace(/[\x00-\x1f]/g, "");
  return clean || undefined;
}

function validateSeverity(
  s?: string,
): "critical" | "notable" | "minor" | undefined {
  if (s === "critical" || s === "notable" || s === "minor") return s;
  return undefined;
}

// ── Prompts ───────────────────────────────────────────

const CONTRADICTION_CHECK_PROMPT = `You are a real-time contradiction detector for a research knowledge base. You are given NEW CONTENT that was just ingested and EXISTING KNOWLEDGE from the brain.

Analyze whether the new content contradicts any existing hypotheses or observations.

Rules:
- Only flag genuine contradictions where the new evidence is substantive
- Do not flag differences in phrasing or emphasis as contradictions
- Do not flag missing information as a contradiction
- Severity: "critical" = directly refutes an active hypothesis, "notable" = conflicts with existing observations, "minor" = slight tension worth noting

Output valid JSON:
{
  "contradictions": [
    {
      "new_claim": "What the new content claims",
      "existing_claim": "What the existing page claims",
      "existing_source": "wiki/path/to/existing-page.md",
      "severity": "critical" | "notable" | "minor",
      "hypothesis": "wiki/path/to/hypothesis.md (if applicable, otherwise omit)"
    }
  ]
}

If no contradictions are found, output: { "contradictions": [] }`;
