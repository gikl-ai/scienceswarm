/**
 * Notification dispatcher
 *
 * In-memory store for ephemeral notifications. Dispatches alerts to
 * NanoClaw (HTTP channel) and OpenClaw (CLI agent) when connected.
 */

export interface Notification {
  id: string;
  type: "experiment" | "agent" | "analysis" | "system";
  title: string;
  message: string;
  projectId?: string;
  timestamp: string;
  read: boolean;
}

// In-memory store keyed by projectId — notifications are ephemeral across
// server restarts. The "_global" key holds notifications without a projectId.
const store = new Map<string, Notification[]>();

function bucket(projectId?: string): Notification[] {
  const key = projectId ?? "_global";
  let list = store.get(key);
  if (!list) {
    list = [];
    store.set(key, list);
  }
  return list;
}

/**
 * Add a notification and dispatch to connected channels.
 * NanoClaw / OpenClaw failures are silently swallowed so the caller
 * never has to worry about channel availability.
 */
export async function notify(
  n: Omit<Notification, "id" | "timestamp" | "read">,
): Promise<void> {
  const notification: Notification = {
    ...n,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    read: false,
  };
  const notifications = bucket(n.projectId);
  notifications.push(notification);

  // Keep last 100 per bucket
  if (notifications.length > 100) notifications.shift();

  // Try NanoClaw
  try {
    const { healthCheck, sendMessage } = await import("./nanoclaw");
    const status = await healthCheck();
    if (status.status === "connected") {
      await sendMessage(`[${n.type}] ${n.title}: ${n.message}`);
    }
  } catch {
    /* NanoClaw not available */
  }

  // Try OpenClaw
  try {
    const { healthCheck, sendAgentMessage } = await import("./openclaw");
    const status = await healthCheck();
    if (status.status === "connected") {
      await sendAgentMessage(`[${n.type}] ${n.title}: ${n.message}`, {
        agent: "main",
      });
    }
  } catch {
    /* OpenClaw not available */
  }
}

/** Return the most recent notifications, newest first. */
export function getNotifications(
  limit = 20,
  unreadOnly = false,
  projectId?: string,
): Notification[] {
  const notifications = bucket(projectId);
  const pool = unreadOnly
    ? notifications.filter((n) => !n.read)
    : notifications;
  return pool.slice(-limit).reverse();
}

/** Count of unread notifications. */
export function getUnreadCount(projectId?: string): number {
  return bucket(projectId).filter((n) => !n.read).length;
}

/** Mark a single notification as read. */
export function markRead(id: string, projectId?: string): void {
  const n = bucket(projectId).find((item) => item.id === id);
  if (n) n.read = true;
}

/** Mark every notification as read. */
export function markAllRead(projectId?: string): void {
  bucket(projectId).forEach((n) => {
    n.read = true;
  });
}
