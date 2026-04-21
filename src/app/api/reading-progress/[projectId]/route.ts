import { resolveBrainRoot } from "@/brain/config";
import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import { isLocalRequest } from "@/lib/local-guard";
import { assertSafeProjectSlug, InvalidSlugError } from "@/lib/state/project-manifests";
import { getProjectStateRootForBrainRoot, isProjectLocalStateRoot } from "@/lib/state/project-storage";
import {
  deleteReadingEntry,
  loadReadingProgress,
  upsertReadingEntry,
  type ReadingStatus,
} from "@/lib/reading-progress";

interface RouteContext {
  params: Promise<{ projectId: string }>;
}

const VALID_STATUSES: readonly ReadingStatus[] = ["unread", "reading", "done"];

function isValidStatus(value: unknown): value is ReadingStatus {
  return typeof value === "string" && (VALID_STATUSES as readonly string[]).includes(value);
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

function handleSlugError(error: unknown): Response | null {
  if (error instanceof InvalidSlugError) {
    return badRequest("Invalid project slug");
  }
  return null;
}

function hasEntries(store: { entries: Record<string, unknown> }): boolean {
  return Object.keys(store.entries).length > 0;
}

async function resolveReadingProgressStateRoot(slug: string): Promise<string> {
  const brainRoot = resolveBrainRoot() ?? getScienceSwarmBrainRoot();
  const preferredStateRoot = getProjectStateRootForBrainRoot(slug, brainRoot);
  const preferredStore = await loadReadingProgress(preferredStateRoot, slug);

  if (!isProjectLocalStateRoot(slug, preferredStateRoot)) {
    return preferredStateRoot;
  }

  if (hasEntries(preferredStore)) {
    return preferredStateRoot;
  }

  const legacyStateRoot = `${brainRoot}/state`;
  const legacyStore = await loadReadingProgress(legacyStateRoot, slug);
  if (hasEntries(legacyStore)) {
    return legacyStateRoot;
  }

  return preferredStateRoot;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { projectId } = await context.params;

  let slug: string;
  try {
    slug = assertSafeProjectSlug(projectId);
  } catch (error) {
    const mapped = handleSlugError(error);
    if (mapped) return mapped;
    throw error;
  }

  const stateRoot = await resolveReadingProgressStateRoot(slug);
  const store = await loadReadingProgress(stateRoot, slug);
  return Response.json(store);
}

interface PostBody {
  action?: unknown;
  paperId?: unknown;
  status?: unknown;
  notes?: unknown;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { projectId } = await context.params;

  let slug: string;
  try {
    slug = assertSafeProjectSlug(projectId);
  } catch (error) {
    const mapped = handleSlugError(error);
    if (mapped) return mapped;
    throw error;
  }

  let body: PostBody;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return badRequest("Invalid JSON body");
    }
    body = parsed as PostBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  const action = body.action;
  const stateRoot = await resolveReadingProgressStateRoot(slug);

  if (action === "upsert") {
    if (typeof body.paperId !== "string" || body.paperId.trim() === "") {
      return badRequest("Missing or invalid paperId");
    }
    if (!isValidStatus(body.status)) {
      return badRequest(`Invalid status: ${String(body.status)}`);
    }
    const notes = typeof body.notes === "string" ? body.notes : undefined;
    const entry = await upsertReadingEntry(stateRoot, slug, {
      paperId: body.paperId,
      status: body.status,
      ...(notes !== undefined ? { notes } : {}),
    });
    return Response.json({ entry });
  }

  if (action === "delete") {
    if (typeof body.paperId !== "string" || body.paperId.trim() === "") {
      return badRequest("Missing or invalid paperId");
    }
    const deleted = await deleteReadingEntry(stateRoot, slug, body.paperId);
    return Response.json({ deleted });
  }

  return badRequest("Unknown or missing action");
}
