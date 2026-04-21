/**
 * POST /api/brain/link
 *
 * Shared-token write path for the ScienceSwarm sandbox. Creates a typed
 * link between two gbrain slugs. This is the HTTP replacement for
 * `gbrain link <from> <to> --link_type <rel>` that the sandbox wrapper
 * at `sandbox/bin/gbrain` calls back into.
 *
 * Request body: JSON `{ from, to, relation, context? }`
 *   - `from`, `to`     gbrain slugs (non-empty strings)
 *   - `relation`       one of the audit-revise relations or compiled-memex
 *                      relations (`cites`, `supports`, `contradicts`,
 *                      `tests`, `replicates`)
 *   - `context`        optional free-text note; not validated
 *
 * Auth: `x-scienceswarm-sandbox-token`. See `src/lib/sandbox-auth.ts`.
 */

import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { ensureBrainStoreReady } from "@/brain/store";
import { requireSandboxToken } from "@/lib/sandbox-auth";
// Decision 3A presence-only lint gate.
import { getCurrentUserHandle as _requireAttributionImport } from "@/lib/setup/gbrain-installer";
void _requireAttributionImport;

const ALLOWED_LINK_RELATIONS = [
  "audited_by",
  "addresses",
  "revises",
  "cover_letter_for",
  "cites",
  "supports",
  "contradicts",
  "tests",
  "replicates",
] as const;

type BrainLinkRelation = (typeof ALLOWED_LINK_RELATIONS)[number];

const ALLOWED_LINK_RELATION_SET = new Set<string>(ALLOWED_LINK_RELATIONS);

export async function POST(request: Request): Promise<Response> {
  const authError = requireSandboxToken(request);
  if (authError) return authError;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = parseLinkPayload(payload);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    await ensureBrainStoreReady();
    const client = createInProcessGbrainClient();
    await client.linkPages(parsed.from, parsed.to, {
      linkType: parsed.relation,
      context: parsed.context,
    });
    return Response.json({
      from: parsed.from,
      to: parsed.to,
      relation: parsed.relation,
      status: "linked",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "brain link write failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

interface ParsedLinkPayload {
  from: string;
  to: string;
  relation: BrainLinkRelation;
  context?: string;
}

function parseLinkPayload(
  raw: unknown,
): ParsedLinkPayload | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const from = body.from;
  const to = body.to;
  const relation = body.relation;
  const context = body.context;

  if (typeof from !== "string" || from.trim().length === 0) {
    return { error: "Missing required field: from (non-empty string)" };
  }
  if (typeof to !== "string" || to.trim().length === 0) {
    return { error: "Missing required field: to (non-empty string)" };
  }
  if (typeof relation !== "string" || relation.length === 0) {
    return {
      error: "Missing required field: relation (non-empty string)",
    };
  }
  if (!ALLOWED_LINK_RELATION_SET.has(relation)) {
    return {
      error: `Invalid relation '${relation}'. Allowed: ${ALLOWED_LINK_RELATIONS.join(", ")}.`,
    };
  }
  if (context !== undefined && typeof context !== "string") {
    return { error: "Field 'context' must be a string when provided" };
  }

  return {
    from: from.trim(),
    to: to.trim(),
    relation: relation as BrainLinkRelation,
    context: typeof context === "string" ? context : undefined,
  };
}
