import { readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

import type {
  ResearchRuntimeHost,
  RuntimeApprovalState,
  RuntimeDataIncluded,
  RuntimeEvent,
  RuntimeHostId,
  RuntimeHostProfile,
  RuntimeProjectPolicy,
  RuntimeTurnMode,
  RuntimeTurnRequest,
  TurnPreview,
} from "@/lib/runtime-hosts/contracts";
import {
  createRuntimeConcurrencyManager,
  type RuntimeConcurrencyManager,
} from "@/lib/runtime-hosts/concurrency";
import {
  createRuntimeEventStore,
  type RuntimeEventStore,
} from "@/lib/runtime-hosts/events";
import {
  RuntimeHostError,
  isRuntimeHostError,
} from "@/lib/runtime-hosts/errors";
import {
  assertTurnPreviewAllowsPromptConstruction,
  computeTurnPreview,
} from "@/lib/runtime-hosts/policy";
import {
  listRuntimeHostProfiles,
  requireRuntimeHostProfile,
  resolveRuntimeHostRecord,
} from "@/lib/runtime-hosts/registry";
import {
  createRuntimeSessionStore,
  type RuntimeSessionStatus,
  type RuntimeSessionStore,
} from "@/lib/runtime-hosts/sessions";
import { createOpenClawRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/openclaw";
import { createClaudeCodeRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/claude-code";
import { createCodexRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/codex";
import { createGeminiCliRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/gemini-cli";
import { createOpenHandsRuntimeHostAdapter } from "@/lib/runtime-hosts/adapters/openhands";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { isLocalRequest } from "@/lib/local-guard";
import { readOpenClawSkill } from "@/lib/openclaw/skill-catalog";
import { listScienceSwarmOpenClawSlashCommandSkills } from "@/lib/openclaw/skill-registry";
import {
  buildOpenClawSlashCommandPrompt,
  buildOpenClawSlashCommands,
  looksLikeSlashCommandInput,
  parseOpenClawSlashCommandInput,
  type ParsedOpenClawSlashCommand,
} from "@/lib/openclaw/slash-commands";

export interface RuntimeApiServices {
  sessionStore: RuntimeSessionStore;
  eventStore: RuntimeEventStore;
  concurrencyManager: RuntimeConcurrencyManager;
  adapters: ResearchRuntimeHost[];
  now: () => Date;
}

export type RuntimeApiServicesInput = Partial<RuntimeApiServices>;

export const RUNTIME_PROJECT_POLICIES = [
  "local-only",
  "cloud-ok",
  "execution-ok",
] as const satisfies readonly RuntimeProjectPolicy[];

export const RUNTIME_TURN_MODES = [
  "chat",
  "task",
  "compare",
  "mcp-tool",
  "artifact-import",
] as const satisfies readonly RuntimeTurnMode[];

export const RUNTIME_APPROVAL_STATES = [
  "not-required",
  "required",
  "approved",
  "rejected",
] as const satisfies readonly RuntimeApprovalState[];

export const RUNTIME_SESSION_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly RuntimeSessionStatus[];

function defaultRuntimeAdapters(): ResearchRuntimeHost[] {
  return [
    createOpenClawRuntimeHostAdapter(),
    createClaudeCodeRuntimeHostAdapter({ authArgs: ["auth", "status"] }),
    createCodexRuntimeHostAdapter({ authArgs: ["login", "status"] }),
    createGeminiCliRuntimeHostAdapter(),
    createOpenHandsRuntimeHostAdapter(),
  ];
}

function createRuntimeApiServices(
  input: RuntimeApiServicesInput = {},
): RuntimeApiServices {
  const sessionStore = input.sessionStore ?? createRuntimeSessionStore();
  const eventStore = input.eventStore ?? createRuntimeEventStore({
    sessions: sessionStore,
  });
  return {
    sessionStore,
    eventStore,
    concurrencyManager: input.concurrencyManager
      ?? createRuntimeConcurrencyManager(),
    adapters: input.adapters ?? defaultRuntimeAdapters(),
    now: input.now ?? (() => new Date()),
  };
}

let runtimeApiServices = createRuntimeApiServices();

export function getRuntimeApiServices(): RuntimeApiServices {
  return runtimeApiServices;
}

export function __setRuntimeApiServicesForTests(
  input: RuntimeApiServicesInput,
): void {
  runtimeApiServices = createRuntimeApiServices(input);
}

export function __resetRuntimeApiServicesForTests(): void {
  runtimeApiServices = createRuntimeApiServices();
}

export function runtimeInvalidRequest(
  message: string,
  context: Record<string, unknown> = {},
): RuntimeHostError {
  return new RuntimeHostError({
    code: "RUNTIME_INVALID_REQUEST",
    status: 400,
    message,
    userMessage: message,
    recoverable: true,
    context,
  });
}

function hostSkillDirectory(hostId: string | null | undefined): string | null {
  switch (hostId) {
    case "openclaw":
    case "claude-code":
    case "codex":
      return hostId;
    default:
      return null;
  }
}

async function readRuntimeHostSkillInstructions(
  parsed: ParsedOpenClawSlashCommand,
  hostId: string | null | undefined,
): Promise<string | null> {
  const skillSlug = parsed.command.skillSlug;
  if (!skillSlug) return null;

  const hostDirectory = hostSkillDirectory(hostId);
  if (hostDirectory) {
    try {
      const rawMarkdown = await readFile(
        path.join(
          process.cwd(),
          "skills",
          skillSlug,
          "hosts",
          hostDirectory,
          "SKILL.md",
        ),
        "utf-8",
      );
      const parsedMarkdown = matter(rawMarkdown);
      if (parsedMarkdown.content.trim()) {
        return parsedMarkdown.content.trim();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn(
          `Skipping malformed host skill instructions for ${skillSlug}/${hostDirectory}:`,
          error,
        );
      }
    }
  }

  try {
    return (await readOpenClawSkill(skillSlug)).content.trim();
  } catch {
    return null;
  }
}

export async function expandRuntimeSlashCommandPrompt(
  prompt: string,
  hostId?: string | null,
): Promise<string> {
  if (!looksLikeSlashCommandInput(prompt)) {
    return prompt;
  }

  const skills = await listScienceSwarmOpenClawSlashCommandSkills();
  const commands = buildOpenClawSlashCommands(skills);
  const parsed = parseOpenClawSlashCommandInput(prompt, commands);
  if (!parsed) {
    const commandName = /^\s*\/([a-z0-9][a-z0-9-]*)/i.exec(prompt)?.[1];
    throw runtimeInvalidRequest(
      commandName
        ? `Unknown command: /${commandName}`
        : "Unknown ScienceSwarm slash command.",
      { commandName },
    );
  }

  const skillInstructions = await readRuntimeHostSkillInstructions(
    parsed,
    hostId,
  );
  return buildOpenClawSlashCommandPrompt(parsed, {
    hostId,
    skillInstructions,
  });
}

export async function assertRuntimeApiLocalRequest(
  request: Request,
): Promise<string | null> {
  if (await isLocalRequest(request)) {
    return runtimeAppOriginFromRequest(request);
  }

  throw new RuntimeHostError({
    code: "RUNTIME_INVALID_REQUEST",
    status: 403,
    message: "Runtime API requests must originate from the local ScienceSwarm app.",
    userMessage: "Runtime controls are only available from the local ScienceSwarm app.",
    recoverable: false,
    context: { localOnly: true },
  });
}

function runtimeAppOriginFromRequest(request: Request): string | null {
  try {
    const origin = new URL(request.url).origin;
    if (origin.startsWith("http://") || origin.startsWith("https://")) {
      return origin;
    }
  } catch {
    // Best effort only. Runtime MCP can still fall back to direct gbrain.
  }
  return null;
}

export async function parseJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw runtimeInvalidRequest("Invalid JSON body.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw runtimeInvalidRequest("Request body must be a JSON object.");
  }
  return raw as Record<string, unknown>;
}

export function runtimeErrorResponse(error: unknown): Response {
  if (isRuntimeHostError(error)) {
    return Response.json(
      {
        error: error.userMessage,
        code: error.code,
        recoverable: error.recoverable,
        context: error.context,
      },
      { status: error.status },
    );
  }

  return Response.json(
    {
      error: "Runtime API request failed.",
      code: "RUNTIME_TRANSPORT_ERROR",
      recoverable: false,
    },
    { status: 500 },
  );
}

export function requireStringField(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw runtimeInvalidRequest(`Missing required string field: ${key}.`, { key });
  }
  return value.trim();
}

export function optionalStringField(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw runtimeInvalidRequest(`Expected string field: ${key}.`, { key });
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function requireStringArrayField(
  body: Record<string, unknown>,
  key: string,
): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw runtimeInvalidRequest(`Missing required string array field: ${key}.`, {
      key,
    });
  }
  const strings = value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw runtimeInvalidRequest(`Expected ${key} to contain only strings.`, {
        key,
      });
    }
    return item.trim();
  });
  return Array.from(new Set(strings));
}

