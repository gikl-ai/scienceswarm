import { describe, expect, it, vi } from "vitest";
import { __testOnly } from "@/lib/openclaw/gateway-ws-client";

describe("gateway-ws-client dispatch", () => {
  it("ignores untagged frames instead of broadcasting them to all listeners", () => {
    const alphaHandler = vi.fn();
    const betaHandler = vi.fn();

    __testOnly.dispatchGatewayFrame(
      {
        type: "event",
        method: "sessions.turn.complete",
        payload: {},
      },
      [
        { sessionKey: "alpha", handler: alphaHandler },
        { sessionKey: "beta", handler: betaHandler },
      ],
    );

    expect(alphaHandler).not.toHaveBeenCalled();
    expect(betaHandler).not.toHaveBeenCalled();
  });

  it("iterates over a snapshot so listener removal does not skip later listeners", () => {
    const listeners: Array<{ sessionKey: string; handler: (frame: unknown) => void }> = [];
    const secondHandler = vi.fn();
    const firstHandler = vi.fn(() => {
      listeners.splice(0, 1);
    });

    listeners.push(
      { sessionKey: "alpha", handler: firstHandler },
      { sessionKey: "alpha", handler: secondHandler },
    );

    __testOnly.dispatchGatewayFrame(
      {
        type: "event",
        method: "session.message",
        payload: { key: "alpha" },
      },
      listeners,
    );

    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });
});
