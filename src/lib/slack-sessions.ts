interface Message {
  role: string;
  content: string;
}

/** In-memory conversation sessions keyed by teamId:channelId:threadTs */
const sessions = new Map<string, Message[]>();

/** Maximum messages per session to prevent unbounded growth */
const MAX_MESSAGES = 50;

/** Get or create a session for the given key */
export function getSession(key: string): Message[] {
  if (!sessions.has(key)) {
    sessions.set(key, []);
  }
  return sessions.get(key)!;
}

/** Add a message to a session, trimming old messages if over the limit */
export function addMessage(
  key: string,
  role: string,
  content: string
): void {
  const session = getSession(key);
  session.push({ role, content });

  // Keep only the most recent messages
  if (session.length > MAX_MESSAGES) {
    const trimmed = session.slice(session.length - MAX_MESSAGES);
    sessions.set(key, trimmed);
  }
}

/** Clear a session's conversation history */
export function clearSession(key: string): void {
  sessions.delete(key);
}

/** List all active session keys (for debugging) */
export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

/** Build a session key from Slack event identifiers */
export function sessionKey(
  teamId: string,
  channelId: string,
  threadTs: string
): string {
  return `${teamId}:${channelId}:${threadTs}`;
}

/** Get all messages across sessions sharing a teamId:channelId prefix */
export function getChannelMessages(
  teamId: string,
  channelId: string
): Message[] {
  const prefix = `${teamId}:${channelId}:`;
  const result: Message[] = [];
  for (const [key, msgs] of sessions.entries()) {
    if (key.startsWith(prefix)) {
      result.push(...msgs);
    }
  }
  return result;
}