export function optionalStringArrayField(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw runtimeInvalidRequest(`Expected string array field: ${key}.`, { key });
  }
  const strings = value.map((item) => {
    if (typeof item !== "string") {
      throw runtimeInvalidRequest(`Expected ${key} to contain only strings.`, {
        key,
      });
    }
    const trimmed = item.trim();
    if (!trimmed) {
      throw runtimeInvalidRequest(`Expected ${key} to contain only strings.`, {
        key,
      });
    }
    return trimmed;
  });
  return Array.from(new Set(strings));
}

export function optionalRuntimeSessionStatusFromSearchParam(
  value: string | null,
): RuntimeSessionStatus | undefined {
  if (value === null || value.trim() === "") return undefined;
  const status = value.trim();
  if (!RUNTIME_SESSION_STATUSES.includes(status as RuntimeSessionStatus)) {
    throw runtimeInvalidRequest("Invalid runtime session status.", {
      status: value,
    });
  }
  return status as RuntimeSessionStatus;
}

export function projectPolicyFromBody(
  body: Record<string, unknown>,
): RuntimeProjectPolicy {
  const value = requireStringField(body, "projectPolicy");
  if (!RUNTIME_PROJECT_POLICIES.includes(value as RuntimeProjectPolicy)) {
    throw runtimeInvalidRequest("Invalid projectPolicy.", { projectPolicy: value });
  }
  return value as RuntimeProjectPolicy;
}

