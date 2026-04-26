#!/usr/bin/env npx tsx

import { performance } from "node:perf_hooks";

export interface ParsedSseEvent {
  event: string | null;
  data: string;
  json: unknown | null;
}

export interface ChatBenchmarkOptions {
  baseUrl: string;
  projectId: string;
  message: string;
  conversationId: string;
  timeoutMs: number;
  streamPhases: boolean;
  includeTimingArtifact: boolean;
  json: boolean;
}

export interface ChatBenchmarkPayload {
  message: string;
  messages: Array<{ role: "user"; content: string }>;
  backend: "openclaw";
  mode: "reasoning";
  files: [];
  projectId: string;
  conversationId: string;
  streamPhases: boolean;
}

export interface ChatBenchmarkSummary {
  status: number;
  ok: boolean;
  backend: string | null;
  contentType: string | null;
  conversationId: string;
  headersMs: number;
  firstChunkMs: number | null;
  firstChunkSharedHeadersTick: boolean;
  totalMs: number;
  bytes: number;
  eventCount: number;
  progressEventCount: number;
  finalEventCount: number;
  finalTextSample: string;
  timingArtifact?: ChatBenchmarkTimingArtifactResult | null;
}

export interface ChatBenchmarkReportRowMetadata {
  date: string;
  prLabel: string;
  changeArea: string;
  environment: string;
}

export interface ChatBenchmarkTimingPhaseSummary {
  name: string;
  durationMs: number;
  startedAtMs?: number;
  endedAtMs?: number;
  skipped?: boolean;
  inferred?: boolean;
}

export interface ChatBenchmarkObservedSplit {
  chatReadinessDurationMs: number | null;
  gatewayConnectAuthDurationMs: number | null;
  requestToSendAckMs: number | null;
  requestToFirstGatewayEventMs: number | null;
  requestToFirstAssistantTextMs: number | null;
  requestToFinalAssistantTextMs: number | null;
}

export interface ChatBenchmarkTimingArtifactSummary {
  turnId: string;
  startedAtMs: number | null;
  totalDurationMs: number;
  outcome: string | null;
  status: number | null;
  phaseCount: number;
  phases: ChatBenchmarkTimingPhaseSummary[];
  promptCharCounts: Record<string, number>;
  observedSplit: ChatBenchmarkObservedSplit | null;
}

export type ChatBenchmarkTimingArtifactUnavailableReason =
  | "endpoint_unreachable_or_non_ok"
  | "timeout"
  | "no_matching_recent_artifact"
  | "endpoint_disabled_or_no_timings";

export interface ChatBenchmarkTimingArtifactUnavailableSummary {
  available: false;
  reason: ChatBenchmarkTimingArtifactUnavailableReason;
  detail?: string;
}

export type ChatBenchmarkTimingArtifactResult =
  | ChatBenchmarkTimingArtifactSummary
  | ChatBenchmarkTimingArtifactUnavailableSummary;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toPositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeBenchmarkBaseUrl(value: string): string {
  return new URL(value).origin;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function eventType(event: ParsedSseEvent): string {
  const json = isRecord(event.json) ? event.json : null;
  return (
    asString(json?.type) ??
    asString(json?.event) ??
    asString(json?.kind) ??
    event.event ??
    ""
  );
}

function eventRecord(event: ParsedSseEvent): Record<string, unknown> | null {
  return isRecord(event.json) ? event.json : null;
}

function eventText(event: ParsedSseEvent): string {
  const json = eventRecord(event);
  return (
    asString(json?.text) ??
    asString(json?.response) ??
    asString(json?.content) ??
    ""
  );
}

function isProgressEvent(event: ParsedSseEvent): boolean {
  const type = eventType(event);
  const json = eventRecord(event);
  return (
    type === "progress" ||
    type === "activity" ||
    type === "thinking" ||
    isRecord(json?.progress)
  );
}

function isFinalEvent(event: ParsedSseEvent): boolean {
  const type = eventType(event);
  if ((type === "final" || type === "done") && !isProgressEvent(event)) {
    return true;
  }
  const json = eventRecord(event);
  return (
    eventText(event).length > 0 &&
    !isProgressEvent(event) &&
    (
      typeof json?.conversationId === "string" ||
      typeof json?.backend === "string" ||
      Array.isArray(json?.generatedFiles) ||
      Array.isArray(json?.taskPhases)
    )
  );
}

export function parseSseEvents(raw: string): ParsedSseEvent[] {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => {
      const dataLines: string[] = [];
      let event: string | null = null;
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim() || null;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
      if (!event && dataLines.length === 0) {
        return [];
      }
      const data = dataLines.join("\n");
      return [{
        event,
        data,
        json: data.length > 0 ? parseJson(data) : null,
      }];
    });
}

