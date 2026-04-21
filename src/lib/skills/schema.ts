export const WORKSPACE_SKILLS_DIR = "skills";
export const WORKSPACE_SKILL_MANIFEST = "skill.json";
export const WORKSPACE_SKILL_HOSTS_DIR = "hosts";
export const WORKSPACE_SKILL_MARKDOWN = "SKILL.md";
export const WORKSPACE_PUBLIC_INDEX = "public-index.json";

export const SUPPORTED_SKILL_HOSTS = [
  "openclaw",
  "claude-code",
  "codex",
  "hermes",
  "nanoclaw",
  "openhands",
] as const;

export type SupportedSkillHost = (typeof SUPPORTED_SKILL_HOSTS)[number];
export type SkillHost = SupportedSkillHost | (string & {});

export type SkillVisibility = "private" | "public";
export type SkillStatus = "draft" | "ready";
export type SkillSourceKind = "local" | "imported";
export type SkillSyncState = "synced" | "pending" | "no-target" | "missing-adapter";

export interface WorkspaceSkillSource {
  kind: SkillSourceKind;
  repo?: string;
  ref?: string;
  path?: string;
  importedAt?: string;
}

export interface WorkspaceSkillManifest {
  slug: string;
  name: string;
  description: string;
  visibility: SkillVisibility;
  status: SkillStatus;
  tags: string[];
  hosts: SkillHost[];
  owner: string | null;
  summary: string | null;
  source: WorkspaceSkillSource;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSkillAdapterRecord {
  host: SkillHost;
  relativePath: string;
  syncTargetPath: string | null;
  syncState: SkillSyncState;
  rawMarkdown: string;
}

export interface WorkspaceSkillRecord extends WorkspaceSkillManifest {
  adapters: WorkspaceSkillAdapterRecord[];
}

export interface WorkspacePublicSkillIndexItem {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  hosts: SkillHost[];
  owner: string | null;
  status: SkillStatus;
  summary: string | null;
}

export interface WorkspacePublicSkillIndex {
  generatedAt: string;
  skills: WorkspacePublicSkillIndexItem[];
}

export interface SkillHostDefinition {
  host: SupportedSkillHost;
  label: string;
  description: string;
  syncTemplate: string | null;
}

export const SKILL_HOST_DEFINITIONS: SkillHostDefinition[] = [
  {
    host: "openclaw",
    label: "OpenClaw",
    description: "Materializes to the repo OpenClaw runtime skill tree.",
    syncTemplate: ".openclaw/skills/{slug}/SKILL.md",
  },
  {
    host: "claude-code",
    label: "Claude Code",
    description: "Materializes to the repo Claude skill tree.",
    syncTemplate: ".claude/skills/{slug}/SKILL.md",
  },
  {
    host: "codex",
    label: "Codex",
    description: "Materializes to the repo Codex skill tree.",
    syncTemplate: ".codex/skills/{slug}/SKILL.md",
  },
  {
    host: "hermes",
    label: "Hermes",
    description: "Optional repo-local Hermes adapter output.",
    syncTemplate: ".hermes/skills/{slug}/SKILL.md",
  },
  {
    host: "nanoclaw",
    label: "NanoClaw",
    description: "Optional repo-local NanoClaw adapter output.",
    syncTemplate: ".nanoclaw/skills/{slug}/SKILL.md",
  },
  {
    host: "openhands",
    label: "OpenHands",
    description: "Optional repo-local OpenHands adapter output.",
    syncTemplate: ".openhands/skills/{slug}/SKILL.md",
  },
];

export function defaultSyncTargetForHost(host: SkillHost, slug: string): string | null {
  const definition = SKILL_HOST_DEFINITIONS.find((entry) => entry.host === host);
  if (!definition?.syncTemplate) return null;
  return definition.syncTemplate.replaceAll("{slug}", slug);
}
