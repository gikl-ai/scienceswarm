import type { BrainPage } from "@/brain/store";
import type { ProjectRecord } from "@/brain/gbrain-data-contracts";
import {
  createProjectRepository,
  DuplicateProjectError,
} from "@/lib/projects/project-repository";
import { materializeProjectFolder } from "@/lib/projects/materialize-project";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";

export interface EnsureProjectShellOptions {
  projectSlug: string;
  descriptionHint?: string | null;
  sourceFilename?: string | null;
  createdBy?: string | null;
}

function trimOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function humanizeProjectSlug(slug: string): string {
  return slug
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
    .join(" ");
}

function readPageTimestamp(page: BrainPage): number {
  const frontmatter = page.frontmatter ?? {};
  const candidates = [
    frontmatter.updated_at,
    frontmatter.updatedAt,
    frontmatter.uploaded_at,
    frontmatter.created_at,
    frontmatter.createdAt,
    frontmatter.date,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      continue;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

async function loadReadyBrainStore() {
  const { ensureBrainStoreReady, getBrainStore } = await import("@/brain/store");
  await ensureBrainStoreReady();
  return getBrainStore();
}

async function listRelatedProjectPages(projectSlug: string): Promise<BrainPage[]> {
  const store = await loadReadyBrainStore();
  const pages = await store.listPages({ limit: 5000 });
  return pages
    .filter((page) => {
      const frontmatter = page.frontmatter ?? {};
      return (
        (typeof frontmatter.project === "string" &&
          frontmatter.project.trim() === projectSlug) ||
        (Array.isArray(frontmatter.projects) &&
          frontmatter.projects.includes(projectSlug)) ||
        page.path.replace(/\.md$/i, "") === projectSlug
      );
    })
    .sort((left, right) => readPageTimestamp(right) - readPageTimestamp(left));
}

function inferProjectDescription(
  projectSlug: string,
  relatedPages: BrainPage[],
  options: EnsureProjectShellOptions,
): string | null {
  const hinted = trimOrNull(options.descriptionHint);
  if (hinted) {
    return hinted;
  }

  const sourceFilename = trimOrNull(options.sourceFilename);
  if (sourceFilename) {
    return `Study created from a saved ScienceSwarm critique for ${sourceFilename}.`;
  }

  const relatedCritique = relatedPages.find((page) => {
    const type =
      typeof page.frontmatter?.type === "string"
        ? page.frontmatter.type
        : page.type;
    return type === "critique";
  });
  if (relatedCritique) {
    const critiqueSource = trimOrNull(
      typeof relatedCritique.frontmatter?.source_filename === "string"
        ? relatedCritique.frontmatter.source_filename
        : null,
    );
    if (critiqueSource) {
      return `Study created from saved critique artifacts for ${critiqueSource}.`;
    }
    return "Study created from saved ScienceSwarm critique artifacts.";
  }

  if (relatedPages.length > 0) {
    return `Study created from saved ScienceSwarm artifacts for ${humanizeProjectSlug(projectSlug)}.`;
  }

  return null;
}

function readCreatedBy(options: EnsureProjectShellOptions): string {
  const hinted = trimOrNull(options.createdBy);
  if (hinted) {
    return hinted;
  }

  return getCurrentUserHandle();
}

// Saved critiques can exist before any local project shell has been materialized.
// This best-effort bridge creates the canonical project record and local shell
// only when the slug is already justified by existing gbrain artifacts or
// explicit caller hints such as a saved critique filename.
export async function ensureProjectShellForProjectSlug(
  options: EnsureProjectShellOptions,
): Promise<ProjectRecord | null> {
  const projectSlug = assertSafeProjectSlug(options.projectSlug);
  const repo = createProjectRepository();
  let record = await repo.get(projectSlug);

  if (!record) {
    const relatedPages = await listRelatedProjectPages(projectSlug);
    const description = inferProjectDescription(projectSlug, relatedPages, options);
    if (!description) {
      return null;
    }

    try {
      record = await repo.create({
        slug: projectSlug,
        name: humanizeProjectSlug(projectSlug),
        description,
        createdBy: readCreatedBy(options),
      });
    } catch (error) {
      if (!(error instanceof DuplicateProjectError)) {
        throw error;
      }
      record = await repo.get(projectSlug);
    }
  }

  if (!record) {
    return null;
  }

  await materializeProjectFolder(record);
  return record;
}