export function summarizeChatBenchmarkResponse(params: {
  status: number;
  ok: boolean;
  backend: string | null;
  contentType: string | null;
  conversationId: string;
  rawBody: string;
  headersMs: number;
  firstChunkMs: number | null;
  totalMs: number;
  bytes: number;
}): ChatBenchmarkSummary {
  const events = parseSseEvents(params.rawBody);
  const progressEventCount = events.filter(isProgressEvent).length;
  const finalEvents = events.filter(isFinalEvent);
  const lastFinal = finalEvents.at(-1);
  const fallbackJson = events.length === 0 ? parseJson(params.rawBody) : null;
  const fallbackText = isRecord(fallbackJson)
    ? asString(fallbackJson.response) ?? asString(fallbackJson.text) ?? ""
    : "";
  const roundedHeadersMs = Math.round(params.headersMs);
  const roundedFirstChunkMs =
    typeof params.firstChunkMs === "number"
      ? Math.round(params.firstChunkMs)
      : null;

  return {
    status: params.status,
    ok: params.ok,
    backend: params.backend,
    contentType: params.contentType,
    conversationId: params.conversationId,
    headersMs: roundedHeadersMs,
    firstChunkMs: roundedFirstChunkMs,
    firstChunkSharedHeadersTick:
      roundedFirstChunkMs !== null && roundedFirstChunkMs === roundedHeadersMs,
    totalMs: Math.round(params.totalMs),
    bytes: params.bytes,
    eventCount: events.length,
    progressEventCount,
    finalEventCount: finalEvents.length,
    finalTextSample: (lastFinal ? eventText(lastFinal) : fallbackText).slice(
      0,
      240,
    ),
  };
}

export function buildBenchmarkPayload(
  options: Pick<
    ChatBenchmarkOptions,
    "message" | "projectId" | "conversationId" | "streamPhases"
  >,
): ChatBenchmarkPayload {
  return {
    message: options.message,
    messages: [{ role: "user", content: options.message }],
    backend: "openclaw",
    mode: "reasoning",
    files: [],
    projectId: options.projectId,
    conversationId: options.conversationId,
    streamPhases: options.streamPhases,
  };
}

function formatTimingPhasesForSummary(
  phases: ChatBenchmarkTimingPhaseSummary[],
): string {
  return phases.length === 0
    ? "none"
    : phases
        .map((phase) =>
          phase.skipped
            ? `${phase.name} skipped`
            : `${phase.name} ${phase.durationMs} ms${
              phase.inferred ? " (inferred)" : ""
            }`
        )
        .join(", ");
}

const PROMPT_CHAR_COUNT_HIGHLIGHT_KEYS = [
  "total",
  "recent_chat_context",
  "workspace_files",
] as const;

const PROMPT_CHAR_COUNT_PREFERRED_ORDER = [
  ...PROMPT_CHAR_COUNT_HIGHLIGHT_KEYS,
  "user_text",
  "guardrails",
  "project_prompt",
  "active_file",
] as const;

