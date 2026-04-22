import {
  deriveCritiqueParentSlug,
  buildStructuredCritiquePageMarkdown,
  isValidCritiqueSlug,
} from "@/lib/structured-critique-gbrain";
import { normalizeStructuredCritiqueJobPayload } from "@/lib/structured-critique-schema";
import type { StructuredCritiqueJob } from "@/lib/structured-critique-schema";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";
import type { BrainPage } from "@/brain/store";
import { isLocalRequest } from "@/lib/local-guard";
import { ensureProjectShellForProjectSlug } from "@/lib/projects/ensure-project-shell";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

type PersistCritiqueRequest = {
  job?: unknown;
  parentSlug?: unknown;
  projectSlug?: unknown;
  sourceFilename?: unknown;
};

type PersistedCritiqueSummary = {
  brain_slug: string;
  parent_slug?: string;
  project_slug?: string;
  title: string;
  uploaded_at?: string;
  source_filename?: string;
  descartes_job_id?: string;
  finding_count?: number;
  url: string;
  project_url?: string;
};

const critiquePersistLocks = new Map<string, Promise<void>>();

export async function GET(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));

  try {
    await ensureBrainStoreReady();
    const pages = await getBrainStore().listPages({ limit: 5000 });
    const audits = pages
      .flatMap((page): PersistedCritiqueSummary[] => {
        const summary = pageToPersistedCritiqueSummary(page);
        return summary ? [summary] : [];
      })
      .sort(comparePersistedCritiques)
      .slice(0, limit);

    return Response.json({ audits });
  } catch {
    return Response.json(
      { error: "Failed to list critique pages" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: PersistCritiqueRequest;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Request body must be a JSON object" }, { status: 400 });
    }
    body = parsed as PersistCritiqueRequest;
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  let job: StructuredCritiqueJob;
  try {
    job = normalizeStructuredCritiqueJobPayload(body.job);
  } catch {
    return Response.json({ error: "job must be a valid structured critique job" }, { status: 400 });
  }

  if (job.status !== "COMPLETED" || !job.result) {
    return Response.json(
      { error: "Only completed structured critique jobs can be saved to gbrain" },
      { status: 400 },
    );
  }

  const sourceFilename =
    typeof body.sourceFilename === "string" && body.sourceFilename.trim().length > 0
      ? body.sourceFilename.trim()
      : typeof job.pdf_filename === "string" && job.pdf_filename.trim().length > 0
        ? job.pdf_filename.trim()
        : undefined;

  if (sourceFilename && /[/\\]/.test(sourceFilename)) {
    return Response.json(
      { error: "sourceFilename must not contain path separators" },
      { status: 400 },
    );
  }

  const parentSlug =
    typeof body.parentSlug === "string" && body.parentSlug.trim().length > 0
      ? body.parentSlug.trim()
      : deriveCritiqueParentSlug(job, sourceFilename);

  if (!isValidCritiqueSlug(parentSlug)) {
    return Response.json(
      { error: "parentSlug must be a safe audit-revise slug" },
      { status: 400 },
    );
  }

  const explicitProjectSlug =
    typeof body.projectSlug === "string" && body.projectSlug.trim().length > 0
      ? body.projectSlug.trim()
      : undefined;
  if (explicitProjectSlug && !isValidCritiqueSlug(explicitProjectSlug)) {
    return Response.json(
      { error: "projectSlug must be a safe audit-revise slug" },
      { status: 400 },
    );
  }

  try {
    await ensureBrainStoreReady();
    const store = getBrainStore();
    const gbrain = createInProcessGbrainClient();
    const parentPage = await store.getPage(parentSlug);
    const parentFrontmatter = (parentPage?.frontmatter ?? {}) as Record<string, unknown>;
    const parentType =
      typeof parentFrontmatter.type === "string"
        ? parentFrontmatter.type
        : parentPage?.type;
    const parentProject =
      explicitProjectSlug ||
      (
        typeof parentFrontmatter.project === "string" &&
        isValidCritiqueSlug(parentFrontmatter.project)
          ? parentFrontmatter.project
          : parentSlug
      );

    const persisted = await withCritiquePersistenceLock(parentSlug, async () => {
      const critiqueSlug = await allocateCritiqueSlug(parentSlug, job.id);
      const built = buildStructuredCritiquePageMarkdown({
        job,
        parentSlug,
        projectSlug: parentProject,
        sourceFilename,
        uploadedAt: new Date(),
        uploadedBy: getCurrentUserHandle(),
      });

      await gbrain.putPage(critiqueSlug, built.markdown);

      let linkedParent = false;
      if (parentPage && parentType === "paper") {
        await gbrain.linkPages(parentSlug, critiqueSlug, { linkType: "audited_by" });
        linkedParent = true;
      }

      return { critiqueSlug, built, linkedParent };
    });

    await ensureProjectShellForProjectSlug({
      projectSlug: parentProject,
      sourceFilename,
    }).catch((error) => {
      console.warn("Failed to ensure project shell for critique", {
        projectSlug: parentProject,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    return Response.json({
      brain_slug: persisted.critiqueSlug,
      parent_slug: parentSlug,
      project_slug: parentProject,
      linked_parent: persisted.linkedParent,
      url: `/dashboard/reasoning?brain_slug=${encodeURIComponent(persisted.critiqueSlug)}`,
      project_url: `/dashboard/project?name=${encodeURIComponent(parentProject)}&brain_slug=${encodeURIComponent(persisted.critiqueSlug)}`,
      brief: persisted.built.brief,
      severity_counts: persisted.built.severityCounts,
      finding_count: persisted.built.findingCount,
    });
  } catch {
    return Response.json(
      { error: "Failed to save critique to gbrain" },
      { status: 500 },
    );
  }
}

function parseLimit(raw: string | null): number {
  if (!raw) return 50;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(100, Math.max(1, parsed));
}

function pageToPersistedCritiqueSummary(
  page: BrainPage,
): PersistedCritiqueSummary | null {
  const frontmatter = page.frontmatter ?? {};
  if (frontmatter.type !== "critique") return null;

  const slug = normalizePageSlug(page.path);
  if (!slug) return null;

  const parentSlug = readSafeSlug(frontmatter.parent);
  const projectSlug = readSafeSlug(frontmatter.project);
  const title =
    readNonEmptyString(frontmatter.title) ||
    page.title ||
    readNonEmptyString(frontmatter.source_filename) ||
    slug;
  const uploadedAt = readNonEmptyString(frontmatter.uploaded_at);
  const sourceFilename = readNonEmptyString(frontmatter.source_filename);
  const descartesJobId = readNonEmptyString(frontmatter.descartes_job_id);
  const findingCount = readFiniteNumber(frontmatter.finding_count);
  const encodedSlug = encodeURIComponent(slug);

  return {
    brain_slug: slug,
    parent_slug: parentSlug,
    project_slug: projectSlug,
    title,
    uploaded_at: uploadedAt,
    source_filename: sourceFilename,
    descartes_job_id: descartesJobId,
    finding_count: findingCount,
    url: `/dashboard/reasoning?brain_slug=${encodedSlug}`,
    project_url: projectSlug
      ? `/dashboard/project?name=${encodeURIComponent(projectSlug)}&brain_slug=${encodedSlug}`
      : undefined,
  };
}

function normalizePageSlug(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, "");
  return trimmed.endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readSafeSlug(value: unknown): string | undefined {
  const slug = readNonEmptyString(value);
  return slug && isValidCritiqueSlug(slug) ? slug : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function comparePersistedCritiques(
  left: PersistedCritiqueSummary,
  right: PersistedCritiqueSummary,
): number {
  const leftParsed = left.uploaded_at ? Date.parse(left.uploaded_at) : 0;
  const rightParsed = right.uploaded_at ? Date.parse(right.uploaded_at) : 0;
  const leftTime = Number.isFinite(leftParsed) ? leftParsed : 0;
  const rightTime = Number.isFinite(rightParsed) ? rightParsed : 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return right.brain_slug.localeCompare(left.brain_slug);
}

async function allocateCritiqueSlug(
  parentSlug: string,
  jobId: string,
): Promise<string> {
  const store = getBrainStore();
  const base = `${parentSlug}-critique`;
  for (let index = 0; index < 100; index += 1) {
    // Desktop-style numbering: the first save is unsuffixed, then -2, -3, ...
    const candidate = index === 0 ? base : `${base}-${index + 1}`;
    const existing = await store.getPage(candidate);
    if (!existing) return candidate;
    const frontmatter = (existing.frontmatter ?? {}) as Record<string, unknown>;
    if (frontmatter.descartes_job_id === jobId) return candidate;
  }
  throw new Error(`Could not allocate critique slug for ${parentSlug}`);
}

async function withCritiquePersistenceLock<T>(
  parentSlug: string,
  persist: () => Promise<T>,
): Promise<T> {
  const previous = critiquePersistLocks.get(parentSlug) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  critiquePersistLocks.set(parentSlug, next);

  await previous.catch(() => undefined);
  try {
    return await persist();
  } finally {
    release();
    if (critiquePersistLocks.get(parentSlug) === next) {
      critiquePersistLocks.delete(parentSlug);
    }
  }
}
