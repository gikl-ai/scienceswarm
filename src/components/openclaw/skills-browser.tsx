"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle,
  FloppyDiskBack,
  Pulse,
  SealWarning,
  Sparkle,
} from "@phosphor-icons/react";
import { Spinner } from "@/components/spinner";

type SkillRuntimeStatus = {
  last_run: string;
  concepts_processed: number;
  errors: number;
  age_ms: number;
  stale: boolean;
  schedule_interval_ms: number;
} | null | undefined;

type SkillHealthResponse = {
  openai?: "configured" | "missing" | "disabled";
  scienceswarm_user_handle?: {
    configured?: boolean;
    value?: string;
    message?: string;
  };
  scientific_databases?: {
    pubmed?: DatabaseHealthStatus;
    materialsProject?: DatabaseHealthStatus;
    semanticScholar?: DatabaseHealthStatus;
    crossref?: DatabaseHealthStatus;
    openalex?: DatabaseHealthStatus;
  };
};

type DatabaseHealthStatus = {
  configured: boolean;
  required: boolean;
  env: string;
};

type OpenClawSkillRecord = {
  slug: string;
  name: string;
  description: string;
  rawMarkdown: string;
  runtime: string | null;
  owner: string | null;
  tier: string | null;
  network: string | null;
  tools: string[];
  secrets: string[];
  outputs: string[];
  routes: string[];
  healthChecks: string[];
  networkDomains: string[];
  entityTypes: string[];
  emoji: string | null;
};

type SkillCatalogResponse = {
  skills?: OpenClawSkillRecord[];
  error?: string;
};

type SkillSaveResponse = {
  skill?: OpenClawSkillRecord;
  message?: string;
  error?: string;
};

type FetchStatus = "idle" | "loading" | "ready" | "error";

type SaveState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; message: string }
  | { state: "error"; message: string };

type SkillSignalTone = "neutral" | "good" | "warning";

type SkillSignal = {
  label: string;
  value: string;
  tone: SkillSignalTone;
};

const RESET_HINT = "Saved to disk. Reset the OpenClaw session to apply the change.";

