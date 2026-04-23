import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPaths, mockWebSockets } = vi.hoisted(() => {
  const mockPaths = {
    stateDir: "",
    configPath: "",
  };

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readonly sentFrames: Array<Record<string, unknown>> = [];
    readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    readyState = MockWebSocket.CONNECTING;

    constructor(_url: string, _options?: { origin?: string }) {
      mockWebSockets.instances.push(this);
      queueMicrotask(() => {
        if (this.readyState !== MockWebSocket.CONNECTING) return;
        this.readyState = MockWebSocket.OPEN;
        this.emit("open");
        this.emit(
          "message",
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "nonce-1" },
          }),
        );
      });
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const existing = this.handlers.get(event) ?? [];
      existing.push(handler);
      this.handlers.set(event, existing);
      return this;
    }

    send(data: string): void {
      const frame = JSON.parse(data) as Record<string, unknown>;
      this.sentFrames.push(frame);
      queueMicrotask(() => {
        const method = typeof frame.method === "string" ? frame.method : "";
        if (mockWebSockets.requestFailures.has(method)) {
          this.emit(
            "message",
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: mockWebSockets.requestFailures.get(method),
            }),
          );
          return;
        }
        this.emit(
          "message",
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: frame.method === "connect" ? { auth: { deviceToken: "device-token" } } : {},
          }),
        );
      });
    }

    close(): void {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }

    terminate(): void {
      this.close();
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return {
    mockPaths,
    mockWebSockets: {
      MockWebSocket,
      instances: [] as MockWebSocket[],
      requestFailures: new Map<string, unknown>(),
      failMethod(method: string, error: unknown) {
        this.requestFailures.set(method, error);
      },
      reset() {
        this.instances.length = 0;
        this.requestFailures.clear();
      },
    },
  };
});

vi.mock("ws", () => ({
  default: mockWebSockets.MockWebSocket,
}));

vi.mock("@/lib/config/ports", () => ({
  getOpenClawGatewayUrl: () => "ws://127.0.0.1:19002/ws",
  getOpenClawPort: () => 19002,
}));

vi.mock("@/lib/scienceswarm-paths", () => ({
  getScienceSwarmOpenClawStateDir: () => mockPaths.stateDir,
  getScienceSwarmOpenClawConfigPath: () => mockPaths.configPath,
}));