export function turnModeFromBody(
  body: Record<string, unknown>,
  fallback?: RuntimeTurnMode,
): RuntimeTurnMode {
  const value = body.mode === undefined ? fallback : requireStringField(body, "mode");
  if (!value || !RUNTIME_TURN_MODES.includes(value as RuntimeTurnMode)) {
    throw runtimeInvalidRequest("Invalid runtime turn mode.", { mode: value });
  }
  return value as RuntimeTurnMode;
}

export function approvalStateFromBody(
  body: Record<string, unknown>,
): RuntimeApprovalState {
  const value = body.approvalState === undefined
    ? "not-required"
    : requireStringField(body, "approvalState");
  if (!RUNTIME_APPROVAL_STATES.includes(value as RuntimeApprovalState)) {
    throw runtimeInvalidRequest("Invalid approvalState.", { approvalState: value });
  }
  return value as RuntimeApprovalState;
}

export function requireSafeProjectId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw runtimeInvalidRequest("Project-scoped runtime requests require projectId.");
  }
  try {
    return assertSafeProjectSlug(value.trim());
  } catch {
    throw runtimeInvalidRequest("Invalid projectId.", { projectId: value });
  }
}

export function optionalSafeProjectId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireSafeProjectId(value);
}

function dataIncludedFromRaw(value: unknown): RuntimeDataIncluded[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw runtimeInvalidRequest("dataIncluded must be an array.");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw runtimeInvalidRequest("dataIncluded entries must be objects.");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.kind !== "string" || typeof record.label !== "string") {
      throw runtimeInvalidRequest("dataIncluded entries require kind and label.");
    }
    if (
      record.bytes !== undefined
      && (typeof record.bytes !== "number" || !Number.isFinite(record.bytes))
    ) {
      throw runtimeInvalidRequest("dataIncluded bytes must be a finite number.");
    }
    return {
      kind: record.kind as RuntimeDataIncluded["kind"],
      label: record.label,
      bytes: record.bytes as number | undefined,
    };
  });
}

export function dataIncludedFromBody(
  body: Record<string, unknown>,
): RuntimeDataIncluded[] {
  const explicit = dataIncludedFromRaw(body.dataIncluded);
  if (explicit) return explicit;
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  return prompt
    ? [
        {
          kind: "prompt",
          label: "User prompt",
          bytes: Buffer.byteLength(prompt, "utf8"),
        },
      ]
    : [];
}

