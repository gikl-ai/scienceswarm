"use client";

import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  FloppyDiskBack,
  Globe,
  Lock,
  Plus,
  Sparkle,
  UploadSimple,
} from "@phosphor-icons/react";
import { Spinner } from "@/components/spinner";
import {
  type SkillHost,
  type SkillHostDefinition,
  type SkillStatus,
  type SkillVisibility,
  type WorkspaceSkillRecord,
  SKILL_HOST_DEFINITIONS,
} from "@/lib/skills/schema";

type WorkspaceSkillsResponse = {
  skills?: WorkspaceSkillRecord[];
  hosts?: SkillHostDefinition[];
  error?: string;
};

type WorkspaceSkillMutationResponse = {
  skill?: WorkspaceSkillRecord;
  message?: string;
  error?: string;
};

type FetchStatus = "idle" | "loading" | "ready" | "error";
type VisibilityFilter = "all" | SkillVisibility;

type RequestState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; message: string }
  | { state: "error"; message: string };

type ManifestDraft = {
  name: string;
  description: string;
  visibility: SkillVisibility;
  status: SkillStatus;
  tags: string;
  owner: string;
  summary: string;
  hosts: SkillHost[];
};

const DEFAULT_CREATE_HOSTS: SkillHost[] = ["openclaw", "claude-code", "codex"];

function buildManifestDraft(skill: WorkspaceSkillRecord): ManifestDraft {
  return {
    name: skill.name,
    description: skill.description,
    visibility: skill.visibility,
    status: skill.status,
    tags: skill.tags.join(", "),
    owner: skill.owner ?? "",
    summary: skill.summary ?? "",
    hosts: [...skill.hosts],
  };
}

