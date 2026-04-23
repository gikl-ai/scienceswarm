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
  totalMs: number;
  bytes: number;
  eventCount: number;
  progressEventCount: number;
  finalEventCount: number;
  finalTextSample: string;
  timingArtifact?: ChatBenchmarkTimingArtifactSummary | null;
}

export interface ChatBenchmarkTimingPhaseSummary {
  name: string;
  durationMs: number;
  skipped?: boolean;
  inferred?: boolean;
}

export interface ChatBenchmarkTimingArtifactSummary {
  turnId: string;
  totalDurationMs: number;
  outcome: string | null;
  status: number | null;
  phaseCount: number;
  phases: ChatBenchmarkTimingPhaseSummary[];
  promptCharCounts: Record<string, number>;
}

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

  return {
    status: params.status,
    ok: params.ok,
    backend: params.backend,
    contentType: params.contentType,
    conversationId: params.conversationId,
    headersMs: Math.round(params.headersMs),
    firstChunkMs:
      typeof params.firstChunkMs === "number"
        ? Math.round(params.firstChunkMs)
        : null,
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

export function formatBenchmarkSummary(summary: ChatBenchmarkSummary): string {
  const timingArtifact = summary.timingArtifact;
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
    `Bytes: ${summary.bytes}`,
    `Events: ${summary.eventCount} (${summary.progressEventCount} progress, ${summary.finalEventCount} final)`,
    ...(timingArtifact === undefined
      ? []
      : timingArtifact === null
        ? ["Timing artifact: unavailable"]
        : [
            `Timing artifact: ${timingArtifact.totalDurationMs} ms, outcome ${
              timingArtifact.outcome ?? "unknown"
            }, status ${timingArtifact.status ?? "unknown"}`,
            `Timing phases: ${timingArtifact.phases
              .map((phase) => `${phase.name} ${phase.durationMs} ms`)
              .join(", ")}`,
            `Prompt chars: total ${timingArtifact.promptCharCounts.total ?? 0}`,
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
): ChatBenchmarkTimingArtifactSummary | null {
  const response = isRecord(responseJson) ? responseJson : null;
  const timings = Array.isArray(response?.timings) ? response.timings : [];
  let latest: unknown;
  for (let index = timings.length - 1; index >= 0; index -= 1) {
    if (isRecord(timings[index])) {
      latest = timings[index];
      break;
    }
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
    totalDurationMs: Math.round(asFiniteNumber(latest.totalDurationMs) ?? 0),
    outcome: asString(latest.outcome),
    status: asFiniteNumber(latest.status),
    phaseCount: phases.length,
    phases,
    promptCharCounts,
  };
}

async function fetchLatestTimingArtifact(
  baseUrl: string,
): Promise<ChatBenchmarkTimingArtifactSummary | null> {
  try {
    const response = await fetch(chatTimingArtifactUrl(baseUrl), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    return summarizeLatestTimingArtifact(await response.json());
  } catch {
    return null;
  }
}

export async function runChatHiBenchmark(
  options: ChatBenchmarkOptions,
): Promise<ChatBenchmarkSummary> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = performance.now();
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
      summary.timingArtifact = await fetchLatestTimingArtifact(options.baseUrl);
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
