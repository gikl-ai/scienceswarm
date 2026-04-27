const LAST_STUDY_SLUG_STORAGE_KEY = "scienceswarm.study.lastSlug";
const LAST_STUDY_SLUG_CHANGE_EVENT = "scienceswarm.study.lastSlug.changed";
const LEGACY_LAST_PROJECT_SLUG_STORAGE_KEY = "scienceswarm.project.lastSlug";
const LEGACY_LAST_PROJECT_SLUG_CHANGE_EVENT = "scienceswarm.project.lastSlug.changed";

export function safeStudySlugOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[a-z0-9-]+$/.test(value) ? value : null;
}

export function readLastStudySlug(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return (
      safeStudySlugOrNull(window.localStorage.getItem(LAST_STUDY_SLUG_STORAGE_KEY))
      ?? safeStudySlugOrNull(window.localStorage.getItem(LEGACY_LAST_PROJECT_SLUG_STORAGE_KEY))
    );
  } catch {
    return null;
  }
}

export function subscribeToLastStudySlug(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === null
      || event.key === LAST_STUDY_SLUG_STORAGE_KEY
      || event.key === LEGACY_LAST_PROJECT_SLUG_STORAGE_KEY
    ) {
      listener();
    }
  };
  const handleLocalChange = () => listener();

  window.addEventListener("storage", handleStorage);
  window.addEventListener(LAST_STUDY_SLUG_CHANGE_EVENT, handleLocalChange);
  window.addEventListener(LEGACY_LAST_PROJECT_SLUG_CHANGE_EVENT, handleLocalChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(LAST_STUDY_SLUG_CHANGE_EVENT, handleLocalChange);
    window.removeEventListener(LEGACY_LAST_PROJECT_SLUG_CHANGE_EVENT, handleLocalChange);
  };
}

export function persistLastStudySlug(slug: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_STUDY_SLUG_STORAGE_KEY, slug);
    window.localStorage.setItem(LEGACY_LAST_PROJECT_SLUG_STORAGE_KEY, slug);
    window.dispatchEvent(new Event(LAST_STUDY_SLUG_CHANGE_EVENT));
    window.dispatchEvent(new Event(LEGACY_LAST_PROJECT_SLUG_CHANGE_EVENT));
  } catch {
    // best effort
  }
}

export function clearLastStudySlug(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LAST_STUDY_SLUG_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_LAST_PROJECT_SLUG_STORAGE_KEY);
    window.dispatchEvent(new Event(LAST_STUDY_SLUG_CHANGE_EVENT));
    window.dispatchEvent(new Event(LEGACY_LAST_PROJECT_SLUG_CHANGE_EVENT));
  } catch {
    // best effort
  }
}

export function buildStudyWorkspaceHrefForSlug(slug: string | null | undefined): string {
  return buildStudyScopedDashboardHref("/dashboard/study", slug);
}

export function buildGbrainHrefForStudySlug(
  slug: string | null | undefined,
  brainSlug?: string | null,
): string {
  return buildStudyScopedDashboardHref("/dashboard/gbrain", slug, brainSlug);
}

export function buildRoutinesHrefForStudySlug(slug: string | null | undefined): string {
  return buildStudyScopedDashboardHref("/dashboard/routines", slug);
}

export function buildPaperLibraryHrefForStudySlug(slug: string | null | undefined): string {
  const baseHref = buildStudyScopedDashboardHref("/dashboard/gbrain", slug);
  const [pathname, queryString] = baseHref.split("?");
  const params = new URLSearchParams(queryString ?? "");
  params.set("view", "paper-library");
  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

function buildStudyScopedDashboardHref(
  basePath: string,
  slug: string | null | undefined,
  brainSlug?: string | null,
): string {
  const safeSlug = safeStudySlugOrNull(slug);
  const safeBrainSlug = brainSlug?.trim().replace(/^gbrain:/, "").replace(/\.md$/i, "") || "";

  if (!safeSlug && !safeBrainSlug) {
    return basePath;
  }

  const params = new URLSearchParams();
  if (safeSlug) {
    params.set("name", safeSlug);
  }
  if (safeBrainSlug) {
    params.set("brain_slug", safeBrainSlug);
  }
  return `${basePath}?${params.toString()}`;
}