export function dataIncludedFromBodyWithRuntimeContext(input: {
  services?: RuntimeApiServices;
  body: Record<string, unknown>;
  projectId?: string | null;
  hostId?: string | null;
  selectedHostIds?: readonly string[];
}): RuntimeDataIncluded[] {
  const dataIncluded = dataIncludedFromBody(input.body);
  const services = input.services ?? getRuntimeApiServices();
  const runtimeHostIds = new Set<string>();
  if (input.hostId) runtimeHostIds.add(input.hostId);
  for (const hostId of input.selectedHostIds ?? []) {
    runtimeHostIds.add(hostId);
  }
  const existingLabels = new Set(dataIncluded.map((item) => item.label));
  const contextData = Array.from(runtimeHostIds).flatMap((hostId) =>
    runtimeAdapterForApi(hostId, services)
      ?.runtimeContextDataIncluded?.({ projectId: input.projectId }) ?? []
  ).filter((item) => {
    if (existingLabels.has(item.label)) return false;
    existingLabels.add(item.label);
    return true;
  });

  return [...dataIncluded, ...contextData];
}

export function adapterMapForServices(
  services: RuntimeApiServices = getRuntimeApiServices(),
): Map<string, ResearchRuntimeHost> {
  return new Map(
    services.adapters.map((adapter) => [adapter.profile().id, adapter]),
  );
}

export function runtimeHostProfileForApi(
  hostId: RuntimeHostId | string,
  services: RuntimeApiServices = getRuntimeApiServices(),
): RuntimeHostProfile {
  const adapterProfile = adapterMapForServices(services).get(hostId)?.profile();
  return adapterProfile ?? requireRuntimeHostProfile(hostId);
}

export function runtimeAdapterForApi(
  hostId: RuntimeHostId | string,
  services: RuntimeApiServices = getRuntimeApiServices(),
): ResearchRuntimeHost | null {
  return adapterMapForServices(services).get(hostId) ?? null;
}

export function runtimeHostHistoryForSession(hostId: RuntimeHostId | string) {
  return resolveRuntimeHostRecord(hostId);
}

export function listRuntimeApiHostProfiles(
  services: RuntimeApiServices = getRuntimeApiServices(),
): RuntimeHostProfile[] {
  const byId = new Map<string, RuntimeHostProfile>();
  for (const profile of listRuntimeHostProfiles()) {
    byId.set(profile.id, profile);
  }
  for (const adapter of services.adapters) {
    const profile = adapter.profile();
    byId.set(profile.id, profile);
  }
  return Array.from(byId.values());
}

export function computeRuntimeApiPreview(input: {
  services?: RuntimeApiServices;
  hostId: RuntimeHostId | string;
  projectPolicy: RuntimeProjectPolicy;
  mode: RuntimeTurnMode;
  dataIncluded: RuntimeDataIncluded[];
  selectedHostIds?: Array<RuntimeHostId | string>;
}): TurnPreview {
  const services = input.services ?? getRuntimeApiServices();
  const host = runtimeHostProfileForApi(input.hostId, services);
  const selectedHosts = input.selectedHostIds?.map((hostId) =>
    runtimeHostProfileForApi(hostId, services)
  );
  return computeTurnPreview({
    projectPolicy: input.projectPolicy,
    host,
    mode: input.mode,
    dataIncluded: input.dataIncluded,
    selectedHosts,
  });
}

export function assertPreviewAllowed(
  preview: TurnPreview,
  approvalState: RuntimeApprovalState = "approved",
): void {
  assertTurnPreviewAllowsPromptConstruction(
    preview,
    approvalState === "approved",
  );
}

export function buildRuntimeTurnRequest(input: {
  hostId: RuntimeHostId | string;
  runtimeSessionId?: string;
  projectId: string | null;
  conversationId: string | null;
  mode: RuntimeTurnMode;
  prompt: string;
  promptHash?: string;
  inputFileRefs?: string[];
  approvalState: RuntimeApprovalState;
  preview: TurnPreview;
  appOrigin?: string | null;
  onEvent?: (event: RuntimeEvent) => void;
}): RuntimeTurnRequest {
  return {
    hostId: input.preview.hostId,
    runtimeSessionId: input.runtimeSessionId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    mode: input.mode,
    prompt: input.prompt,
    promptHash: input.promptHash,
    inputFileRefs: input.inputFileRefs ?? [],
    dataIncluded: input.preview.dataIncluded,
    approvalState: input.approvalState,
    preview: input.preview,
    appOrigin: input.appOrigin ?? null,
    onEvent: input.onEvent,
  };
}