export function OpenClawSkillsBrowser({
  selectedSkillSlug,
  onSelectSkill,
  radarStatus,
}: {
  selectedSkillSlug?: string | null;
  onSelectSkill: (slug: string) => void;
  radarStatus?: SkillRuntimeStatus;
}) {
  const [skillsStatus, setSkillsStatus] = useState<FetchStatus>("loading");
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skills, setSkills] = useState<OpenClawSkillRecord[]>([]);
  const [healthStatus, setHealthStatus] = useState<FetchStatus>("idle");
  const [health, setHealth] = useState<SkillHealthResponse | null>(null);
  const [draftsBySkill, setDraftsBySkill] = useState<Record<string, string>>({});
  const [saveStateBySkill, setSaveStateBySkill] = useState<Record<string, SaveState>>({});
  const draftsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const controller = new AbortController();

    setSkillsStatus("loading");
    setSkillsError(null);

    fetch("/api/openclaw/skills", { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as SkillCatalogResponse;
        if (!response.ok) {
          throw new Error(payload.error || "Failed to load OpenClaw skills.");
        }
        setSkills(payload.skills ?? []);
        setSkillsStatus("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setSkillsStatus("error");
        setSkillsError(error instanceof Error ? error.message : "Failed to load OpenClaw skills.");
      });

    setHealthStatus("loading");
    fetch("/api/health", { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as SkillHealthResponse;
        if (!response.ok) {
          throw new Error("Failed to load runtime health.");
        }
        setHealth(payload);
        setHealthStatus("ready");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setHealthStatus("error");
      });

    return () => controller.abort();
  }, []);

  const selectedSkill = useMemo(() => {
    if (skills.length === 0) return null;
    if (!selectedSkillSlug) return skills[0];
    return skills.find((skill) => skill.slug === selectedSkillSlug) ?? skills[0];
  }, [selectedSkillSlug, skills]);

  useEffect(() => {
    if (!selectedSkill || selectedSkill.slug === selectedSkillSlug) return;
    onSelectSkill(selectedSkill.slug);
  }, [onSelectSkill, selectedSkill, selectedSkillSlug]);

  const draftValue =
    selectedSkill
      ? draftsBySkill[selectedSkill.slug] ?? selectedSkill.rawMarkdown
      : "";
  const saveState = selectedSkill
    ? saveStateBySkill[selectedSkill.slug] ?? { state: "idle" as const }
    : { state: "idle" as const };
  const hasUnsavedChanges = Boolean(
    selectedSkill && draftValue !== selectedSkill.rawMarkdown,
  );

  async function handleSave(): Promise<void> {
    if (!selectedSkill) return;
    const skillSlug = selectedSkill.slug;
    const submittedDraft = draftValue;
    draftsRef.current = {
      ...draftsRef.current,
      [skillSlug]: submittedDraft,
    };

    setSaveStateBySkill((current) => ({
      ...current,
      [skillSlug]: { state: "saving" },
    }));

    try {
      const response = await fetch(`/api/openclaw/skills/${encodeURIComponent(skillSlug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: submittedDraft }),
      });
      const payload = await response.json().catch(() => ({})) as SkillSaveResponse;
      if (!response.ok || !payload.skill) {
        throw new Error(payload.error || "Failed to save skill.");
      }
      const savedSkill = payload.skill;

      setSkills((current) =>
        current.map((skill) => (skill.slug === savedSkill.slug ? savedSkill : skill)),
      );
      setDraftsBySkill((current) => {
        const activeDraft = current[skillSlug];
        if (typeof activeDraft === "string" && activeDraft !== submittedDraft) {
          return current;
        }
        const next = { ...current };
        delete next[skillSlug];
        draftsRef.current = next;
        return next;
      });
      const hasNewerDraft =
        typeof draftsRef.current[skillSlug] === "string" && draftsRef.current[skillSlug] !== submittedDraft;
      setSaveStateBySkill((current) => ({
        ...current,
        [skillSlug]: hasNewerDraft
          ? { state: "idle" }
          : {
              state: "saved",
              message: payload.message || RESET_HINT,
            },
      }));
    } catch (error) {
      setSaveStateBySkill((current) => ({
        ...current,
        [skillSlug]: {
          state: "error",
          message: error instanceof Error ? error.message : "Failed to save skill.",
        },
      }));
    }
  }

  if (skillsStatus === "loading") {
    return (
      <div className="flex min-h-[32rem] items-center justify-center gap-2 rounded-[24px] border border-border bg-white shadow-sm">
        <Spinner size="h-4 w-4" />
        <span className="text-sm text-muted">Loading OpenClaw skills...</span>
      </div>
    );
  }

  if (skillsStatus === "error") {
    return (
      <div className="rounded-[24px] border border-red-200 bg-red-50 p-5 text-sm text-red-800 shadow-sm">
        <p className="font-semibold">Could not load OpenClaw skills.</p>
        <p className="mt-2 text-red-700">{skillsError ?? "Unknown error"}</p>
      </div>
    );
  }

  if (!selectedSkill) {
    return (
      <div className="rounded-[24px] border border-border bg-white p-6 text-sm text-muted shadow-sm">
        No repo-backed OpenClaw skills were found under <code>.openclaw/skills</code>.
      </div>
    );
  }

  const signals = buildSkillSignals(selectedSkill, {
    health,
    healthStatus,
    radarStatus,
  });

  return (
    <div className="flex min-h-[32rem] overflow-hidden rounded-[24px] border border-border bg-white shadow-sm">
      <aside className="flex w-[20rem] shrink-0 flex-col border-r border-border bg-surface/50">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            <Sparkle size={14} />
            OpenClaw skills
          </div>
          <p className="mt-2 text-sm text-muted">
            Repo-defined skills that OpenClaw auto-loads at session start.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {skills.map((skill) => {
            const active = skill.slug === selectedSkill.slug;
            const detailBits = [skill.tier, skill.runtime].filter(Boolean);
            return (
              <button
                key={skill.slug}
                type="button"
                onClick={() => onSelectSkill(skill.slug)}
                className={`mb-1 block w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
                  active
                    ? "border-accent bg-accent/5"
                    : "border-transparent bg-white hover:border-border hover:bg-surface"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-sm">
                    {skill.emoji ?? (skill.tier === "database" ? "DB" : "AI")}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-foreground">
                      {skill.name}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">
                      {skill.description}
                    </p>
                    {detailBits.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {detailBits.map((bit) => (
                          <span
                            key={bit}
                            className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted"
                          >
                            {bit}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                <Pulse size={14} />
                Durable definition
              </div>
              <div className="mt-1 flex items-center gap-2">
                <h2 className="truncate text-xl font-semibold text-foreground">
                  {selectedSkill.name}
                </h2>
                <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                  {selectedSkill.slug}
                </span>
              </div>
              <p className="mt-2 max-w-3xl text-sm text-muted">{selectedSkill.description}</p>
              <p className="mt-3 text-xs text-muted">
                <code>.openclaw/skills/{selectedSkill.slug}/SKILL.md</code>
              </p>
            </div>

            <div className="flex shrink-0 flex-col items-start gap-2">
              <button
                type="button"
                onClick={() => { void handleSave(); }}
                disabled={!hasUnsavedChanges || saveState.state === "saving"}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FloppyDiskBack size={16} />
                {saveState.state === "saving" ? "Saving..." : "Save skill"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!selectedSkill) return;
                  setDraftsBySkill((current) => {
                    const next = { ...current };
                    delete next[selectedSkill.slug];
                    draftsRef.current = next;
                    return next;
                  });
                  setSaveStateBySkill((current) => ({
                    ...current,
                    [selectedSkill.slug]: { state: "idle" },
                  }));
                }}
                disabled={!hasUnsavedChanges || saveState.state === "saving"}
                className="text-xs font-semibold text-muted transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                Reset draft
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {signals.map((signal) => (
              <SkillSignalBadge key={`${signal.label}-${signal.value}`} signal={signal} />
            ))}
          </div>

          {saveState.state === "saved" && (
            <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <CheckCircle size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">Skill saved.</p>
                <p className="mt-1 text-emerald-700">{saveState.message}</p>
                <p className="mt-2 text-xs text-emerald-700">
                  Run <code>npm run openclaw:reset-session</code> or restart your OpenClaw profile to reload the edited skill.
                </p>
              </div>
            </div>
          )}

          {saveState.state === "error" && (
            <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-semibold">Skill save failed.</p>
              <p className="mt-1 text-red-700">{saveState.message}</p>
            </div>
          )}
        </div>

        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <section className="min-h-0 overflow-y-auto border-b border-border p-5 lg:border-b-0 lg:border-r">
            <h3 className="text-sm font-semibold text-foreground">Capability surface</h3>
            <p className="mt-1 text-sm text-muted">
              What this skill touches today, with just enough runtime context to make it understandable from ScienceSwarm.
            </p>

            <div className="mt-4 grid gap-4">
              <SkillField title="Tools" values={selectedSkill.tools} empty="No explicit tool list." />
              <SkillField title="Secrets" values={selectedSkill.secrets} empty="No declared secrets." />
              <SkillField title="Network domains" values={selectedSkill.networkDomains} empty="No declared external domains." />
              <SkillField title="Routes" values={selectedSkill.routes} empty="No declared HTTP routes." />
              <SkillField title="Outputs" values={selectedSkill.outputs} empty="No declared durable outputs." />
              <SkillField title="Health checks" values={selectedSkill.healthChecks} empty="No explicit health checks." />
            </div>
          </section>

          <section className="min-h-0 overflow-y-auto p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Raw SKILL.md</h3>
                <p className="mt-1 text-sm text-muted">
                  Edit the repo-backed skill definition directly. Validation runs before write.
                </p>
              </div>
              {hasUnsavedChanges && (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-800">
                  Unsaved
                </span>
              )}
            </div>
            <textarea
              value={draftValue}
              onChange={(event) => {
                const nextValue = event.target.value;
                draftsRef.current = {
                  ...draftsRef.current,
                  [selectedSkill.slug]: nextValue,
                };
                setDraftsBySkill((current) => ({
                  ...current,
                  [selectedSkill.slug]: nextValue,
                }));
                setSaveStateBySkill((current) => ({
                  ...current,
                  [selectedSkill.slug]: { state: "idle" },
                }));
              }}
              spellCheck={false}
              className="mt-4 min-h-[28rem] w-full resize-y rounded-2xl border border-border bg-surface px-4 py-4 font-mono text-[12px] leading-6 text-foreground outline-none transition-colors focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/20"
              aria-label={`${selectedSkill.name} markdown editor`}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

function SkillField({
  title,
  values,
  empty,
}: {
  title: string;
  values: string[];
  empty: string;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface/40 p-4">
      <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">{title}</h4>
      {values.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {values.map((value) => (
            <li
              key={value}
              className="rounded-xl border border-border bg-white px-3 py-2 font-mono text-xs text-foreground"
            >
              {value}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SkillSignalBadge({ signal }: { signal: SkillSignal }) {
  const toneClass =
    signal.tone === "good"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : signal.tone === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-border bg-surface text-foreground";

  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${toneClass}`}>
      {signal.tone === "warning" && <SealWarning size={14} />}
      <span className="font-semibold">{signal.label}</span>
      <span>{signal.value}</span>
    </span>
  );
}

function buildSkillSignals(
  skill: OpenClawSkillRecord,
  input: {
    health: SkillHealthResponse | null;
    healthStatus: FetchStatus;
    radarStatus: SkillRuntimeStatus;
  },
): SkillSignal[] {
  const signals: SkillSignal[] = [
    { label: "Source", value: "Repo-defined", tone: "good" },
    {
      label: "Apply",
      value: "Reload OpenClaw session",
      tone: "warning",
    },
  ];

  if (skill.runtime) {
    signals.push({ label: "Runtime", value: skill.runtime, tone: "neutral" });
  }

  if (skill.slug === "research-radar") {
    if (input.radarStatus) {
      signals.push({
        label: "Radar",
        value: input.radarStatus.stale ? "Stale" : "Fresh",
        tone: input.radarStatus.stale ? "warning" : "good",
      });
      signals.push({
        label: "Last run",
        value: formatElapsed(input.radarStatus.age_ms),
        tone: input.radarStatus.stale ? "warning" : "neutral",
      });
    } else {
      signals.push({
        label: "Radar",
        value: "No run recorded",
        tone: "warning",
      });
    }
  }

  if (input.healthStatus === "ready" && input.health) {
    for (const secret of skill.secrets) {
      const secretSignal = buildSecretSignal(secret, input.health);
      if (secretSignal) {
        signals.push(secretSignal);
      }
    }
  }

  return signals;
}

function buildSecretSignal(
  secret: string,
  health: SkillHealthResponse,
): SkillSignal | null {
  const mappedDatabaseSecrets: Record<string, DatabaseHealthStatus | undefined> = {
    NCBI_API_KEY: health.scientific_databases?.pubmed,
    MATERIALS_PROJECT_API_KEY: health.scientific_databases?.materialsProject,
    SEMANTIC_SCHOLAR_API_KEY: health.scientific_databases?.semanticScholar,
    CROSSREF_MAILTO: health.scientific_databases?.crossref,
    OPENALEX_MAILTO: health.scientific_databases?.openalex,
  };

  const databaseStatus = mappedDatabaseSecrets[secret];
  if (databaseStatus) {
    return {
      label: secret,
      value: databaseStatus.configured
        ? databaseStatus.required ? "Configured" : "Configured (optional)"
        : databaseStatus.required ? "Missing" : "Optional",
      tone: databaseStatus.configured ? "good" : databaseStatus.required ? "warning" : "neutral",
    };
  }

  if (secret === "SCIENCESWARM_USER_HANDLE") {
    const configured = Boolean(health.scienceswarm_user_handle?.configured);
    return {
      label: secret,
      value: configured ? "Configured" : "Missing",
      tone: configured ? "good" : "warning",
    };
  }

  if (secret === "OPENAI_API_KEY") {
    if (health.openai === "configured") {
      return { label: secret, value: "Configured", tone: "good" };
    }
    return {
      label: secret,
      value: health.openai === "disabled" ? "Disabled" : "Missing",
      tone: "warning",
    };
  }

  return null;
}

function formatElapsed(ageMs: number): string {
  const totalMinutes = Math.max(0, Math.round(ageMs / 60_000));
  if (totalMinutes < 1) return "just now";
  if (totalMinutes < 60) return `${totalMinutes}m ago`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "1d ago" : `${days}d ago`;
}
