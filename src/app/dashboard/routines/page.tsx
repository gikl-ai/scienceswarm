"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowSquareOut,
  Broadcast,
  CalendarCheck,
  Database,
  MoonStars,
} from "@phosphor-icons/react";
import { SchedulerPanel } from "@/components/research/scheduler-panel";
import { RadarBriefingView } from "@/components/radar/radar-briefing-view";
import { RadarSettingsPanel } from "@/components/radar/radar-settings-panel";
import { FrontierWatchComposer } from "@/components/settings/frontier-watch-composer";
import { DreamCycleRoutinePanel } from "@/components/routines/dream-cycle-routine-panel";
import type { ProjectWatchConfig } from "@/lib/watch/types";
import {
  buildGbrainHrefForSlug,
  buildRoutinesHrefForSlug,
  buildWorkspaceHrefForSlug,
  persistLastProjectSlug,
  readLastProjectSlug,
  safeProjectSlugOrNull,
} from "@/lib/project-navigation";

interface ProjectOption {
  id: string;
  name: string;
}

interface ProjectListResult {
  projects?: Array<{
    slug?: string;
    name?: string;
  }>;
}

function createDefaultWatchConfig(): ProjectWatchConfig {
  return {
    version: 1,
    keywords: [],
    promotionThreshold: 5,
    stagingThreshold: 2,
    schedule: {
      enabled: false,
      cadence: "daily",
      time: "08:00",
      timezone: "local",
    },
    sources: [],
  };
}

function RoutinesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectFromUrl =
    safeProjectSlugOrNull(searchParams.get("name")) ??
    safeProjectSlugOrNull(searchParams.get("project"));
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [selectedProject, setSelectedProject] = useState(projectFromUrl ?? "");
  const [watchConfig, setWatchConfig] = useState<ProjectWatchConfig>(createDefaultWatchConfig());
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchSaving, setWatchSaving] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [watchMessage, setWatchMessage] = useState<string | null>(null);

  const selectedProjectLabel = useMemo(() => {
    const match = projectOptions.find((project) => project.id === selectedProject);
    return match?.name ?? selectedProject;
  }, [projectOptions, selectedProject]);

  const fetchProjects = useCallback(async () => {
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) return;
      const data = (await response.json()) as ProjectListResult;
      const projects = Array.isArray(data.projects)
        ? data.projects
            .filter(
              (project): project is { slug: string; name: string } =>
                Boolean(
                  project &&
                    typeof project.slug === "string" &&
                    project.slug.trim().length > 0 &&
                    typeof project.name === "string" &&
                    project.name.trim().length > 0,
                ),
            )
            .map((project) => ({
              id: project.slug.trim(),
              name: project.name.trim(),
            }))
        : [];

      setProjectOptions(projects);
      setSelectedProject((current) => {
        if (current) {
          return current;
        }
        const rememberedProject = readLastProjectSlug();
        return projects.some((project) => project.id === rememberedProject)
          ? rememberedProject ?? ""
          : projects[0]?.id ?? "";
      });
    } catch {
      // keep current state
    }
  }, []);

  const fetchWatchConfig = useCallback(async (project: string, signal?: AbortSignal) => {
    if (!project.trim()) {
      setWatchConfig(createDefaultWatchConfig());
      setWatchError(null);
      setWatchLoading(false);
      return;
    }

    setWatchLoading(true);
    setWatchError(null);
    setWatchMessage(null);
    try {
      const response = await fetch(`/api/brain/watch-config?project=${encodeURIComponent(project)}`, {
        signal,
      });
      const data = (await response.json()) as {
        config?: ProjectWatchConfig;
        error?: string;
      };
      if (!response.ok || !data.config) {
        setWatchConfig(createDefaultWatchConfig());
        setWatchError(data.error || "Failed to load watch config");
        return;
      }
      setWatchConfig(data.config);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setWatchConfig(createDefaultWatchConfig());
      setWatchError("Failed to load watch config");
    } finally {
      if (!signal?.aborted) {
        setWatchLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    if (!projectFromUrl) return;
    setSelectedProject(projectFromUrl);
    persistLastProjectSlug(projectFromUrl);
  }, [projectFromUrl]);

  useEffect(() => {
    if (!selectedProject) {
      void fetchWatchConfig("");
      return;
    }

    const controller = new AbortController();
    void fetchWatchConfig(selectedProject, controller.signal);
    return () => controller.abort();
  }, [fetchWatchConfig, selectedProject]);

  function selectProject(project: string) {
    const safeProject = safeProjectSlugOrNull(project);
    if (!safeProject) return;
    setSelectedProject(safeProject);
    persistLastProjectSlug(safeProject);
    router.replace(buildRoutinesHrefForSlug(safeProject));
  }

  async function saveWatchConfig() {
    if (!selectedProject.trim()) {
      setWatchError("Choose a project before saving Frontier Watch");
      return;
    }

    setWatchSaving(true);
    setWatchError(null);
    setWatchMessage(null);
    try {
      const response = await fetch("/api/brain/watch-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: selectedProject,
          config: watchConfig,
        }),
      });
      const data = (await response.json()) as {
        config?: ProjectWatchConfig;
        error?: string;
      };
      if (!response.ok || !data.config) {
        const message = data.error || "Failed to save watch config";
        setWatchError(message);
        return;
      }

      setWatchConfig(data.config);
      setWatchMessage(`Saved Frontier Watch for ${selectedProject}.`);
    } catch {
      setWatchError("Failed to save watch config");
    } finally {
      setWatchSaving(false);
    }
  }

  const inputClassName =
    "w-full bg-background border-2 border-border rounded-lg px-4 py-2.5 text-sm font-mono focus:outline-none focus:border-accent transition-colors";
  const primaryButtonClassName =
    "bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-40";
  const secondaryButtonClassName =
    "border-2 border-border text-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-surface-hover transition-colors disabled:opacity-40";

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface/30">
      <section className="border-b border-border bg-white px-4 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted">
              <CalendarCheck size={15} />
              Routines
            </div>
            <h1 className="mt-1 text-xl font-semibold text-foreground">Recurring workbench</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Project jobs, Dream Cycle, Frontier Watch, and Research Radar in one scheduled-work surface.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="routines-project">
              Project
            </label>
            <select
              id="routines-project"
              value={selectedProject}
              onChange={(event) => selectProject(event.target.value)}
              disabled={projectOptions.length === 0 && !selectedProject}
              className="h-9 min-w-48 rounded-lg border border-border bg-surface px-3 text-xs font-semibold text-foreground focus:border-accent focus:outline-none"
            >
              {projectOptions.length === 0 ? (
                <option value={selectedProject}>
                  {selectedProject || "No projects"}
                </option>
              ) : (
                <>
                  {selectedProject && !projectOptions.some((project) => project.id === selectedProject) ? (
                    <option value={selectedProject}>{selectedProject}</option>
                  ) : null}
                  {projectOptions.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </>
              )}
            </select>
            {selectedProject ? (
              <>
                <Link
                  href={buildWorkspaceHrefForSlug(selectedProject)}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                >
                  <ArrowSquareOut size={14} />
                  Workspace
                </Link>
                <Link
                  href={buildGbrainHrefForSlug(selectedProject)}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                >
                  <Database size={14} />
                  gbrain
                </Link>
              </>
            ) : null}
          </div>
        </div>
      </section>

      <nav className="flex shrink-0 gap-2 overflow-x-auto border-b border-border bg-white px-4 py-2">
        {[
          ["#project-jobs", "Project jobs"],
          ["#dream-cycle", "Dream Cycle"],
          ["#frontier-watch", "Frontier Watch"],
          ["#research-radar", "Research Radar"],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="inline-flex h-8 shrink-0 items-center rounded-lg border border-transparent px-3 text-xs font-semibold text-muted transition-colors hover:border-border hover:bg-surface hover:text-foreground"
          >
            {label}
          </a>
        ))}
      </nav>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <RoutineSection
          id="project-jobs"
          icon={<CalendarCheck size={16} />}
          title="Project jobs"
          eyebrow={selectedProject ? selectedProjectLabel : "No project selected"}
          description="Scheduled commands, reruns, and pipelines tied to the selected workspace."
        >
          {selectedProject ? (
            <div className="h-[560px] overflow-hidden rounded-lg border border-border bg-white">
              <SchedulerPanel
                projectId={selectedProject}
                defaultJobName="Nightly project rerun"
                defaultJobType="recurring"
                defaultSchedule="0 0 * * *"
                defaultActionType="run-script"
                defaultOutputPath="results/nightly-rerun-result.md"
              />
            </div>
          ) : (
            <EmptyProjectCallout />
          )}
        </RoutineSection>

        <RoutineSection
          id="dream-cycle"
          icon={<MoonStars size={16} />}
          title="Dream Cycle"
          eyebrow="gbrain"
          description="Automatic synthesis, link repair, contradiction checks, and stale-work detection."
        >
          <DreamCycleRoutinePanel
            onNavigateBrainPage={(slug) => {
              router.push(buildGbrainHrefForSlug(selectedProject, slug));
            }}
          />
        </RoutineSection>

        <RoutineSection
          id="frontier-watch"
          icon={<Broadcast size={16} />}
          title="Frontier Watch"
          eyebrow={selectedProject ? selectedProjectLabel : "No project selected"}
          description="Project-scoped recurring research briefs powered by OpenClaw."
        >
          {selectedProject ? (
            <div className="space-y-3">
              <FrontierWatchComposer
                projectOptions={projectOptions}
                watchProject={selectedProject}
                onWatchProjectChange={selectProject}
                watchConfig={watchConfig}
                setWatchConfig={setWatchConfig}
                watchLoading={watchLoading}
                watchSaving={watchSaving}
                watchError={watchError}
                onSave={() => void saveWatchConfig()}
                inputClassName={inputClassName}
                primaryButtonClassName={primaryButtonClassName}
                secondaryButtonClassName={secondaryButtonClassName}
              />
              {watchMessage ? (
                <p className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
                  {watchMessage}
                </p>
              ) : null}
            </div>
          ) : (
            <EmptyProjectCallout />
          )}
        </RoutineSection>

        <RoutineSection
          id="research-radar"
          icon={<Broadcast size={16} />}
          title="Research Radar"
          eyebrow="Global"
          description="Recurring field monitoring, source weighting, and current briefing state."
        >
          <div className="grid gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <RadarSettingsPanel
              inputClassName={inputClassName}
              primaryButtonClassName={primaryButtonClassName}
            />
            <RadarBriefingView />
          </div>
        </RoutineSection>
      </main>
    </div>
  );
}

function RoutineSection({
  id,
  icon,
  title,
  eyebrow,
  description,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  eyebrow: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="border-b border-border bg-white px-4 py-5">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
              {icon}
              {eyebrow}
            </div>
            <h2 className="mt-1 text-lg font-semibold text-foreground">{title}</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>
          </div>
        </div>
        {children}
      </div>
    </section>
  );
}

function EmptyProjectCallout() {
  return (
    <div className="rounded-lg border border-border bg-background px-4 py-5 text-sm text-muted">
      Select or create a project to configure project-scoped routines.
    </div>
  );
}

export default function RoutinesPage() {
  return (
    <Suspense fallback={<div className="flex h-full bg-surface/30" />}>
      <RoutinesPageContent />
    </Suspense>
  );
}
