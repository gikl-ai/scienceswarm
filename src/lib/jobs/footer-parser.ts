/**
 * Fenced-JSON footer parser.
 *
 * Every audit-revise job-kind prompt instructs the model inside the
 * OpenHands sandbox to end its final message with a code fence of the
 * shape:
 *
 *     ```json
 *     {"slugs": ["hubble-1929-revision"], "files": ["sha256:..."]}
 *     ```
 *
 * `run_job` extracts that block out of the final
 * `MessageAction.content` the OpenHands event stream returns. Parsing
 * lives in its own module so tests can exercise it without any
 * OpenHands plumbing and so consumers can tolerate slightly malformed
 * output (e.g. backticks inside a string, multiple fences) without
 * unrooting the whole parse.
 */

export interface JobFooter {
  slugs: string[];
  files: string[];
  warnings: string[];
}

const FENCE_RE = /```json\s*\n([\s\S]*?)\n```/g;

/**
 * Extract the LAST fenced JSON footer from a content string. Audit-
 * revise prompts tell the model to end with the footer, and the
 * OpenHands event stream may contain earlier debugging fences too; the
 * last fence is the authoritative answer.
 */
export function parseJobFooter(content: string | null | undefined): JobFooter {
  const warnings: string[] = [];
  if (!content || typeof content !== "string") {
    warnings.push("missing content");
    return { slugs: [], files: [], warnings };
  }
  const matches = Array.from(content.matchAll(FENCE_RE));
  if (matches.length === 0) {
    warnings.push("no fenced JSON footer found in final message");
    return { slugs: [], files: [], warnings };
  }
  const last = matches[matches.length - 1]?.[1] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch (error) {
    warnings.push(
      `failed to parse JSON footer: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { slugs: [], files: [], warnings };
  }
  if (!parsed || typeof parsed !== "object") {
    warnings.push("parsed footer is not an object");
    return { slugs: [], files: [], warnings };
  }
  const record = parsed as Record<string, unknown>;
  const slugs = Array.isArray(record.slugs)
    ? record.slugs.filter((v): v is string => typeof v === "string")
    : [];
  const files = Array.isArray(record.files)
    ? record.files.filter((v): v is string => typeof v === "string")
    : [];
  if (matches.length > 1) {
    warnings.push(
      `${matches.length} fenced blocks in final message; using the last one`,
    );
  }
  if (slugs.length === 0 && files.length === 0) {
    warnings.push("footer had no slugs or files");
  }
  return { slugs, files, warnings };
}
