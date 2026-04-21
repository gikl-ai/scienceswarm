import path from "node:path";
import { computeDailyDigest } from "@/lib/daily-digest";
import { getScienceSwarmProjectsRoot } from "@/lib/scienceswarm-paths";
import { assertSafeProjectSlug, InvalidSlugError } from "@/lib/state/project-manifests";

// ---------------------------------------------------------------------------
// GET /api/digest/[projectId]?hours=24
//
// Returns a per-project daily activity digest. Clamps the window to
// [1, 168] hours (1 hour to 7 days). Invalid slugs → 400. Unknown/missing
// projects → 200 with an empty digest instead of 404 so clients can poll
// uniformly for any slug.
// ---------------------------------------------------------------------------

const DEFAULT_HOURS = 24;
const MIN_HOURS = 1;
const MAX_HOURS = 168;

function parseHours(raw: string | null): number {
  if (raw == null) return DEFAULT_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_HOURS;
  // Clamp to [MIN_HOURS, MAX_HOURS]. Sub-hour windows are disallowed so the
  // contract is stable and cheap to reason about.
  const rounded = Math.floor(parsed);
  if (rounded < MIN_HOURS) return MIN_HOURS;
  if (rounded > MAX_HOURS) return MAX_HOURS;
  return rounded;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const { projectId } = await context.params;
    const slug = assertSafeProjectSlug(projectId);

    const { searchParams } = new URL(request.url);
    const hours = parseHours(searchParams.get("hours"));

    const projectRoot = path.join(getScienceSwarmProjectsRoot(), slug);
    const digest = await computeDailyDigest(projectRoot, { windowHours: hours });

    return Response.json(digest);
  } catch (err) {
    // InvalidSlugError is client input (path traversal, uppercase, etc.),
    // not a server fault — surface it as 400.
    if (err instanceof InvalidSlugError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error("GET /api/digest/[projectId] failed", err);
    return Response.json({ error: "Digest error" }, { status: 500 });
  }
}