function sortSkills(skills: WorkspaceSkillRecord[]): WorkspaceSkillRecord[] {
  return [...skills].sort((left, right) => {
    if (left.visibility !== right.visibility) {
      return left.visibility === "public" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function normalizeTagList(value: string): string[] {
  return [...new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
}

function sameHosts(left: SkillHost[], right: SkillHost[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.every((host, index) => host === normalizedRight[index]);
}

function manifestDraftChanged(draft: ManifestDraft, skill: WorkspaceSkillRecord): boolean {
  return (
    draft.name !== skill.name ||
    draft.description !== skill.description ||
    draft.visibility !== skill.visibility ||
    draft.status !== skill.status ||
    draft.owner.trim() !== (skill.owner ?? "") ||
    draft.summary.trim() !== (skill.summary ?? "") ||
    !sameHosts(draft.hosts, skill.hosts) ||
    normalizeTagList(draft.tags).join("\n") !== skill.tags.join("\n")
  );
}

function sameManifestDraft(left: ManifestDraft, right: ManifestDraft): boolean {
  return (
    left.name === right.name &&
    left.description === right.description &&
    left.visibility === right.visibility &&
    left.status === right.status &&
    left.owner === right.owner &&
    left.summary === right.summary &&
    left.tags === right.tags &&
    sameHosts(left.hosts, right.hosts)
  );
}

function toneForSyncState(syncState: WorkspaceSkillRecord["adapters"][number]["syncState"]): string {
  if (syncState === "synced") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (syncState === "pending") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-border bg-surface text-muted";
}

export function WorkspaceSkillsBrowser({
  selectedSkillSlug,
  onSelectSkill,
}: {
  selectedSkillSlug?: string | null;
  onSelectSkill: (slug: string) => void;
}) {
  const [skillsStatus, setSkillsStatus] = useState<FetchStatus>("loading");
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skills, setSkills] = useState<WorkspaceSkillRecord[]>([]);
  const [hostDefinitions, setHostDefinitions] = useState<SkillHostDefinition[]>(SKILL_HOST_DEFINITIONS);
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>("all");
  const [query, setQuery] = useState("");
  const [manifestDraftsBySkill, setManifestDraftsBySkill] = useState<Record<string, ManifestDraft>>({});
  const [adapterDraftsBySkill, setAdapterDraftsBySkill] = useState<Record<string, Record<string, string>>>({});
  const [selectedAdapterHostBySkill, setSelectedAdapterHostBySkill] = useState<Record<string, SkillHost>>({});
  const [saveStateBySkill, setSaveStateBySkill] = useState<Record<string, RequestState>>({});
  const [syncStateBySkill, setSyncStateBySkill] = useState<Record<string, RequestState>>({});
  const [promoteStateBySkill, setPromoteStateBySkill] = useState<Record<string, RequestState>>({});
  const [selectedSkillOverride, setSelectedSkillOverride] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportForm, setShowImportForm] = useState(false);
  const [createState, setCreateState] = useState<RequestState>({ state: "idle" });
  const [importState, setImportState] = useState<RequestState>({ state: "idle" });
  const [createForm, setCreateForm] = useState({
    slug: "",
    name: "",
    description: "",
    hosts: DEFAULT_CREATE_HOSTS,
  });
  const [importForm, setImportForm] = useState({
    repo: "",
    path: "",
    ref: "main",
    host: "openclaw" as SkillHost,
    slug: "",
  });
  const manifestDraftsRef = useRef<Record<string, ManifestDraft>>({});
  const draftsRef = useRef<Record<string, Record<string, string>>>({});
  const creationModeActive = showCreateForm || showImportForm;
  const effectiveSelectedSkillSlug = selectedSkillOverride ?? selectedSkillSlug ?? null;

  useEffect(() => {
    if (!selectedSkillOverride) return;
    if (selectedSkillSlug === selectedSkillOverride) {
      setSelectedSkillOverride(null);
    }
  }, [selectedSkillOverride, selectedSkillSlug]);

  useEffect(() => {
    const controller = new AbortController();

    setSkillsStatus("loading");
    setSkillsError(null);

    fetch("/api/skills", { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as WorkspaceSkillsResponse;
        if (!response.ok) {
          throw new Error(payload.error || "Failed to load workspace skills.");
        }
        setSkills(sortSkills(payload.skills ?? []));
        setHostDefinitions(payload.hosts ?? SKILL_HOST_DEFINITIONS);
        setSkillsStatus("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setSkillsStatus("error");
        setSkillsError(error instanceof Error ? error.message : "Failed to load workspace skills.");
      });

    return () => controller.abort();
  }, []);

  const filteredSkills = useMemo(() => {
    const visibilityFiltered = visibilityFilter === "all"
      ? skills
      : skills.filter((skill) => skill.visibility === visibilityFilter);
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return visibilityFiltered;
    return visibilityFiltered.filter((skill) => (
      skill.slug.toLowerCase().includes(normalizedQuery) ||
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.description.toLowerCase().includes(normalizedQuery) ||
      skill.hosts.some((host) => host.toLowerCase().includes(normalizedQuery)) ||
      skill.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))
    ));
  }, [query, skills, visibilityFilter]);

  const selectedSkill = useMemo(() => {
    if (creationModeActive) return null;
    if (filteredSkills.length === 0) return null;
    if (!effectiveSelectedSkillSlug) return filteredSkills[0];
    return filteredSkills.find((skill) => skill.slug === effectiveSelectedSkillSlug) ?? filteredSkills[0];
  }, [creationModeActive, effectiveSelectedSkillSlug, filteredSkills]);

  useEffect(() => {
    if (creationModeActive) return;
    if (!selectedSkill) return;
    if (selectedSkill.slug === effectiveSelectedSkillSlug) return;
    startTransition(() => {
      onSelectSkill(selectedSkill.slug);
    });
  }, [creationModeActive, effectiveSelectedSkillSlug, onSelectSkill, selectedSkill]);

  const manifestDraft = selectedSkill
    ? manifestDraftsBySkill[selectedSkill.slug] ?? buildManifestDraft(selectedSkill)
    : null;

  const selectedAdapterHost = useMemo(() => {
    if (!selectedSkill) return null;
    const requestedHost = selectedAdapterHostBySkill[selectedSkill.slug];
    if (requestedHost && selectedSkill.adapters.some((adapter) => adapter.host === requestedHost)) {
      return requestedHost;
    }
    return selectedSkill.adapters[0]?.host ?? null;
  }, [selectedAdapterHostBySkill, selectedSkill]);

  const selectedAdapter = useMemo(() => {
    if (!selectedSkill || !selectedAdapterHost) return null;
    return selectedSkill.adapters.find((adapter) => adapter.host === selectedAdapterHost) ?? null;
  }, [selectedAdapterHost, selectedSkill]);

  useEffect(() => {
    if (!selectedSkill || !selectedAdapterHost) return;
    setSelectedAdapterHostBySkill((current) => {
      if (current[selectedSkill.slug] === selectedAdapterHost) return current;
      return { ...current, [selectedSkill.slug]: selectedAdapterHost };
    });
  }, [selectedAdapterHost, selectedSkill]);

  const adapterDraft =
    selectedSkill && selectedAdapter
      ? adapterDraftsBySkill[selectedSkill.slug]?.[selectedAdapter.host] ?? selectedAdapter.rawMarkdown
      : "";

  const saveState = selectedSkill
    ? saveStateBySkill[selectedSkill.slug] ?? { state: "idle" as const }
    : { state: "idle" as const };
  const syncState = selectedSkill
    ? syncStateBySkill[selectedSkill.slug] ?? { state: "idle" as const }
    : { state: "idle" as const };
  const promoteState = selectedSkill
    ? promoteStateBySkill[selectedSkill.slug] ?? { state: "idle" as const }
    : { state: "idle" as const };

  const hasManifestChanges = Boolean(selectedSkill && manifestDraft && manifestDraftChanged(manifestDraft, selectedSkill));
  const hasAdapterChanges = Boolean(selectedAdapter && adapterDraft !== selectedAdapter.rawMarkdown);
  const hasUnsavedChanges = hasManifestChanges || hasAdapterChanges;

  function upsertManifestDraft(skillSlug: string, nextDraft: ManifestDraft): void {
    manifestDraftsRef.current = {
      ...manifestDraftsRef.current,
      [skillSlug]: nextDraft,
    };
    setManifestDraftsBySkill((current) => ({
      ...current,
      [skillSlug]: nextDraft,
    }));
    setPromoteStateBySkill((current) => ({
      ...current,
      [skillSlug]: { state: "idle" },
    }));
  }

  function clearManifestDraft(skillSlug: string): void {
    const nextDrafts = { ...manifestDraftsRef.current };
    delete nextDrafts[skillSlug];
    manifestDraftsRef.current = nextDrafts;
    setManifestDraftsBySkill((current) => {
      const next = { ...current };
      delete next[skillSlug];
      return next;
    });
  }

  function upsertAdapterDraft(skillSlug: string, host: SkillHost, value: string): void {
    draftsRef.current = {
      ...draftsRef.current,
      [skillSlug]: {
        ...(draftsRef.current[skillSlug] ?? {}),
        [host]: value,
      },
    };
    setAdapterDraftsBySkill((current) => ({
      ...current,
      [skillSlug]: {
        ...(current[skillSlug] ?? {}),
        [host]: value,
      },
    }));
    setPromoteStateBySkill((current) => ({
      ...current,
      [skillSlug]: { state: "idle" },
    }));
  }

  function clearSkillDrafts(skillSlug: string): void {
    clearManifestDraft(skillSlug);
    setAdapterDraftsBySkill((current) => {
      const next = { ...current };
      delete next[skillSlug];
      draftsRef.current = next;
      return next;
    });
  }

  function updateSkill(nextSkill: WorkspaceSkillRecord): void {
    setSkills((current) => {
      const existingIndex = current.findIndex((skill) => skill.slug === nextSkill.slug);
      if (existingIndex < 0) {
        return sortSkills([...current, nextSkill]);
      }
      const copy = [...current];
      copy[existingIndex] = nextSkill;
      return sortSkills(copy);
    });
  }

  async function handleSave(): Promise<void> {
    if (!selectedSkill || !manifestDraft) return;

    const skillSlug = selectedSkill.slug;
    const submittedManifestDraft = hasManifestChanges ? manifestDraft : null;
    const submittedAdapterHost = hasAdapterChanges && selectedAdapter ? selectedAdapter.host : null;
    const submittedAdapterDraft = submittedAdapterHost ? adapterDraft : null;

    setSaveStateBySkill((current) => ({
      ...current,
      [skillSlug]: { state: "saving" },
    }));

    const payload: Record<string, unknown> = {};
    if (hasManifestChanges) {
      payload.manifest = {
        name: manifestDraft.name,
        description: manifestDraft.description,
        visibility: manifestDraft.visibility,
        status: manifestDraft.status,
        tags: normalizeTagList(manifestDraft.tags),
        hosts: manifestDraft.hosts,
        owner: manifestDraft.owner,
        summary: manifestDraft.summary,
      };
    }
    if (hasAdapterChanges && selectedAdapter) {
      payload.adapterHost = selectedAdapter.host;
      payload.markdown = adapterDraft;
    }

    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skillSlug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const responseBody = await response.json().catch(() => ({})) as WorkspaceSkillMutationResponse;
      if (!response.ok || !responseBody.skill) {
        throw new Error(responseBody.error || "Failed to save workspace skill.");
      }

      updateSkill(responseBody.skill);
      const latestManifestDraft = manifestDraftsRef.current[skillSlug];
      const hasNewerManifestDraft = Boolean(
        submittedManifestDraft &&
        latestManifestDraft &&
        !sameManifestDraft(latestManifestDraft, submittedManifestDraft),
      );
      if (!submittedManifestDraft || !hasNewerManifestDraft) {
        clearManifestDraft(skillSlug);
      }

      const latestAdapterDraft = submittedAdapterHost
        ? draftsRef.current[skillSlug]?.[submittedAdapterHost]
        : undefined;
      const hasNewerAdapterDraft = Boolean(
        submittedAdapterHost &&
        submittedAdapterDraft !== null &&
        typeof latestAdapterDraft === "string" &&
        latestAdapterDraft !== submittedAdapterDraft,
      );
      if (!submittedAdapterHost || !hasNewerAdapterDraft) {
        setAdapterDraftsBySkill((current) => {
          const activeSkillDrafts = current[skillSlug];
          if (!activeSkillDrafts || !submittedAdapterHost) {
            return current;
          }
          const nextSkillDrafts = { ...activeSkillDrafts };
          delete nextSkillDrafts[submittedAdapterHost];
          const next = { ...current };
          if (Object.keys(nextSkillDrafts).length === 0) {
            delete next[skillSlug];
          } else {
            next[skillSlug] = nextSkillDrafts;
          }

          const refNext = { ...draftsRef.current };
          if (refNext[skillSlug]) {
            const refSkillDrafts = { ...refNext[skillSlug] };
            delete refSkillDrafts[submittedAdapterHost];
            if (Object.keys(refSkillDrafts).length === 0) {
              delete refNext[skillSlug];
            } else {
              refNext[skillSlug] = refSkillDrafts;
            }
          }
          draftsRef.current = refNext;
          return next;
        });
      }

      setSaveStateBySkill((current) => ({
        ...current,
        [skillSlug]: {
          state: hasNewerManifestDraft || hasNewerAdapterDraft ? "idle" : "saved",
          message: responseBody.message || "Workspace skill saved.",
        },
      }));
    } catch (error) {
      setSaveStateBySkill((current) => ({
        ...current,
        [skillSlug]: {
          state: "error",
          message: error instanceof Error ? error.message : "Failed to save workspace skill.",
        },
      }));
    }
  }

  async function handleSync(hosts?: SkillHost[]): Promise<void> {
    if (!selectedSkill) return;

    const skillSlug = selectedSkill.slug;
    setSyncStateBySkill((current) => ({
      ...current,
      [skillSlug]: { state: "saving" },
    }));

    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skillSlug)}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hosts }),
      });
      const responseBody = await response.json().catch(() => ({})) as WorkspaceSkillMutationResponse;
      if (!response.ok || !responseBody.skill) {
        throw new Error(responseBody.error || "Failed to sync workspace skill.");
      }

      updateSkill(responseBody.skill);
      setSyncStateBySkill((current) => ({
        ...current,
        [skillSlug]: {
          state: "saved",
          message: responseBody.message || "Workspace skill synced.",
        },
      }));
    } catch (error) {
      setSyncStateBySkill((current) => ({
        ...current,
        [skillSlug]: {
          state: "error",
          message: error instanceof Error ? error.message : "Failed to sync workspace skill.",
        },
      }));
    }
  }

  async function handleCreateSkill(): Promise<void> {
    setCreateState({ state: "saving" });
    try {
      const response = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createForm),
      });
      const responseBody = await response.json().catch(() => ({})) as WorkspaceSkillMutationResponse;
      if (!response.ok || !responseBody.skill) {
        throw new Error(responseBody.error || "Failed to create workspace skill.");
      }

      updateSkill(responseBody.skill);
      setCreateState({
        state: "saved",
        message: responseBody.message || "Workspace skill created.",
      });
      setCreateForm({
        slug: "",
        name: "",
        description: "",
        hosts: DEFAULT_CREATE_HOSTS,
      });
      setSelectedSkillOverride(responseBody.skill.slug);
      onSelectSkill(responseBody.skill.slug);
      setShowCreateForm(false);
    } catch (error) {
      setCreateState({
        state: "error",
        message: error instanceof Error ? error.message : "Failed to create workspace skill.",
      });
    }
  }

  async function handleImportSkill(): Promise<void> {
    setImportState({ state: "saving" });
    try {
      const response = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: importForm.repo,
          path: importForm.path,
          ref: importForm.ref,
          host: importForm.host,
          slug: importForm.slug || undefined,
        }),
      });
      const responseBody = await response.json().catch(() => ({})) as WorkspaceSkillMutationResponse;
      if (!response.ok || !responseBody.skill) {
        throw new Error(responseBody.error || "Failed to import workspace skill.");
      }

      updateSkill(responseBody.skill);
      setImportState({
        state: "saved",
        message: responseBody.message || "Workspace skill imported.",
      });
      setImportForm({
        repo: "",
        path: "",
        ref: "main",
        host: "openclaw",
        slug: "",
      });
      setSelectedSkillOverride(responseBody.skill.slug);
      onSelectSkill(responseBody.skill.slug);
      setShowImportForm(false);
    } catch (error) {
      setImportState({
        state: "error",
        message: error instanceof Error ? error.message : "Failed to import workspace skill.",
      });
    }
  }

  function toggleCreateHost(host: SkillHost): void {
    setCreateForm((current) => ({
      ...current,
      hosts: current.hosts.includes(host)
        ? current.hosts.filter((entry) => entry !== host)
        : [...current.hosts, host],
    }));
  }

  function toggleManifestHost(host: SkillHost): void {
    if (!selectedSkill || !manifestDraft) return;
    const nextHosts = manifestDraft.hosts.includes(host)
      ? manifestDraft.hosts.filter((entry) => entry !== host)
      : [...manifestDraft.hosts, host];
    upsertManifestDraft(selectedSkill.slug, {
      ...manifestDraft,
      hosts: nextHosts,
    });
    setSaveStateBySkill((current) => ({
      ...current,
      [selectedSkill.slug]: { state: "idle" },
    }));
  }

  async function handlePromote(): Promise<void> {
    if (!selectedSkill || hasUnsavedChanges) return;

    const skillSlug = selectedSkill.slug;
    setPromoteStateBySkill((current) => ({
      ...current,
      [skillSlug]: { state: "saving" },
    }));

    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skillSlug)}/promote`, {
        method: "POST",
      });
      const responseBody = await response.json().catch(() => ({})) as WorkspaceSkillMutationResponse;
      if (!response.ok || !responseBody.skill) {
        throw new Error(responseBody.error || "Failed to promote workspace skill.");
      }

      updateSkill(responseBody.skill);
      clearSkillDrafts(skillSlug);
      setSaveStateBySkill((current) => ({
        ...current,
        [skillSlug]: { state: "idle" },
      }));
      setSyncStateBySkill((current) => ({
        ...current,
        [skillSlug]: { state: "idle" },
      }));
      setPromoteStateBySkill((current) => ({
        ...current,
        [skillSlug]: {
          state: "saved",
          message: responseBody.message || "Workspace skill promoted.",
        },
      }));
    } catch (error) {
      setPromoteStateBySkill((current) => ({
        ...current,
        [skillSlug]: {
          state: "error",
          message: error instanceof Error ? error.message : "Failed to promote workspace skill.",
        },
      }));
    }
  }

  if (skillsStatus === "loading") {
    return (
      <div className="flex min-h-[32rem] items-center justify-center gap-2 rounded-[24px] border border-border bg-white shadow-sm">
        <Spinner size="h-4 w-4" />
        <span className="text-sm text-muted">Loading ScienceSwarm skills workspace...</span>
      </div>
    );
  }

  if (skillsStatus === "error") {
    return (
      <div className="rounded-[24px] border border-red-200 bg-red-50 p-5 text-sm text-red-800 shadow-sm">
        <p className="font-semibold">Could not load the ScienceSwarm skills workspace.</p>
        <p className="mt-2 text-red-700">{skillsError ?? "Unknown error"}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-[32rem] overflow-hidden rounded-[24px] border border-border bg-white shadow-sm">
      <aside className="flex w-[22rem] shrink-0 flex-col border-r border-border bg-surface/50">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            <Sparkle size={14} />
            ScienceSwarm skills
          </div>
          <p className="mt-2 text-sm text-muted">
            Curate private skills in this clone, sync host outputs, and promote only the ones you want public.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setShowCreateForm((current) => !current);
                setShowImportForm(false);
                setCreateState({ state: "idle" });
              }}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
            >
              <Plus size={14} />
              New skill
            </button>
            <button
              type="button"
              onClick={() => {
                setShowImportForm((current) => !current);
                setShowCreateForm(false);
                setImportState({ state: "idle" });
              }}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
            >
              <UploadSimple size={14} />
              Import
            </button>
          </div>

          <div className="mt-4 inline-flex items-center gap-1 rounded-xl border border-border bg-white p-1">
            {(["all", "public", "private"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setVisibilityFilter(value)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  visibilityFilter === value
                    ? "bg-surface text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {value === "all" ? "All" : value === "public" ? "Public" : "Private"}
              </button>
            ))}
          </div>
          <label className="mt-4 block">
            <span className="sr-only">Search workspace skills</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, slug, tag, or host"
              className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
            />
          </label>
        </div>

        {showCreateForm && (
          <div className="border-b border-border bg-white px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Create skill</div>
            <div className="mt-3 grid gap-3">
              <label className="grid gap-1">
                <span className="text-xs font-semibold text-foreground">Slug</span>
                <input
                  value={createForm.slug}
                  onChange={(event) => {
                    setCreateForm((current) => ({ ...current, slug: event.target.value }));
                    setCreateState({ state: "idle" });
                  }}
                  placeholder="my-skill"
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-semibold text-foreground">Display name</span>
                <input
                  value={createForm.name}
                  onChange={(event) => {
                    setCreateForm((current) => ({ ...current, name: event.target.value }));
                    setCreateState({ state: "idle" });
                  }}
                  placeholder="My Skill"
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-semibold text-foreground">Description</span>
                <textarea
                  value={createForm.description}
                  onChange={(event) => {
                    setCreateForm((current) => ({ ...current, description: event.target.value }));
                    setCreateState({ state: "idle" });
                  }}
                  rows={3}
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                />
              </label>
              <div className="grid gap-2">
                <span className="text-xs font-semibold text-foreground">Hosts</span>
                <div className="grid gap-2">
                  {hostDefinitions.map((host) => (
                    <label key={host.host} className="flex items-start gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={createForm.hosts.includes(host.host)}
                        onChange={() => {
                          toggleCreateHost(host.host);
                          setCreateState({ state: "idle" });
                        }}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block font-semibold text-foreground">{host.label}</span>
                        <span>{host.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <p className="rounded-xl border border-border bg-surface px-3 py-2 text-xs text-muted">
                New skills start private in this clone. Promote them later when they are ready for the ScienceSwarm public catalog.
              </p>
              <button
                type="button"
                onClick={() => { void handleCreateSkill(); }}
                disabled={
                  createState.state === "saving" ||
                  createForm.slug.trim().length === 0 ||
                  createForm.name.trim().length === 0 ||
                  createForm.description.trim().length === 0 ||
                  createForm.hosts.length === 0
                }
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={16} />
                {createState.state === "saving" ? "Creating..." : "Create skill"}
              </button>
              {createState.state === "error" && (
                <p className="text-sm text-red-700">{createState.message}</p>
              )}
              {createState.state === "saved" && (
                <p className="text-sm text-emerald-700">{createState.message}</p>
              )}
            </div>
          </div>
        )}

        {showImportForm && (
          <div className="border-b border-border bg-white px-4 py-4">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Import skill</div>
            <div className="mt-3 grid gap-3">
              <label className="grid gap-1">
                <span className="text-xs font-semibold text-foreground">Repo</span>
                <input
                  value={importForm.repo}
                  onChange={(event) => {
                    setImportForm((current) => ({ ...current, repo: event.target.value }));
                    setImportState({ state: "idle" });
                  }}
                  placeholder="owner/repo"
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-semibold text-foreground">Path to skill</span>
                <input
                  value={importForm.path}
                  onChange={(event) => {
                    setImportForm((current) => ({ ...current, path: event.target.value }));
                    setImportState({ state: "idle" });
                  }}
                  placeholder="skills/my-skill"
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1">
                  <span className="text-xs font-semibold text-foreground">Ref</span>
                  <input
                    value={importForm.ref}
                    onChange={(event) => {
                      setImportForm((current) => ({ ...current, ref: event.target.value }));
                      setImportState({ state: "idle" });
                    }}
                    className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-xs font-semibold text-foreground">Adapter host</span>
                  <select
                    value={importForm.host}
                    onChange={(event) => {
                      setImportForm((current) => ({ ...current, host: event.target.value }));
                      setImportState({ state: "idle" });
                    }}
                    className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                  >
                    {hostDefinitions.map((host) => (
                      <option key={host.host} value={host.host}>
                        {host.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="grid gap-1">
                <span className="text-xs font-semibold text-foreground">Optional local slug override</span>
                <input
                  value={importForm.slug}
                  onChange={(event) => {
                    setImportForm((current) => ({ ...current, slug: event.target.value }));
                    setImportState({ state: "idle" });
                  }}
                  placeholder="leave blank to keep source slug"
                  className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:bg-white"
                />
              </label>
              <p className="rounded-xl border border-border bg-surface px-3 py-2 text-xs text-muted">
                Imported skills land as private workspace entries first. Review and adapt them before promoting any subset publicly.
              </p>
              <button
                type="button"
                onClick={() => { void handleImportSkill(); }}
                disabled={
                  importState.state === "saving" ||
                  importForm.repo.trim().length === 0 ||
                  importForm.path.trim().length === 0
                }
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <UploadSimple size={16} />
                {importState.state === "saving" ? "Importing..." : "Import skill"}
              </button>
              {importState.state === "error" && (
                <p className="text-sm text-red-700">{importState.message}</p>
              )}
              {importState.state === "saved" && (
                <p className="text-sm text-emerald-700">{importState.message}</p>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">
          {filteredSkills.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-white px-4 py-5 text-sm text-muted">
              No skills match the current filter.
            </div>
          ) : (
            filteredSkills.map((skill) => {
              const active = skill.slug === selectedSkill?.slug;
              return (
                <button
                  key={skill.slug}
                  type="button"
                  onClick={() => {
                    setShowCreateForm(false);
                    setShowImportForm(false);
                    setSelectedSkillOverride(skill.slug);
                    startTransition(() => {
                      onSelectSkill(skill.slug);
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
                      {skill.visibility === "public" ? <Globe size={16} /> : <Lock size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-foreground">{skill.name}</div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{skill.description}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                          {skill.visibility}
                        </span>
                        <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                          {skill.status}
                        </span>
                        <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                          {skill.hosts.length} hosts
                        </span>
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
        {showCreateForm ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-lg text-center">
              <p className="text-sm font-semibold text-foreground">Create a new workspace skill</p>
              <p className="mt-2 text-sm text-muted">
                Use the form on the left to define the slug, name, description, and hosts for a new private workspace skill.
              </p>
            </div>
          </div>
        ) : showImportForm ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-lg text-center">
              <p className="text-sm font-semibold text-foreground">Import a workspace skill</p>
              <p className="mt-2 text-sm text-muted">
                Use the import form on the left to pull an existing skill into this workspace before editing or syncing it.
              </p>
            </div>
          </div>
        ) : !selectedSkill || !manifestDraft ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-lg text-center">
              <p className="text-sm font-semibold text-foreground">Create your first workspace skill</p>
              <p className="mt-2 text-sm text-muted">
                Skills now live in <code>skills/</code> first, then sync into host-specific trees like <code>.openclaw/skills</code>.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="border-b border-border px-5 py-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                    <Sparkle size={14} />
                    Canonical workspace skill
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-xl font-semibold text-foreground">{selectedSkill.name}</h2>
                    <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      {selectedSkill.slug}
                    </span>
                    <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      {selectedSkill.visibility}
                    </span>
                    <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      {selectedSkill.status}
                    </span>
                    <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      {selectedSkill.source.kind}
                    </span>
                  </div>
                  <p className="mt-2 max-w-3xl text-sm text-muted">{selectedSkill.description}</p>
                  <p className="mt-3 text-xs text-muted">
                    <code>skills/{selectedSkill.slug}/skill.json</code> is the source of truth. Public skills auto-export into <code>skills/public-index.json</code>.
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
                    {saveState.state === "saving" ? "Saving..." : "Save workspace skill"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleSync(); }}
                    disabled={syncState.state === "saving"}
                    className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ArrowsClockwise size={16} />
                    {syncState.state === "saving" ? "Syncing..." : "Sync enabled hosts"}
                  </button>
                  {selectedSkill.visibility === "private" ? (
                    <button
                      type="button"
                      onClick={() => { void handlePromote(); }}
                      disabled={hasUnsavedChanges || promoteState.state === "saving"}
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 text-sm font-semibold text-emerald-900 transition-colors hover:border-emerald-400 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Globe size={16} />
                      {promoteState.state === "saving" ? "Promoting..." : "Promote to public catalog"}
                    </button>
                  ) : (
                    <div className="inline-flex h-10 items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 text-sm font-semibold text-emerald-900">
                      <CheckCircle size={16} />
                      Public in ScienceSwarm catalog
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      clearSkillDrafts(selectedSkill.slug);
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
                  {selectedSkill.visibility === "private" && hasUnsavedChanges && (
                    <p className="max-w-[17rem] text-xs text-muted">
                      Save the current draft before promoting it into the public ScienceSwarm catalog.
                    </p>
                  )}
                </div>
              </div>

              {saveState.state === "saved" && (
                <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  <CheckCircle size={18} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Workspace skill saved.</p>
                    <p className="mt-1 text-emerald-700">{saveState.message}</p>
                  </div>
                </div>
              )}

              {syncState.state === "saved" && (
                <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  <CheckCircle size={18} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Host outputs synced.</p>
                    <p className="mt-1 text-emerald-700">{syncState.message}</p>
                  </div>
                </div>
              )}

              {promoteState.state === "saved" && (
                <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  <CheckCircle size={18} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Skill promoted.</p>
                    <p className="mt-1 text-emerald-700">{promoteState.message}</p>
                  </div>
                </div>
              )}

              {saveState.state === "error" && (
                <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  <p className="font-semibold">Save failed.</p>
                  <p className="mt-1 text-red-700">{saveState.message}</p>
                </div>
              )}

              {syncState.state === "error" && (
                <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  <p className="font-semibold">Sync failed.</p>
                  <p className="mt-1 text-red-700">{syncState.message}</p>
                </div>
              )}

              {promoteState.state === "error" && (
                <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  <p className="font-semibold">Promotion failed.</p>
                  <p className="mt-1 whitespace-pre-line text-red-700">{promoteState.message}</p>
                </div>
              )}
            </div>

            <div className="grid min-h-0 flex-1 gap-0 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
              <section className="min-h-0 overflow-y-auto border-b border-border p-5 xl:border-b-0 xl:border-r">
                <div className="grid gap-4">
                  <section className="rounded-2xl border border-border bg-surface/40 p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Metadata</h3>
                    <div className="mt-3 grid gap-3">
                      <label className="grid gap-1">
                        <span className="text-xs font-semibold text-foreground">Display name</span>
                        <input
                          value={manifestDraft.name}
                          onChange={(event) => {
                            upsertManifestDraft(selectedSkill.slug, {
                              ...manifestDraft,
                              name: event.target.value,
                            });
                            setSaveStateBySkill((current) => ({
                              ...current,
                              [selectedSkill.slug]: { state: "idle" },
                            }));
                          }}
                          className="rounded-xl border border-border bg-white px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
                        />
                      </label>
                      <label className="grid gap-1">
                        <span className="text-xs font-semibold text-foreground">Description</span>
                        <textarea
                          value={manifestDraft.description}
                          onChange={(event) => {
                            upsertManifestDraft(selectedSkill.slug, {
                              ...manifestDraft,
                              description: event.target.value,
                            });
                            setSaveStateBySkill((current) => ({
                              ...current,
                              [selectedSkill.slug]: { state: "idle" },
                            }));
                          }}
                          rows={3}
                          className="rounded-xl border border-border bg-white px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1">
                          <span className="text-xs font-semibold text-foreground">Visibility</span>
                          <div className="rounded-xl border border-border bg-white px-3 py-2 text-sm text-foreground">
                            <div className="flex items-center gap-2">
                              {selectedSkill.visibility === "public" ? <Globe size={16} /> : <Lock size={16} />}
                              <span>{selectedSkill.visibility === "public" ? "Public" : "Private"}</span>
                            </div>
                          </div>
                          <p className="text-xs text-muted">
                            {selectedSkill.visibility === "public"
                              ? "This skill already ships in the ScienceSwarm public catalog."
                              : "Private skills stay in your clone until you promote them."}
                          </p>
                        </div>
                        <label className="grid gap-1">
                          <span className="text-xs font-semibold text-foreground">Status</span>
                          <select
                            value={manifestDraft.status}
                            onChange={(event) => {
                              upsertManifestDraft(selectedSkill.slug, {
                                ...manifestDraft,
                                status: event.target.value === "ready" ? "ready" : "draft",
                              });
                              setSaveStateBySkill((current) => ({
                                ...current,
                                [selectedSkill.slug]: { state: "idle" },
                              }));
                            }}
                            className="rounded-xl border border-border bg-white px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
                          >
                            <option value="draft">Draft</option>
                            <option value="ready">Ready</option>
                          </select>
                        </label>
                      </div>
                      <label className="grid gap-1">
                        <span className="text-xs font-semibold text-foreground">Tags</span>
                        <input
                          value={manifestDraft.tags}
                          onChange={(event) => {
                            upsertManifestDraft(selectedSkill.slug, {
                              ...manifestDraft,
                              tags: event.target.value,
                            });
                            setSaveStateBySkill((current) => ({
                              ...current,
                              [selectedSkill.slug]: { state: "idle" },
                            }));
                          }}
                          placeholder="science, planning, evidence"
                          className="rounded-xl border border-border bg-white px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
                        />
                      </label>
                      <label className="grid gap-1">
                        <span className="text-xs font-semibold text-foreground">Owner</span>
                        <input
                          value={manifestDraft.owner}
                          onChange={(event) => {
                            upsertManifestDraft(selectedSkill.slug, {
                              ...manifestDraft,
                              owner: event.target.value,
                            });
                            setSaveStateBySkill((current) => ({
                              ...current,
                              [selectedSkill.slug]: { state: "idle" },
                            }));
                          }}
                          placeholder="Optional public owner"
                          className="rounded-xl border border-border bg-white px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
                        />
                      </label>
                      <label className="grid gap-1">
                        <span className="text-xs font-semibold text-foreground">Summary</span>
                        <textarea
                          value={manifestDraft.summary}
                          onChange={(event) => {
                            upsertManifestDraft(selectedSkill.slug, {
                              ...manifestDraft,
                              summary: event.target.value,
                            });
                            setSaveStateBySkill((current) => ({
                              ...current,
                              [selectedSkill.slug]: { state: "idle" },
                            }));
                          }}
                          rows={3}
                          placeholder="Optional one-paragraph catalog summary"
                          className="rounded-xl border border-border bg-white px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent"
                        />
                      </label>
                    </div>
                  </section>

                  <section className="rounded-2xl border border-border bg-surface/40 p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Host adapters</h3>
                    <p className="mt-2 text-sm text-muted">
                      Pick which hosts this workspace skill supports. Sync writes the chosen adapters into each repo-local host tree.
                    </p>
                    <div className="mt-4 grid gap-2">
                      {hostDefinitions.map((host) => {
                        const enabled = manifestDraft.hosts.includes(host.host);
                        const adapter = selectedSkill.adapters.find((entry) => entry.host === host.host);
                        return (
                          <label
                            key={host.host}
                            className="flex items-start gap-2 rounded-xl border border-border bg-white px-3 py-2 text-xs text-muted"
                          >
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={() => toggleManifestHost(host.host)}
                              className="mt-0.5"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block font-semibold text-foreground">{host.label}</span>
                              <span>{host.description}</span>
                              {adapter?.syncTargetPath && (
                                <span className="mt-1 block font-mono text-[11px] text-muted">
                                  {adapter.syncTargetPath}
                                </span>
                              )}
                            </span>
                            {adapter && (
                              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${toneForSyncState(adapter.syncState)}`}>
                                {adapter.syncState}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  </section>

                  <section className="rounded-2xl border border-border bg-surface/40 p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Source</h3>
                    <div className="mt-3 grid gap-2 text-sm text-muted">
                      <p>
                        <span className="font-semibold text-foreground">Kind:</span> {selectedSkill.source.kind}
                      </p>
                      {selectedSkill.source.repo && (
                        <p>
                          <span className="font-semibold text-foreground">Repo:</span> {selectedSkill.source.repo}
                        </p>
                      )}
                      {selectedSkill.source.ref && (
                        <p>
                          <span className="font-semibold text-foreground">Ref:</span> {selectedSkill.source.ref}
                        </p>
                      )}
                      {selectedSkill.source.path && (
                        <p>
                          <span className="font-semibold text-foreground">Path:</span> {selectedSkill.source.path}
                        </p>
                      )}
                      {selectedSkill.source.importedAt && (
                        <p>
                          <span className="font-semibold text-foreground">Imported:</span> {selectedSkill.source.importedAt}
                        </p>
                      )}
                    </div>
                  </section>
                </div>
              </section>

              <section className="min-h-0 overflow-y-auto p-5">
                <div className="flex flex-wrap items-center gap-2">
                  {selectedSkill.adapters.map((adapter) => (
                    <button
                      key={adapter.host}
                      type="button"
                      onClick={() => {
                        setSelectedAdapterHostBySkill((current) => ({
                          ...current,
                          [selectedSkill.slug]: adapter.host,
                        }));
                      }}
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        adapter.host === selectedAdapter?.host
                          ? "border-accent bg-accent/5 text-accent"
                          : "border-border bg-surface text-foreground hover:border-accent hover:text-accent"
                      }`}
                    >
                      {adapter.host}
                    </button>
                  ))}
                </div>

                {selectedAdapter ? (
                  <>
                    <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-border bg-surface/40 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">{selectedAdapter.host} adapter</h3>
                        <p className="mt-1 text-sm text-muted">
                          Source: <code>{selectedAdapter.relativePath}</code>
                        </p>
                        {selectedAdapter.syncTargetPath && (
                          <p className="mt-1 text-sm text-muted">
                            Sync target: <code>{selectedAdapter.syncTargetPath}</code>
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${toneForSyncState(selectedAdapter.syncState)}`}>
                          {selectedAdapter.syncState}
                        </span>
                        <button
                          type="button"
                          onClick={() => { void handleSync([selectedAdapter.host]); }}
                          disabled={syncState.state === "saving"}
                          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-foreground transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <ArrowsClockwise size={14} />
                          Sync this host
                        </button>
                      </div>
                    </div>

                    <div className="mt-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-foreground">Raw SKILL.md</h3>
                          <p className="mt-1 text-sm text-muted">
                            Edit the host-specific adapter directly, then sync it into the repo host tree.
                          </p>
                        </div>
                        {hasAdapterChanges && (
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-800">
                            Unsaved
                          </span>
                        )}
                      </div>

                      <textarea
                        value={adapterDraft}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          upsertAdapterDraft(selectedSkill.slug, selectedAdapter.host, nextValue);
                          setSaveStateBySkill((current) => ({
                            ...current,
                            [selectedSkill.slug]: { state: "idle" },
                          }));
                        }}
                        spellCheck={false}
                        className="mt-4 min-h-[32rem] w-full resize-y rounded-2xl border border-border bg-surface px-4 py-4 font-mono text-[12px] leading-6 text-foreground outline-none transition-colors focus:border-accent focus:bg-white focus:ring-2 focus:ring-accent/20"
                        aria-label={`${selectedSkill.name} ${selectedAdapter.host} adapter editor`}
                      />
                    </div>
                  </>
                ) : (
                  <div className="mt-6 rounded-2xl border border-dashed border-border bg-surface/40 px-4 py-5 text-sm text-muted">
                    Save the manifest after enabling a host to generate its starter adapter.
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
