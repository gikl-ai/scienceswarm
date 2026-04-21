/**
 * External Integration — Gmail
 *
 * Adapter pattern: MockEmailAdapter for dev/testing,
 * GmailAdapter for real Gmail API v1.
 * Factory returns the appropriate adapter based on env credentials.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { EmailThread } from "./types";

// ── Adapter Interface ────────────────────────────────────

export interface EmailAdapter {
  getRecentThreads(maxAgeDays: number): Promise<EmailThread[]>;
  searchThreads(query: string): Promise<EmailThread[]>;
  getThread(threadId: string): Promise<EmailThread | null>;
}

// ── Mock Adapter ─────────────────────────────────────────

const STATE_FILE = join(process.cwd(), "state", "email-threads.json");

export class MockEmailAdapter implements EmailAdapter {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? STATE_FILE;
  }

  private loadThreads(): EmailThread[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8");
    return JSON.parse(raw) as EmailThread[];
  }

  async getRecentThreads(maxAgeDays: number): Promise<EmailThread[]> {
    const threads = this.loadThreads();
    const cutoff = new Date(
      Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    return threads.filter((t) => {
      const lastDate = t.messages.at(-1)?.date;
      return lastDate !== undefined && lastDate >= cutoff;
    });
  }

  async searchThreads(query: string): Promise<EmailThread[]> {
    const threads = this.loadThreads();
    const q = query.toLowerCase();
    return threads.filter(
      (t) =>
        t.subject.toLowerCase().includes(q) ||
        t.messages.some(
          (m) =>
            m.body.toLowerCase().includes(q) ||
            m.snippet.toLowerCase().includes(q),
        ),
    );
  }

  async getThread(threadId: string): Promise<EmailThread | null> {
    const threads = this.loadThreads();
    return threads.find((t) => t.id === threadId) ?? null;
  }
}

// ── Gmail API Adapter ────────────────────────────────────

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

export class GmailAdapter implements EmailAdapter {
  private readonly credentials: string;

  constructor(credentials: string) {
    this.credentials = credentials;
  }

  private async fetchGmail(
    path: string,
    params: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(`${GMAIL_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.credentials}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gmail API error ${res.status}: ${text}`);
    }

    return res.json();
  }

  async getRecentThreads(maxAgeDays: number): Promise<EmailThread[]> {
    const data = (await this.fetchGmail("/users/me/messages", {
      q: `newer_than:${maxAgeDays}d`,
      maxResults: "50",
    })) as { messages?: Array<{ id: string; threadId: string }> };

    if (!data.messages?.length) return [];

    // Group by threadId, fetch unique threads
    const threadIds = [...new Set(data.messages.map((m) => m.threadId))];
    const threads: EmailThread[] = [];

    for (const tid of threadIds.slice(0, 20)) {
      const thread = await this.fetchThreadById(tid);
      if (thread) threads.push(thread);
    }

    return threads;
  }

  async searchThreads(query: string): Promise<EmailThread[]> {
    const data = (await this.fetchGmail("/users/me/messages", {
      q: query,
      maxResults: "20",
    })) as { messages?: Array<{ id: string; threadId: string }> };

    if (!data.messages?.length) return [];

    const threadIds = [...new Set(data.messages.map((m) => m.threadId))];
    const threads: EmailThread[] = [];

    for (const tid of threadIds.slice(0, 20)) {
      const thread = await this.fetchThreadById(tid);
      if (thread) threads.push(thread);
    }

    return threads;
  }

  async getThread(threadId: string): Promise<EmailThread | null> {
    return this.fetchThreadById(threadId);
  }

  private async fetchThreadById(
    threadId: string,
  ): Promise<EmailThread | null> {
    try {
      const data = (await this.fetchGmail(
        `/users/me/threads/${encodeURIComponent(threadId)}`,
        { format: "full" },
      )) as GmailThread;

      return parseGmailThread(data);
    } catch {
      return null;
    }
  }
}

// ── Gmail API Types (internal) ───────────────────────────

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: {
    headers?: GmailHeader[];
    body?: { data?: string };
    parts?: GmailMessagePart[];
  };
  snippet?: string;
  labelIds?: string[];
}

interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

function getHeader(
  headers: GmailHeader[] | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  try {
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    return atob(base64);
  } catch {
    return "";
  }
}

function extractTextBody(part: GmailMessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const text = extractTextBody(sub);
      if (text) return text;
    }
  }
  return "";
}

function parseGmailThread(thread: GmailThread): EmailThread {
  const messages = (thread.messages ?? []).map((msg) => {
    const headers = msg.payload?.headers;
    const from = getHeader(headers, "From");
    const date = msg.internalDate
      ? new Date(parseInt(msg.internalDate, 10)).toISOString()
      : "";
    const body =
      extractTextBody(msg.payload as GmailMessagePart | undefined) || "";
    const snippet = msg.snippet ?? "";

    return { from, date, body, snippet };
  });

  // Collect all unique participants from From headers
  const participantSet = new Map<string, { name: string; email: string }>();
  for (const msg of thread.messages ?? []) {
    const from = getHeader(msg.payload?.headers, "From");
    const emailMatch = from.match(/<(.+?)>/);
    const email = emailMatch?.[1] ?? from;
    const name = from.replace(/<.+?>/, "").trim() || email;
    if (email) participantSet.set(email, { name, email });
  }

  const subject = thread.messages?.[0]
    ? getHeader(thread.messages[0].payload?.headers, "Subject")
    : "";

  const labels = [
    ...new Set(
      (thread.messages ?? []).flatMap((m) => m.labelIds ?? []),
    ),
  ];

  return {
    id: thread.id,
    subject,
    participants: [...participantSet.values()],
    messages,
    labels,
  };
}

// ── Factory ──────────────────────────────────────────────

/**
 * Create the appropriate email adapter.
 * Returns GmailAdapter if GMAIL_CREDENTIALS is set,
 * MockEmailAdapter otherwise.
 */
export function createEmailAdapter(): EmailAdapter {
  const creds = process.env.GMAIL_CREDENTIALS;
  if (creds) {
    return new GmailAdapter(creds);
  }
  return new MockEmailAdapter();
}
