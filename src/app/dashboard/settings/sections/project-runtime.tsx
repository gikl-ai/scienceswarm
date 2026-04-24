"use client";

import { useState } from "react";
import {
  RuntimeAccountSetupGuide,
  subscriptionCliHosts,
} from "@/components/runtime/RuntimeAccountSetupGuide";
import { RuntimePicker } from "@/components/runtime/runtime-picker";
import { SessionDetail } from "@/components/runtime/session-detail";
import type { RuntimeHealthResponse } from "@/components/runtime/RuntimeHostMatrix";
import { RuntimeTaskBoard } from "@/components/runtime/runtime-task-board";
import { useProjectRuntimePreferences } from "@/hooks/use-project-runtime-preferences";
import {
  useRuntimeSessionDetail,
  useRuntimeSessions,
} from "@/hooks/use-runtime-hosts";

interface ProjectOption {
  id: string;
  name: string;
}

export function ProjectRuntimeSection({
  projectOptions,
  projectId,
  runtimeHealth,
  onProjectChange,
}: {
  projectOptions: ProjectOption[];
  projectId: string;
  runtimeHealth: RuntimeHealthResponse | null;
  onProjectChange: (projectId: string) => void;
}) {
  const hosts = runtimeHealth?.hosts ?? [];
  const {
    projectPolicy,
    mode,
    selectedHostId,
    compareHostIds,
    setProjectPolicy,
    setMode,
    setSelectedHostId,
    setCompareHostIds,
  } = useProjectRuntimePreferences(projectId || null, hosts);
  const runtimeSessions = useRuntimeSessions(projectId || null);
  const hasSubscriptionCliHosts = subscriptionCliHosts(hosts).length > 0;
  const [selectedRuntimeSessionIdState, setSelectedRuntimeSessionId] = useState<string | null>(null);
  const selectedRuntimeSessionId = runtimeSessions.sessions.some(
    (session) => session.id === selectedRuntimeSessionIdState,
  )
    ? selectedRuntimeSessionIdState
    : null;
  const runtimeSessionDetail = useRuntimeSessionDetail(selectedRuntimeSessionId);

  return (
    <section
      className="space-y-4 rounded-lg border-2 border-border bg-surface p-6"
      data-testid="project-runtime-section"
    >
      <div>
        <h2 className="text-lg font-semibold">Project runtime</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Use the project chat composer switcher for everyday Claude Code and OpenClaw
          sends. Settings keeps runtime diagnostics, advanced modes, compare targets,
          and session history in one place.
        </p>
      </div>

      {projectOptions.length > 0 ? (
        <label className="block max-w-sm space-y-2">
          <span className="text-sm font-medium text-foreground">Project</span>
          <select
            className="w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
            value={projectId}
            onChange={(event) => onProjectChange(event.currentTarget.value)}
            data-testid="project-runtime-project-select"
          >
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm text-muted">
          Create a project before configuring project-specific runtime settings.
        </p>
      )}

      {!runtimeHealth && (
        <p className="text-sm text-muted">Loading runtime host availability...</p>
      )}

      {runtimeHealth && projectId && (
        <div className="overflow-hidden rounded-2xl border border-border bg-white">
          {hasSubscriptionCliHosts && (
            <div className="border-b border-border bg-white p-4">
              <RuntimeAccountSetupGuide hosts={hosts} />
            </div>
          )}
          <RuntimePicker
            hosts={hosts}
            selectedHostId={selectedHostId}
            projectPolicy={projectPolicy}
            mode={mode}
            compareHostIds={compareHostIds}
            onSelectedHostIdChange={setSelectedHostId}
            onProjectPolicyChange={setProjectPolicy}
            onModeChange={setMode}
            onCompareHostIdsChange={setCompareHostIds}
          />
          <RuntimeTaskBoard
            sessions={runtimeSessions.sessions}
            loading={runtimeSessions.loading}
            error={runtimeSessions.error}
            selectedSessionId={selectedRuntimeSessionId}
            onRefresh={() => void runtimeSessions.refresh()}
            onSelectSession={setSelectedRuntimeSessionId}
            onCancelSession={(sessionId) => {
              void fetch(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/cancel`, {
                method: "POST",
              }).then(() =>
                Promise.all([
                  runtimeSessions.refresh(),
                  runtimeSessionDetail.refresh(),
                ]),
              );
            }}
          />
          <SessionDetail
            session={runtimeSessionDetail.session}
            events={runtimeSessionDetail.events}
            loading={runtimeSessionDetail.loading}
            error={runtimeSessionDetail.error}
            onClose={() => setSelectedRuntimeSessionId(null)}
            onRefresh={() => void runtimeSessionDetail.refresh()}
          />
        </div>
      )}
    </section>
  );
}
