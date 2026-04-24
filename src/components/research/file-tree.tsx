"use client";

import { useMemo, useState } from "react";

export interface FileNode {
  name: string;
  type: "file" | "directory";
  children?: FileNode[];
  icon?: string;
  size?: string;
  modified?: string;
  hasCompanion?: boolean;
  changed?: boolean;
  /** "gbrain" when the node represents a gbrain page, undefined for workspace files. */
  source?: "gbrain";
  /** gbrain page slug, present when source === "gbrain". */
  slug?: string;
  /** gbrain page type (paper, critique, revision_plan, revision, etc.). */
  pageType?: string;
}

export function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const icons: Record<string, string> = {
    py: "🐍", ipynb: "📓", tex: "📝", bib: "📚", pdf: "📄",
    png: "🖼️", jpg: "🖼️", svg: "🖼️", gif: "🖼️",
    csv: "📊", json: "📋", yaml: "⚙️", yml: "⚙️", toml: "⚙️",
    md: "📑", txt: "📃", log: "📃",
    sh: "💻", bash: "💻",
    r: "📈", m: "📐", jl: "📐",
    dat: "💾", npy: "💾", pkl: "💾", h5: "💾", hdf5: "💾",
  };
  return icons[ext] || "📄";
}

export function getNodePath(node: FileNode, parentPath: string): string {
  const segment = node.source === "gbrain" && node.slug ? `gbrain:${node.slug}` : node.name;
  return parentPath ? `${parentPath}/${segment}` : segment;
}

