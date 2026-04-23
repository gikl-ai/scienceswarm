"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectWatchConfig } from "@/lib/watch/types";
import { OpenClawSection } from "@/components/setup/openclaw-section";
import { DEFAULT_OPENAI_MODEL } from "@/lib/openai-models";
import { OLLAMA_RECOMMENDED_MODEL } from "@/lib/ollama-constants";
import {
  hasRecommendedOllamaModel,
  normalizeInstalledOllamaModels,
  ollamaModelsMatch,
} from "@/lib/ollama-models";
import { StatusDot } from "./sections/_primitives";
import { IdentitySection } from "./sections/identity";
import { SetupAndConfigurationSection } from "./sections/setup-and-configuration";
import { ApiKeysAndModelSection } from "./sections/api-keys-and-model";
import { LocalModelSection } from "./sections/local-model";
import { TelegramOpenClawSection } from "./sections/telegram-openclaw";
import { FrontierWatchSection } from "./sections/frontier-watch";
import { ResearchRadarSection } from "./sections/research-radar";
import { WorkspaceDisplaySection } from "./sections/workspace-display";
import { ProjectRuntimeSection } from "./sections/project-runtime";
import { useFilePreviewLocation } from "@/hooks/use-file-preview-location";
import {
  RuntimeHostMatrix,
  type RuntimeHealthResponse,
} from "@/components/runtime/RuntimeHostMatrix";
import { RuntimeSetupCallouts } from "@/components/runtime/RuntimeSetupCallouts";
import {
  readLastProjectSlug,
  safeProjectSlugOrNull,
} from "@/lib/project-navigation";

/* ---------- types ---------- */

type LlmProvider = "openai" | "local";

interface Settings {
  agent: string;
  agentUrl: string;
  agentApiKey: string | null;
  openaiKey: string | null;
  llmModel: string;
  llmProvider: LlmProvider;
  strictLocalOnly?: boolean;
  ollamaUrl: string;
  ollamaModel: string;
  userHandle: string;
  userEmail: string;
  telegramPhone: string;
  telegram: {
    botToken: string | null;
    configured: boolean;
    paired?: boolean;
    username?: string | null;
    creature?: string | null;
    userId?: string | null;
    pendingPairing?: {
      userId: string;
      username?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      createdAt?: string | null;
      lastSeenAt?: string | null;
    } | null;
  };
  slack: {
    botToken: string | null;
    signingSecret: string | null;
    configured: boolean;
  };
}

interface HealthStatus {
  openhands: "connected" | "disconnected";
  openclaw: "connected" | "disconnected";
  openai: "configured" | "missing" | "disabled";
  ollama: "connected" | "disconnected";
  ollamaModels: string[];
  database: string;
  agent: string;
  llmProvider: LlmProvider;
  strictLocalOnly?: boolean;
}

interface LocalHealthStatus {
  running: boolean;
  models: string[];
  url: string;
  hostPlatform?: string;
  hostArchitecture?: string;
  binaryInstalled: boolean;
  binaryPath?: string | null;
  binaryVersion?: string | null;
  binaryArchitecture?: string | null;
  binaryCompatible?: boolean;
  reinstallRecommended?: boolean;
  preferredInstaller?: string;
  installCommand?: string | null;
  startCommand?: string | null;
  installHint?: string;
  installUrl?: string;
  serviceManager?: string;
}

interface OpenClawSetupStatus {
  installed: boolean;
  configured: boolean;
  running: boolean;
  version: string | null;
  model: string | null;
  configPath: string | null;
  source?: "system" | "external" | "none";
  steps: { install: boolean; configure: boolean; start: boolean };
}

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

type PendingTelegramPairing =
  NonNullable<NonNullable<Settings["telegram"]["pendingPairing"]>>;

const OLLAMA_PULL_STORAGE_KEY = "scienceswarm.settings.activeOllamaPull";

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

function parseStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function resolveConfiguredOllamaModel(settings: Settings | null): string {
  return settings?.ollamaModel?.trim() || OLLAMA_RECOMMENDED_MODEL;
}

/* ---------- Toast ---------- */

