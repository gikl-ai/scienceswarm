"use client";

import { useState, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────

interface ClawUser {
  id: string;
  displayName: string;
  channels: Array<{ platform: string; externalId: string }>;
  lastActive: string;
}

interface ClawConversation {
  id: string;
  channel: string;
  lastMessage: string;
  updatedAt: string;
}

interface ClawMessage {
  id: string;
  userId: string;
  channel: string;
  content: string;
  timestamp: string;
  conversationId: string;
}

interface HealthStatus {
  status: string;
  wsConnected: boolean;
  channels: string[];
  usersCount: number;
}

// ── Channel icons ──────────────────────────────────────────────

const channelIcons: Record<string, string> = {
  whatsapp: "\u{1F4F1}",
  telegram: "\u{2708}\uFE0F",
  slack: "\u{1F4AC}",
  discord: "\u{1F3AE}",
  web: "\u{1F310}",
  line: "\u{1F4E9}",
  sms: "\u{1F4F2}",
  email: "\u{2709}\uFE0F",
};

const channelColors: Record<string, string> = {
  whatsapp: "bg-ok/10 text-ok border-ok/30",
  telegram: "bg-accent/10 text-accent border-accent/30",
  slack: "bg-raised text-body border-rule",
  discord: "bg-raised text-body border-rule",
  web: "bg-sunk text-body border-rule",
  line: "bg-ok/10 text-ok border-ok/30",
  sms: "bg-warn/10 text-warn border-warn/30",
  email: "bg-raised text-body border-rule",
};

function ChannelBadge({ channel }: { channel: string }) {
  const icon = channelIcons[channel] || "\u{1F4E8}";
  const color = channelColors[channel] || "bg-sunk text-body border-rule";
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${color}`}>
      {icon} {channel}
    </span>
  );
}

// ── Demo data ──────────────────────────────────────────────────

const demoUsers: ClawUser[] = [
  {
    id: "u1",
    displayName: "Dr. Sarah Chen",
    channels: [
      { platform: "slack", externalId: "U0392FKLD" },
      { platform: "telegram", externalId: "sarah_chen_phd" },
    ],
    lastActive: "2 min ago",
  },
  {
    id: "u2",
    displayName: "Prof. Marcos Reyes",
    channels: [
      { platform: "whatsapp", externalId: "+1-555-0123" },
      { platform: "email", externalId: "m.reyes@university.edu" },
    ],
    lastActive: "15 min ago",
  },
  {
    id: "u3",
    displayName: "Alex Kim",
    channels: [
      { platform: "discord", externalId: "alexk_4821" },
      { platform: "web", externalId: "alex.kim@lab" },
      { platform: "telegram", externalId: "alexkim_dev" },
    ],
    lastActive: "1 hour ago",
  },
  {
    id: "u4",
    displayName: "Dr. Priya Sharma",
    channels: [{ platform: "slack", externalId: "U0482JKMS" }],
    lastActive: "3 hours ago",
  },
];

const demoConversations: Record<string, ClawConversation[]> = {
  u1: [
    { id: "c1", channel: "slack", lastMessage: "The new partition results look promising!", updatedAt: "2 min ago" },
    { id: "c2", channel: "telegram", lastMessage: "Can you run exp_003 overnight?", updatedAt: "1 day ago" },
  ],
  u2: [
    { id: "c3", channel: "whatsapp", lastMessage: "Paper draft v19 is ready for review", updatedAt: "15 min ago" },
  ],
  u3: [
    { id: "c4", channel: "discord", lastMessage: "Found a bug in graph_utils.py line 42", updatedAt: "1 hour ago" },
    { id: "c5", channel: "web", lastMessage: "Uploaded new dataset graphs_medium.csv", updatedAt: "2 days ago" },
  ],
  u4: [
    { id: "c6", channel: "slack", lastMessage: "Statistical analysis for section 4.2 done", updatedAt: "3 hours ago" },
  ],
};

const demoMessages: Record<string, ClawMessage[]> = {
  c1: [
    { id: "m1", userId: "u1", channel: "slack", content: "Hey, I just ran the baseline experiment on the small graph set", timestamp: "10:23 AM", conversationId: "c1" },
    { id: "m2", userId: "system", channel: "slack", content: "**Experiment completed**: Baseline partition on small graphs\n\n- Graphs tested: 128\n- Tight bounds: 94 (73.4%)\n- Gaps found: 34\n- Max gap: 3", timestamp: "10:27 AM", conversationId: "c1" },
    { id: "m3", userId: "u1", channel: "slack", content: "The new partition results look promising!", timestamp: "10:30 AM", conversationId: "c1" },
  ],
  c3: [
    { id: "m4", userId: "u2", channel: "whatsapp", content: "I finished the revisions on section 3. Can you check the proof of Theorem 3.2?", timestamp: "9:45 AM", conversationId: "c3" },
    { id: "m5", userId: "system", channel: "whatsapp", content: "I reviewed Theorem 3.2. The proof is correct but could be tightened. Specifically:\n\n- Step 3 can use Lemma 2.1 directly instead of re-deriving\n- The bound in equation (7) is loose by a factor of 2", timestamp: "9:46 AM", conversationId: "c3" },
    { id: "m6", userId: "u2", channel: "whatsapp", content: "Paper draft v19 is ready for review", timestamp: "11:15 AM", conversationId: "c3" },
  ],
  c4: [
    { id: "m7", userId: "u3", channel: "discord", content: "Found a bug in graph_utils.py line 42", timestamp: "9:00 AM", conversationId: "c4" },
    { id: "m8", userId: "system", channel: "discord", content: "Looking at `graph_utils.py:42` — the adjacency check is using `>=` instead of `>` for the degree threshold. This would include self-loops in the clique count. Should I create a fix?", timestamp: "9:01 AM", conversationId: "c4" },
  ],
};

// ── Stats ──────────────────────────────────────────────────────

interface ChannelStat {
  channel: string;
  messages: number;
  activeUsers: number;
  avgResponseTime: string;
}

const demoStats: ChannelStat[] = [
  { channel: "slack", messages: 156, activeUsers: 2, avgResponseTime: "1.2s" },
  { channel: "whatsapp", messages: 43, activeUsers: 1, avgResponseTime: "2.1s" },
  { channel: "discord", messages: 89, activeUsers: 1, avgResponseTime: "1.5s" },
  { channel: "telegram", messages: 27, activeUsers: 1, avgResponseTime: "1.8s" },
  { channel: "web", messages: 312, activeUsers: 3, avgResponseTime: "0.9s" },
];

// ── Component ──────────────────────────────────────────────────

export function CommunicationsPanel() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [users] = useState<ClawUser[]>(demoUsers);
  const [selectedUser, setSelectedUser] = useState<ClawUser | null>(null);
  const [selectedConvo, setSelectedConvo] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [sendChannel, setSendChannel] = useState("");
  const [broadcastInput, setBroadcastInput] = useState("");
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [view, setView] = useState<"users" | "stats">("users");
  const [sendError, setSendError] = useState<string | null>(null);

  // Check OpenClaw health on mount
  useEffect(() => {
    fetch("/api/openclaw?action=health")
      .then((r) => r.json())
      .then((data: HealthStatus) => setHealth(data))
      .catch(() =>
        setHealth({
          status: "disconnected",
          wsConnected: false,
          channels: [],
          usersCount: 0,
        })
      );
  }, []);

  const handleSend = useCallback(async () => {
    if (!messageInput.trim() || !selectedUser || !sendChannel) return;

    const savedInput = messageInput;
    setMessageInput("");
    setSendError(null);
    try {
      const res = await fetch("/api/openclaw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send",
          userId: selectedUser.id,
          channel: sendChannel,
          content: savedInput,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Send failed: HTTP ${res.status}`);
      }
    } catch (err) {
      setMessageInput(savedInput);
      setSendError(err instanceof Error ? err.message : "Failed to send message");
    }
  }, [messageInput, selectedUser, sendChannel]);

  const handleBroadcast = useCallback(async () => {
    if (!broadcastInput.trim()) return;

    setSendError(null);
    const savedInput = broadcastInput;
    setBroadcastInput("");
    setShowBroadcast(false);
    try {
      const res = await fetch("/api/openclaw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "broadcast",
          content: savedInput,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Broadcast failed: HTTP ${res.status}`);
      }
    } catch (err) {
      setBroadcastInput(savedInput);
      setShowBroadcast(true);
      setSendError(err instanceof Error ? err.message : "Failed to broadcast message");
    }
  }, [broadcastInput]);

  const conversations = selectedUser
    ? demoConversations[selectedUser.id] || []
    : [];

  const messages = selectedConvo ? demoMessages[selectedConvo] || [] : [];

  return (
    <div className="flex h-full">
      {/* Left sidebar: status + user list / stats */}
      <div className="w-72 flex-shrink-0 border-r-2 border-border bg-white flex flex-col">
        {/* Connection status */}
        <div className="p-3 border-b-2 border-border">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted">
              OpenClaw
            </h2>
            <span
              className={`flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full border ${
                health?.status === "connected"
                  ? "bg-ok/10 text-ok border-ok/30"
                  : "bg-danger/10 text-danger border-danger/30"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  health?.status === "connected"
                    ? "bg-ok"
                    : "bg-danger"
                }`}
              />
              {health?.status === "connected" ? "Connected" : "Disconnected"}
            </span>
          </div>

          {/* Connected channels */}
          {health && health.channels.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {health.channels.map((ch) => (
                <ChannelBadge key={ch} channel={ch} />
              ))}
            </div>
          )}

          {/* View toggles */}
          <div className="flex gap-1">
            <button
              onClick={() => setView("users")}
              className={`flex-1 text-[10px] font-medium py-1 rounded border transition-colors ${
                view === "users"
                  ? "bg-accent text-white border-accent"
                  : "bg-surface text-muted border-border hover:border-accent"
              }`}
            >
              Users
            </button>
            <button
              onClick={() => setView("stats")}
              className={`flex-1 text-[10px] font-medium py-1 rounded border transition-colors ${
                view === "stats"
                  ? "bg-accent text-white border-accent"
                  : "bg-surface text-muted border-border hover:border-accent"
              }`}
            >
              Stats
            </button>
            <button
              onClick={() => setShowBroadcast(!showBroadcast)}
              className="flex-1 text-[10px] font-medium py-1 rounded border bg-surface text-muted border-border hover:border-accent hover:text-accent transition-colors"
            >
              Broadcast
            </button>
          </div>
        </div>

        {/* Broadcast panel */}
        {showBroadcast && (
          <div className="p-3 border-b-2 border-border bg-warn/10">
            <p className="text-[10px] text-muted mb-2 font-medium">
              Send to all connected users:
            </p>
            <textarea
              value={broadcastInput}
              onChange={(e) => setBroadcastInput(e.target.value)}
              placeholder="Experiment completed! Results are in..."
              rows={2}
              className="w-full text-xs border-2 border-border rounded-lg px-2 py-1.5 focus:outline-none focus:border-accent resize-none"
            />
            <button
              onClick={handleBroadcast}
              disabled={!broadcastInput.trim()}
              className="mt-1 w-full text-[10px] font-semibold bg-accent text-white rounded py-1.5 hover:bg-accent-hover transition-colors disabled:opacity-40"
            >
              Broadcast
            </button>
          </div>
        )}

        {/* User list */}
        {view === "users" && (
          <div className="flex-1 overflow-y-auto">
            {users.map((user) => (
              <button
                key={user.id}
                onClick={() => {
                  setSelectedUser(user);
                  setSelectedConvo(null);
                  if (user.channels.length > 0) {
                    setSendChannel(user.channels[0].platform);
                  }
                }}
                className={`w-full text-left px-3 py-2.5 border-b border-border transition-colors ${
                  selectedUser?.id === user.id
                    ? "bg-accent/5 border-l-2 border-l-accent"
                    : "hover:bg-surface"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-foreground truncate">
                    {user.displayName}
                  </span>
                  <span className="text-[10px] text-muted flex-shrink-0 ml-2">
                    {user.lastActive}
                  </span>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {user.channels.map((ch) => (
                    <ChannelBadge key={ch.platform} channel={ch.platform} />
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Stats view */}
        {view === "stats" && (
          <div className="flex-1 overflow-y-auto p-3">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-muted mb-2">
              Channel Statistics
            </h3>
            <div className="space-y-2">
              {demoStats.map((stat) => (
                <div
                  key={stat.channel}
                  className="bg-surface border-2 border-border rounded-lg p-2"
                >
                  <div className="flex items-center justify-between mb-1">
                    <ChannelBadge channel={stat.channel} />
                    <span className="text-[10px] text-muted">
                      {stat.avgResponseTime} avg
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-muted">
                      {stat.messages} messages
                    </span>
                    <span className="text-muted">
                      {stat.activeUsers} users
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 bg-surface border-2 border-border rounded-lg p-3">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-muted mb-2">
                Totals
              </h3>
              <div className="grid grid-cols-2 gap-2 text-center">
                <div>
                  <div className="text-lg font-bold text-foreground">627</div>
                  <div className="text-[10px] text-muted">Messages</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-foreground">4</div>
                  <div className="text-[10px] text-muted">Users</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-foreground">5</div>
                  <div className="text-[10px] text-muted">Channels</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-foreground">1.4s</div>
                  <div className="text-[10px] text-muted">Avg Response</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right: conversation view */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedUser ? (
          <div className="flex-1 flex items-center justify-center text-muted">
            <div className="text-center">
              <p className="text-4xl mb-3">{"\u{1F4E1}"}</p>
              <p className="text-sm font-medium">Unified Communications</p>
              <p className="text-xs mt-1">
                Select a user to view their conversations across all channels
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* User header */}
            <div className="px-4 py-3 border-b-2 border-border bg-white flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  {selectedUser.displayName}
                </h2>
                <div className="flex gap-1 mt-1">
                  {selectedUser.channels.map((ch) => (
                    <ChannelBadge key={ch.platform} channel={ch.platform} />
                  ))}
                </div>
              </div>
              <span className="text-[10px] text-muted">
                Last active: {selectedUser.lastActive}
              </span>
            </div>

            {/* Conversation list */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface/50">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted">
                Conversations:
              </span>
              {conversations.map((convo) => (
                <button
                  key={convo.id}
                  onClick={() => setSelectedConvo(convo.id)}
                  className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition-colors ${
                    selectedConvo === convo.id
                      ? "bg-accent text-white border-accent"
                      : "bg-white text-muted border-border hover:border-accent"
                  }`}
                >
                  <ChannelBadge channel={convo.channel} />
                  <span className="truncate max-w-[120px]">
                    {convo.updatedAt}
                  </span>
                </button>
              ))}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-surface/30">
              {!selectedConvo ? (
                <div className="text-center text-muted text-xs py-8">
                  Select a conversation above
                </div>
              ) : messages.length === 0 ? (
                <div className="text-center text-muted text-xs py-8">
                  No messages yet
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.userId === "system" ? "justify-start" : "justify-end"
                    }`}
                  >
                    <div
                      className={`max-w-xl rounded-xl px-4 py-3 text-sm shadow-sm ${
                        msg.userId === "system"
                          ? "bg-white border-2 border-border"
                          : "bg-accent/10 border-2 border-accent/30"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <ChannelBadge channel={msg.channel} />
                        <span className="text-[10px] text-muted">
                          {msg.timestamp}
                        </span>
                        <span className="text-[10px] font-medium text-foreground">
                          {msg.userId === "system"
                            ? "ScienceSwarm"
                            : selectedUser.displayName}
                        </span>
                      </div>
                      <div className="whitespace-pre-wrap text-xs leading-relaxed">
                        {msg.content.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
                          part.startsWith("**") && part.endsWith("**") ? (
                            <strong key={i} className="font-semibold">
                              {part.slice(2, -2)}
                            </strong>
                          ) : (
                            <span key={i}>{part}</span>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Send message */}
            <div className="p-3 border-t-2 border-border bg-white flex-shrink-0">
              <div className="flex gap-2 items-end">
                <select
                  value={sendChannel}
                  onChange={(e) => setSendChannel(e.target.value)}
                  className="text-[10px] bg-surface border-2 border-border rounded-lg px-2 py-2.5 focus:outline-none focus:border-accent"
                >
                  {selectedUser.channels.map((ch) => (
                    <option key={ch.platform} value={ch.platform}>
                      {channelIcons[ch.platform] || ""} {ch.platform}
                    </option>
                  ))}
                </select>
                <input
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={`Message ${selectedUser.displayName} on ${sendChannel}...`}
                  className="flex-1 text-xs bg-surface border-2 border-border rounded-lg px-3 py-2.5 focus:outline-none focus:border-accent"
                />
                <button
                  onClick={handleSend}
                  disabled={!messageInput.trim()}
                  className="bg-accent text-white px-4 py-2.5 rounded-lg text-xs font-semibold hover:bg-accent-hover transition-colors disabled:opacity-40 flex-shrink-0"
                >
                  Send
                </button>
              </div>
              {sendError && (
                <p className="text-xs text-danger mt-1 px-1">{sendError}</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
