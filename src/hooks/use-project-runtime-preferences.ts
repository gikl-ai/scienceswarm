"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { RuntimeHealthHost } from "@/components/runtime/RuntimeHostMatrix";
import {
  chooseRuntimeHostFallback,
  type RuntimeComposerMode,
} from "@/hooks/use-runtime-hosts";
import {
  readRuntimeProjectPreferences,
  writeRuntimeProjectPreferences,
  type RuntimeProjectPreferences,
} from "@/lib/runtime-project-preferences";

function ensureCompareHostIds(hostIds: string[]): string[] {
  if (hostIds.length === 0) {
    return ["openclaw"];
  }
  if (hostIds.includes("openclaw")) {
    return hostIds;
  }
  return Array.from(new Set(["openclaw", ...hostIds]));
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useProjectRuntimePreferences(
  projectId: string | null,
  hosts: RuntimeHealthHost[],
) {
  const normalizedProjectId = projectId ?? null;
  const [preferences, setPreferences] = useState<RuntimeProjectPreferences>(() =>
    readRuntimeProjectPreferences(normalizedProjectId),
  );

  useIsomorphicLayoutEffect(() => {
    setPreferences(readRuntimeProjectPreferences(normalizedProjectId));
  }, [normalizedProjectId]);

  const updatePreferences = useCallback((
    updater: (current: RuntimeProjectPreferences) => RuntimeProjectPreferences,
  ) => {
    setPreferences((current) => {
      const next = updater(current);
      writeRuntimeProjectPreferences(normalizedProjectId, next);
      return next;
    });
  }, [normalizedProjectId]);

  const selectedHostId = useMemo(() => {
    if (hosts.length === 0) {
      return preferences.selectedHostId;
    }
    return chooseRuntimeHostFallback({
      hosts,
      policy: preferences.projectPolicy,
      mode: preferences.mode === "compare" ? "chat" : preferences.mode,
      preferredHostId: preferences.selectedHostId,
    });
  }, [
    hosts,
    preferences.mode,
    preferences.projectPolicy,
    preferences.selectedHostId,
  ]);

  const compareHostIds = useMemo(
    () =>
      preferences.mode === "compare"
        ? ensureCompareHostIds(preferences.compareHostIds)
        : preferences.compareHostIds,
    [preferences.compareHostIds, preferences.mode],
  );

  const setProjectPolicy = useCallback((projectPolicy: RuntimeProjectPreferences["projectPolicy"]) => {
    updatePreferences((current) => ({ ...current, projectPolicy }));
  }, [updatePreferences]);

  const setMode = useCallback((mode: RuntimeComposerMode) => {
    updatePreferences((current) => ({ ...current, mode }));
  }, [updatePreferences]);

  const setSelectedHostId = useCallback((selectedHostId: string) => {
    updatePreferences((current) => ({ ...current, selectedHostId }));
  }, [updatePreferences]);

  const setCompareHostIds = useCallback((compareHostIds: string[]) => {
    updatePreferences((current) => ({ ...current, compareHostIds }));
  }, [updatePreferences]);

  return {
    ...preferences,
    selectedHostId,
    compareHostIds,
    setProjectPolicy,
    setMode,
    setSelectedHostId,
    setCompareHostIds,
  };
}
