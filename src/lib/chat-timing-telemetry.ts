export const CHAT_TIMING_ENV_FLAG = "SCIENCESWARM_CHAT_TIMING";

export type ChatTimingPhaseName =
  | "request_parse"
  | "project_materialization"
  | "file_reference_merge"
  | "shortcut_detectors"
  | "chat_readiness"
  | "prompt_context_construction"
  | "gateway_connect_auth"
  | "chat_send_ack"
  | "first_gateway_event"
  | "first_assistant_text"
  | "final_assistant_text"
  | "artifact_import_repair";

export type PromptSizeBucketName =
  | "user_text"
  | "guardrails"
  | "project_prompt"
  | "recent_chat_context"
  | "active_file"
  | "workspace_files";

export type PromptSizeBuckets = Record<PromptSizeBucketName, number> & {
  total: number;
};

export interface ChatTimingPhaseRecord {
  name: ChatTimingPhaseName;
  order: number;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  skipped?: boolean;
  inferred?: boolean;
  detail?: Record<string, string | number | boolean | null>;
}

export interface ChatTimingLogPayload {
  event: "scienceswarm.chat.timing";
  route: string;
  turnId: string;
  totalDurationMs: number;
  outcome?: string;
  status?: number;
  phases: ChatTimingPhaseRecord[];
  promptCharCounts: PromptSizeBuckets;
}

type Logger = (payload: ChatTimingLogPayload) => void;

interface ActivePhase {
  name: ChatTimingPhaseName;
  order: number;
  startedAtMs: number;
  detail?: Record<string, string | number | boolean | null>;
}

export interface ChatTimingTelemetryOptions {
  enabled?: boolean;
  route?: string;
  turnId?: string;
  now?: () => number;
  logger?: Logger;
}

export interface EndPhaseOptions {
  skipped?: boolean;
  inferred?: boolean;
  detail?: Record<string, string | number | boolean | null>;
}

export function isChatTimingTelemetryEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[CHAT_TIMING_ENV_FLAG] === "1";
}

export const CHAT_TIMING_ARTIFACT_LIMIT = 25;

const recentChatTimingArtifacts: ChatTimingLogPayload[] = [];

function sanitizeIdentifier(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return /^[a-z0-9_.:-]{1,128}$/i.test(value) ? value : "[redacted]";
}

function sanitizeRoute(route: string): string {
  if (!route.startsWith("/") && !/^https?:\/\//i.test(route)) {
    return "/api/chat/unified";
  }
  try {
    return new URL(route, "http://localhost").pathname || "/api/chat/unified";
  } catch {
    return "/api/chat/unified";
  }
}

function sanitizeDetail(
  detail?: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> | undefined {
  if (!detail) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [
      key,
      typeof value === "string" ? "[redacted]" : value,
    ]),
  );
}

function sanitizeTimingArtifact(payload: ChatTimingLogPayload): ChatTimingLogPayload {
  return {
    event: "scienceswarm.chat.timing",
    route: sanitizeRoute(payload.route),
    turnId: sanitizeIdentifier(payload.turnId) ?? "[redacted]",
    totalDurationMs: payload.totalDurationMs,
    outcome: sanitizeIdentifier(payload.outcome),
    status: payload.status,
    phases: payload.phases.map((phase) => ({
      ...phase,
      detail: sanitizeDetail(phase.detail),
    })),
    promptCharCounts: { ...payload.promptCharCounts },
  };
}

export function recordChatTimingArtifact(payload: ChatTimingLogPayload): void {
  recentChatTimingArtifacts.push(sanitizeTimingArtifact(payload));
  if (recentChatTimingArtifacts.length > CHAT_TIMING_ARTIFACT_LIMIT) {
    recentChatTimingArtifacts.splice(
      0,
      recentChatTimingArtifacts.length - CHAT_TIMING_ARTIFACT_LIMIT,
    );
  }
}

export function getRecentChatTimingArtifacts(): ChatTimingLogPayload[] {
  return recentChatTimingArtifacts.map((payload) => sanitizeTimingArtifact(payload));
}

export function clearChatTimingArtifactsForTests(): void {
  recentChatTimingArtifacts.length = 0;
}

export function promptCharCount(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + promptCharCount(item), 0);
  }
  return 0;
}

export function buildPromptSizeBuckets(
  sources: Partial<Record<PromptSizeBucketName, unknown>> = {},
): PromptSizeBuckets {
  const buckets: PromptSizeBuckets = {
    user_text: promptCharCount(sources.user_text),
    guardrails: promptCharCount(sources.guardrails),
    project_prompt: promptCharCount(sources.project_prompt),
    recent_chat_context: promptCharCount(sources.recent_chat_context),
    active_file: promptCharCount(sources.active_file),
    workspace_files: promptCharCount(sources.workspace_files),
    total: 0,
  };

  buckets.total =
    buckets.user_text +
    buckets.guardrails +
    buckets.project_prompt +
    buckets.recent_chat_context +
    buckets.active_file +
    buckets.workspace_files;

  return buckets;
}

function defaultNow(): number {
  return Date.now();
}

