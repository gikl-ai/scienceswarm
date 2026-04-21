"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, startTransition, useState, useEffect, useCallback } from "react";

interface Project {
  id: string;
  name: string;
  slug?: string;
  description: string;
  lastActive?: string;
  createdAt?: string;
  updatedAt?: string;
  status: "active" | "idle";
}

/** Derive a URL-safe slug from a project name (client-side fallback). */
function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function buildProjectWorkspaceHref(
  project: Pick<Project, "name" | "description" | "slug">,
  options?: { onboarding?: boolean },
): string {
  const params = new URLSearchParams({
    name: project.slug || toSlug(project.name),
  });

  if (project.description) {
    params.set("description", project.description);
  }

  if (options?.onboarding) {
    params.set("onboarding", "1");
  }

  return `/dashboard/project?${params.toString()}`;
}

function DashboardPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const showNewForm = searchParams.get("new") === "1";

  const [, setProjects] = useState<Project[]>([]);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [createError, setCreateError] = useState("");
  const normalizedProjectSlug = toSlug(projectName.trim());

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data = await res.json();
        if (data.projects) setProjects(data.projects);
      }
    } catch { /* API not available */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // Redirect to /dashboard/project unless ?new=1 is present.
  useEffect(() => {
    if (!showNewForm) {
      router.replace("/dashboard/project");
    }
  }, [showNewForm, router]);

  const handleCreate = async () => {
    if (!projectName.trim()) return;
    setCreateError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: projectName.trim(), description: projectDescription.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.project) {
          setProjects((prev) => [data.project, ...prev]);
          setProjectName("");
          setProjectDescription("");
          startTransition(() => {
            router.push(buildProjectWorkspaceHref(data.project, { onboarding: true }));
          });
          return;
        }
        setCreateError("Project creation failed: server response did not include project details.");
      } else {
        const data = await res.json().catch(() => ({ error: "Project creation failed" }));
        setCreateError(data.error || `Request failed (${res.status})`);
      }
    } catch {
      setCreateError("Network error — please check your connection and try again.");
    }
  };

  // While redirecting, show nothing.
  if (!showNewForm) {
    return null;
  }

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">New Project</h1>
          <p className="text-muted text-sm mt-1">Create a new research workspace</p>
        </div>
        <Link
          href="/dashboard/project"
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          Back to workspace
        </Link>
      </div>

      <div className="mb-8 bg-surface border-2 border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Create a new project</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-muted mb-1.5">Project name</label>
            <input type="text" value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="project-alpha" className="w-full bg-background border-2 border-border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent transition-colors font-mono" />
            <p className="text-xs text-muted mt-2">
              Project slug: <code className="font-mono">{normalizedProjectSlug || "..."}</code>
              {normalizedProjectSlug && normalizedProjectSlug !== projectName.trim().toLowerCase() ? " (normalized for URLs and API calls)" : ""}
            </p>
          </div>
          <div>
            <label className="block text-sm text-muted mb-1.5">What are you researching?</label>
            <textarea value={projectDescription} onChange={(e) => setProjectDescription(e.target.value)} placeholder="Analyzing citation patterns in public benchmark datasets..." rows={3} className="w-full bg-background border-2 border-border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-accent transition-colors resize-none" />
          </div>
          {createError && <p className="text-sm text-red-400">{createError}</p>}
          <div className="flex gap-3">
            <button onClick={handleCreate} disabled={!projectName.trim() || loading} className="bg-accent text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-40">Create Project</button>
            <Link
              href="/dashboard/project"
              className="text-muted px-4 py-2 rounded-lg text-sm hover:text-foreground transition-colors"
            >
              Cancel
            </Link>
          </div>
        </div>
        <p className="text-xs text-muted mt-3">
          Creates a local project workspace with upload, import, chat, and artifact review ready to use, then opens the project workspace.
        </p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="p-8 max-w-5xl"><div className="text-center text-muted text-sm py-8">Loading...</div></div>}>
      <DashboardPageContent />
    </Suspense>
  );
}