export function FileTreeNode({
  node,
  depth,
  onSelect,
  selectedPath,
  path,
  onDelete,
  expandedPaths,
  onToggleDirectory,
}: {
  node: FileNode;
  depth: number;
  onSelect: (path: string, node: FileNode) => void;
  selectedPath: string | null;
  path: string;
  onDelete?: (path: string, node: FileNode) => void;
  expandedPaths?: ReadonlySet<string>;
  onToggleDirectory?: (path: string) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const fullPath = getNodePath(node, path);
  const isSelected = selectedPath === fullPath;
  const canDelete = onDelete !== undefined && node.source !== "gbrain";
  const isControlled = expandedPaths !== undefined && onToggleDirectory !== undefined;
  const expanded = isControlled ? expandedPaths.has(fullPath) : localExpanded;

  if (node.type === "directory") {
    return (
      <div>
        <div
          className={`group flex items-center gap-1.5 text-xs rounded transition-colors hover:bg-surface-hover ${
            isSelected ? "bg-accent/10 text-accent" : "text-foreground"
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (isControlled) {
                onToggleDirectory(fullPath);
              } else {
                setLocalExpanded(!expanded);
              }
            }}
            className="flex-1 flex items-center gap-1.5 px-2 py-1 text-left"
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
            aria-expanded={expanded}
          >
            <span className="text-[10px] text-muted w-3">{expanded ? "▼" : "▶"}</span>
            <span>📁</span>
            <span className="font-medium truncate">{node.name}</span>
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(fullPath, node); }}
              className="flex-shrink-0 px-2 py-1 text-[10px] text-muted opacity-0 group-hover:opacity-100 hover:text-danger transition-opacity"
              title="Delete folder"
              aria-label={`Delete ${node.name}`}
            >
              ×
            </button>
          )}
        </div>
        {expanded && node.children && (
          <div>
            {node.children.map((child) => (
              <FileTreeNode
                key={getNodePath(child, fullPath)}
                node={child}
                depth={depth + 1}
                onSelect={onSelect}
                selectedPath={selectedPath}
                path={fullPath}
                onDelete={onDelete}
                expandedPaths={expandedPaths}
                onToggleDirectory={onToggleDirectory}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center gap-1.5 text-xs rounded transition-colors hover:bg-surface-hover ${
        isSelected ? "bg-accent/10 text-accent font-medium" : "text-foreground"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(fullPath, node)}
        className="flex-1 flex items-center gap-1.5 px-2 py-1 text-left"
        style={{ paddingLeft: `${depth * 16 + 20}px` }}
      >
        <span>{node.icon || getFileIcon(node.name)}</span>
        <span className="truncate">{node.name}</span>
        {node.hasCompanion && <span className="text-[9px] flex-shrink-0" title="Has companion .md">*</span>}
        {node.changed && <span className="text-[9px] text-warn flex-shrink-0" title="Changed since import">~</span>}
        {node.pageType && (
          <span
            className="ml-auto text-[9px] bg-accent/10 text-accent px-1 py-0.5 rounded flex-shrink-0"
            title={`gbrain: ${node.pageType}`}
          >
            {node.pageType}
          </span>
        )}
        {node.size && !node.pageType && <span className="ml-auto text-[10px] text-muted flex-shrink-0">{node.size}</span>}
      </button>
      {canDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(fullPath, node); }}
          className="flex-shrink-0 px-2 py-1 text-[10px] text-muted opacity-0 group-hover:opacity-100 hover:text-danger transition-opacity"
          title="Delete file"
          aria-label={`Delete ${node.name}`}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function FileTree({
  files,
  onSelect,
  selectedPath,
  onUpload,
  onUploadFolder,
  onImportFromDrive,
  onCheckChanges,
  onDropFiles,
}: {
  files: FileNode[];
  onSelect: (path: string, node: FileNode) => void;
  selectedPath: string | null;
  onUpload: () => void;
  onUploadFolder?: () => void;
  onImportFromDrive?: () => void;
  onCheckChanges?: () => void;
  onDropFiles?: (files: File[]) => void;
}) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const directoryPaths = useMemo(() => collectDirectoryPaths(files), [files]);
  const hasDirectories = directoryPaths.length > 0;

  const toggleDirectory = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const dragHandlers = onDropFiles
    ? {
        onDragEnter: (e: React.DragEvent<HTMLDivElement>) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragOver(true);
        },
        onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
          // Must preventDefault on every dragover to keep the drop target alive.
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          if (!isDragOver) setIsDragOver(true);
        },
        onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
          // Only clear when we actually leave the container, not its children.
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
      className={`flex flex-col h-full transition-colors ${
        isDragOver ? "bg-accent/5 ring-2 ring-accent" : ""
      }`}
      {...dragHandlers}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b-2 border-border">
        <span className="text-xs font-bold text-muted uppercase tracking-wider">Workspace</span>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center overflow-hidden rounded border border-border bg-white">
            <button
              type="button"
              onClick={() => setExpandedPaths(new Set())}
              disabled={!hasDirectories}
              className="flex h-6 w-7 items-center justify-center text-[10px] text-muted transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title="Collapse all folders"
              aria-label="Collapse all folders"
            >
              ▸▸
            </button>
            <button
              type="button"
              onClick={() => setExpandedPaths(new Set(directoryPaths))}
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
              title="Add files"
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
                {onImportFromDrive && (
                  <button
                    onClick={() => { onImportFromDrive(); setAddMenuOpen(false); }}
                    className="w-full text-left text-xs px-3 py-2 hover:bg-surface transition-colors flex items-center gap-2 border-t border-border"
                  >
                    Import from Drive
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
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {files.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-muted">Drop files here to start your research project</p>
            <div className="mt-4 flex flex-col gap-2">
              {onUploadFolder && (
                <button
                  type="button"
                  onClick={onUploadFolder}
                  className="rounded-lg border border-border bg-white px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
                >
                  Import local folder
                </button>
              )}
              <button
                type="button"
                onClick={onUpload}
                className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                Upload files
              </button>
            </div>
          </div>
        ) : (
          files.map((node) => (
            <FileTreeNode
              key={getNodePath(node, "")}
              node={node}
              depth={0}
              onSelect={onSelect}
              selectedPath={selectedPath}
              path=""
              expandedPaths={expandedPaths}
              onToggleDirectory={toggleDirectory}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function collectDirectoryPaths(nodes: FileNode[], parentPath = ""): string[] {
  return nodes.flatMap((node) => {
    const fullPath = getNodePath(node, parentPath);
    if (node.type !== "directory") {
      return [];
    }
    return [
      fullPath,
      ...collectDirectoryPaths(node.children ?? [], fullPath),
    ];
  });
}