function Toast({
  message,
  type,
  onClose,
}: {
  message: string;
  type: "success" | "error";
  onClose: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div
      className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
        type === "success"
          ? "bg-emerald-500 text-white"
          : "bg-red-500 text-white"
      }`}
    >
      {message}
    </div>
  );
}


/* ---------- Main Page ---------- */

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealthResponse | null>(null);
  const [localHealth, setLocalHealth] = useState<LocalHealthStatus | null>(null);
  const [openclawSetup, setOpenclawSetup] = useState<OpenClawSetupStatus | null>(null);
  const [llmProviderDraft, setLlmProviderDraft] = useState<LlmProvider>("local");
  const [llmModelDraft, setLlmModelDraft] = useState(DEFAULT_OPENAI_MODEL);
  const [openAiKeyDraft, setOpenAiKeyDraft] = useState("");
  const [runtimeProject, setRuntimeProject] = useState("");
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [watchProject, setWatchProject] = useState("");
  const [watchConfig, setWatchConfig] = useState<ProjectWatchConfig>(createDefaultWatchConfig());
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchSaving, setWatchSaving] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const [filePreviewLocation, setFilePreviewLocation] = useFilePreviewLocation();

  /* loading states */
  const [saving, setSaving] = useState<string | null>(null);

  // Timer refs for cleanup on unmount
  const pullIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pullTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up all polling timers on unmount
  useEffect(() => {
    return () => {
      if (pullIntervalRef.current) clearInterval(pullIntervalRef.current);
      if (pullTimeoutRef.current) clearTimeout(pullTimeoutRef.current);
    };
  }, []);

  const showToast = useCallback(
    (message: string, type: "success" | "error") => {
      setToast({ message, type });
    },
    [],
  );

  useEffect(() => {
    if (!settings) return;
    setLlmProviderDraft(settings.llmProvider);
    setLlmModelDraft(settings.llmModel);
    setOpenAiKeyDraft("");
  }, [settings]);

  /* ---------- fetch settings ---------- */

  const fetchPendingTelegramPairing = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/telegram");
      if (!res.ok) return;
      const data = (await res.json()) as {
        pendingPairing?: PendingTelegramPairing | null;
      };
      setSettings((current) => {
        if (!current) return current;
        if (current.telegram.paired || current.telegram.userId) {
          return current;
        }

        const nextPendingPairing = data.pendingPairing ?? null;
        const currentPendingPairing = current.telegram.pendingPairing ?? null;
        if (
          currentPendingPairing?.userId === nextPendingPairing?.userId
          && currentPendingPairing?.lastSeenAt === nextPendingPairing?.lastSeenAt
          && currentPendingPairing?.createdAt === nextPendingPairing?.createdAt
        ) {
          return current;
        }

        return {
          ...current,
          telegram: {
            ...current.telegram,
            pendingPairing: nextPendingPairing,
          },
        };
      });
    } catch {
      // ignore optional Telegram status fetch failures
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const data = (await res.json()) as Settings;
      setSettings(data);
    } catch {
      // server not reachable
    }
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "health" }),
      });
      if (!res.ok) return;
      setHealth((await res.json()) as HealthStatus);
    } catch {
      // ignore
    }
  }, []);

  const fetchRuntimeHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/runtime/health", { cache: "no-store" });
      if (!res.ok) return;
      setRuntimeHealth((await res.json()) as RuntimeHealthResponse);
    } catch {
      // ignore
    }
  }, []);

  const fetchOpenclaw = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/openclaw");
      if (!res.ok) return;
      setOpenclawSetup((await res.json()) as OpenClawSetupStatus);
    } catch {
      // ignore
    }
  }, []);

  const fetchLocalHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "local-health" }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as LocalHealthStatus;
      setLocalHealth(data);
    } catch {
      // ignore
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) return;
      const data = (await res.json()) as ProjectListResult;
      const projects = Array.isArray(data.projects)
        ? data.projects
            .filter(
              (project): project is { slug: string; name: string } =>
                Boolean(
                  project
                  && typeof project.slug === "string"
                  && project.slug.trim().length > 0
                  && typeof project.name === "string"
                  && project.name.trim().length > 0,
                ),
            )
            .map((project) => ({
              id: project.slug.trim(),
              name: project.name.trim(),
            }))
        : [];
      const rememberedProject = readLastProjectSlug();
      const initialProject = projects.some((project) => project.id === rememberedProject)
        ? rememberedProject ?? ""
        : projects[0]?.id ?? "";
      setProjectOptions(projects);
      setRuntimeProject((current) => current || initialProject);
      setWatchProject((current) => current || initialProject);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const project = safeProjectSlugOrNull(
      new URLSearchParams(window.location.search).get("project"),
    );
    if (project) {
      setRuntimeProject(project);
      setWatchProject(project);
    }
  }, []);

  const fetchWatchConfig = useCallback(async (project: string, signal?: AbortSignal) => {
    if (!project.trim()) {
      setWatchConfig(createDefaultWatchConfig());
      setWatchError(null);
      return;
    }

    setWatchLoading(true);
    setWatchError(null);
    try {
      const res = await fetch(`/api/brain/watch-config?project=${encodeURIComponent(project)}`, {
        signal,
      });
      const data = (await res.json()) as {
        config?: ProjectWatchConfig;
        error?: string;
      };
      if (!res.ok || !data.config) {
        setWatchConfig(createDefaultWatchConfig());
        setWatchError(data.error || "Failed to load watch config");
        return;
      }
      setWatchConfig(data.config);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      setWatchConfig(createDefaultWatchConfig());
      setWatchError("Failed to load watch config");
    } finally {
      if (!signal?.aborted) {
        setWatchLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchHealth();
    fetchRuntimeHealth();
    fetchOpenclaw();
    fetchProjects();
    fetchLocalHealth();

    const interval = setInterval(() => {
      fetchHealth();
      fetchRuntimeHealth();
      fetchOpenclaw();
      fetchLocalHealth();
    }, 10_000);

    return () => clearInterval(interval);
  }, [
    fetchSettings,
    fetchHealth,
    fetchRuntimeHealth,
    fetchOpenclaw,
    fetchProjects,
    fetchLocalHealth,
  ]);

  useEffect(() => {
    if (!watchProject.trim()) {
      setWatchLoading(false);
      fetchWatchConfig(watchProject);
      return;
    }

    const controller = new AbortController();
    fetchWatchConfig(watchProject, controller.signal);
    return () => controller.abort();
  }, [fetchWatchConfig, watchProject]);

  /* ---------- actions ---------- */

  async function postSettings(payload: Record<string, unknown>) {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json() as Promise<Record<string, unknown>>;
  }

  async function postOpenClawAction(action: "configure" | "start" | "stop") {
    const res = await fetch("/api/settings/openclaw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || data.ok === false) {
      throw new Error(
        typeof data.error === "string" && data.error.trim().length > 0
          ? data.error
          : `OpenClaw ${action} failed`,
      );
    }
    return data;
  }

  async function saveStrictLocalOnly(enabled: boolean) {
    setSaving("strict-local-only");
    try {
      const data = await postSettings({ action: "save-strict-local-only", enabled });
      if (data.ok) {
        if (enabled) {
          setLlmProviderDraft("local");
        }
        showToast(
          enabled ? "Strict local-only mode enabled" : "Strict local-only mode disabled",
          "success",
        );
        fetchSettings();
        fetchHealth();
        fetchRuntimeHealth();
      } else {
        showToast(String(data.error || "Failed to update strict local-only mode"), "error");
      }
    } catch {
      showToast("Network error", "error");
    } finally {
      setSaving(null);
    }
  }

  async function verifyOpenAiKey() {
    if (llmProviderDraft !== "openai") {
      showToast("Switch to OpenAI first to verify the API key.", "error");
      return;
    }

    setSaving("verify-openai-key");
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          openAiKeyDraft.trim()
            ? { action: "test-key", key: openAiKeyDraft.trim() }
            : { action: "test-key" },
        ),
      });
      const data = (await res.json()) as { valid?: unknown; error?: unknown };
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Key validation failed");
      }
      if (data.valid === true) {
        showToast("OpenAI key verified", "success");
      } else {
        showToast(
          typeof data.error === "string" ? data.error : "OpenAI key verification failed",
          "error",
        );
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Key validation failed", "error");
    } finally {
      setSaving(null);
    }
  }

  async function applyRuntimeSettings() {
    const provider = llmProviderDraft;
    const model = llmModelDraft.trim();
    const key = openAiKeyDraft.trim();
    const localModel = resolveConfiguredOllamaModel(settings);
    const hasSavedKey = Boolean(settings?.openaiKey);
    const shouldApplyToOpenClaw =
      Boolean(openclawSetup?.installed) || health?.openclaw === "connected";

    if (provider === "openai") {
      if (!model) {
        showToast("Choose an OpenAI model first.", "error");
        return;
      }
      if (!key && !hasSavedKey) {
        showToast("Add an OpenAI API key before applying the OpenAI runtime.", "error");
        return;
      }
    }

    setSaving("apply-runtime");
    try {
      if (key) {
        const keySave = await postSettings({ action: "save-key", key });
        if (keySave.ok !== true) {
          throw new Error(String(keySave.error || "Failed to save OpenAI API key"));
        }
      }

      const providerSave = await postSettings({ action: "save-provider", provider });
      if (providerSave.ok !== true) {
        throw new Error(String(providerSave.error || "Failed to save LLM provider"));
      }

      if (provider === "openai") {
        const modelSave = await postSettings({ action: "save-model", model });
        if (modelSave.ok !== true) {
          throw new Error(String(modelSave.error || "Failed to save OpenAI model"));
        }
      } else {
        const localModelSave = await postSettings({
          action: "save-ollama-model",
          ollamaModel: localModel,
        });
        if (localModelSave.ok !== true) {
          throw new Error(String(localModelSave.error || "Failed to save local Ollama model"));
        }
      }

      if (shouldApplyToOpenClaw) {
        const openclawWasRunning =
          Boolean(openclawSetup?.running) || health?.openclaw === "connected";
        await postOpenClawAction("configure");
        if (openclawWasRunning) {
          await postOpenClawAction("stop");
        }
        await postOpenClawAction("start");
      }

      setOpenAiKeyDraft("");
      await Promise.all([
        fetchSettings(),
        fetchHealth(),
        fetchRuntimeHealth(),
        fetchOpenclaw(),
      ]);

      if (shouldApplyToOpenClaw) {
        showToast(
          provider === "openai"
            ? "OpenAI runtime saved and applied to OpenClaw"
            : "Local runtime saved and applied to OpenClaw",
          "success",
        );
      } else {
        showToast(
          provider === "openai"
            ? "OpenAI runtime saved. Install OpenClaw below to use the agent path."
            : "Local runtime saved. Install OpenClaw below to use the agent path.",
          "success",
        );
      }
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : "Failed to save runtime settings",
        "error",
      );
    } finally {
      setSaving(null);
    }
  }

  const handleConfiguredLocalModelChange = useCallback((model: string) => {
    setSettings((current) => {
      if (!current) return current;
      return { ...current, ollamaModel: model };
    });
  }, []);

  const handleLocalModelReady = useCallback((_model: string) => {
    void fetchHealth();
    void fetchLocalHealth();
  }, [fetchHealth, fetchLocalHealth]);

  const strictLocalOnlyEnabled = settings?.strictLocalOnly ?? health?.strictLocalOnly ?? false;

  const persistActiveOllamaPull = useCallback((model: string | null) => {
    try {
      if (model) {
        window.localStorage.setItem(OLLAMA_PULL_STORAGE_KEY, model);
      } else {
        window.localStorage.removeItem(OLLAMA_PULL_STORAGE_KEY);
      }
    } catch {
      // ignore storage failures
    }
  }, []);

  const clearOllamaPullTimers = useCallback(() => {
    if (pullIntervalRef.current) clearInterval(pullIntervalRef.current);
    if (pullTimeoutRef.current) clearTimeout(pullTimeoutRef.current);
    pullIntervalRef.current = null;
    pullTimeoutRef.current = null;
  }, []);

  const clearActiveOllamaPull = useCallback(() => {
    clearOllamaPullTimers();
    persistActiveOllamaPull(null);
  }, [clearOllamaPullTimers, persistActiveOllamaPull]);

  const pollOllamaPullStatus = useCallback(async (model: string) => {
    try {
      const statusData = await postSettings({ action: "pull-status", ollamaModel: model });
      const activePulls = parseStringList(statusData.activePulls);
      const installedModels = parseStringList(statusData.models);
      const installed = installedModels.some((installedModel) => ollamaModelsMatch(model, installedModel));
      const stillPulling = statusData.pulling === true || activePulls.includes(model);

      if (stillPulling) {
        persistActiveOllamaPull(model);
        return;
      }

      clearActiveOllamaPull();
      await fetchHealth();
      await fetchLocalHealth();

      if (installed) {
        showToast(`Model ${model} ready`, "success");
      } else if (typeof statusData.error === "string" && statusData.error.trim().length > 0) {
        showToast(statusData.error, "error");
      } else {
        showToast(`Model ${model} pull stopped before completion`, "error");
      }
    } catch {
      // Keep polling on transient local network failures.
    }
  }, [clearActiveOllamaPull, fetchHealth, fetchLocalHealth, persistActiveOllamaPull, showToast]);

  const beginOllamaPullTracking = useCallback((model: string, announceStart = true) => {
    clearOllamaPullTimers();
    persistActiveOllamaPull(model);

    if (announceStart) {
      showToast(`Pulling ${model}... This may take a few minutes.`, "success");
    }

    pullIntervalRef.current = setInterval(() => {
      void pollOllamaPullStatus(model);
    }, 5000);

    void pollOllamaPullStatus(model);
  }, [clearOllamaPullTimers, persistActiveOllamaPull, pollOllamaPullStatus, showToast]);

  const resumeOllamaPull = useCallback(async () => {
    let storedModel: string | null = null;
    try {
      storedModel = window.localStorage.getItem(OLLAMA_PULL_STORAGE_KEY)?.trim() || null;
    } catch {
      storedModel = null;
    }

    try {
      const statusData = await postSettings(
        storedModel
          ? { action: "pull-status", ollamaModel: storedModel }
          : { action: "pull-status" },
      );
      const activePulls = parseStringList(statusData.activePulls);
      const installedModels = parseStringList(statusData.models);
      const resumedModel =
        activePulls[0]
        || (storedModel && statusData.pulling === true ? storedModel : null);

      if (!resumedModel) {
        if (storedModel) {
          if (installedModels.some((installedModel) => ollamaModelsMatch(storedModel, installedModel))) {
            showToast(`Model ${storedModel} ready`, "success");
          } else if (typeof statusData.error === "string" && statusData.error.trim().length > 0) {
            showToast(statusData.error, "error");
          } else {
            showToast(`Model ${storedModel} is not downloading anymore. Click Pull Model to resume.`, "error");
          }
          persistActiveOllamaPull(null);
        }
        return;
      }

      beginOllamaPullTracking(resumedModel, false);
    } catch {
      // ignore initial resume failures
    }
  }, [beginOllamaPullTracking, persistActiveOllamaPull, showToast]);

  useEffect(() => {
    void resumeOllamaPull();
  }, [resumeOllamaPull]);

  useEffect(() => {
    if (!runtimeProject && projectOptions.length > 0) {
      const rememberedProject = readLastProjectSlug();
      const fallbackProject = projectOptions.some((project) => project.id === rememberedProject)
        ? rememberedProject ?? ""
        : projectOptions[0]?.id ?? "";
      if (fallbackProject) {
        setRuntimeProject(fallbackProject);
      }
    }
  }, [projectOptions, runtimeProject]);

  async function saveWatchConfig() {
    if (!watchProject.trim()) {
      showToast("Choose a project slug before saving watch config", "error");
      return;
    }

    setWatchSaving(true);
    setWatchError(null);
    try {
      const res = await fetch("/api/brain/watch-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: watchProject.trim(),
          config: watchConfig,
        }),
      });
      const data = (await res.json()) as {
        config?: ProjectWatchConfig;
        error?: string;
      };
      if (!res.ok || !data.config) {
        const message = data.error || "Failed to save watch config";
        setWatchError(message);
        showToast(message, "error");
        return;
      }

      setWatchConfig(data.config);
      showToast(`Saved watch config for ${watchProject.trim()}`, "success");
    } catch {
      setWatchError("Failed to save watch config");
      showToast("Failed to save watch config", "error");
    } finally {
      setWatchSaving(false);
    }
  }

  /* ---------- render ---------- */

  const inputCls =
    "w-full bg-background border-2 border-border rounded-lg px-4 py-2.5 text-sm font-mono focus:outline-none focus:border-accent transition-colors";
  const btnPrimary =
    "bg-accent text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-40";
  const btnSecondary =
    "border-2 border-border text-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-surface-hover transition-colors disabled:opacity-40";
  const openclawRunning = openclawSetup?.running || health?.openclaw === "connected";
  const installedOllamaModels = normalizeInstalledOllamaModels([
    ...parseStringList(health?.ollamaModels),
    ...parseStringList(localHealth?.models),
  ]);
  const configuredOllamaModel = resolveConfiguredOllamaModel(settings);
  const openclawHealthSummary = (() => {
    if (openclawRunning) {
      return { label: "running", dot: "ok" as const };
    }
    if (openclawSetup?.configured) {
      return { label: "configured, not running", dot: "warn" as const };
    }
    if (openclawSetup?.installed) {
      return { label: "installed, not configured", dot: "warn" as const };
    }
    if (openclawSetup) {
      return { label: "not installed", dot: "off" as const };
    }
    if (health?.openclaw === "connected") {
      return { label: "connected", dot: "ok" as const };
    }
    return { label: "checking", dot: "off" as const };
  })();
  const configuredOllamaModelInstalled = installedOllamaModels.some((model) =>
    ollamaModelsMatch(configuredOllamaModel, model),
  );
  const ollamaHealthSummary = (() => {
    if (health?.ollama === "connected" || localHealth?.running) {
      return {
        label: configuredOllamaModelInstalled
          ? `${configuredOllamaModel} ready`
          : `${configuredOllamaModel} selected, pull pending`,
        dot: configuredOllamaModelInstalled ? ("ok" as const) : ("warn" as const),
      };
    }
    if (localHealth?.binaryInstalled === false) {
      return { label: "not installed", dot: "off" as const };
    }
    if (localHealth?.binaryInstalled === true) {
      return { label: "installed, stopped", dot: "warn" as const };
    }
    return { label: "checking", dot: "off" as const };
  })();
  const openclawCardStatus = openclawSetup
    ? {
        installed: openclawSetup.installed,
        configured: openclawSetup.configured,
        running: openclawSetup.running,
      }
    : null;
  const ollamaCardStatus =
    health !== null || localHealth !== null
      ? {
          installed: localHealth?.binaryInstalled ?? false,
          running: Boolean(localHealth?.running || health?.ollama === "connected"),
          hasRecommendedModel: hasRecommendedOllamaModel(installedOllamaModels),
          models: installedOllamaModels,
          installCommand: localHealth?.installCommand ?? undefined,
          startCommand: localHealth?.startCommand ?? undefined,
        }
      : null;

  return (
    <div className="p-8 max-w-6xl space-y-6">
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted text-sm mt-1">
          Review runtime, API keys, and onboarding status
        </p>
        <div
          className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted"
          role="status"
          aria-label="Service health"
        >
          {health ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <StatusDot status={strictLocalOnlyEnabled ? "ok" : "warn"} />
                <span className="text-muted">Mode</span>
                <span className="text-foreground">{strictLocalOnlyEnabled ? "strict local-only" : "standard"}</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <StatusDot status={openclawHealthSummary.dot} />
                <span className="text-muted">OpenClaw</span>
                <span className="text-foreground">{openclawHealthSummary.label}</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <StatusDot status={ollamaHealthSummary.dot} />
                <span className="text-muted">Ollama</span>
                <span className="text-foreground">{ollamaHealthSummary.label}</span>
              </span>
            </>
          ) : (
            <span>Loading health status...</span>
          )}
        </div>
      </div>

      <IdentitySection
        initialValues={
          settings
            ? {
                userHandle: settings.userHandle,
                userEmail: settings.userEmail,
              }
            : null
        }
        inputClassName={inputCls}
        onSaved={fetchSettings}
      />

      <WorkspaceDisplaySection
        filePreviewLocation={filePreviewLocation}
        onFilePreviewLocationChange={setFilePreviewLocation}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] xl:items-start">
        <div className="space-y-6">
          <SetupAndConfigurationSection
            strictLocalOnlyEnabled={strictLocalOnlyEnabled}
            saving={saving}
            buttonClassName={btnSecondary}
            onToggleStrictLocalOnly={saveStrictLocalOnly}
          />

          {settings && (
            <ApiKeysAndModelSection
              provider={llmProviderDraft}
              model={llmModelDraft}
              openAiKey={openAiKeyDraft}
              savedOpenAiKeyMasked={settings.openaiKey}
              strictLocalOnlyEnabled={strictLocalOnlyEnabled}
              openclawModel={openclawSetup?.model ?? null}
              openclawInstalled={Boolean(openclawSetup?.installed)}
              openclawRunning={openclawRunning}
              saving={saving}
              inputClassName={inputCls}
              primaryButtonClassName={btnPrimary}
              secondaryButtonClassName={btnSecondary}
              onProviderChange={setLlmProviderDraft}
              onModelChange={setLlmModelDraft}
              onOpenAiKeyChange={setOpenAiKeyDraft}
              onVerifyKey={verifyOpenAiKey}
              onApplyRuntime={applyRuntimeSettings}
            />
          )}

          <LocalModelSection
            ollamaCardStatus={ollamaCardStatus}
            configuredOllamaModel={configuredOllamaModel}
            configuredOllamaModelInstalled={configuredOllamaModelInstalled}
            saving={saving}
            onConfiguredModelChange={handleConfiguredLocalModelChange}
            onLocalModelReady={handleLocalModelReady}
          />
        </div>

        <div className="space-y-6">
          {/* ---- 2. OpenClaw backend ---- */}
          <OpenClawSection
            initialStatus={openclawCardStatus}
            initialStatusLoading={openclawSetup === null}
            initialBackend="openclaw"
            hasOpenAiKey={openAiKeyDraft.trim().length > 0}
            hasSavedOpenAiKey={Boolean(settings?.openaiKey)}
            llmProvider={settings?.llmProvider ?? "local"}
            showBackendChoice={false}
            showNanoClawFallback={false}
            disabled={saving !== null}
            autoStart
          />

          {settings && (
            <TelegramOpenClawSection
              userHandle={settings.userHandle}
              userEmail={settings.userEmail}
              initialPhone={settings.telegramPhone}
              telegram={settings.telegram}
              openclawInstalled={Boolean(openclawSetup?.installed)}
              openclawSource={openclawSetup?.source}
              inputClassName={inputCls}
              primaryButtonClassName={btnPrimary}
              secondaryButtonClassName={btnSecondary}
              onRefreshPendingPairing={fetchPendingTelegramPairing}
              onUpdated={() => {
                void Promise.all([
                  fetchSettings(),
                  fetchHealth(),
                  fetchOpenclaw(),
                ]);
              }}
            />
          )}
        </div>
      </div>

      <ProjectRuntimeSection
        key={runtimeProject || "no-project"}
        projectOptions={projectOptions}
        projectId={runtimeProject}
        runtimeHealth={runtimeHealth}
        onProjectChange={setRuntimeProject}
      />

      <RuntimeHostMatrix runtimeHealth={runtimeHealth} />

      {runtimeHealth && (
        <RuntimeSetupCallouts hosts={runtimeHealth.hosts} />
      )}

      <FrontierWatchSection
        projectOptions={projectOptions}
        watchProject={watchProject}
        onWatchProjectChange={setWatchProject}
        watchConfig={watchConfig}
        setWatchConfig={setWatchConfig}
        watchLoading={watchLoading}
        watchSaving={watchSaving}
        watchError={watchError}
        onSave={saveWatchConfig}
        inputClassName={inputCls}
        primaryButtonClassName={btnPrimary}
        secondaryButtonClassName={btnSecondary}
      />

      <ResearchRadarSection
        inputClassName={inputCls}
        primaryButtonClassName={btnPrimary}
      />
    </div>
  );
}
