const LAST_PROJECT_SLUG_STORAGE_KEY = "scienceswarm.project.lastSlug";
const LAST_PROJECT_SLUG_CHANGE_EVENT = "scienceswarm.project.lastSlug.changed";

export function safeProjectSlugOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[a-z0-9-]+$/.test(value) ? value : null;
}

export function readLastProjectSlug(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return safeProjectSlugOrNull(window.localStorage.getItem(LAST_PROJECT_SLUG_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function subscribeToLastProjectSlug(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === LAST_PROJECT_SLUG_STORAGE_KEY) {
      listener();
    }
  };
  const handleLocalChange = () => listener();

  window.addEventListener("storage", handleStorage);
  window.addEventListener(LAST_PROJECT_SLUG_CHANGE_EVENT, handleLocalChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(LAST_PROJECT_SLUG_CHANGE_EVENT, handleLocalChange);
  };
}

export function persistLastProjectSlug(slug: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_PROJECT_SLUG_STORAGE_KEY, slug);
    window.dispatchEvent(new Event(LAST_PROJECT_SLUG_CHANGE_EVENT));
  } catch {
    // best effort
  }
}

export function clearLastProjectSlug(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LAST_PROJECT_SLUG_STORAGE_KEY);
    window.dispatchEvent(new Event(LAST_PROJECT_SLUG_CHANGE_EVENT));
  } catch {
    // best effort
  }
}

export function buildWorkspaceHrefForSlug(slug: string | null | undefined): string {
  return buildProjectScopedDashboardHref("/dashboard/project", slug);
}

export function buildGbrainHrefForSlug(
  slug: string | null | undefined,
  brainSlug?: string | null,
): string {
  return buildProjectScopedDashboardHref("/dashboard/gbrain", slug, brainSlug);
}

export function buildPaperLibraryHrefForSlug(slug: string | null | undefined): string {
  const baseHref = buildProjectScopedDashboardHref("/dashboard/gbrain", slug);
  const [pathname, queryString] = baseHref.split("?");
  const params = new URLSearchParams(queryString ?? "");
  params.set("view", "paper-library");
  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

function buildProjectScopedDashboardHref(
  basePath: string,
  slug: string | null | undefined,
  brainSlug?: string | null,
): string {
  const safeSlug = safeProjectSlugOrNull(slug);
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