vi.mock("@/lib/openclaw/runner", () => ({
  resolveOpenClawMode: () => ({
    kind: "state-dir" as const,
    configPath: mockPaths.configPath,
  }),
}));

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("gateway-ws-client", () => {
  let tempRoot = "";

  beforeEach(() => {
    vi.resetModules();
    mockWebSockets.reset();
    tempRoot = mkdtempSync(path.join(tmpdir(), "scienceswarm-gateway-ws-"));
    mockPaths.stateDir = path.join(tempRoot, "state");
    mockPaths.configPath = path.join(tempRoot, "openclaw.json");
    mkdirSync(mockPaths.stateDir, { recursive: true });
    writeFileSync(
      mockPaths.configPath,
      JSON.stringify({ gateway: { auth: { token: "test-token" } } }),
      "utf8",
    );
  });

  afterEach(async () => {
    try {
      const { closeGatewayConnection } = await import("@/lib/openclaw/gateway-ws-client");
      closeGatewayConnection();
    } catch {
      // Ignore cleanup failures in tests that never imported the module.
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("sends web chat turns through chat.send and resolves from chat.final", async () => {
    const { sendChatViaGateway } = await import("@/lib/openclaw/gateway-ws-client");

    const turn = sendChatViaGateway("session-alpha", "hello", {
      timeoutMs: 60_000,
      idempotencyKey: "run-alpha",
    });

    await waitUntil(() => {
      const socket = mockWebSockets.instances.at(-1);
      return Boolean(socket?.sentFrames.some((frame) => frame.method === "chat.send"));
    });

    const socket = mockWebSockets.instances.at(-1);
    expect(socket).toBeTruthy();
    expect(socket?.sentFrames.some((frame) => frame.method === "sessions.send")).toBe(false);

    const chatSendFrame = socket?.sentFrames.find((frame) => frame.method === "chat.send");
    expect(chatSendFrame).toMatchObject({
      method: "chat.send",
      params: {
        sessionKey: "session-alpha",
        message: "hello",
        deliver: false,
        timeoutMs: 60_000,
        idempotencyKey: "run-alpha",
      },
    });

    socket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          sessionKey: "session-alpha",
          runId: "run-alpha",
          state: "final",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden" },
              { type: "text", text: "visible reply" },
            ],
          },
        },
      }),
    );

    await expect(turn).resolves.toMatchObject({
      runId: "run-alpha",
      text: "visible reply",
      events: [expect.objectContaining({ method: "chat" })],
    });
  });

  it("forwards chat.send agent progress events for the active run", async () => {
    const { sendChatViaGateway } = await import("@/lib/openclaw/gateway-ws-client");
    const onEvent = vi.fn();

    const turn = sendChatViaGateway("session-alpha", "hello", {
      timeoutMs: 60_000,
      idempotencyKey: "run-alpha",
      onEvent,
    });

    await waitUntil(() => {
      const socket = mockWebSockets.instances.at(-1);
      return Boolean(socket?.sentFrames.some((frame) => frame.method === "chat.send"));
    });

    const socket = mockWebSockets.instances.at(-1);
    expect(socket).toBeTruthy();

    socket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          sessionKey: "session-alpha",
          runId: "other-run",
          stream: "tool",
          data: { phase: "start", name: "read" },
        },
      }),
    );
    socket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          sessionKey: "session-alpha",
          runId: "run-alpha",
          stream: "tool",
          data: { phase: "start", name: "read", args: { path: "paper.md" } },
        },
      }),
    );
    socket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          sessionKey: "session-alpha",
          runId: "run-alpha",
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        },
      }),
    );

    await expect(turn).resolves.toMatchObject({ text: "done" });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "agent",
        payload: expect.objectContaining({
          runId: "run-alpha",
          stream: "tool",
        }),
      }),
    );
    expect(onEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: "chat" }),
    );
  });

  it("wraps chat.send failures after ACK as post-ACK errors", async () => {
    const {
      GatewayPostAckError,
      sendChatViaGateway,
    } = await import("@/lib/openclaw/gateway-ws-client");

    const turnResult = sendChatViaGateway("session-alpha", "hello", {
      timeoutMs: 60_000,
      idempotencyKey: "run-alpha",
    }).then(
      (value) => ({ status: "resolved" as const, value }),
      (error) => ({ status: "rejected" as const, error }),
    );

    await waitUntil(() => {
      const socket = mockWebSockets.instances.at(-1);
      return Boolean(socket?.sentFrames.some((frame) => frame.method === "chat.send"));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = mockWebSockets.instances.at(-1);
    socket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          sessionKey: "session-alpha",
          runId: "run-alpha",
          state: "error",
          errorMessage: "model failed",
        },
      }),
    );

    const outcome = await turnResult;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.error).toBeInstanceOf(GatewayPostAckError);
      expect(outcome.error).toMatchObject({
        message: expect.stringContaining("model failed"),
      });
    }
  });

  it("surfaces chat.send pre-ACK failures without post-ACK wrapping", async () => {
    const {
      GatewayPostAckError,
      sendChatViaGateway,
    } = await import("@/lib/openclaw/gateway-ws-client");
    mockWebSockets.failMethod("chat.send", { message: "gateway rejected send" });

    const turnResult = sendChatViaGateway("session-alpha", "hello", {
      timeoutMs: 60_000,
      idempotencyKey: "run-alpha",
    }).then(
      (value) => ({ status: "resolved" as const, value }),
      (error) => ({ status: "rejected" as const, error }),
    );

    await waitUntil(() => {
      const socket = mockWebSockets.instances.at(-1);
      return Boolean(socket?.sentFrames.some((frame) => frame.method === "chat.send"));
    });

    await expect(turnResult).resolves.toMatchObject({
      status: "rejected",
      error: expect.objectContaining({
        message: expect.stringContaining("gateway rejected send"),
      }),
    });
    const outcome = await turnResult;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.error).not.toBeInstanceOf(GatewayPostAckError);
    }
  });

  it("rejects a dropped turn before a reconnect can reuse stale listeners", async () => {
    const {
      GatewayPostAckError,
      sendMessageViaGateway,
    } = await import("@/lib/openclaw/gateway-ws-client");

    const firstTurnResult = sendMessageViaGateway("session-alpha", "first", {
      timeoutMs: 60_000,
    }).then(
      (value) => ({ status: "resolved" as const, value }),
      (error) => ({ status: "rejected" as const, error }),
    );

    await waitUntil(() => {
      const socket = mockWebSockets.instances.at(-1);
      return Boolean(socket?.sentFrames.some((frame) => frame.method === "sessions.send"));
    });

    const firstSocket = mockWebSockets.instances.at(-1);
    expect(firstSocket).toBeTruthy();

    firstSocket?.close();

    const secondTurn = sendMessageViaGateway("session-alpha", "second", {
      timeoutMs: 60_000,
    });
    await waitUntil(() => mockWebSockets.instances.length >= 2);
    await waitUntil(() => {
      const socket = mockWebSockets.instances.at(-1);
      return Boolean(socket?.sentFrames.some((frame) => frame.method === "sessions.send"));
    });

    const secondSocket = mockWebSockets.instances.at(-1);
    expect(secondSocket).toBeTruthy();
    expect(secondSocket).not.toBe(firstSocket);

    secondSocket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          key: "session-alpha",
          stream: "assistant",
          data: { text: "fresh reply" },
        },
      }),
    );
    secondSocket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          key: "session-alpha",
          stream: "lifecycle",
          data: { phase: "end" },
        },
      }),
    );

    await expect(secondTurn).resolves.toMatchObject({ text: "fresh reply" });
    await expect(firstTurnResult).resolves.toMatchObject({
      status: "rejected",
      error: expect.any(GatewayPostAckError),
    });
  });

  it("does not fan out untagged completion frames across concurrent turns", async () => {
    const { sendMessageViaGateway } = await import("@/lib/openclaw/gateway-ws-client");

    let firstStatus: "pending" | "resolved" | "rejected" = "pending";
    let secondStatus: "pending" | "resolved" | "rejected" = "pending";

    const firstTurn = sendMessageViaGateway("session-alpha", "first", {
      timeoutMs: 60_000,
    }).then(
      (value) => {
        firstStatus = "resolved";
        return value;
      },
      (error) => {
        firstStatus = "rejected";
        throw error;
      },
    );

    const secondTurn = sendMessageViaGateway("session-beta", "second", {
      timeoutMs: 60_000,
    }).then(
      (value) => {
        secondStatus = "resolved";
        return value;
      },
      (error) => {
        secondStatus = "rejected";
        throw error;
      },
    );

    await waitUntil(() => {
      const socket = mockWebSockets.instances.at(-1);
      const sendCount =
        socket?.sentFrames.filter((frame) => frame.method === "sessions.send").length ?? 0;
      return sendCount === 2;
    });

    const socket = mockWebSockets.instances.at(-1);
    expect(socket).toBeTruthy();

    socket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          stream: "lifecycle",
          data: { phase: "end" },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(firstStatus).toBe("pending");
    expect(secondStatus).toBe("pending");

    socket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          key: "session-alpha",
          stream: "assistant",
          data: { text: "alpha reply" },
        },
      }),
    );
    socket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          key: "session-alpha",
          stream: "lifecycle",
          data: { phase: "end" },
        },
      }),
    );
    socket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          key: "session-beta",
          stream: "assistant",
          data: { text: "beta reply" },
        },
      }),
    );
    socket?.emit(
      "message",
      JSON.stringify({
        type: "event",
        event: "agent",
        payload: {
          key: "session-beta",
          stream: "lifecycle",
          data: { phase: "end" },
        },
      }),
    );

    await expect(firstTurn).resolves.toMatchObject({ text: "alpha reply" });
    await expect(secondTurn).resolves.toMatchObject({ text: "beta reply" });
    expect(firstStatus).toBe("resolved");
    expect(secondStatus).toBe("resolved");
  });

  it("iterates over a snapshot so listener removal does not skip later listeners", async () => {
    const { __testOnly } = await import("@/lib/openclaw/gateway-ws-client");

    const listeners: Array<{
      sessionKey: string;
      handler: (frame: unknown) => void;
      reject: (err: Error) => void;
    }> = [];
    const secondHandler = vi.fn();
    const firstHandler = vi.fn(() => {
      listeners.splice(0, 1);
    });

    listeners.push(
      { sessionKey: "session-alpha", handler: firstHandler, reject: vi.fn() },
      { sessionKey: "session-alpha", handler: secondHandler, reject: vi.fn() },
    );

    __testOnly.dispatchGatewayFrame(
      {
        type: "event",
        method: "sessions.message",
        payload: { key: "session-alpha" },
      },
      listeners as never,
    );

    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });
});
