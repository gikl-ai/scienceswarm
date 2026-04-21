"use client";

import { useCallback, useEffect, useState } from "react";
import type { Radar, RadarTopic, RadarSource } from "@/lib/radar/types";

interface RadarSettingsPanelProps {
  inputClassName?: string;
  primaryButtonClassName?: string;
}

const DEFAULT_INPUT_CLS =
  "w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-accent";
const DEFAULT_BTN_PRIMARY =
  "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50";

export function RadarSettingsPanel({
  inputClassName = DEFAULT_INPUT_CLS,
  primaryButtonClassName = DEFAULT_BTN_PRIMARY,
}: RadarSettingsPanelProps) {
  const [radar, setRadar] = useState<Radar | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupText, setSetupText] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);

  const fetchRadar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/radar");
      if (res.status === 404) {
        setRadar(null);
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to load radar config.");
        return;
      }
      const data = (await res.json()) as Radar;
      setRadar(data ?? null);
    } catch {
      setError("Failed to load radar config.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRadar();
  }, [fetchRadar]);

  async function handleSetup() {
    if (!setupText.trim()) return;
    setSetupLoading(true);
    setSetupError(null);
    try {
      const res = await fetch("/api/radar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: setupText }),
      });
      const data = (await res.json().catch(() => ({}))) as
        Radar & { error?: string };
      if (!res.ok) {
        setSetupError(data.error ?? "Failed to set up radar.");
        return;
      }
      setRadar(data ?? null);
    } catch {
      setSetupError("Failed to set up radar.");
    } finally {
      setSetupLoading(false);
    }
  }

  async function patchTopicWeight(topicName: string, weight: number) {
    if (!radar) return;
    const updatedTopics = radar.topics.map((t) =>
      t.name === topicName ? { ...t, weight } : t,
    );
    setRadar({ ...radar, topics: updatedTopics });
    setSaving(true);
    try {
      await fetch("/api/radar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ radarId: radar.id, topics: updatedTopics }),
      });
    } finally {
      setSaving(false);
    }
  }

  async function patchSourceEnabled(sourceId: string, enabled: boolean) {
    if (!radar) return;
    const updatedSources = radar.sources.map((s) =>
      s.id === sourceId ? { ...s, enabled } : s,
    );
    setRadar({ ...radar, sources: updatedSources });
    setSaving(true);
    try {
      await fetch("/api/radar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ radarId: radar.id, sources: updatedSources }),
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted">Loading radar config...</p>;
  }

  if (error) {
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        {error}
      </p>
    );
  }

  if (!radar) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          No radar configured yet. Describe what you want to track and your
          radar will be set up automatically.
        </p>
        <label className="sr-only" htmlFor="radar-setup-text">
          Radar description
        </label>
        <textarea
          id="radar-setup-text"
          value={setupText}
          onChange={(e) => setSetupText(e.target.value)}
          rows={4}
          placeholder="Track new papers on CRISPR gene editing, lab automation robotics, and protein structure prediction. Alert me to major funding rounds in biotech and new preprints from top labs."
          className={`${inputClassName} min-h-[110px] resize-y`}
        />
        {setupError && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {setupError}
          </p>
        )}
        <button
          type="button"
          onClick={handleSetup}
          disabled={!setupText.trim() || setupLoading}
          className={primaryButtonClassName}
        >
          {setupLoading ? "Setting up..." : "Set up my radar"}
        </button>
      </div>
    );
  }

  const scheduleLabel = radar.schedule?.cron
    ? `${radar.schedule.cron} (${radar.schedule.timezone ?? "UTC"})`
    : "Not scheduled";

  const channelList = Object.entries(radar.channels ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ") || "None";

  return (
    <div className="space-y-6">
      {saving && (
        <p className="text-xs text-muted">Saving...</p>
      )}

      {/* Topics */}
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium">Topics</p>
          <p className="text-xs text-muted">
            Adjust weight (0 = ignore, 1 = highest priority).
          </p>
        </div>
        {radar.topics.length === 0 && (
          <p className="text-xs text-muted">No topics configured.</p>
        )}
        {radar.topics.map((topic: RadarTopic) => (
          <div
            key={topic.name}
            className="rounded-xl border border-border bg-background p-4 space-y-2"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{topic.name}</p>
                {topic.description && (
                  <p className="text-xs text-muted">{topic.description}</p>
                )}
              </div>
              <span className="text-xs font-mono text-muted">
                {topic.weight.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={topic.weight}
              onChange={(e) =>
                patchTopicWeight(topic.name, parseFloat(e.target.value))
              }
              className="w-full accent-accent"
              aria-label={`Weight for ${topic.name}`}
            />
          </div>
        ))}
      </div>

      {/* Sources */}
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium">Sources</p>
          <p className="text-xs text-muted">Enable or disable individual sources.</p>
        </div>
        {radar.sources.length === 0 && (
          <p className="text-xs text-muted">No sources configured.</p>
        )}
        {radar.sources.map((source: RadarSource) => (
          <div
            key={source.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-mono uppercase tracking-wide text-muted">
                  {source.type}
                </span>
                <span className="truncate text-sm font-medium">
                  {source.url ?? source.query ?? source.id}
                </span>
              </div>
            </div>
            <label className="inline-flex shrink-0 items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={source.enabled}
                onChange={(e) => patchSourceEnabled(source.id, e.target.checked)}
              />
              {source.enabled ? "Enabled" : "Disabled"}
            </label>
          </div>
        ))}
      </div>

      {/* Schedule & Channels */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-background p-4 space-y-1">
          <p className="text-sm font-medium">Schedule</p>
          <p className="text-xs text-muted font-mono">{scheduleLabel}</p>
        </div>
        <div className="rounded-xl border border-border bg-background p-4 space-y-1">
          <p className="text-sm font-medium">Channels</p>
          <p className="text-xs text-muted">{channelList}</p>
        </div>
      </div>
    </div>
  );
}
