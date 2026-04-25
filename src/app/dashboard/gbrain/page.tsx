"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowSquareOut, Brain, CalendarCheck, Database, SpinnerGap } from "@phosphor-icons/react";
import { OpenClawSkillsBrowser } from "@/components/openclaw/skills-browser";
import { InstalledMarketPluginsBrowser } from "@/components/skills/installed-market-browser";
import { WorkspaceSkillsBrowser } from "@/components/skills/workspace-browser";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BrainSearchPanel } from "@/components/research/brain-search-panel";
import { PaperLibraryCommandCenter } from "@/components/research/paper-library/command-center";
import {
  CompiledPageView,
  type CompiledPageRead,
} from "@/components/research/compiled-page-view";
import { Spinner } from "@/components/spinner";
import {
  buildGbrainHrefForSlug,
  buildRoutinesHrefForSlug,
  buildWorkspaceHrefForSlug,
  persistLastProjectSlug,
  readLastProjectSlug,
  safeProjectSlugOrNull,
} from "@/lib/project-navigation";

type BrainRadarStatus = {
  last_run: string;
  concepts_processed: number;
  errors: number;
  age_ms: number;
  stale: boolean;
  schedule_interval_ms: number;
};

type BrainBootstrapState =
  | { status: "loading" }
  | { status: "missing"; message?: string }
  | { status: "ready"; pageCount: number; backend?: string; radar?: BrainRadarStatus | null }
  | { status: "error"; message: string };

type BrainArtifactState =
  | { status: "idle" }
  | { status: "loading"; slug: string }
  | { status: "ready"; slug: string; page: CompiledPageRead }
  | { status: "error"; slug: string; message: string };

type GbrainView = "pages" | "skills" | "paper-library";
type GbrainSkillsCatalog = "workspace" | "openclaw" | "installed";

function GbrainPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectSlugFromUrl = searchParams.get("name");
  const requestedBrainSlug = searchParams.get("brain_slug");
  const requestedSkillSlug = normalizeSkillSlug(searchParams.get("skill"));
  const activeSkillsCatalog: GbrainSkillsCatalog =
    searchParams.get("skills_catalog") === "openclaw"
      ? "openclaw"
      : searchParams.get("skills_catalog") === "installed"
        ? "installed"
        : "workspace";
  const activeProjectSlug = safeProjectSlugOrNull(projectSlugFromUrl);
  const activeView: GbrainView = searchParams.get("view") === "skills"
    ? "skills"
    : searchParams.get("view") === "paper-library"
      ? "paper-library"
      : "pages";
  const requestedBrainPageSlug = useMemo(
    () => normalizeBrainArtifactSlug(requestedBrainSlug),
    [requestedBrainSlug],
  );
  const [brainBootstrapState, setBrainBootstrapState] = useState<BrainBootstrapState>({ status: "loading" });
  const [selectedArtifact, setSelectedArtifact] = useState<BrainArtifactState>({ status: "idle" });

  useEffect(() => {
    if (activeProjectSlug) {
      persistLastProjectSlug(activeProjectSlug);
      return;
    }

    if (activeView !== "pages") {
      return;
    }

    const lastProjectSlug = readLastProjectSlug();
    if (!lastProjectSlug) {
      return;
    }
    router.replace(buildGbrainDashboardHref({
      projectSlug: lastProjectSlug,
      brainSlug: requestedBrainSlug,
      view: activeView,
      skillSlug: requestedSkillSlug,
      skillsCatalog: activeSkillsCatalog,
    }));
  }, [activeProjectSlug, activeSkillsCatalog, activeView, requestedBrainSlug, requestedSkillSlug, router]);

  const loadBrainStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/brain/status");
      const data = await response.json().catch(() => ({}));

      if (response.status === 503) {
        setBrainBootstrapState({
          status: "missing",
          message: typeof data.error === "string" ? data.error : undefined,
        });
        return;
      }

      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Brain status check failed");
      }

      let radar: BrainRadarStatus | null = null;
      if (data.radar && typeof data.radar === "object") {
        const candidate = data.radar as Partial<BrainRadarStatus>;
        if (
          typeof candidate.last_run === "string" &&
          typeof candidate.concepts_processed === "number" &&
          typeof candidate.errors === "number" &&
          typeof candidate.age_ms === "number" &&
          typeof candidate.stale === "boolean" &&
          typeof candidate.schedule_interval_ms === "number"
        ) {
          radar = {
            last_run: candidate.last_run,
            concepts_processed: candidate.concepts_processed,
            errors: candidate.errors,
            age_ms: candidate.age_ms,
            stale: candidate.stale,
            schedule_interval_ms: candidate.schedule_interval_ms,
          };
        }
      }

      setBrainBootstrapState({
        status: "ready",
        pageCount: typeof data.pageCount === "number" ? data.pageCount : 0,
        backend: typeof data.backend === "string" ? data.backend : undefined,
        radar,
      });
    } catch (error) {
      setBrainBootstrapState({
        status: "error",
        message: error instanceof Error ? error.message : "Brain status check failed",
      });
    }
  }, []);

  const loadBrainArtifact = useCallback(async (slug: string, signal?: AbortSignal) => {
    const normalizedSlug = normalizeBrainArtifactSlug(slug);
    if (!normalizedSlug) {
      setSelectedArtifact({ status: "idle" });
      return;
    }

    setSelectedArtifact({ status: "loading", slug: normalizedSlug });
    try {
      const response = await fetch(`/api/brain/read?path=${encodeURIComponent(normalizedSlug)}`, {
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : "Failed to read brain page",
        );
      }
      setSelectedArtifact({
        status: "ready",
        slug: normalizedSlug,
        page: payload as CompiledPageRead,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      setSelectedArtifact({
        status: "error",
        slug: normalizedSlug,
        message: error instanceof Error ? error.message : "Failed to read brain page",
      });
    }
  }, []);

  const handleNavigateBrainPage = useCallback((slug: string) => {
    router.replace(buildGbrainDashboardHref({
      projectSlug: activeProjectSlug,
      brainSlug: slug,
      view: "pages",
      skillSlug: requestedSkillSlug,
      skillsCatalog: activeSkillsCatalog,
    }));
  }, [activeProjectSlug, activeSkillsCatalog, requestedSkillSlug, router]);

  const handleSelectView = useCallback((nextView: GbrainView) => {
    router.replace(buildGbrainDashboardHref({
      projectSlug: activeProjectSlug,
      brainSlug: requestedBrainSlug,
      view: nextView,
      skillSlug: requestedSkillSlug,
      skillsCatalog: activeSkillsCatalog,
    }));
  }, [activeProjectSlug, activeSkillsCatalog, requestedBrainSlug, requestedSkillSlug, router]);

  const handleSelectSkill = useCallback((slug: string) => {
    router.replace(buildGbrainDashboardHref({
      projectSlug: activeProjectSlug,
      brainSlug: requestedBrainSlug,
      view: "skills",
      skillSlug: slug,
      skillsCatalog: activeSkillsCatalog,
    }));
  }, [activeProjectSlug, activeSkillsCatalog, requestedBrainSlug, router]);

  const handleSelectSkillsCatalog = useCallback((nextCatalog: GbrainSkillsCatalog) => {
    router.replace(buildGbrainDashboardHref({
      projectSlug: activeProjectSlug,
      brainSlug: requestedBrainSlug,
      view: "skills",
      skillSlug: requestedSkillSlug,
      skillsCatalog: nextCatalog,
    }));
  }, [activeProjectSlug, requestedBrainSlug, requestedSkillSlug, router]);

  useEffect(() => {
    void loadBrainStatus();
  }, [loadBrainStatus]);

  useEffect(() => {
    if (brainBootstrapState.status === "missing" && activeView === "pages") {
      router.replace("/setup");
    }
  }, [activeView, brainBootstrapState.status, router]);

  useEffect(() => {
    if (activeView !== "pages") {
      setSelectedArtifact({ status: "idle" });
      return;
    }

    if (!requestedBrainPageSlug || brainBootstrapState.status !== "ready") {
      setSelectedArtifact({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    void loadBrainArtifact(requestedBrainPageSlug, controller.signal);
    return () => controller.abort();
  }, [activeView, brainBootstrapState.status, loadBrainArtifact, requestedBrainPageSlug]);

  const selectedProjectLabel = useMemo(() => activeProjectSlug ?? "No project selected", [activeProjectSlug]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface/30">
      <section className="border-b border-border bg-white px-4 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted">
              <Brain size={15} />
              gbrain
            </div>
            <h1 className="mt-1 text-xl font-semibold text-foreground">Research brain</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              {activeView === "pages"
                ? "Search and page inspection for your current project's gbrain."
                : activeView === "paper-library"
                  ? "Turn a local PDF archive into a reviewed, reversible, graph-aware research library."
                  : activeSkillsCatalog === "workspace"
                  ? "Curate host-neutral skills in this repo, keep some private, and sync them into OpenClaw, Claude Code, Codex, and other adapters."
                  : activeSkillsCatalog === "openclaw"
                    ? "Inspect the generated OpenClaw adapter output that ScienceSwarm materializes from the canonical workspace skill source."
                    : "Inspect, install, and manage private third-party market plugin bundles that ScienceSwarm pins locally and projects into OpenClaw, Codex, and Claude Code without promoting them into the public catalog."}
            </p>
            <div className="mt-4 inline-flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
              <button
                type="button"
                onClick={() => handleSelectView("pages")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeView === "pages"
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Pages
              </button>
              <button
                type="button"
                onClick={() => handleSelectView("skills")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeView === "skills"
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Skills
              </button>
              <button
                type="button"
                onClick={() => handleSelectView("paper-library")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeView === "paper-library"
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Paper Library
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">
              <Database size={14} />
              <span className="font-semibold text-foreground">
                {activeView === "skills" && !activeProjectSlug ? "Global skill catalog" : selectedProjectLabel}
              </span>
              {activeView === "pages" && brainBootstrapState.status === "ready" && (
                <span>{brainBootstrapState.pageCount} pages</span>
              )}
            </div>
            {(activeView === "pages" || activeView === "paper-library") && activeProjectSlug && (
              <>
                <Link
                  href={buildRoutinesHrefForSlug(activeProjectSlug)}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                >
                  <CalendarCheck size={14} />
                  Routines
                </Link>
                <Link
                  href={buildWorkspaceHrefForSlug(activeProjectSlug)}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                >
                  <ArrowSquareOut size={14} />
                  Open workspace
                </Link>
              </>
            )}
          </div>
        </div>
      </section>

      {activeView === "pages" && !activeProjectSlug && !requestedBrainPageSlug && (
        <section className="m-4 rounded-[28px] border-2 border-border bg-white p-8 shadow-sm">
          <div className="flex flex-col items-center text-center">
            <h2 className="text-lg font-semibold">No project selected</h2>
            <p className="mt-2 max-w-md text-sm text-muted">
              Open a project workspace first so gbrain can scope Dream Cycle and search to that project.
            </p>
            <Link
              href="/dashboard/project"
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Open workspace
            </Link>
          </div>
        </section>
      )}

      {activeView === "paper-library" && !activeProjectSlug && (
        <section className="m-4 rounded-[28px] border-2 border-border bg-white p-8 shadow-sm">
          <div className="flex flex-col items-center text-center">
            <h2 className="text-lg font-semibold">No project selected</h2>
            <p className="mt-2 max-w-md text-sm text-muted">
              Open a project workspace first so Paper Library can scope scans, apply plans, and graph state to one local research archive.
            </p>
            <Link
              href="/dashboard/project"
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Open workspace
            </Link>
          </div>
        </section>
      )}

      {activeView === "skills" && (
        <div className="p-3 md:p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[24px] border border-border bg-white px-4 py-4 shadow-sm">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                Skills catalog
              </div>
              <p className="mt-1 text-sm text-muted">
                The workspace catalog is the source of truth. Private market installs stay user-local and separate from the public catalog.
              </p>
            </div>
            <div className="inline-flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
              <button
                type="button"
                onClick={() => handleSelectSkillsCatalog("workspace")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeSkillsCatalog === "workspace"
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Workspace
              </button>
              <button
                type="button"
                onClick={() => handleSelectSkillsCatalog("openclaw")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeSkillsCatalog === "openclaw"
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                OpenClaw
              </button>
              <button
                type="button"
                onClick={() => handleSelectSkillsCatalog("installed")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeSkillsCatalog === "installed"
                    ? "bg-white text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                Installed
              </button>
            </div>
          </div>

          {activeSkillsCatalog === "workspace" ? (
            <WorkspaceSkillsBrowser
              selectedSkillSlug={requestedSkillSlug}
              onSelectSkill={handleSelectSkill}
            />
          ) : activeSkillsCatalog === "openclaw" ? (
            <OpenClawSkillsBrowser
              selectedSkillSlug={requestedSkillSlug}
              onSelectSkill={handleSelectSkill}
              radarStatus={brainBootstrapState.status === "ready" ? brainBootstrapState.radar : null}
            />
          ) : (
            <InstalledMarketPluginsBrowser
              selectedPluginId={requestedSkillSlug}
              onSelectPlugin={handleSelectSkill}
            />
          )}
        </div>
      )}

      {activeView === "pages" && (activeProjectSlug || requestedBrainPageSlug) && (
        <>
          {brainBootstrapState.status === "error" && (
            <section
              role="alert"
              className="border-b border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
            >
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-semibold">Research brain is unavailable.</p>
                  <p className="mt-1 text-xs leading-5 text-danger">
                    {brainBootstrapState.message}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { void loadBrainStatus(); }}
                  className="inline-flex h-8 shrink-0 items-center justify-center rounded border border-danger/40 bg-raised px-3 text-xs font-semibold text-danger transition-colors hover:border-danger"
                >
                  Retry brain status
                </button>
              </div>
            </section>
          )}

          {activeProjectSlug && (
            <BrainSearchPanel
              enabled={brainBootstrapState.status === "ready"}
              onOpenResult={handleNavigateBrainPage}
            />
          )}

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
            <div className="min-h-0 flex-1 overflow-hidden rounded-[24px] border border-border bg-white shadow-sm">
              <BrainArtifactPanel
                state={selectedArtifact}
                onNavigate={handleNavigateBrainPage}
                onRetry={() => {
                  const normalizedSlug = normalizeBrainArtifactSlug(requestedBrainSlug);
                  if (!normalizedSlug) return;
                  void loadBrainArtifact(normalizedSlug);
                }}
              />
            </div>
          </div>
        </>
      )}

      {activeView === "paper-library" && activeProjectSlug && (
        <>
          {brainBootstrapState.status === "missing" && (
            <section
              role="alert"
              className="border-b border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn"
            >
              <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-semibold">Paper Library needs local setup.</p>
                  <p className="mt-1 text-xs leading-5 text-warn">
                    {brainBootstrapState.message ?? "Run setup first so ScienceSwarm has a local brain root for paper-library state."}
                  </p>
                </div>
                <Link
                  href="/setup"
                  className="inline-flex h-8 shrink-0 items-center justify-center rounded border border-warn/40 bg-raised px-3 text-xs font-semibold text-warn transition-colors hover:border-warn"
                >
                  Open setup
                </Link>
              </div>
            </section>
          )}

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
            <div className="min-h-0 flex-1 overflow-hidden rounded-[24px] border border-border bg-white shadow-sm">
              <PaperLibraryCommandCenter projectSlug={activeProjectSlug} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function BrainArtifactPanel({
  state,
  onNavigate,
  onRetry,
}: {
  state: BrainArtifactState;
  onNavigate: (slug: string) => void;
  onRetry: () => void;
}) {
  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
        <Spinner size="h-4 w-4" />
        Loading brain page...
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-lg rounded-2xl border border-danger/30 bg-danger/10 px-5 py-4 text-sm text-danger">
          <p className="font-semibold">Could not open that gbrain page.</p>
          <p className="mt-2 text-danger">{state.message}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-danger/40 bg-raised px-3 text-xs font-semibold text-danger transition-colors hover:border-danger"
          >
            <SpinnerGap size={14} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (state.status !== "ready") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-lg text-center">
          <p className="text-sm font-semibold text-foreground">Open a gbrain page</p>
          <p className="mt-2 text-sm text-muted">
            Search gbrain or open a linked routine insight to inspect the page here.
          </p>
        </div>
      </div>
    );
  }

  if (hasCompiledPayload(state.page)) {
    return <CompiledPageView page={state.page} onNavigate={onNavigate} />;
  }

  return (
    <article className="h-full overflow-y-auto px-6 py-5">
      <header className="border-b border-border pb-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
          {state.page.type ?? "page"}
        </div>
        <h2 className="mt-1 text-xl font-semibold text-foreground">
          {state.page.title ?? state.page.path}
        </h2>
        <p className="mt-1 text-xs text-muted">{state.page.path}</p>
      </header>
      <div className="prose prose-sm mt-5 max-w-none prose-headings:font-semibold prose-p:leading-6 prose-li:leading-6">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {state.page.content?.trim() || "This gbrain page is empty."}
        </ReactMarkdown>
      </div>
    </article>
  );
}

function normalizeBrainArtifactSlug(slug: string | null | undefined): string | null {
  const trimmed = slug?.trim().replace(/^gbrain:/, "");
  if (!trimmed) return null;
  return trimmed.replace(/\.md$/i, "");
}

function normalizeSkillSlug(slug: string | null | undefined): string | null {
  const trimmed = slug?.trim().toLowerCase();
  if (!trimmed) return null;
  return /^[a-z0-9][a-z0-9._-]*$/.test(trimmed) ? trimmed : null;
}

function buildGbrainDashboardHref({
  projectSlug,
  brainSlug,
  view,
  skillSlug,
  skillsCatalog,
}: {
  projectSlug: string | null | undefined;
  brainSlug?: string | null;
  view: GbrainView;
  skillSlug?: string | null;
  skillsCatalog?: GbrainSkillsCatalog;
}): string {
  const baseHref = buildGbrainHrefForSlug(projectSlug, brainSlug);
  const nextSkillSlug = normalizeSkillSlug(skillSlug);

  if (view === "pages" && !nextSkillSlug) {
    return baseHref;
  }

  const [pathname, queryString] = baseHref.split("?");
  const params = new URLSearchParams(queryString ?? "");
  if (view === "skills") {
    params.set("view", "skills");
    params.set(
      "skills_catalog",
      skillsCatalog === "openclaw"
        ? "openclaw"
        : skillsCatalog === "installed"
          ? "installed"
          : "workspace",
    );
    if (nextSkillSlug) {
      params.set("skill", nextSkillSlug);
    } else {
      params.delete("skill");
    }
  } else if (view === "paper-library") {
    params.set("view", "paper-library");
    params.delete("skill");
    params.delete("skills_catalog");
  } else {
    params.delete("view");
    params.delete("skill");
    params.delete("skills_catalog");
  }

  const serialized = params.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

function hasCompiledPayload(page: CompiledPageRead): boolean {
  return Boolean(
    typeof page.path === "string" && (
      typeof page.compiled_truth === "string" ||
      page.frontmatter !== undefined ||
      Array.isArray(page.timeline) ||
      Array.isArray(page.links) ||
      Array.isArray(page.backlinks)
    ),
  );
}

export default function GbrainPage() {
  return (
    <Suspense>
      <GbrainPageContent />
    </Suspense>
  );
}