function formatPromptCharCountsForSummary(
  promptCharCounts: Record<string, number>,
): string {
  const entries = Object.entries(promptCharCounts).sort(([leftKey], [rightKey]) => {
    const leftIndex = PROMPT_CHAR_COUNT_PREFERRED_ORDER.indexOf(leftKey as typeof PROMPT_CHAR_COUNT_PREFERRED_ORDER[number]);
    const rightIndex = PROMPT_CHAR_COUNT_PREFERRED_ORDER.indexOf(rightKey as typeof PROMPT_CHAR_COUNT_PREFERRED_ORDER[number]);
    if (leftIndex === -1 && rightIndex === -1) {
      return leftKey.localeCompare(rightKey);
    }
    if (leftIndex === -1) {
      return 1;
    }
    if (rightIndex === -1) {
      return -1;
    }
    return leftIndex - rightIndex;
  });
  return entries.length === 0
    ? "none"
    : entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function formatSkippedTimingPhasesForSummary(
  phases: ChatBenchmarkTimingPhaseSummary[],
): string | null {
  const skipped = phases
    .filter((phase) => phase.skipped)
    .map((phase) => phase.name);
  return skipped.length === 0 ? null : skipped.join(", ");
}

function formatPromptBudgetHighlights(
  promptCharCounts: Record<string, number>,
): string {
  const highlights = PROMPT_CHAR_COUNT_HIGHLIGHT_KEYS.flatMap((key) =>
    typeof promptCharCounts[key] === "number"
      ? [`${key} ${promptCharCounts[key]}`]
      : []
  );
  return highlights.length === 0 ? "none" : highlights.join(", ");
}

function timingPhaseByName(
  phases: ChatBenchmarkTimingPhaseSummary[],
  name: string,
): ChatBenchmarkTimingPhaseSummary | null {
  for (const phase of phases) {
    if (phase.name === name && !phase.skipped) {
      return phase;
    }
  }
  return null;
}

function timingPhaseStartAnchorMs(
  phases: ChatBenchmarkTimingPhaseSummary[],
): number | null {
  for (const phase of phases) {
    if (typeof phase.startedAtMs !== "number") {
      continue;
    }
    return phase.startedAtMs;
  }
  return null;
}

function phaseEndedOffsetMs(
  phases: ChatBenchmarkTimingPhaseSummary[],
  name: string,
): number | null {
  const requestStartedAtMs = timingPhaseStartAnchorMs(phases);
  const phase = timingPhaseByName(phases, name);
  if (
    requestStartedAtMs === null ||
    !phase ||
    typeof phase.endedAtMs !== "number"
  ) {
    return null;
  }
  return Math.max(0, Math.round(phase.endedAtMs - requestStartedAtMs));
}

function buildObservedTimingSplit(
  phases: ChatBenchmarkTimingPhaseSummary[],
): ChatBenchmarkObservedSplit | null {
  const observedSplit: ChatBenchmarkObservedSplit = {
    chatReadinessDurationMs:
      timingPhaseByName(phases, "chat_readiness")?.durationMs ?? null,
    gatewayConnectAuthDurationMs:
      timingPhaseByName(phases, "gateway_connect_auth")?.durationMs ?? null,
    requestToSendAckMs: phaseEndedOffsetMs(phases, "chat_send_ack"),
    requestToFirstGatewayEventMs: phaseEndedOffsetMs(phases, "first_gateway_event"),
    requestToFirstAssistantTextMs: phaseEndedOffsetMs(
      phases,
      "first_assistant_text",
    ),
    requestToFinalAssistantTextMs: phaseEndedOffsetMs(
      phases,
      "final_assistant_text",
    ),
  };

  return Object.values(observedSplit).some((value) => value !== null)
    ? observedSplit
    : null;
}

function formatObservedTimingArtifactSplit(
  observedSplit: ChatBenchmarkObservedSplit | null | undefined,
): string | null {
  if (!observedSplit) {
    return null;
  }

  const parts = [
    observedSplit.chatReadinessDurationMs === null
      ? null
      : `readiness ${observedSplit.chatReadinessDurationMs} ms`,
    observedSplit.gatewayConnectAuthDurationMs === null
      ? null
      : `connect/auth ${observedSplit.gatewayConnectAuthDurationMs} ms`,
    observedSplit.requestToSendAckMs === null
      ? null
      : `request->ack ${observedSplit.requestToSendAckMs} ms`,
    observedSplit.requestToFirstGatewayEventMs === null
      ? null
      : `request->first gateway event ${observedSplit.requestToFirstGatewayEventMs} ms`,
    observedSplit.requestToFirstAssistantTextMs === null
      ? null
      : `request->first assistant text ${observedSplit.requestToFirstAssistantTextMs} ms`,
    observedSplit.requestToFinalAssistantTextMs === null
      ? null
      : `request->final text ${observedSplit.requestToFinalAssistantTextMs} ms`,
  ].filter((part): part is string => Boolean(part));

  return parts.length === 0 ? null : parts.join(", ");
}

function isTimingArtifactUnavailable(
  timingArtifact: ChatBenchmarkTimingArtifactResult | null | undefined,
): timingArtifact is ChatBenchmarkTimingArtifactUnavailableSummary {
  return (
    timingArtifact !== null &&
    timingArtifact !== undefined &&
    "available" in timingArtifact &&
    timingArtifact.available === false
  );
}

function formatTimingArtifactUnavailableReason(
  reason: ChatBenchmarkTimingArtifactUnavailableReason,
): string {
  switch (reason) {
    case "endpoint_unreachable_or_non_ok":
      return "timing endpoint unreachable or non-OK";
    case "timeout":
      return "timing endpoint timed out";
    case "no_matching_recent_artifact":
      return "no matching recent artifact";
    case "endpoint_disabled_or_no_timings":
      return "artifact endpoint disabled or no timings";
  }
}

function formatObservedLatencySplit(summary: ChatBenchmarkSummary): string {
  const browserToServerMs = summary.headersMs;
  const serverToFirstChunkMs =
    typeof summary.firstChunkMs === "number"
      ? Math.max(0, summary.firstChunkMs - summary.headersMs)
      : null;
  const firstChunkToCompleteMs =
    typeof summary.firstChunkMs === "number"
      ? Math.max(0, summary.totalMs - summary.firstChunkMs)
      : null;

  return [
    `browser->server headers ${browserToServerMs} ms`,
    `server->first chunk ${
      serverToFirstChunkMs === null ? "n/a" : `${serverToFirstChunkMs} ms`
    }`,
    `first chunk->complete ${
      firstChunkToCompleteMs === null ? "n/a" : `${firstChunkToCompleteMs} ms`
    }`,
  ].join(", ");
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatMarkdownCodeSpan(value: string): string {
  const maxBacktickRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const delimiter = "`".repeat(maxBacktickRun + 1);
  const requiresPadding =
    value.startsWith("`") ||
    value.endsWith("`") ||
    value.startsWith(" ") ||
    value.endsWith(" ");
  const content = requiresPadding ? ` ${value} ` : value;
  return `${delimiter}${content}${delimiter}`;
}

function formatTimingArtifactCell(
  timingArtifact: ChatBenchmarkTimingArtifactResult | null | undefined,
): string {
  if (timingArtifact === undefined || timingArtifact === null) {
    return "unavailable";
  }
  if (isTimingArtifactUnavailable(timingArtifact)) {
    return `unavailable (${formatTimingArtifactUnavailableReason(
      timingArtifact.reason,
    )}${timingArtifact.detail ? `; ${timingArtifact.detail}` : ""})`;
  }
  return `${timingArtifact.totalDurationMs} ms`;
}

export function formatBenchmarkMarkdownRow(
  summary: ChatBenchmarkSummary,
  metadata: ChatBenchmarkReportRowMetadata,
): string {
  const cells = [
    escapeMarkdownTableCell(metadata.date),
    escapeMarkdownTableCell(metadata.prLabel),
    escapeMarkdownTableCell(metadata.changeArea),
    escapeMarkdownTableCell(metadata.environment),
    String(summary.headersMs),
    summary.firstChunkMs === null ? "n/a" : String(summary.firstChunkMs),
    summary.firstChunkSharedHeadersTick ? "yes" : "no",
    String(summary.totalMs),
    String(summary.progressEventCount),
    formatMarkdownCodeSpan(
      escapeMarkdownTableCell(summary.finalTextSample || "n/a"),
    ),
    escapeMarkdownTableCell(formatTimingArtifactCell(summary.timingArtifact)),
  ];
  return `| ${cells.join(" | ")} |`;
}

export function formatBenchmarkSummary(summary: ChatBenchmarkSummary): string {
  const timingArtifact = summary.timingArtifact;
  const skippedTimingPhases =
    timingArtifact && !isTimingArtifactUnavailable(timingArtifact)
      ? formatSkippedTimingPhasesForSummary(timingArtifact.phases)
      : null;
  const observedTimingArtifactSplit =
    timingArtifact && !isTimingArtifactUnavailable(timingArtifact)
      ? formatObservedTimingArtifactSplit(timingArtifact.observedSplit)
      : null;
  return [
    "Chat Hi Benchmark",
    `Status: ${summary.status} ${summary.ok ? "ok" : "failed"}`,
    `Backend: ${summary.backend ?? "unknown"}`,
    `Conversation: ${summary.conversationId}`,
    `Headers: ${summary.headersMs} ms`,
    `First chunk: ${
      summary.firstChunkMs === null ? "n/a" : `${summary.firstChunkMs} ms`
    }`,
    `Total: ${summary.totalMs} ms`,
    `Observed split: ${formatObservedLatencySplit(summary)}`,
    `Bytes: ${summary.bytes}`,
    `Events: ${summary.eventCount} (${summary.progressEventCount} progress, ${summary.finalEventCount} final)`,
    ...(timingArtifact === undefined
      ? []
      : timingArtifact === null
        ? ["Timing artifact: unavailable"]
        : isTimingArtifactUnavailable(timingArtifact)
          ? [
              `Timing artifact: unavailable (${formatTimingArtifactUnavailableReason(
                timingArtifact.reason,
              )}${
                timingArtifact.detail ? `; ${timingArtifact.detail}` : ""
              })`,
            ]
        : [
            `Timing artifact: ${timingArtifact.totalDurationMs} ms, outcome ${
              timingArtifact.outcome ?? "unknown"
            }, status ${timingArtifact.status ?? "unknown"}`,
            ...(observedTimingArtifactSplit
              ? [`Server timing: ${observedTimingArtifactSplit}`]
              : []),
            `Timing phases: ${formatTimingPhasesForSummary(timingArtifact.phases)}`,
            ...(skippedTimingPhases
              ? [`Skipped phases: ${skippedTimingPhases}`]
              : []),
            `Prompt chars: ${formatPromptCharCountsForSummary(
              timingArtifact.promptCharCounts,
            )}`,
            `Prompt highlights: ${formatPromptBudgetHighlights(
              timingArtifact.promptCharCounts,
            )}`,
          ]),
    summary.finalTextSample
      ? `Final sample: ${summary.finalTextSample}`
      : "Final sample: n/a",
  ].join("\n");
}

export function benchmarkHelpText(): string {
  return [
    "Usage: npx tsx scripts/benchmark-chat-hi.ts [options]",
    "",
    "Options:",
    "  --url <url>              ScienceSwarm origin; path/query/hash are stripped (default: http://127.0.0.1:3001)",
    "  --project <slug>         Project slug (default: test)",
    "  --message <text>         Message to send (default: Hi)",
    "  --conversation-id <id>   Conversation id for the benchmark turn",
    "  --timeout-ms <ms>        Abort after this many ms (default: 120000)",
    "  --no-stream-phases       Disable streamPhases for comparison",
    "  --timing-artifact        Fetch the latest local /api/chat/timing artifact after the run",
    "  --json                   Print machine-readable JSON",
  ].join("\n");
}

export function parseBenchmarkArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): ChatBenchmarkOptions {
  const options: ChatBenchmarkOptions = {
    baseUrl: normalizeBenchmarkBaseUrl(
      env.SCIENCESWARM_CHAT_URL ?? "http://127.0.0.1:3001",
    ),
    projectId: env.SCIENCESWARM_CHAT_PROJECT ?? "test",
    message: env.SCIENCESWARM_CHAT_MESSAGE ?? "Hi",
    conversationId:
      env.SCIENCESWARM_CHAT_CONVERSATION_ID ??
      `benchmark-hi-${Date.now().toString(36)}`,
    timeoutMs: toPositiveInteger(
      env.SCIENCESWARM_CHAT_TIMEOUT_MS ?? "",
      120_000,
    ),
    streamPhases: true,
    includeTimingArtifact: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] ?? "";
    if (arg === "--url") {
      options.baseUrl = normalizeBenchmarkBaseUrl(next());
    } else if (arg === "--project") {
      options.projectId = next();
    } else if (arg === "--message") {
      options.message = next();
    } else if (arg === "--conversation-id") {
      options.conversationId = next();
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = toPositiveInteger(next(), options.timeoutMs);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-stream-phases") {
      options.streamPhases = false;
    } else if (arg === "--timing-artifact") {
      options.includeTimingArtifact = true;
    }
  }

  return options;
}

