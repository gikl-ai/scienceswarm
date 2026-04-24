import type { RuntimeEvent } from "../contracts";

type RuntimeHostIdLike = RuntimeEvent["hostId"];

export interface ClaudeCodeStreamParseResult {
  message: string;
  nativeSessionId: string | null;
  events: RuntimeEvent[];
}

interface ClaudeCodeStreamEventInput {
  hostId: RuntimeHostIdLike;
  sessionId: string;
  createdAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function findSessionId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = firstString(value.session_id, value.sessionId);
  if (direct) return direct;
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) {
      const found = findSessionId(nested);
      if (found) return found;
    }
  }
  return null;
}

function textFromContentItem(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return null;
  return firstString(
    item.text,
    item.content,
    isRecord(item.delta) ? item.delta.text : null,
  );
}

function textFromContentArray(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text = value
    .map(textFromContentItem)
    .filter((entry): entry is string => Boolean(entry))
    .join("");
  return text || null;
}

function extractAssistantText(record: Record<string, unknown>): string | null {
  const message = isRecord(record.message) ? record.message : null;
  const delta = isRecord(record.delta) ? record.delta : null;

  if (record.type === "result") {
    return firstString(record.result, record.message, record.response, record.text);
  }

  if (record.type === "assistant" && message) {
    return firstString(
      textFromContentArray(message.content),
      message.text,
      message.content,
    );
  }

  if (record.type === "content_block_delta" && delta) {
    return firstString(delta.text);
  }

  return firstString(
    textFromContentArray(record.content),
    record.text,
    record.content,
    message ? textFromContentArray(message.content) : null,
  );
}

function eventTypeFor(record: Record<string, unknown>): RuntimeEvent["type"] {
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "assistant" || type === "content_block_delta" || type === "result") {
    return "message";
  }
  if (type.includes("tool")) return "tool-call";
  if (type === "error") return "error";
  return "status";
}

export class ClaudeCodeStreamAccumulator {
  private readonly hostId: RuntimeHostIdLike;
  private readonly sessionId: string;
  private readonly events: RuntimeEvent[] = [];
  private readonly rawLines: string[] = [];
  private assistantMessage = "";
  private nativeSessionId: string | null = null;
  private sequence = 0;

  constructor(input: ClaudeCodeStreamEventInput) {
    this.hostId = input.hostId;
    this.sessionId = input.sessionId;
  }

  get hasLines(): boolean {
    return this.rawLines.length > 0;
  }

  acceptLine(line: string): RuntimeEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    this.rawLines.push(trimmed);

    const record = parseJsonLine(trimmed);
    if (!record) {
      return null;
    }

    const sessionId = findSessionId(record);
    if (sessionId) {
      this.nativeSessionId = sessionId;
    }

    const text = extractAssistantText(record);
    const eventType = text ? "message" : eventTypeFor(record);
    if (text) {
      this.assistantMessage = record.type === "content_block_delta"
        ? this.assistantMessage + text
        : text;
    }

    return this.appendEvent(eventType, {
      ...(text ? { text: this.assistantMessage } : {}),
      ...(sessionId ? { nativeSessionId: sessionId } : {}),
      claudeCodeEvent: record,
    });
  }

  acceptLines(lines: readonly string[]): void {
    for (const line of lines) {
      this.acceptLine(line);
    }
  }

  result(): ClaudeCodeStreamParseResult {
    return {
      message: this.finalMessage(),
      nativeSessionId: this.nativeSessionId,
      events: [...this.events],
    };
  }

  private finalMessage(): string {
    return this.assistantMessage.trim();
  }

  private appendEvent(
    type: RuntimeEvent["type"],
    payload: Record<string, unknown>,
  ): RuntimeEvent {
    this.sequence += 1;
    const event = {
      id: `${this.sessionId}:claude-code-${this.sequence}`,
      sessionId: this.sessionId,
      hostId: this.hostId,
      type,
      createdAt: new Date().toISOString(),
      payload,
    };
    this.events.push(event);
    return event;
  }
}

export function parseClaudeCodeStreamOutput(input: {
  hostId: RuntimeHostIdLike;
  sessionId: string;
  lines: readonly string[];
}): ClaudeCodeStreamParseResult {
  const accumulator = new ClaudeCodeStreamAccumulator({
    hostId: input.hostId,
    sessionId: input.sessionId,
  });
  accumulator.acceptLines(input.lines);
  return accumulator.result();
}
