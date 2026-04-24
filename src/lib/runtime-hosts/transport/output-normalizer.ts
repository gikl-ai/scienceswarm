import { RuntimeHostError } from "../errors";

export interface NormalizeCliOutputInput {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  requireJson?: boolean;
}

export interface NormalizedCliOutput {
  stdout: string;
  stderr: string;
  combined: string;
  text: string;
  lines: string[];
  json: unknown | null;
  jsonLines: unknown[];
  authChallenge: boolean;
}

export interface RuntimeCliFailureUserMessageInput {
  hostId?: string;
  command: string;
  output?: Pick<NormalizedCliOutput, "stderr" | "stdout" | "text" | "combined">;
}

export class RuntimeCliMalformedOutputError extends RuntimeHostError {
  constructor(input: { hostId?: string; command?: string; detail: string }) {
    super({
      code: "RUNTIME_TRANSPORT_ERROR",
      status: 502,
      message: input.detail,
      userMessage: "Runtime host output could not be parsed.",
      recoverable: true,
      context: {
        ...input,
        transportError: "MALFORMED_OUTPUT",
      },
    });
    this.name = "RuntimeCliMalformedOutputError";
  }
}

const ANSI_PATTERN = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)",
    "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  ].join(""),
  "g",
);

const AUTH_CHALLENGE_PATTERN =
  /\b(auth(?:entication)? required|not authenticated|unauthorized|forbidden|please log in|please login|sign in|login required|api key required|missing api key|invalid api key)\b/i;

function asString(value: string | Buffer | undefined): string {
  if (!value) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

export function normalizeCliText(input: string | Buffer | undefined): string {
  return stripAnsi(asString(input))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

export function isCliAuthChallengeText(input: string): boolean {
  return AUTH_CHALLENGE_PATTERN.test(input);
}

function runtimeHostLabel(hostId: string | undefined): string {
  switch (hostId) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "gemini-cli":
      return "Gemini CLI";
    case "openhands":
      return "OpenHands";
    case "openclaw":
      return "OpenClaw";
    default:
      return "Runtime host";
  }
}

function summarizeCliDetail(
  output: RuntimeCliFailureUserMessageInput["output"],
): string | null {
  const text = output?.stderr || output?.text || output?.stdout || output?.combined || "";
  const normalized = normalizeCliText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
  if (!normalized) return null;
  return normalized.length <= 360 ? normalized : `${normalized.slice(0, 357)}...`;
}

export function buildRuntimeCliFailureUserMessage(
  input: RuntimeCliFailureUserMessageInput,
): string {
  const label = runtimeHostLabel(input.hostId);
  const detail = summarizeCliDetail(input.output);
  const combined = input.output?.combined ?? input.output?.text ?? "";

  const looksLikeScienceSwarmMcp =
    /scienceswarm|runtime mcp|mcp server|gbrain/i.test(combined);
  const looksLikeRuntimeMcpAuth =
    /Runtime MCP access token|SCIENCESWARM_RUNTIME_MCP|signature is invalid|not scoped to this/i
      .test(combined);
  const looksLikeBrainConfig =
    /Brain not configured|BRAIN_ROOT|brain backend unavailable|PGLite|pglite/i
      .test(combined);

  if (input.hostId === "claude-code" && looksLikeRuntimeMcpAuth) {
    return [
      "Claude Code could not access ScienceSwarm's scoped gbrain tools because the runtime MCP authorization failed.",
      "Retry the turn; if it keeps happening, restart the ScienceSwarm preview so a fresh MCP session is minted.",
      detail ? `Detail: ${detail}` : null,
    ].filter(Boolean).join(" ");
  }

  if (input.hostId === "claude-code" && looksLikeBrainConfig) {
    return [
      "Claude Code reached ScienceSwarm, but the gbrain backend was not readable.",
      "Check that the project brain is initialized and BRAIN_ROOT points at the expected brain.",
      detail ? `Detail: ${detail}` : null,
    ].filter(Boolean).join(" ");
  }

  if (input.hostId === "claude-code" && looksLikeScienceSwarmMcp) {
    return [
      "Claude Code exited while using ScienceSwarm's scoped gbrain tools.",
      "Try a narrower question or restart the ScienceSwarm preview if the MCP server is stale.",
      detail ? `Detail: ${detail}` : null,
    ].filter(Boolean).join(" ");
  }

  return [
    `${label} command failed.`,
    detail ? `Detail: ${detail}` : `Command: ${input.command}`,
  ].join(" ");
}

function parseJsonLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function extractTextFromJson(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "text", "content", "output", "response"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

export function normalizeCliOutput(
  input: NormalizeCliOutputInput,
): NormalizedCliOutput {
  const stdout = normalizeCliText(input.stdout);
  const stderr = normalizeCliText(input.stderr);
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const lines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let json: unknown | null = null;

  if (stdout.startsWith("{") || stdout.startsWith("[")) {
    try {
      json = JSON.parse(stdout) as unknown;
    } catch {
      json = null;
    }
  }

  const jsonLines = lines
    .map(parseJsonLine)
    .filter((value): value is unknown => value !== null);
  if (json === null && jsonLines.length === 1) {
    json = jsonLines[0] ?? null;
  }

  if (input.requireJson && json === null && jsonLines.length === 0) {
    throw new RuntimeCliMalformedOutputError({
      detail: "Runtime host returned non-JSON output when JSON was required.",
    });
  }

  const jsonText = json ? extractTextFromJson(json) : null;
  const jsonLineText = jsonLines
    .map(extractTextFromJson)
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
  const text = jsonText ?? (jsonLineText || stdout || stderr);

  return {
    stdout,
    stderr,
    combined,
    text,
    lines,
    json,
    jsonLines,
    authChallenge: isCliAuthChallengeText(combined),
  };
}