export function chatBenchmarkUrl(baseUrl: string): string {
  return new URL(
    "/api/chat/unified",
    normalizeBenchmarkBaseUrl(baseUrl),
  ).toString();
}

export function chatTimingArtifactUrl(baseUrl: string): string {
  return new URL(
    "/api/chat/timing",
    normalizeBenchmarkBaseUrl(baseUrl),
  ).toString();
}

export function summarizeLatestTimingArtifact(
  responseJson: unknown,
  options: { minStartedAtMs?: number } = {},
): ChatBenchmarkTimingArtifactSummary | null {
  const response = isRecord(responseJson) ? responseJson : null;
  const timings = Array.isArray(response?.timings) ? response.timings : [];
  let latest: unknown;
  for (let index = timings.length - 1; index >= 0; index -= 1) {
    const candidate = timings[index];
    if (!isRecord(candidate)) {
      continue;
    }
    const startedAtMs = timingArtifactStartedAtMs(candidate);
    if (
      typeof options.minStartedAtMs === "number" &&
      (startedAtMs === null || startedAtMs < options.minStartedAtMs)
    ) {
      continue;
    }
    latest = candidate;
    break;
  }
  if (!isRecord(latest)) {
    return null;
  }

  const phases = Array.isArray(latest.phases)
    ? latest.phases.flatMap((phase): ChatBenchmarkTimingPhaseSummary[] => {
        if (!isRecord(phase)) {
          return [];
        }
        const name = asString(phase.name);
        const durationMs = asFiniteNumber(phase.durationMs);
        if (!name || durationMs === null) {
          return [];
        }
        return [{
          name,
          durationMs: Math.round(durationMs),
          ...(typeof phase.startedAtMs === "number"
            ? { startedAtMs: Math.round(phase.startedAtMs) }
            : {}),
          ...(typeof phase.endedAtMs === "number"
            ? { endedAtMs: Math.round(phase.endedAtMs) }
            : {}),
          ...(typeof phase.skipped === "boolean"
            ? { skipped: phase.skipped }
            : {}),
          ...(typeof phase.inferred === "boolean"
            ? { inferred: phase.inferred }
            : {}),
        }];
      })
    : [];

  const promptCharCounts = isRecord(latest.promptCharCounts)
    ? Object.fromEntries(
        Object.entries(latest.promptCharCounts).flatMap(([key, value]) => {
          const numericValue = asFiniteNumber(value);
          return numericValue === null ? [] : [[key, Math.round(numericValue)]];
        }),
      )
    : {};

  return {
    turnId: asString(latest.turnId) ?? "unknown",
    startedAtMs: timingArtifactStartedAtMs(latest),
    totalDurationMs: Math.round(asFiniteNumber(latest.totalDurationMs) ?? 0),
    outcome: asString(latest.outcome),
    status: asFiniteNumber(latest.status),
    phaseCount: phases.length,
    phases,
    promptCharCounts,
    observedSplit: buildObservedTimingSplit(phases),
  };
}

