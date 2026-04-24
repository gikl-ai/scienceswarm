"use client";

import { useState, useEffect, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

interface ImportedFile {
  name: string;
  mimeType: string;
  importedAt: Date;
}

interface BreadcrumbItem {
  id: string | null;
  name: string;
}

// ── Helpers ──────────────────────────────────────────────────

function getDriveIcon(mimeType: string): string {
  const icons: Record<string, string> = {
    "application/vnd.google-apps.folder": "📁",
    "application/vnd.google-apps.document": "📝",
    "application/vnd.google-apps.spreadsheet": "📊",
    "application/vnd.google-apps.presentation": "📽️",
    "application/vnd.google-apps.form": "📋",
    "application/pdf": "📄",
    "text/csv": "📊",
    "text/plain": "📃",
    "application/json": "📋",
    "image/png": "🖼️",
    "image/jpeg": "🖼️",
  };
  return icons[mimeType] || "📄";
}

function formatSize(bytes?: string): string {
  if (!bytes) return "";
  const n = parseInt(bytes, 10);
  if (isNaN(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── Component ────────────────────────────────────────────────

export function DrivePanel({
  onImport,
}: {
  onImport?: (files: Array<{ name: string; content: string; mimeType: string }>) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([{ id: null, name: "My Drive" }]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<DriveFile[] | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [recentImports, setRecentImports] = useState<ImportedFile[]>([]);
  const [syncing, setSyncing] = useState(false);

  // ── Load files ──
  const loadFiles = useCallback(
    async (folderId?: string) => {
      setLoading(true);
      setError(null);
      setSearchResults(null);
      try {
        const param = folderId ? `&folderId=${encodeURIComponent(folderId)}` : "";
        const res = await fetch(`/api/drive?action=list${param}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setFiles(data.files || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load files");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // ── Check connection status ──
  useEffect(() => {
    fetch("/api/drive?action=status")
      .then((r) => r.json())
      .then((data) => {
        if (data.connected) {
          setConnected(true);
          loadFiles();
        }
      })
      .catch(() => {});
  }, [loadFiles]);

  // ── Navigate into folder ──
  const openFolder = useCallback(
    (file: DriveFile) => {
      setBreadcrumbs((prev) => [...prev, { id: file.id, name: file.name }]);
      loadFiles(file.id);
      setSelectedFiles(new Set());
    },
    [loadFiles]
  );

  // ── Navigate via breadcrumb ──
  const navigateTo = useCallback(
    (index: number) => {
      setBreadcrumbs((prev) => prev.slice(0, index + 1));
      const folderId = breadcrumbs[index]?.id || undefined;
      loadFiles(folderId || undefined);
      setSelectedFiles(new Set());
    },
    [breadcrumbs, loadFiles]
  );

  // ── Search ──
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/drive?action=search&q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSearchResults(data.files || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  // ── Import single file ──
  const importFile = useCallback(
    async (file: DriveFile) => {
      setImporting((prev) => new Set(prev).add(file.id));
      setError(null);
      try {
        const res = await fetch("/api/drive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "import", fileId: file.id }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setRecentImports((prev) => [
          { name: data.file.name, mimeType: data.file.mimeType, importedAt: new Date() },
          ...prev,
        ]);
        onImport?.([data.file]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed");
      } finally {
        setImporting((prev) => {
          const next = new Set(prev);
          next.delete(file.id);
          return next;
        });
      }
    },
    [onImport]
  );

  // ── Batch import ──
  const batchImport = useCallback(async () => {
    if (selectedFiles.size === 0) return;
    const ids = Array.from(selectedFiles);
    setImporting(new Set(ids));
    setError(null);
    try {
      const res = await fetch("/api/drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "batch-import", fileIds: ids }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const imported = (data.files || []).map((f: { name: string; mimeType: string }) => ({
        name: f.name,
        mimeType: f.mimeType,
        importedAt: new Date(),
      }));
      setRecentImports((prev) => [...imported, ...prev]);
      setSelectedFiles(new Set());
      onImport?.(data.files || []);
      if (data.errors?.length > 0) {
        setError(`Imported ${data.files.length} files. ${data.errors.length} failed.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch import failed");
    } finally {
      setImporting(new Set());
    }
  }, [selectedFiles, onImport]);

  // ── Folder sync ──
  const syncFolder = useCallback(async () => {
    const currentFolder = breadcrumbs[breadcrumbs.length - 1];
    if (!currentFolder?.id) return;
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync", folderId: currentFolder.id }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const imported = (data.files || []).map((f: { name: string; mimeType: string }) => ({
        name: f.name,
        mimeType: f.mimeType,
        importedAt: new Date(),
      }));
      setRecentImports((prev) => [...imported, ...prev]);
      onImport?.(data.files || []);
      if (data.errors?.length > 0) {
        setError(`Synced ${data.files.length} files. ${data.errors.length} failed.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [breadcrumbs, onImport]);

  // ── Toggle selection ──
  const toggleSelect = useCallback((fileId: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }, []);

  // ── Connect ──
  const handleConnect = async () => {
    try {
      const res = await fetch("/api/drive?action=auth-url");
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      setError("Failed to start Google OAuth flow");
    }
  };

  // ── Disconnect ──
  const handleDisconnect = async () => {
    await fetch("/api/drive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disconnect" }),
    });
    setConnected(false);
    setFiles([]);
    setBreadcrumbs([{ id: null, name: "My Drive" }]);
  };

  // ── Not connected state ──
  if (!connected) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-md text-center">
          <div className="text-5xl mb-4">
            <svg viewBox="0 0 87.3 78" className="w-16 h-16 mx-auto">
              <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 55H0c0 1.55.4 3.1 1.2 4.5z" fill="var(--brand-gdrive-blue)"/>
              <path d="M43.65 25L29.9 0c-1.35.8-2.5 1.9-3.3 3.3L1.2 50.5C.4 51.9 0 53.45 0 55h27.5z" fill="var(--brand-gdrive-green)"/>
              <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.1 59.35c.8-1.4 1.2-2.95 1.2-4.5H59.8l6.15 11.05z" fill="var(--brand-gdrive-red)"/>
              <path d="M43.65 25L57.4 1.5C56.05.7 54.5.3 52.95.3H34.35c-1.55 0-3.1.4-4.45 1.2z" fill="var(--brand-gdrive-darkgreen)"/>
              <path d="M59.8 55h27.5c0-1.55-.4-3.1-1.2-4.5L68.3 19.15c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 59.8 55z" fill="var(--brand-gdrive-lightblue)"/>
              <path d="M43.65 25L27.5 55h32.3z" fill="var(--brand-gdrive-paleblue)"/>
            </svg>
          </div>
          <h3 className="text-lg font-bold mb-2">Connect Google Drive</h3>
          <p className="text-sm text-muted mb-6">
            Import research data, papers, and datasets directly from your Google Drive.
            Supports Sheets (CSV export), Docs (text export), and all file types.
          </p>
          <button
            onClick={handleConnect}
            className="bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-semibold hover:bg-accent-hover transition-colors"
          >
            Connect Google Drive
          </button>
        </div>
      </div>
    );
  }

  const displayFiles = searchResults !== null ? searchResults : files;

  // ── Connected state ──
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b-2 border-border bg-white flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-ok" />
          <span className="text-[10px] font-medium text-ok">Connected</span>
        </div>
        <div className="w-px h-5 bg-border" />

        {/* Search */}
        <div className="flex items-center gap-1 flex-1 max-w-sm">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            placeholder="Search Drive..."
            className="flex-1 text-xs bg-surface border border-border rounded-lg px-3 py-1.5 focus:outline-none focus:border-accent"
          />
          <button
            onClick={handleSearch}
            disabled={loading}
            className="text-xs bg-surface border border-border rounded-lg px-3 py-1.5 text-muted hover:text-foreground transition-colors"
          >
            Search
          </button>
          {searchResults !== null && (
            <button
              onClick={() => { setSearchResults(null); setSearchQuery(""); }}
              className="text-xs text-muted hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex-1" />

        {/* Batch actions */}
        {selectedFiles.size > 0 && (
          <button
            onClick={batchImport}
            disabled={importing.size > 0}
            className="text-xs bg-accent text-white rounded-lg px-4 py-1.5 font-semibold hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {importing.size > 0 ? "Importing..." : `Import ${selectedFiles.size} selected`}
          </button>
        )}

        {/* Sync folder */}
        {breadcrumbs.length > 1 && (
          <button
            onClick={syncFolder}
            disabled={syncing}
            className="text-xs bg-surface border border-border rounded-lg px-3 py-1.5 text-muted hover:text-foreground transition-colors disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync Folder"}
          </button>
        )}

        <button
          onClick={handleDisconnect}
          className="text-[10px] text-muted hover:text-danger transition-colors"
        >
          Disconnect
        </button>
      </div>

      {/* Breadcrumbs */}
      {searchResults === null && (
        <div className="flex items-center gap-1 px-4 py-1.5 bg-surface/50 border-b border-border text-xs flex-shrink-0">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted">/</span>}
              <button
                onClick={() => navigateTo(i)}
                className={`hover:text-accent transition-colors ${
                  i === breadcrumbs.length - 1 ? "font-medium text-foreground" : "text-muted"
                }`}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 py-2 bg-danger/10 border-b border-danger/30 text-danger text-xs flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-danger/60 hover:text-danger ml-4">
            x
          </button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* File list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <div className="text-sm text-muted">Loading...</div>
            </div>
          ) : displayFiles.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <div className="text-sm text-muted">
                {searchResults !== null ? "No search results" : "This folder is empty"}
              </div>
            </div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-surface">
                  <th className="w-8 px-3 py-2 border-b-2 border-border">
                    <input
                      type="checkbox"
                      checked={selectedFiles.size === displayFiles.filter((f) => f.mimeType !== "application/vnd.google-apps.folder").length && displayFiles.length > 0}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedFiles(new Set(displayFiles.filter((f) => f.mimeType !== "application/vnd.google-apps.folder").map((f) => f.id)));
                        } else {
                          setSelectedFiles(new Set());
                        }
                      }}
                      className="rounded"
                    />
                  </th>
                  <th className="text-left px-3 py-2 font-bold text-foreground border-b-2 border-border">Name</th>
                  <th className="text-left px-3 py-2 font-bold text-muted border-b-2 border-border w-24">Size</th>
                  <th className="text-left px-3 py-2 font-bold text-muted border-b-2 border-border w-28">Modified</th>
                  <th className="text-right px-3 py-2 font-bold text-muted border-b-2 border-border w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayFiles.map((file) => {
                  const isFolder = file.mimeType === "application/vnd.google-apps.folder";
                  const isImporting = importing.has(file.id);
                  return (
                    <tr
                      key={file.id}
                      className="hover:bg-surface/50 transition-colors"
                    >
                      <td className="px-3 py-1.5 border-b border-border/50">
                        {!isFolder && (
                          <input
                            type="checkbox"
                            checked={selectedFiles.has(file.id)}
                            onChange={() => toggleSelect(file.id)}
                            className="rounded"
                          />
                        )}
                      </td>
                      <td className="px-3 py-1.5 border-b border-border/50">
                        <button
                          onClick={() => isFolder ? openFolder(file) : undefined}
                          className={`flex items-center gap-2 ${isFolder ? "hover:text-accent cursor-pointer" : "cursor-default"}`}
                        >
                          <span>{getDriveIcon(file.mimeType)}</span>
                          <span className={`truncate ${isFolder ? "font-medium" : ""}`}>{file.name}</span>
                        </button>
                      </td>
                      <td className="px-3 py-1.5 border-b border-border/50 text-muted font-mono">
                        {formatSize(file.size)}
                      </td>
                      <td className="px-3 py-1.5 border-b border-border/50 text-muted">
                        {formatDate(file.modifiedTime)}
                      </td>
                      <td className="px-3 py-1.5 border-b border-border/50 text-right">
                        {!isFolder && (
                          <button
                            onClick={() => importFile(file)}
                            disabled={isImporting}
                            className="text-[10px] font-medium text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
                          >
                            {isImporting ? "Importing..." : "Import"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Recently imported sidebar */}
        {recentImports.length > 0 && (
          <div className="w-56 flex-shrink-0 border-l-2 border-border bg-white overflow-y-auto">
            <div className="px-3 py-2 border-b border-border">
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">
                Recently Imported
              </h3>
            </div>
            <div className="py-1">
              {recentImports.slice(0, 20).map((file, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs"
                >
                  <span>{getDriveIcon(file.mimeType)}</span>
                  <span className="truncate flex-1 text-foreground">{file.name}</span>
                  <span className="text-[10px] text-muted flex-shrink-0">
                    {file.importedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
