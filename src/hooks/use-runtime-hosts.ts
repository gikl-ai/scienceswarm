"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RuntimeEvent,
  RuntimeProjectPolicy,
  RuntimeSessionRecord,
  RuntimeTurnMode,
} from "@/lib/runtime-hosts/contracts";
import type {
  RuntimeHealthHost,
  RuntimeHealthResponse,
} from "@/components/runtime/RuntimeHostMatrix";
import {
  authReady,
  runtimeHostBlockedByPolicy,
  runtimeHostSelectableForDefault,
  runtimeHostSupportsCompare,
} from "@/components/runtime/RuntimeHostMatrix";

export type RuntimeComposerMode = Extract<
  RuntimeTurnMode,
  "chat" | "task" | "compare"
>;

export interface RuntimeSessionWithHost extends RuntimeSessionRecord {
  host?: {
    known: boolean;
    readOnly: boolean;
    id: string;
    label: string;
    profile?: {
      lifecycle?: {
        canCancel?: boolean;
        canResumeNativeSession?: boolean;
        canListNativeSessions?: boolean;
      };
      controlSurface?: {
        supportsCancel?: boolean;
        supportsResume?: boolean;
        supportsNativeSessionList?: boolean;
      };
    } | null;
  };
}

export interface RuntimeSessionDetail {
  session: RuntimeSessionWithHost | null;
  events: RuntimeEvent[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function runtimeHostSupportsMode(
  host: RuntimeHealthHost,
  mode: RuntimeComposerMode,
): boolean {
  if (mode === "compare") return runtimeHostSupportsCompare(host);
  if (mode === "task") return host.profile.capabilities.includes("task");
  return host.profile.capabilities.includes("chat");
}

export function runtimeHostDisabledReason(input: {
  host: RuntimeHealthHost;
  policy: RuntimeProjectPolicy;
  mode: RuntimeComposerMode;
}): string | null {
  const { host, policy, mode } = input;
  if (runtimeHostBlockedByPolicy(host, policy)) {
    return `Requires ${host.profile.accountDisclosure.requiresProjectPrivacy}`;
  }
  if (!runtimeHostSupportsMode(host, mode)) {
    return mode === "task"
      ? "No task support"
      : mode === "compare"
        ? "No compare support"
        : "No chat support";
  }
  if (host.health.status !== "ready") {
    return host.health.status === "misconfigured"
      ? "Misconfigured"
      : "Install or start required";
  }
  if (!authReady(host)) {
    return "Login or .env setup required";
  }
  return null;
}

export function chooseRuntimeHostFallback(input: {
  hosts: RuntimeHealthHost[];
  policy: RuntimeProjectPolicy;
  mode: RuntimeComposerMode;
  preferredHostId?: string | null;
}): string {
  const preferred = input.hosts.find(
    (host) => host.profile.id === input.preferredHostId,
  );
  if (
    preferred
    && runtimeHostDisabledReason({
      host: preferred,
      policy: input.policy,
      mode: input.mode,
    }) === null
  ) {
    return preferred.profile.id;
  }

  const openClaw = input.hosts.find((host) => host.profile.id === "openclaw");
  if (
    openClaw
    && runtimeHostDisabledReason({
      host: openClaw,
      policy: input.policy,
      mode: input.mode,
    }) === null
  ) {
    return openClaw.profile.id;
  }

  return input.hosts.find((host) =>
    runtimeHostDisabledReason({
      host,
      policy: input.policy,
      mode: input.mode,
    }) === null
  )?.profile.id ?? "openclaw";
}

export interface UseRuntimeHostsOptions {
  deferInitialRefresh?: boolean;
  initialRefreshDelayMs?: number;
  refreshImmediately?: boolean;
}

export function useRuntimeHosts(options: UseRuntimeHostsOptions = {}) {
  const {
    deferInitialRefresh = false,
    initialRefreshDelayMs = 3_000,
    refreshImmediately = false,
  } = options;
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasRequestedHealthRef = useRef(false);

  const refresh = useCallback(async () => {
    hasRequestedHealthRef.current = true;
    setLoading(true);
    try {
      const response = await fetch("/api/runtime/health");
      const payload = await response.json().catch(() => null) as
        | RuntimeHealthResponse
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(
          payload && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Runtime health failed: ${response.status}`,
        );
      }
      setRuntimeHealth(payload as RuntimeHealthResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Runtime health failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!deferInitialRefresh) {
      void refresh();
      return;
    }

    if (hasRequestedHealthRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (!hasRequestedHealthRef.current) {
        void refresh();
      }
    }, initialRefreshDelayMs);

    return () => window.clearTimeout(timeoutId);
  }, [deferInitialRefresh, initialRefreshDelayMs, refresh]);

  useEffect(() => {
    if (refreshImmediately) {
      void refresh();
    }
  }, [refresh, refreshImmediately]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const hosts = useMemo(() => runtimeHealth?.hosts ?? [], [runtimeHealth]);
  const defaultHostId = useMemo(
    () =>
      hosts.find((host) =>
        runtimeHostSelectableForDefault(host, "local-only")
      )?.profile.id ?? "openclaw",
    [hosts],
  );

  return {
    runtimeHealth,
    hosts,
    checkedAt: runtimeHealth?.checkedAt ?? null,
    defaultHostId,
    loading,
    error,
    refresh,
  };
}

export function useRuntimeSessions(projectId: string | null) {
  const [sessions, setSessions] = useState<RuntimeSessionWithHost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setSessions([]);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ projectId });
      const response = await fetch(`/api/runtime/sessions?${params.toString()}`);
      const payload = await response.json().catch(() => null) as
        | { sessions?: RuntimeSessionWithHost[]; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || `Runtime sessions failed: ${response.status}`);
      }
      setSessions(Array.isArray(payload?.sessions) ? payload.sessions : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Runtime sessions failed.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  return {
    sessions,
    loading,
    error,
    refresh,
  };
}

export function useRuntimeSessionDetail(sessionId: string | null): RuntimeSessionDetail {
  const [session, setSession] = useState<RuntimeSessionWithHost | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setSession(null);
      setEvents([]);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const [sessionResponse, eventsResponse] = await Promise.all([
        fetch(`/api/runtime/sessions/${encodeURIComponent(sessionId)}`),
        fetch(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/events`),
      ]);
      const [sessionPayload, eventsPayload] = await Promise.all([
        sessionResponse.json().catch(() => null) as Promise<{
          session?: RuntimeSessionWithHost;
          error?: string;
        } | null>,
        eventsResponse.json().catch(() => null) as Promise<{
          events?: RuntimeEvent[];
          error?: string;
        } | null>,
      ]);
      if (!sessionResponse.ok) {
        throw new Error(sessionPayload?.error || `Runtime session failed: ${sessionResponse.status}`);
      }
      if (!eventsResponse.ok) {
        throw new Error(eventsPayload?.error || `Runtime events failed: ${eventsResponse.status}`);
      }
      setSession(sessionPayload?.session ?? null);
      setEvents(Array.isArray(eventsPayload?.events) ? eventsPayload.events : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Runtime session detail failed.");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    session,
    events,
    loading,
    error,
    refresh,
  };
}
