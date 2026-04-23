import type { RuntimeProjectPolicy } from "@/lib/runtime-hosts/contracts";

export type RuntimeProjectMode = "chat" | "task" | "compare";

export interface RuntimeProjectPreferences {
  projectPolicy: RuntimeProjectPolicy;
  mode: RuntimeProjectMode;
  selectedHostId: string;
  compareHostIds: string[];
}

const STORAGE_KEY_PREFIX = "scienceswarm.runtime.project";

export const DEFAULT_RUNTIME_PROJECT_PREFERENCES: RuntimeProjectPreferences = {
  projectPolicy: "local-only",
  mode: "chat",
  selectedHostId: "openclaw",
  compareHostIds: ["openclaw"],
};

function normalizeCompareHostIds(value: unknown): string[] {
  const hostIds = Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  if (hostIds.length === 0) {
    return ["openclaw"];
  }

  return Array.from(new Set(hostIds));
}

function normalizeProjectPolicy(value: unknown): RuntimeProjectPolicy {
  return value === "cloud-ok" || value === "execution-ok" || value === "local-only"
    ? value
    : "local-only";
}

function normalizeMode(value: unknown): RuntimeProjectMode {
  return value === "task" || value === "compare" || value === "chat" ? value : "chat";
}

function storageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}.${projectId}`;
}

function normalizePreferences(value: unknown): RuntimeProjectPreferences {
  if (!value || typeof value !== "object") {
    return DEFAULT_RUNTIME_PROJECT_PREFERENCES;
  }

  const record = value as Partial<Record<keyof RuntimeProjectPreferences, unknown>>;
  const selectedHostId =
    typeof record.selectedHostId === "string" && record.selectedHostId.trim().length > 0
      ? record.selectedHostId.trim()
      : "openclaw";

  return {
    projectPolicy: normalizeProjectPolicy(record.projectPolicy),
    mode: normalizeMode(record.mode),
    selectedHostId,
    compareHostIds: normalizeCompareHostIds(record.compareHostIds),
  };
}

export function readRuntimeProjectPreferences(
  projectId: string | null | undefined,
): RuntimeProjectPreferences {
  if (typeof window === "undefined" || !projectId) {
    return DEFAULT_RUNTIME_PROJECT_PREFERENCES;
  }

  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (!raw) {
      return DEFAULT_RUNTIME_PROJECT_PREFERENCES;
    }
    return normalizePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_RUNTIME_PROJECT_PREFERENCES;
  }
}

export function writeRuntimeProjectPreferences(
  projectId: string | null | undefined,
  preferences: RuntimeProjectPreferences,
): void {
  if (typeof window === "undefined" || !projectId) {
    return;
  }

  try {
    window.localStorage.setItem(
      storageKey(projectId),
      JSON.stringify(normalizePreferences(preferences)),
    );
  } catch {
    // best effort
  }
}
