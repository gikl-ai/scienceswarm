/**
 * POST /api/brain/import-references
 *
 * Import BibTeX or RIS references into the second brain.
 * Body: {
 *   content: string,
 *   format: 'bibtex' | 'ris',
 *   options?: { enrichMatches?: boolean, skipDuplicates?: boolean }
 * }
 *
 * When skipDuplicates is true: parses, deduplicates, and imports new refs in one shot.
 * When skipDuplicates is false/omitted: returns a DeduplicationResult preview.
 */

import {
  parseBibtex,
  parseRIS,
  deduplicateReferences,
  importReferences,
} from "@/brain/bibtex-import";
import { isLocalRequest } from "@/lib/local-guard";
import { getBrainConfig, getLLMClient, isErrorResponse } from "../_shared";

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { content, format, options } = body as {
    content?: string;
    format?: string;
    options?: { enrichMatches?: boolean; skipDuplicates?: boolean };
  };

  if (!content || typeof content !== "string") {
    return Response.json(
      { error: "Missing required field: content" },
      { status: 400 }
    );
  }

  if (!format || (format !== "bibtex" && format !== "ris")) {
    return Response.json(
      { error: "Invalid format. Must be 'bibtex' or 'ris'" },
      { status: 400 }
    );
  }

  try {
    // Step 1: Parse
    const refs = format === "bibtex" ? parseBibtex(content) : parseRIS(content);

    if (refs.length === 0) {
      return Response.json(
        { error: "No valid references found in content" },
        { status: 422 }
      );
    }

    // Step 2: Deduplicate
    const dedup = await deduplicateReferences(refs, config);

    // Step 3: Import or preview
    if (options?.skipDuplicates) {
      const llm = getLLMClient(config);
      const result = await importReferences(config, llm, refs, {
        enrichMatches: options.enrichMatches,
      });
      return Response.json(result);
    }

    // Return dedup preview for user confirmation
    return Response.json(dedup);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Reference import failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
