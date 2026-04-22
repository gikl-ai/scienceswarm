"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  Package,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { Spinner } from "@/components/spinner";
import type {
  InstalledMarketPluginRecord,
  MarketPluginHostRecord,
  MarketPluginInstallPreview,
} from "@/lib/plugins/market";

type InstalledMarketPluginsResponse = {
  plugins?: InstalledMarketPluginRecord[];
  error?: string;
};

type InstalledMarketPluginMutationResponse = {
  plugin?: InstalledMarketPluginRecord;
  preview?: MarketPluginInstallPreview;
  message?: string;
  error?: string;
};

type RequestState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; message: string }
  | { state: "error"; message: string };

type FetchStatus = "loading" | "ready" | "error";

function sortPlugins(plugins: InstalledMarketPluginRecord[]): InstalledMarketPluginRecord[] {
  return [...plugins].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function toneForHostStatus(status: MarketPluginHostRecord["status"]): string {
  if (status === "installed") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "partial") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function summarizeTrust(preview: Pick<InstalledMarketPluginRecord, "trust"> | Pick<MarketPluginInstallPreview, "trust">): string {
  const { trust } = preview;
  return `${trust.scriptFileCount} script files, ${trust.agentFileCount} agent files, ${trust.referenceFileCount} reference files, ${trust.assetFileCount} asset files`;
}

export function InstalledMarketPluginsBrowser({
  selectedPluginId,
  onSelectPlugin,
}: {
  selectedPluginId?: string | null;
  onSelectPlugin: (pluginId: string) => void;
}) {
  const [pluginsStatus, setPluginsStatus] = useState<FetchStatus>("loading");
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [plugins, setPlugins] = useState<InstalledMarketPluginRecord[]>([]);
  const [selectedPluginOverride, setSelectedPluginOverride] = useState<string | null>(null);
  const [showInstallForm, setShowInstallForm] = useState(false);
  const [inspectState, setInspectState] = useState<RequestState>({ state: "idle" });
  const [installState, setInstallState] = useState<RequestState>({ state: "idle" });
  const [preview, setPreview] = useState<MarketPluginInstallPreview | null>(null);
  const [deleteStateByPlugin, setDeleteStateByPlugin] = useState<Record<string, RequestState>>({});
  const [refreshStateByPlugin, setRefreshStateByPlugin] = useState<Record<string, RequestState>>({});
  const [installForm, setInstallForm] = useState({
    repo: "",
    path: "",
    ref: "main",
  });

  async function loadPlugins(signal?: AbortSignal): Promise<void> {
    setPluginsStatus("loading");
    setPluginsError(null);

    try {
      const response = await fetch("/api/market/plugins", { signal });
      const payload = await response.json().catch(() => ({})) as InstalledMarketPluginsResponse;
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load installed market plugins.");
      }
      setPlugins(sortPlugins(payload.plugins ?? []));
      setPluginsStatus("ready");
    } catch (error) {
      if (signal?.aborted) return;
      setPluginsStatus("error");
      setPluginsError(error instanceof Error ? error.message : "Failed to load installed market plugins.");
    }
  }

  const effectiveSelectedPluginId = selectedPluginOverride ?? selectedPluginId ?? null;

  useEffect(() => {
    if (!selectedPluginOverride) return;
    if (selectedPluginOverride === selectedPluginId) {
      setSelectedPluginOverride(null);
    }
  }, [selectedPluginId, selectedPluginOverride]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPlugins(controller.signal);
    return () => controller.abort();
  }, []);

  const selectedPlugin = useMemo(() => {
    if (showInstallForm) return null;
    if (plugins.length === 0) return null;
    if (!effectiveSelectedPluginId) return plugins[0];
    return plugins.find((plugin) => plugin.id === effectiveSelectedPluginId) ?? plugins[0];
  }, [effectiveSelectedPluginId, plugins, showInstallForm]);

  useEffect(() => {
    if (showInstallForm || !selectedPlugin) return;
    if (selectedPlugin.id === effectiveSelectedPluginId) return;
    startTransition(() => {
      onSelectPlugin(selectedPlugin.id);
    });
  }, [effectiveSelectedPluginId, onSelectPlugin, selectedPlugin, showInstallForm]);

  const deleteState = selectedPlugin
    ? deleteStateByPlugin[selectedPlugin.id] ?? { state: "idle" as const }
    : { state: "idle" as const };
  const refreshState = selectedPlugin
    ? refreshStateByPlugin[selectedPlugin.id] ?? { state: "idle" as const }
    : { state: "idle" as const };

  function resetInstallDraft(): void {
    setPreview(null);
    setInspectState({ state: "idle" });
    setInstallState({ state: "idle" });
  }

  async function handleInspect(): Promise<void> {
    setInspectState({ state: "saving" });
    setInstallState({ state: "idle" });

    try {
      const response = await fetch("/api/market/plugins/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(installForm),
      });
      const payload = await response.json().catch(() => ({})) as InstalledMarketPluginMutationResponse;
      if (!response.ok || !payload.preview) {
        throw new Error(payload.error || "Failed to inspect market plugin.");
      }
      setPreview(payload.preview);
      setInspectState({ state: "saved", message: "Fetched upstream bundle metadata and host plan." });
    } catch (error) {
      setPreview(null);
      setInspectState({
        state: "error",
        message: error instanceof Error ? error.message : "Failed to inspect market plugin.",
      });
    }
  }

  async function handleInstall(): Promise<void> {
    if (!preview) return;

    setInstallState({ state: "saving" });
    try {
      const response = await fetch("/api/market/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(installForm),
      });
      const payload = await response.json().catch(() => ({})) as InstalledMarketPluginMutationResponse;
      if (!response.ok || !payload.plugin) {
        throw new Error(payload.error || "Failed to install market plugin.");
      }
      const plugin = payload.plugin;

      setPlugins((current) => sortPlugins([...current.filter((entry) => entry.id !== plugin.id), plugin]));
      setInstallState({
        state: "saved",
        message: payload.message || "Installed market plugin.",
      });
      setInstallForm({
        repo: "",
        path: "",
        ref: "main",
      });
      setPreview(null);
      setShowInstallForm(false);
      setSelectedPluginOverride(plugin.id);
      onSelectPlugin(plugin.id);
    } catch (error) {
      setInstallState({
        state: "error",
        message: error instanceof Error ? error.message : "Failed to install market plugin.",
      });
    }
  }

  async function handleRefresh(pluginId: string, action: "update" | "reinstall"): Promise<void> {
    setRefreshStateByPlugin((current) => ({
      ...current,
      [pluginId]: { state: "saving" },
    }));

    try {
      const response = await fetch(`/api/market/plugins/${encodeURIComponent(pluginId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json().catch(() => ({})) as InstalledMarketPluginMutationResponse;
      if (!response.ok || !payload.plugin) {
        throw new Error(payload.error || "Failed to refresh market plugin.");
      }

      setPlugins((current) => sortPlugins(
        current.map((plugin) => (plugin.id === pluginId ? payload.plugin ?? plugin : plugin)),
      ));
      setRefreshStateByPlugin((current) => ({
        ...current,
        [pluginId]: {
          state: "saved",
          message:
            payload.message ||
            (action === "update" ? "Updated from upstream." : "Reinstalled from the pinned local bundle."),
        },
      }));
    } catch (error) {
      setRefreshStateByPlugin((current) => ({
        ...current,
        [pluginId]: {
          state: "error",
          message: error instanceof Error ? error.message : "Failed to refresh market plugin.",
        },
      }));
    }
  }

  async function handleDelete(pluginId: string): Promise<void> {
    setDeleteStateByPlugin((current) => ({
      ...current,
      [pluginId]: { state: "saving" },
    }));

    try {
      const response = await fetch(`/api/market/plugins/${encodeURIComponent(pluginId)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({})) as { message?: string; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to uninstall market plugin.");
      }

      const remaining = plugins.filter((plugin) => plugin.id !== pluginId);
      setPlugins(remaining);
      setDeleteStateByPlugin((current) => ({
        ...current,
        [pluginId]: {
          state: "saved",
          message: payload.message || "Removed market plugin.",
        },
      }));

      if (selectedPlugin?.id === pluginId) {
        const nextSelected = remaining[0]?.id ?? null;
        setSelectedPluginOverride(nextSelected);
        if (nextSelected) {
          onSelectPlugin(nextSelected);
        }
      }
    } catch (error) {
      setDeleteStateByPlugin((current) => ({
        ...current,
        [pluginId]: {
          state: "error",
          message: error instanceof Error ? error.message : "Failed to uninstall market plugin.",
        },
      }));
    }
  }

  if (pluginsStatus === "loading") {
    return (
      <div className="flex min-h-[32rem] items-center justify-center gap-2 rounded-[24px] border border-border bg-white shadow-sm">
        <Spinner size="h-4 w-4" />
        <span className="text-sm text-muted">Loading private market installs...</span>
      </div>
    );
  }

  if (pluginsStatus === "error") {
    return (
      <div className="rounded-[24px] border border-red-200 bg-red-50 p-5 text-sm text-red-800 shadow-sm">
        <p className="font-semibold">Could not load private market installs.</p>
        <p className="mt-2 text-red-700">{pluginsError ?? "Unknown error"}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-[32rem] overflow-hidden rounded-[24px] border border-border bg-white shadow-sm">
      <aside className="flex w-[23rem] shrink-0 flex-col border-r border-border bg-surface/50">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            <Package size={14} />
            Private Market Installs
          </div>
          <p className="mt-2 text-sm text-muted">
            Install third-party plugin bundles privately from upstream, keep the full bundle snapshot under your local ScienceSwarm state, and project usable skills into OpenClaw, Codex, and Claude Code without promoting them into the public catalog.
          </p>
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900">
            <div className="flex items-start gap-2">
              <WarningCircle size={16} className="mt-0.5 shrink-0" />
              <p>
                Third-party bundles may ship scripts and executable files. Inspect the pinned upstream ref before installing and treat local execution as an explicit trust decision.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowInstallForm((current) => !current);
              resetInstallDraft();
            }}
            className="mt-4 inline-flex h-10 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
          >
            {showInstallForm ? "Close installer" : "Install plugin"}
          </button>
        </div>

        {showInstallForm && (
          <div className="border-b border-border bg-white px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Inspect from GitHub</div>
            <div className="mt-3 grid gap-3">
              <label className="grid gap-1">
                <span className="text-xs font-semibold text-foreground">Repo</span>
                <input
                  value={installForm.repo}
                  onChange={(event) => {
                    setInstallForm((current) => ({ ...current, repo: event.target.value }));
                    resetInstallDraft();
                  }}
                  placeholder="owner/repo"
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-semibold text-foreground">Bundle path</span>
                <input
                  value={installForm.path}
                  onChange={(event) => {
                    setInstallForm((current) => ({ ...current, path: event.target.value }));
                    resetInstallDraft();
                  }}
                  placeholder="plugins/life-science-research"
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-semibold text-foreground">Ref</span>
                <input
                  value={installForm.ref}
                  onChange={(event) => {
                    setInstallForm((current) => ({ ...current, ref: event.target.value }));
                    resetInstallDraft();
                  }}
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                />
              </label>
              <p className="rounded-xl border border-border bg-surface px-3 py-2 text-xs text-muted">
                ScienceSwarm stores the exact upstream bundle snapshot under your local <code>SCIENCESWARM_DIR</code>, then activates hosts from that pinned copy. Public workspace promotion stays separate.
              </p>
              <button
                type="button"
                onClick={() => { void handleInspect(); }}
                disabled={
                  inspectState.state === "saving" ||
                  installForm.repo.trim().length === 0 ||
                  installForm.path.trim().length === 0
                }
                className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-white px-4 text-sm font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {inspectState.state === "saving" ? "Inspecting..." : "Inspect bundle"}
              </button>
              <button
                type="button"
                onClick={() => { void handleInstall(); }}
                disabled={installState.state === "saving" || !preview}
                className="inline-flex h-10 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {installState.state === "saving" ? "Installing..." : "Install privately"}
              </button>
              {inspectState.state === "error" && (
                <p className="text-sm text-red-700">{inspectState.message}</p>
              )}
              {inspectState.state === "saved" && (
                <p className="text-sm text-emerald-700">{inspectState.message}</p>
              )}
              {installState.state === "error" && (
                <p className="text-sm text-red-700">{installState.message}</p>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">
          {plugins.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-white px-4 py-5 text-sm text-muted">
              No private market plugins are installed yet.
            </div>
          ) : (
            plugins.map((plugin) => {
              const active = plugin.id === selectedPlugin?.id;
              return (
                <button
                  key={plugin.id}
                  type="button"
                  onClick={() => {
                    setShowInstallForm(false);
                    setSelectedPluginOverride(plugin.id);
                    startTransition(() => {
                      onSelectPlugin(plugin.id);
                    });
                  }}
                  className={`mb-2 block w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
                    active
                      ? "border-accent bg-accent/5"
                      : "border-transparent bg-white hover:border-border hover:bg-surface"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-sm text-foreground">
                      <Package size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-foreground">{plugin.displayName}</div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{plugin.description}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                          {plugin.skills.length} skills
                        </span>
                        <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                          {summarizeTrust(plugin)}
                        </span>
                        {(["openclaw", "codex", "claude-code"] as const).map((host) => (
                          <span
                            key={host}
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${toneForHostStatus(plugin.hosts[host].status)}`}
                          >
                            {host}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {showInstallForm ? (
          <div className="min-h-0 overflow-y-auto p-6">
            {!preview ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-xl text-center">
                  <p className="text-sm font-semibold text-foreground">Inspect a private market plugin</p>
                  <p className="mt-2 text-sm text-muted">
                    Resolve the exact upstream ref first. ScienceSwarm will show the bundle provenance, file-risk summary, and the local OpenClaw, Codex, and Claude Code projections before installing.
                  </p>
                </div>
              </div>
            ) : (
              <div className="min-h-0 overflow-y-auto">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  <Package size={14} />
                  Install Preview
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold text-foreground">{preview.displayName}</h2>
                  <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                    {preview.id}
                  </span>
                  {preview.pluginVersion && (
                    <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      v{preview.pluginVersion}
                    </span>
                  )}
                </div>
                <p className="mt-2 max-w-3xl text-sm text-muted">{preview.description}</p>

                <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
                  <section className="rounded-2xl border border-border bg-surface/40 p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Provenance</h3>
                    <div className="mt-3 grid gap-2 text-sm text-muted">
                      <p><span className="font-semibold text-foreground">Repo:</span> {preview.source.repo}</p>
                      <p><span className="font-semibold text-foreground">Requested ref:</span> {preview.source.requestedRef}</p>
                      <p><span className="font-semibold text-foreground">Resolved commit:</span> <code>{preview.source.resolvedCommit}</code></p>
                      <p><span className="font-semibold text-foreground">Bundle path:</span> <code>{preview.source.path}</code></p>
                      <p><span className="font-semibold text-foreground">License:</span> {preview.license ?? "Not declared"}</p>
                    </div>
                  </section>

                  <section className="rounded-2xl border border-border bg-surface/40 p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Trust Surface</h3>
                    <div className="mt-3 grid gap-2 text-sm text-muted">
                      <p><span className="font-semibold text-foreground">Files:</span> {preview.trust.totalFiles} total</p>
                      <p><span className="font-semibold text-foreground">Scripts:</span> {preview.trust.scriptFileCount}</p>
                      <p><span className="font-semibold text-foreground">Executable files:</span> {preview.trust.executableFileCount}</p>
                      <p><span className="font-semibold text-foreground">Detected runtimes:</span> {preview.trust.detectedRuntimes.join(", ") || "None inferred"}</p>
                      <p><span className="font-semibold text-foreground">Examples:</span> {preview.trust.scriptFiles.slice(0, 3).join(", ") || "No script-like files detected"}</p>
                    </div>
                  </section>
                </div>

                <section className="mt-4 rounded-2xl border border-border bg-surface/40 p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Host Projections</h3>
                  <div className="mt-4 grid gap-3 lg:grid-cols-3">
                    {([
                      ["openclaw", preview.hosts.openclaw],
                      ["codex", preview.hosts.codex],
                      ["claude-code", preview.hosts["claude-code"]],
                    ] as const).map(([host, details]) => (
                      <div key={host} className="rounded-xl border border-border bg-white px-3 py-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{host}</p>
                        <p className="mt-2 text-xs text-muted"><span className="font-semibold text-foreground">Install root:</span> <code>{details.installRoot}</code></p>
                        <div className="mt-3 grid gap-2">
                          {details.projectedSkills.map((projection) => (
                            <div key={`${host}-${projection.sourceSlug}`} className="rounded-lg border border-border bg-surface/60 px-2.5 py-2">
                              <p className="text-xs font-semibold text-foreground">
                                {projection.sourceSlug}
                                {projection.mode === "aliased" && (
                                  <span className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-amber-800">
                                    aliased as {projection.hostSlug}
                                  </span>
                                )}
                              </p>
                              <p className="mt-1 text-[11px] text-muted"><code>{projection.installPath}</code></p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            )}
          </div>
        ) : !selectedPlugin ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-lg text-center">
              <p className="text-sm font-semibold text-foreground">No private market plugin selected</p>
              <p className="mt-2 text-sm text-muted">
                Installed bundles stay user-local and are kept separate from the repo-backed workspace skill catalog.
              </p>
            </div>
          </div>
        ) : (
          <div className="min-h-0 overflow-y-auto p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  <Package size={14} />
                  Installed Plugin Bundle
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-xl font-semibold text-foreground">{selectedPlugin.displayName}</h2>
                  <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                    {selectedPlugin.id}
                  </span>
                  {selectedPlugin.pluginVersion && (
                    <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      v{selectedPlugin.pluginVersion}
                    </span>
                  )}
                </div>
                <p className="mt-2 max-w-3xl text-sm text-muted">{selectedPlugin.description}</p>
                <p className="mt-3 text-xs text-muted">
                  Private installs are kept outside the repo workspace skill tree, stored under your local ScienceSwarm data root, and never update <code>skills/public-index.json</code> automatically.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { void handleRefresh(selectedPlugin.id, "update"); }}
                  disabled={refreshState.state === "saving"}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowsClockwise size={16} />
                  Update from upstream
                </button>
                <button
                  type="button"
                  onClick={() => { void handleRefresh(selectedPlugin.id, "reinstall"); }}
                  disabled={refreshState.state === "saving"}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowsClockwise size={16} />
                  Reinstall hosts
                </button>
                <button
                  type="button"
                  onClick={() => { void handleDelete(selectedPlugin.id); }}
                  disabled={deleteState.state === "saving"}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-4 text-sm font-semibold text-red-900 transition-colors hover:border-red-400 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash size={16} />
                  {deleteState.state === "saving" ? "Removing..." : "Uninstall plugin"}
                </button>
              </div>
            </div>

            {refreshState.state === "saved" && (
              <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <CheckCircle size={18} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold">Plugin refreshed.</p>
                  <p className="mt-1 text-emerald-700">{refreshState.message}</p>
                </div>
              </div>
            )}

            {refreshState.state === "error" && (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                <p className="font-semibold">Refresh failed.</p>
                <p className="mt-1 text-red-700">{refreshState.message}</p>
              </div>
            )}

            {deleteState.state === "saved" && (
              <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <CheckCircle size={18} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-semibold">Plugin removed.</p>
                  <p className="mt-1 text-emerald-700">{deleteState.message}</p>
                </div>
              </div>
            )}

            {deleteState.state === "error" && (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                <p className="font-semibold">Remove failed.</p>
                <p className="mt-1 text-red-700">{deleteState.message}</p>
              </div>
            )}

            <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
              <section className="rounded-2xl border border-border bg-surface/40 p-4">
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Provenance</h3>
                <div className="mt-3 grid gap-2 text-sm text-muted">
                  <p><span className="font-semibold text-foreground">Repo:</span> {selectedPlugin.source.repo}</p>
                  <p><span className="font-semibold text-foreground">Requested ref:</span> {selectedPlugin.source.requestedRef}</p>
                  <p><span className="font-semibold text-foreground">Resolved commit:</span> <code>{selectedPlugin.source.resolvedCommit}</code></p>
                  <p><span className="font-semibold text-foreground">Bundle path:</span> <code>{selectedPlugin.source.path}</code></p>
                  <p><span className="font-semibold text-foreground">Snapshot:</span> <code>{selectedPlugin.bundlePath}</code></p>
                  <p><span className="font-semibold text-foreground">Installed at:</span> {selectedPlugin.installedAt}</p>
                  <p><span className="font-semibold text-foreground">Last refreshed:</span> {selectedPlugin.updatedAt ?? "Not yet refreshed"}</p>
                  <p><span className="font-semibold text-foreground">License:</span> {selectedPlugin.license ?? "Not declared"}</p>
                </div>
              </section>

              <section className="rounded-2xl border border-border bg-surface/40 p-4">
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Trust Surface</h3>
                <div className="mt-3 grid gap-2 text-sm text-muted">
                  <p><span className="font-semibold text-foreground">Files:</span> {selectedPlugin.trust.totalFiles} total</p>
                  <p><span className="font-semibold text-foreground">Scripts:</span> {selectedPlugin.trust.scriptFileCount}</p>
                  <p><span className="font-semibold text-foreground">Executable files:</span> {selectedPlugin.trust.executableFileCount}</p>
                  <p><span className="font-semibold text-foreground">Agents:</span> {selectedPlugin.trust.agentFileCount}</p>
                  <p><span className="font-semibold text-foreground">References:</span> {selectedPlugin.trust.referenceFileCount}</p>
                  <p><span className="font-semibold text-foreground">Assets:</span> {selectedPlugin.trust.assetFileCount}</p>
                  <p><span className="font-semibold text-foreground">Detected runtimes:</span> {selectedPlugin.trust.detectedRuntimes.join(", ") || "None inferred"}</p>
                  <p><span className="font-semibold text-foreground">Examples:</span> {selectedPlugin.trust.scriptFiles.slice(0, 5).join(", ") || "No script-like files detected"}</p>
                </div>
              </section>
            </div>

            <section className="mt-4 rounded-2xl border border-border bg-surface/40 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Host Activation</h3>
              <div className="mt-4 grid gap-3 lg:grid-cols-3">
                {([
                  ["openclaw", selectedPlugin.hosts.openclaw],
                  ["codex", selectedPlugin.hosts.codex],
                  ["claude-code", selectedPlugin.hosts["claude-code"]],
                ] as const).map(([host, details]) => (
                  <div key={host} className="rounded-xl border border-border bg-white px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{host}</p>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${toneForHostStatus(details.status)}`}>
                        {details.status}
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] text-muted"><span className="font-semibold text-foreground">Install root:</span> <code>{details.installRoot}</code></p>
                    <div className="mt-3 grid gap-2">
                      {details.projectedSkills.map((projection) => (
                        <div key={`${host}-${projection.hostSlug}`} className="rounded-lg border border-border bg-surface/60 px-2.5 py-2">
                          <p className="text-xs font-semibold text-foreground">
                            {projection.hostSlug}
                            {projection.mode === "aliased" && (
                              <span className="ml-2 text-[10px] uppercase tracking-[0.12em] text-amber-800">
                                alias for {projection.sourceSlug}
                              </span>
                            )}
                          </p>
                          <p className="mt-1 text-[11px] text-muted"><code>{projection.installPath}</code></p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="mt-4 rounded-2xl border border-border bg-surface/40 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Bundled Skills</h3>
              <p className="mt-2 text-sm text-muted">
                {selectedPlugin.skills.length} skills were discovered inside the bundle.
              </p>
              <div className="mt-4 grid gap-2 md:grid-cols-2">
                {selectedPlugin.skills.map((skill) => (
                  <div key={skill.slug} className="rounded-xl border border-border bg-white px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{skill.slug}</span>
                      {skill.runtime && (
                        <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                          {skill.runtime}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted">{skill.description}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
