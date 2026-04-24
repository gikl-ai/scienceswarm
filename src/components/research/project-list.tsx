"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  FileTreeNode,
  collectDirectoryPaths,
  getNodePath,
  type FileNode,
} from "./file-tree";
import { clearLastProjectSlug, readLastProjectSlug } from "@/lib/project-navigation";
import { Spinner } from "@/components/spinner";

interface ProjectMeta {
  id: string;
  slug: string;
  name: string;
  description?: string;
  createdAt?: string;
  lastActive?: string;
  status?: "active" | "idle" | "paused" | "archived";
}

type FetchStatus = "loading" | "ready" | "error";
const EMPTY_EXPANDED_PATHS: string[] = [];
const NO_ACTIVE_PROJECT_KEY = "__no_active_project__";

export function ProjectList({
  activeSlug,
  files,
  onSelect,
  selectedPath,
  onUpload,
  onUploadFolder,
  onCheckChanges,
  onDropFiles,
  onDeleteFile,
  onProjectNavigate,
}: {
  activeSlug: string | null;
  files: FileNode[];
  onSelect: (path: string, node: FileNode) => void;
  selectedPath: string | null;
  onUpload: () => void;
  onUploadFolder?: () => void;
  onCheckChanges?: () => void;
  onDropFiles?: (files: File[]) => void;
  onDeleteFile?: (path: string, node: FileNode) => void;
  onProjectNavigate?: () => void;
}) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [status, setStatus] = useState<FetchStatus>("loading");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [collapsedProjectSlug, setCollapsedProjectSlug] = useState<string | null>(null);
  const [expandedFilePathState, setExpandedFilePathState] = useState<{
    key: string;
    paths: string[];
  }>({ key: activeSlug ?? NO_ACTIVE_PROJECT_KEY, paths: EMPTY_EXPANDED_PATHS });
  const [isDragOver, setIsDragOver] = useState(false);
  const directoryPaths = useMemo(() => collectDirectoryPaths(files), [files]);
  const hasDirectories = directoryPaths.length > 0;
  const activeExpansionKey = activeSlug ?? NO_ACTIVE_PROJECT_KEY;
  const expandedFilePaths = useMemo(
    () =>
      new Set(
        expandedFilePathState.key === activeExpansionKey
          ? expandedFilePathState.paths
          : EMPTY_EXPANDED_PATHS,
      ),
    [activeExpansionKey, expandedFilePathState],
  );

  const setExpandedFilePathsForActiveProject = (paths: string[]) => {
    setExpandedFilePathState({ key: activeExpansionKey, paths });
  };

  const toggleDirectory = (path: string) => {
    setExpandedFilePathState((current) => {
      const next = new Set(
        current.key === activeExpansionKey ? current.paths : EMPTY_EXPANDED_PATHS,
      );
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return {
        key: activeExpansionKey,
        paths: [...next],
      };
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/projects", { signal: controller.signal })
      .then(async (res) => {
        if (controller.signal.aborted) {
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const body = (await res.json()) as { projects?: ProjectMeta[] };
        if (controller.signal.aborted) {
          return;
        }
        setProjects(Array.isArray(body.projects) ? body.projects : []);
        setStatus("ready");
      })
      .catch((error) => {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        setStatus("error");
      });
    return () => {
      controller.abort();
    };
  }, []);

  const dragHandlers = onDropFiles
    ? {
        onDragEnter: (e: React.DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragOver(true);
        },
        onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          if (!isDragOver) setIsDragOver(true);
        },
        onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setIsDragOver(false);
        },
        onDrop: (e: React.DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragOver(false);
          const dropped = Array.from(e.dataTransfer.files || []);
          if (dropped.length > 0) onDropFiles(dropped);
        },
      }
    : {};

  return (
    <div
      data-testid="filetree-dropzone"
      className={`flex h-full flex-col transition-colors ${
        isDragOver ? "bg-accent/5 ring-2 ring-accent" : ""
      }`}
      {...dragHandlers}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b-2 border-border">
        <span className="text-xs font-bold text-muted uppercase tracking-wider">Projects</span>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center overflow-hidden rounded border border-border bg-white">
            <button
              type="button"
              onClick={() => setExpandedFilePathsForActiveProject([])}
              disabled={!hasDirectories}
              className="flex h-6 w-7 items-center justify-center text-[10px] text-muted transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title="Collapse all folders"
              aria-label="Collapse all folders"
            >
              ▸▸
            </button>
            <button
              type="button"
              onClick={() => setExpandedFilePathsForActiveProject(directoryPaths)}
              disabled={!hasDirectories}
              className="flex h-6 w-7 items-center justify-center border-l border-border text-[10px] text-muted transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title="Expand all folders"
              aria-label="Expand all folders"
            >
              ▾▾
            </button>
          </div>
          <div className="relative">
            <button
              onClick={() => setAddMenuOpen(!addMenuOpen)}
              className="text-xs text-accent hover:text-accent-hover transition-colors font-medium"
              title="Add files to the active project"
            >
              + Add
            </button>
            {addMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-white border-2 border-border rounded-lg shadow-lg z-20 overflow-hidden">
                <button
                  onClick={() => { onUpload(); setAddMenuOpen(false); }}
                  className="w-full text-left text-xs px-3 py-2 hover:bg-surface transition-colors flex items-center gap-2"
                >
                  Upload Files
                </button>
                {onUploadFolder && (
                  <button
                    onClick={() => { onUploadFolder(); setAddMenuOpen(false); }}
                    className="w-full text-left text-xs px-3 py-2 hover:bg-surface transition-colors flex items-center gap-2 border-t border-border"
                  >
                    <span>📁</span> Import Local Folder
                  </button>
                )}
                {onCheckChanges && (
                  <button
                    onClick={() => { onCheckChanges(); setAddMenuOpen(false); }}
                    className="w-full text-left text-xs px-3 py-2 hover:bg-surface transition-colors flex items-center gap-2 border-t border-border"
                  >
                    Check for Changes
                  </button>
                )}
                <Link
                  href="/dashboard?new=1"
                  onClick={() => {
                    setAddMenuOpen(false);
                    onProjectNavigate?.();
                  }}
                  className="w-full block text-left text-xs px-3 py-2 hover:bg-surface transition-colors border-t border-border"
                >
                  + New project
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {status === "loading" && (
        <div className="flex items-center gap-2 p-4 text-xs text-muted">
          <Spinner size="h-3.5 w-3.5" testId="project-list-spinner" />
          <span>Loading projects…</span>
        </div>
      )}
      {status === "error" && (
        <div className="p-4 text-xs text-danger">Could not load projects.</div>
      )}
      {status === "ready" && projects.length === 0 && (
        <div className="flex flex-col items-center gap-3 p-6 text-center">
          <p className="text-xs text-muted">No projects yet.</p>
          <Link
            href="/dashboard?new=1"
            className="inline-flex items-center gap-1 bg-accent text-white text-xs font-medium px-4 py-2 rounded-lg hover:bg-accent-hover transition-colors"
          >
            + New Project
          </Link>
        </div>
      )}
      {status === "ready" && projects.length > 0 && (
        <div className="flex-1 overflow-y-auto py-1">
          {projects.map((project) => {
            const isActive = activeSlug !== null && project.slug === activeSlug;
            const isExpanded = isActive && collapsedProjectSlug !== project.slug;
            const handleArchive = async (e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              const label = project.name || project.slug;
              if (
                !confirm(
                  `Archive project "${label}"? This removes it from the Projects list but keeps local files on disk.`,
                )
              )
                return;
              try {
                const res = await fetch("/api/projects", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "archive", projectId: project.slug }),
                });
                if (!res.ok) {
                  const err = (await res.json().catch(() => ({}))) as { error?: string };
                  alert(`Archive failed: ${err.error ?? res.statusText}`);
                  return;
                }
                setProjects((prev) => prev.filter((p) => p.slug !== project.slug));
                if (readLastProjectSlug() === project.slug) {
                  clearLastProjectSlug();
                }
                if (isActive) {
                  window.location.href = "/dashboard/project";
                }
              } catch (err) {
                alert(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            };
            return (
              <div key={project.slug} className="group/project">
                <div className={`flex items-stretch ${isActive ? "border-l-2 border-accent" : "border-l-2 border-transparent"}`}>
                  <button
                    type="button"
                    onClick={() => {
                      if (isActive) {
                        setCollapsedProjectSlug(isExpanded ? project.slug : null);
                      }
                    }}
                    className="flex items-center px-1 text-[10px] text-muted hover:text-foreground transition-colors"
                    title={isExpanded ? "Collapse" : "Expand"}
                    aria-label={isExpanded ? "Collapse project" : "Expand project"}
                  >
                    {isExpanded ? "▼" : "▶"}
                  </button>
                  <Link
                    href={`/dashboard/project?name=${encodeURIComponent(project.slug)}`}
                    onClick={() => onProjectNavigate?.()}
                    className={`flex-1 flex flex-col gap-0.5 px-2 py-2 text-xs transition-colors ${
                      isActive
                        ? "bg-accent/10 text-accent"
                        : "text-foreground hover:bg-surface"
                    }`}
                  >
                    <span className="font-semibold truncate">{project.name || project.slug}</span>
                    {project.description && (
                      <span className="truncate text-[10px] text-muted">{project.description}</span>
                    )}
                  </Link>
                  <button
                    type="button"
                    onClick={handleArchive}
                    className="flex-shrink-0 px-2 text-[10px] text-muted opacity-0 group-hover/project:opacity-100 hover:text-accent transition-opacity"
                    title="Archive project"
                    aria-label={`Archive project ${project.name || project.slug}`}
                  >
                    Archive
                  </button>
                </div>
                {isExpanded && isActive && (
                  <div className="ml-4 py-1 border-l border-border/40">
                    {files.length === 0 ? (
                      <div className="px-3 py-4 text-[10px] text-muted">
                        No files yet. Use <b>+ Add</b> to upload.
                      </div>
                    ) : (
                      files.map((node, idx) => (
                        <FileTreeNode
                          key={getNodePath(node, "") || `${node.name}-${idx}`}
                          node={node}
                          depth={0}
                          onSelect={onSelect}
                          selectedPath={selectedPath}
                          path=""
                          onDelete={onDeleteFile}
                          expandedPaths={expandedFilePaths}
                          onToggleDirectory={toggleDirectory}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