function defaultTurnId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultLogger(payload: ChatTimingLogPayload): void {
  console.info("[scienceswarm-chat-timing]", JSON.stringify(payload));
}

function mergeDetail(
  left?: Record<string, string | number | boolean | null>,
  right?: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> | undefined {
  if (!left && !right) {
    return undefined;
  }
  return { ...(left ?? {}), ...(right ?? {}) };
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function gatewayEventMethod(event: unknown): string {
  const record = recordFromUnknown(event);
  if (!record) {
    return "";
  }
  return (
    safeString(record.method) ??
    safeString(record.event) ??
    safeString(record.type) ??
    ""
  );
}

function gatewayEventPayload(event: unknown): Record<string, unknown> | null {
  const record = recordFromUnknown(event);
  if (!record) {
    return null;
  }
  return (
    recordFromUnknown(record.payload) ??
    recordFromUnknown(record.params) ??
    recordFromUnknown(record.raw) ??
    null
  );
}

function contentArrayCharCount(value: unknown): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  return value.reduce((sum, part) => {
    if (typeof part === "string") {
      return sum + part.length;
    }
    const record = recordFromUnknown(part);
    return sum + promptCharCount(record?.text ?? record?.content);
  }, 0);
}

function messageContentCharCount(message: unknown): number {
  if (typeof message === "string") {
    return message.length;
  }
  const record = recordFromUnknown(message);
  if (!record) {
    return 0;
  }
  if (typeof record.content === "string") {
    return record.content.length;
  }
  if (Array.isArray(record.content)) {
    return contentArrayCharCount(record.content);
  }
  if (typeof record.text === "string") {
    return record.text.length;
  }
  return 0;
}

function assistantTextCharCountFromEvent(event: unknown): number {
  const method = gatewayEventMethod(event);
  const payload = gatewayEventPayload(event);
  if (!payload) {
    return 0;
  }

  if (method === "agent") {
    const data = recordFromUnknown(payload.data);
    if (payload.stream === "assistant" && data) {
      return promptCharCount(data.delta) || promptCharCount(data.text);
    }
  }

  if (method === "chat.delta" || method === "chat.final") {
    const message = payload.message;
    return (
      promptCharCount(payload.delta) ||
      promptCharCount(payload.text) ||
      promptCharCount(payload.content) ||
      messageContentCharCount(message)
    );
  }

  if (
    method === "session.message" ||
    method === "sessions.message" ||
    method === "sessions.messages.new"
  ) {
    const nestedMessage = recordFromUnknown(payload.message);
    if (nestedMessage?.role === "assistant") {
      return messageContentCharCount(nestedMessage);
    }
    if (payload.role === "assistant") {
      return (
        promptCharCount(payload.text) ||
        promptCharCount(payload.message) ||
        promptCharCount(payload.content)
      );
    }
  }

  return 0;
}

function isExplicitSendAckEvent(event: unknown): boolean {
  const method = gatewayEventMethod(event).toLowerCase();
  return (
    method === "chat.send.ack" ||
    method === "sessions.send.ack" ||
    method === "chat.send:ack" ||
    method === "sessions.send:ack"
  );
}

export class ChatTimingTelemetry {
  private readonly enabled: boolean;
  private readonly route: string;
  private readonly turnId: string;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly startedAtMs: number;
  private readonly phases: ChatTimingPhaseRecord[] = [];
  private readonly activePhases = new Map<symbol, ActivePhase>();
  private promptCharCounts = buildPromptSizeBuckets();
  private order = 0;
  private flushed = false;
  private firstGatewayEventRecorded = false;
  private firstAssistantTextRecorded = false;
  private finalAssistantTextRecorded = false;
  private sendAckRecorded = false;
  private gatewayConnectAuthPhase: symbol | null = null;

  constructor(options: ChatTimingTelemetryOptions = {}) {
    this.enabled = options.enabled ?? isChatTimingTelemetryEnabled();
    this.route = options.route ?? "/api/chat/unified";
    this.turnId = options.turnId ?? defaultTurnId();
    this.now = options.now ?? defaultNow;
    this.logger = options.logger ?? defaultLogger;
    this.startedAtMs = this.now();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  startPhase(
    name: ChatTimingPhaseName,
    detail?: Record<string, string | number | boolean | null>,
  ): symbol {
    const id = Symbol(name);
    if (!this.enabled) {
      return id;
    }

    this.activePhases.set(id, {
      name,
      order: ++this.order,
      startedAtMs: this.now(),
      detail,
    });
    return id;
  }

  endPhase(id: symbol, options: EndPhaseOptions = {}): void {
    if (!this.enabled) {
      return;
    }
    const active = this.activePhases.get(id);
    if (!active) {
      return;
    }
    this.activePhases.delete(id);
    const endedAtMs = this.now();
    this.phases.push({
      name: active.name,
      order: active.order,
      startedAtMs: active.startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - active.startedAtMs),
      skipped: options.skipped === true ? true : undefined,
      inferred: options.inferred === true ? true : undefined,
      detail: mergeDetail(active.detail, options.detail),
    });
  }

  recordSkippedPhase(
    name: ChatTimingPhaseName,
    detail?: Record<string, string | number | boolean | null>,
  ): void {
    if (!this.enabled) {
      return;
    }
    const now = this.now();
    this.phases.push({
      name,
      order: ++this.order,
      startedAtMs: now,
      endedAtMs: now,
      durationMs: 0,
      skipped: true,
      detail,
    });
  }

  markPhase(
    name: ChatTimingPhaseName,
    options: EndPhaseOptions = {},
  ): void {
    if (!this.enabled) {
      return;
    }
    const now = this.now();
    this.phases.push({
      name,
      order: ++this.order,
      startedAtMs: now,
      endedAtMs: now,
      durationMs: 0,
      skipped: options.skipped === true ? true : undefined,
      inferred: options.inferred === true ? true : undefined,
      detail: options.detail,
    });
  }

  async measure<T>(
    name: ChatTimingPhaseName,
    run: () => Promise<T>,
    detail?: Record<string, string | number | boolean | null>,
  ): Promise<T> {
    const phase = this.startPhase(name, detail);
    try {
      const result = await run();
      this.endPhase(phase);
      return result;
    } catch (error) {
      this.endPhase(phase, { detail: { failed: true } });
      throw error;
    }
  }

  setPromptCharCounts(buckets: PromptSizeBuckets): void {
    if (!this.enabled) {
      return;
    }
    this.promptCharCounts = { ...buckets };
  }

  beginGatewayConnectAuth(): void {
    if (!this.enabled || this.gatewayConnectAuthPhase) {
      return;
    }
    this.gatewayConnectAuthPhase = this.startPhase("gateway_connect_auth");
  }

  endGatewayConnectAuth(options: EndPhaseOptions = {}): void {
    if (!this.enabled || !this.gatewayConnectAuthPhase) {
      return;
    }
    this.endPhase(this.gatewayConnectAuthPhase, options);
    this.gatewayConnectAuthPhase = null;
  }

  observeGatewayEvent(event: unknown): void {
    if (!this.enabled) {
      return;
    }

    const method = gatewayEventMethod(event);
    const isExplicitAck = isExplicitSendAckEvent(event);
    if (isExplicitAck) {
      this.recordChatSendAck();
    }

    if (!this.firstGatewayEventRecorded) {
      this.endGatewayConnectAuth({ inferred: true });
      if (!this.sendAckRecorded) {
        this.recordChatSendAck({ inferred: true });
      }
      this.markPhase("first_gateway_event", {
        detail: { method: method || null },
      });
      this.firstGatewayEventRecorded = true;
    }

    const assistantTextChars = assistantTextCharCountFromEvent(event);
    if (assistantTextChars > 0 && !this.firstAssistantTextRecorded) {
      this.markFirstAssistantText(assistantTextChars);
    }
  }

  recordChatSendAck(options: EndPhaseOptions = {}): void {
    if (!this.enabled || this.sendAckRecorded) {
      return;
    }
    this.markPhase("chat_send_ack", options);
    this.sendAckRecorded = true;
  }

  markFirstAssistantText(charCount?: number): void {
    if (!this.enabled || this.firstAssistantTextRecorded) {
      return;
    }
    this.markPhase("first_assistant_text", {
      detail:
        typeof charCount === "number" ? { assistant_text_chars: charCount } : undefined,
    });
    this.firstAssistantTextRecorded = true;
  }

  markFinalAssistantText(charCount?: number): void {
    if (!this.enabled || this.finalAssistantTextRecorded) {
      return;
    }
    if (!this.firstAssistantTextRecorded && typeof charCount === "number" && charCount > 0) {
      this.markFirstAssistantText(charCount);
    }
    this.markPhase("final_assistant_text", {
      detail:
        typeof charCount === "number" ? { assistant_text_chars: charCount } : undefined,
    });
    this.finalAssistantTextRecorded = true;
  }

  private endActivePhasesAsInferred(): void {
    for (const id of Array.from(this.activePhases.keys())) {
      this.endPhase(id, { inferred: true });
    }
  }

  finish(options: { outcome?: string; status?: number } = {}): void {
    if (!this.enabled || this.flushed) {
      return;
    }
    this.flushed = true;
    this.endGatewayConnectAuth({ inferred: true });
    this.endActivePhasesAsInferred();
    const endedAtMs = this.now();
    const payload: ChatTimingLogPayload = {
      event: "scienceswarm.chat.timing",
      route: this.route,
      turnId: this.turnId,
      totalDurationMs: Math.max(0, endedAtMs - this.startedAtMs),
      outcome: options.outcome,
      status: options.status,
      phases: [...this.phases].sort((left, right) => left.order - right.order),
      promptCharCounts: { ...this.promptCharCounts },
    };
    recordChatTimingArtifact(payload);
    this.logger(payload);
  }
}

export function createChatTimingTelemetry(
  options: ChatTimingTelemetryOptions = {},
): ChatTimingTelemetry {
  return new ChatTimingTelemetry(options);
}