function timingArtifactStartedAtMs(
  artifact: Record<string, unknown>,
): number | null {
  const phases = Array.isArray(artifact.phases) ? artifact.phases : [];
  for (const phase of phases) {
    if (!isRecord(phase)) {
      continue;
    }
    const startedAtMs = asFiniteNumber(phase.startedAtMs);
    if (startedAtMs !== null) {
      return startedAtMs;
    }
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return (
    isRecord(error) &&
    asString(error.name) === "AbortError"
  );
}

function unavailableTimingArtifact(
  reason: ChatBenchmarkTimingArtifactUnavailableReason,
  detail?: string,
): ChatBenchmarkTimingArtifactUnavailableSummary {
  return {
    available: false,
    reason,
    ...(detail ? { detail } : {}),
  };
}

export async function fetchLatestTimingArtifact(
  baseUrl: string,
  options: { minStartedAtMs?: number } = {},
): Promise<ChatBenchmarkTimingArtifactResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(chatTimingArtifactUrl(baseUrl), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return unavailableTimingArtifact(
        "endpoint_disabled_or_no_timings",
        "HTTP 404 Not Found; enable SCIENCESWARM_CHAT_TIMING=1 and ensure the app is running locally with current code",
      );
    }
    if (!response.ok) {
      return unavailableTimingArtifact(
        "endpoint_unreachable_or_non_ok",
        `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`.trim(),
      );
    }
    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch (error) {
      return unavailableTimingArtifact(
        "endpoint_unreachable_or_non_ok",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!isRecord(responseJson) || !Array.isArray(responseJson.timings)) {
      return unavailableTimingArtifact(
        "endpoint_disabled_or_no_timings",
        "timings array was missing",
      );
    }
    if (responseJson.timings.length === 0) {
      return unavailableTimingArtifact(
        "endpoint_disabled_or_no_timings",
        "timings array was empty",
      );
    }
    const latest = summarizeLatestTimingArtifact(responseJson, options);
    if (latest === null) {
      return unavailableTimingArtifact(
        "no_matching_recent_artifact",
        typeof options.minStartedAtMs === "number"
          ? `no timings started at or after ${options.minStartedAtMs} ms`
          : "no recent artifact matched this benchmark turn",
      );
    }
    return latest;
  } catch (error) {
    const isTimeout = isAbortError(error) || controller.signal.aborted;
    return unavailableTimingArtifact(
      isTimeout ? "timeout" : "endpoint_unreachable_or_non_ok",
      isTimeout
        ? "timing endpoint did not respond before the 5000 ms timeout"
        : "timing endpoint was unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function runChatHiBenchmark(
  options: ChatBenchmarkOptions,
): Promise<ChatBenchmarkSummary> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = performance.now();
  const requestStartedAtEpochMs = Date.now();
  let headersAt = startedAt;
  let firstChunkAt: number | null = null;
  let rawBody = "";
  let bytes = 0;

  try {
    const response = await fetch(chatBenchmarkUrl(options.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBenchmarkPayload(options)),
      signal: controller.signal,
    });
    headersAt = performance.now();

    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (firstChunkAt === null) {
          firstChunkAt = performance.now();
        }
        bytes += value.byteLength;
        rawBody += decoder.decode(value, { stream: true });
      }
      rawBody += decoder.decode();
    } else {
      rawBody = await response.text();
      bytes = new TextEncoder().encode(rawBody).byteLength;
    }

    const completedAt = performance.now();
    const summary = summarizeChatBenchmarkResponse({
      status: response.status,
      ok: response.ok,
      backend: response.headers.get("x-chat-backend"),
      contentType: response.headers.get("content-type"),
      conversationId: options.conversationId,
      rawBody,
      headersMs: headersAt - startedAt,
      firstChunkMs:
        firstChunkAt === null ? null : firstChunkAt - startedAt,
      totalMs: completedAt - startedAt,
      bytes,
    });
    if (options.includeTimingArtifact) {
      summary.timingArtifact = await fetchLatestTimingArtifact(
        options.baseUrl,
        { minStartedAtMs: requestStartedAtEpochMs },
      );
    }
    return summary;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(`${benchmarkHelpText()}\n`);
      return;
    }
    const options = parseBenchmarkArgs(argv);
    const summary = await runChatHiBenchmark(options);
    console.log(
      options.json
        ? JSON.stringify(summary, null, 2)
        : formatBenchmarkSummary(summary),
    );
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
