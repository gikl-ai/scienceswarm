"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { RadarTopic } from "@/lib/radar/types";

interface TopicItem {
  name: string;
  description: string;
  weight: number;
  origin: "inferred" | "user";
  checked: boolean;
}

interface RadarOnboardingCardProps {
  onDismiss?: () => void;
}

const MAX_TOPICS = 5;

export function RadarOnboardingCard({ onDismiss }: RadarOnboardingCardProps) {
  const [state, setState] = useState<"loading" | "setup" | "confirmed" | "dismissed">("loading");
  const [topics, setTopics] = useState<TopicItem[]>([]);
  const [customInput, setCustomInput] = useState("");
  const [telegram, setTelegram] = useState(false);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialize = useCallback(async () => {
    try {
      // Check if radar already exists
      const radarRes = await fetch("/api/radar");
      const radar = radarRes.ok ? await radarRes.json().catch(() => null) : null;
      if (radar) {
        // Radar exists, don't show the card
        setState("dismissed");
        return;
      }

      // Fetch inferred topics
      const topicsRes = await fetch("/api/radar/infer-topics");
      const topicsData = (await topicsRes.json()) as { topics: RadarTopic[] };
      const inferred = (topicsData.topics ?? []).slice(0, MAX_TOPICS).map((t) => ({
        ...t,
        checked: true,
      }));

      setTopics(inferred);
      setState("setup");
    } catch {
      // Even if fetches fail, show setup with empty topics
      setState("setup");
    }
  }, []);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  function handleToggleTopic(name: string) {
    setTopics((prev) =>
      prev.map((t) => (t.name === name ? { ...t, checked: !t.checked } : t)),
    );
  }

  function handleAddCustomTopic(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const value = customInput.trim();
    if (!value) return;
    // Prevent duplicates (case-insensitive)
    if (topics.some((t) => t.name.toLowerCase() === value.toLowerCase())) {
      setCustomInput("");
      return;
    }
    setTopics((prev) => [
      ...prev,
      {
        name: value,
        description: "",
        weight: 0.8,
        origin: "user",
        checked: true,
      },
    ]);
    setCustomInput("");
  }

  async function handleActivate() {
    setActivating(true);
    setError(null);

    const checkedTopics = topics
      .filter((t) => t.checked)
      .map(({ checked: _checked, ...rest }) => rest);

    try {
      const res = await fetch("/api/radar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topics: checkedTopics,
          schedule: {
            cron: "0 6 * * *",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            fetchLeadMinutes: 120,
          },
          channels: {
            dashboard: true,
            telegram,
            email: false,
          },
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to activate radar.");
        return;
      }

      setState("confirmed");
    } catch {
      setError("Failed to activate radar.");
    } finally {
      setActivating(false);
    }
  }

  function handleDismiss() {
    setState("dismissed");
    onDismiss?.();
  }

  // Loading or dismissed: render nothing
  if (state === "loading" || state === "dismissed") {
    return null;
  }

  // Confirmation state
  if (state === "confirmed") {
    return (
      <section className="rounded-[28px] border-2 border-border bg-white p-5 shadow-sm">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold text-foreground">
            Radar active. Your first briefing arrives tomorrow at 6 AM.
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            You can fine-tune your radar anytime in{" "}
            <strong>Settings &gt; Research Radar</strong>, or just tell your
            OpenClaw: <em>&lsquo;stop watching scaling laws&rsquo;</em> or{" "}
            <em>&lsquo;also track protein folding.&rsquo;</em>
          </p>
          <Link
            href="/dashboard/settings"
            className="mt-4 inline-block text-sm font-medium text-accent hover:underline"
          >
            Customize schedule, sources, or topics
          </Link>
        </div>
      </section>
    );
  }

  // Setup state
  return (
    <section className="rounded-[28px] border-2 border-border bg-white p-5 shadow-sm">
      <div className="max-w-2xl">
        <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted">
          RESEARCH RADAR
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-foreground">
          Your daily research briefing
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted">
          Based on your brain, here&rsquo;s what we&rsquo;ll watch for you each morning.
        </p>
      </div>

      {/* Topic checkboxes */}
      {topics.length > 0 && (
        <div className="mt-4 space-y-2">
          {topics.map((topic) => (
            <label
              key={topic.name}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-4 py-3 text-sm font-medium text-foreground cursor-pointer"
            >
              <input
                type="checkbox"
                checked={topic.checked}
                onChange={() => handleToggleTopic(topic.name)}
                aria-label={topic.name}
                className="accent-accent"
              />
              {topic.name}
            </label>
          ))}
        </div>
      )}

      {/* Custom topic input */}
      <div className="mt-4">
        <label className="text-xs font-medium text-muted">
          Anything else?
          <input
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={handleAddCustomTopic}
            placeholder="e.g. protein folding, CRISPR delivery"
            className="mt-1 w-full rounded-lg border-2 border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent"
          />
        </label>
      </div>

      {/* Telegram toggle */}
      <div className="mt-4">
        <label className="flex items-center gap-3 text-sm font-medium text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={telegram}
            onChange={(e) => setTelegram(e.target.checked)}
            aria-label="Also deliver via Telegram?"
            className="accent-accent"
          />
          Also deliver via Telegram?
        </label>
      </div>

      {/* Error display */}
      {error && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="mt-5 flex items-center gap-4">
        <button
          type="button"
          onClick={handleActivate}
          disabled={activating}
          className="rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {activating ? "Starting..." : "Start my radar"}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-sm font-medium text-muted hover:text-foreground transition-colors"
        >
          Maybe later
        </button>
      </div>
    </section>
  );
}
