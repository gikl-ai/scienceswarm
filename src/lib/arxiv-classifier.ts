/**
 * arXiv Paper Classifier
 *
 * Thin wrapper around the LLM call described in `recipes/arxiv-to-brain.md`
 * (Step 3 — Enrich). Given a tracked-concept context plus a paper's title and
 * abstract, the classifier decides whether the paper is clearly relevant
 * (`"papers"`) or uncertain (`"inbox"`).
 *
 * The function exists as its own module for two reasons:
 *   1. The reasoning engine's classification quality is the scientist's
 *      differentiator — it needs an eval harness, and that harness needs a
 *      single, stable call site (see `tests/evals/arxiv-classification/`).
 *   2. The LLM client is injected, so the eval runs deterministically with a
 *      stub classifier and never depends on a live `OPENAI_API_KEY`.
 *
 * Contract (from `recipes/arxiv-to-brain.md`):
 *   Given (concept context, paper title, paper abstract), return
 *   `{"bucket": "papers"|"inbox", "reason": "<1 sentence>"}`.
 *
 * Fallback rule (Iron Law): on any LLM error, timeout, parse failure, or
 * schema violation, default to `inbox/` and surface `classification_error`
 * so the paper is still ingested. Never silently drop a paper.
 */

import type { LLMCall, LLMClient, LLMResponse } from "../brain/llm";

export type ArxivBucket = "papers" | "inbox";

/**
 * Shape of one row in the ground-truth dataset at
 * `tests/evals/arxiv-classification/ground-truth.jsonl`. Exported so the
 * vitest runner and the standalone CLI runner share one definition.
 */
export interface GroundTruthRow {
  arxiv_id: string;
  title: string;
  abstract: string;
  expected_bucket: ArxivBucket;
  expected_concepts: string[];
  reasoning: string;
}

export interface ArxivClassificationInput {
  /** Paper title (already whitespace-collapsed). */
  title: string;
  /** Paper abstract (already whitespace-collapsed). */
  abstract: string;
  /**
   * Concepts the user is tracking. Used both as prompt context and as the
   * search-space for entity matching. An empty array is valid — it just
   * means the classifier has no relevance context and will lean `"inbox"`.
   */
  tracked_concepts?: string[];
  /**
   * Optional free-form concept context text (Compiled-Truth summary, one
   * paragraph per concept). If present it replaces `tracked_concepts` in the
   * prompt. Used by the production recipe path.
   */
  concept_context?: string;
}

export interface ArxivClassificationResult {
  bucket: ArxivBucket;
  reason: string;
  /**
   * Populated when the classifier hit its fallback path (LLM error, parse
   * failure, empty input). Callers write this to the paper page frontmatter
   * so misclassifications are auditable.
   */
  classification_error?: string;
}

export interface ClassifyOptions {
  /** LLM client — inject a stub for tests. Required. */
  llm: LLMClient;
  /** Override the model. Defaults to whatever the llm client picks. */
  model?: string;
}

const SYSTEM_PROMPT = `You are a research-paper triage classifier for a working scientist's second brain.

You decide whether a new arXiv paper is clearly relevant to the user's tracked concepts (bucket "papers") or uncertain / tangential / off-topic (bucket "inbox"). Uncertain goes to inbox so the human can decide.

Rules:
- Prefer "papers" only when the title or abstract directly advances one of the tracked concepts.
- Prefer "inbox" for surveys, opinion pieces, tangential work, or anything outside the user's tracked concepts.
- Prefer "inbox" when the title or abstract is empty, malformed, or in an unsupported language.
- Return strict JSON: {"bucket": "papers"|"inbox", "reason": "<one sentence>"}.
- No markdown, no preamble, no trailing prose.`;

/**
 * Build the LLM user message. Exported for the eval harness so the prompt
 * shape is locked down and can be unit-tested without a live LLM.
 */
export function buildClassificationPrompt(
  input: ArxivClassificationInput,
): string {
  const contextBlock =
    input.concept_context && input.concept_context.trim()
      ? input.concept_context.trim()
      : (input.tracked_concepts ?? []).filter(Boolean).join(", ") ||
        "(none provided)";

  const title = (input.title ?? "").trim() || "(empty)";
  const abstract = (input.abstract ?? "").trim() || "(empty)";

  return [
    `Tracked concepts: ${contextBlock}`,
    `Paper title: ${title}`,
    `Paper abstract: ${abstract}`,
    "",
    'Respond with JSON only: {"bucket": "papers"|"inbox", "reason": "<one sentence>"}.',
  ].join("\n");
}

/**
 * Parse an LLM response into a classification result. Exported for the eval
 * harness so parsing can be tested independently of the LLM call.
 */
export function parseClassificationResponse(
  raw: string,
): ArxivClassificationResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return {
      bucket: "inbox",
      reason: "Empty LLM response; defaulting to inbox.",
      classification_error: "empty_response",
    };
  }

  // Strip markdown code fences if the model leaked them.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to salvage a JSON object from a noisier response.
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      return {
        bucket: "inbox",
        reason: "LLM response was not JSON; defaulting to inbox.",
        classification_error: "not_json",
      };
    }
    try {
      parsed = JSON.parse(objMatch[0]);
    } catch {
      return {
        bucket: "inbox",
        reason: "LLM response was not JSON; defaulting to inbox.",
        classification_error: "not_json",
      };
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      bucket: "inbox",
      reason: "LLM response was not an object; defaulting to inbox.",
      classification_error: "not_object",
    };
  }

  const bucketRaw = (parsed as { bucket?: unknown }).bucket;
  const reasonRaw = (parsed as { reason?: unknown }).reason;

  const bucket: ArxivBucket =
    bucketRaw === "papers" ? "papers" : bucketRaw === "inbox" ? "inbox" : "inbox";
  const schemaViolation = bucketRaw !== "papers" && bucketRaw !== "inbox";

  const reason =
    typeof reasonRaw === "string" && reasonRaw.trim()
      ? reasonRaw.trim()
      : schemaViolation
        ? "Missing or invalid bucket; defaulted to inbox."
        : "";

  const result: ArxivClassificationResult = { bucket, reason };
  if (schemaViolation) {
    result.classification_error = "schema_violation";
  }
  return result;
}

/**
 * Classify an arXiv paper into `papers/` or `inbox/`.
 *
 * Input sanitization, adversarial handling, and the default-to-inbox
 * fallback are deliberate: per `recipes/arxiv-to-brain.md`, a misbehaving
 * LLM must never drop a paper — inbox is the safe bucket.
 */
export async function classifyArxivPaper(
  input: ArxivClassificationInput,
  opts: ClassifyOptions,
): Promise<ArxivClassificationResult> {
  // Adversarial short-circuit: empty title AND empty abstract is unsalvageable.
  // Skip the LLM entirely — deterministic, free, and correct.
  const emptyTitle = !(input.title ?? "").trim();
  const emptyAbstract = !(input.abstract ?? "").trim();
  if (emptyTitle && emptyAbstract) {
    return {
      bucket: "inbox",
      reason: "Empty title and abstract; cannot classify.",
      classification_error: "empty_input",
    };
  }

  const call: LLMCall = {
    system: SYSTEM_PROMPT,
    user: buildClassificationPrompt(input),
    model: opts.model,
    maxTokens: 200,
  };

  let response: LLMResponse;
  try {
    response = await opts.llm.complete(call);
  } catch (err) {
    return {
      bucket: "inbox",
      reason: "LLM call failed; defaulting to inbox.",
      classification_error:
        err instanceof Error ? `llm_error:${err.message}` : "llm_error",
    };
  }

  return parseClassificationResponse(response.content);
}
