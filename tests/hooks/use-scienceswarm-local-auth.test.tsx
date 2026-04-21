// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useScienceSwarmLocalAuth } from "@/hooks/use-scienceswarm-local-auth";

function ScienceSwarmLocalAuthProbe() {
  const { authDetail, beginSignIn, isLoaded, isSignedIn } =
    useScienceSwarmLocalAuth();

  return (
    <div>
      <button onClick={() => void beginSignIn()} type="button">
        Sign in
      </button>
      <output data-testid="loaded">{isLoaded ? "loaded" : "loading"}</output>
      <output data-testid="signed-in">
        {isSignedIn ? "signed-in" : "signed-out"}
      </output>
      <output data-testid="detail">{authDetail ?? ""}</output>
    </div>
  );
}

describe("useScienceSwarmLocalAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts sign-in even when a reused popup handle is cross-origin", async () => {
    const replace = vi.fn();
    const close = vi.fn();
    const popup = {
      close,
      closed: false,
      location: {
        replace,
      },
    } as unknown as Window;

    Object.defineProperty(popup, "document", {
      configurable: true,
      get() {
        throw new DOMException(
          "Blocked a frame with origin from accessing a cross-origin frame.",
          "SecurityError",
        );
      },
    });

    vi.spyOn(window, "open").mockReturnValue(popup);

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();

        if (url === "/api/scienceswarm-auth/status") {
          return new Response(
            JSON.stringify({
              detail: "",
              expiresAt: null,
              signedIn: false,
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            },
          );
        }

        if (url === "/api/scienceswarm-auth/start") {
          expect(init).toEqual({ method: "POST" });
          return new Response(
            JSON.stringify({
              authUrl:
                "https://scienceswarm.ai/sign-in?redirect_url=https%3A%2F%2Fscienceswarm.ai%2Fauth%2Flocal-bridge",
              state: "state-123",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            },
          );
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    render(<ScienceSwarmLocalAuthProbe />);

    await waitFor(() => {
      expect(screen.getByTestId("loaded").textContent).toBe("loaded");
    });

    expect(() => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    }).not.toThrow();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/scienceswarm-auth/start", {
        method: "POST",
      });
    });

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "https://scienceswarm.ai/sign-in?redirect_url=https%3A%2F%2Fscienceswarm.ai%2Fauth%2Flocal-bridge",
      );
    });

    expect(screen.getByTestId("detail").textContent).toBe("");
    expect(close).not.toHaveBeenCalled();
  });

  it("finalizes the local session from a hosted token message", async () => {
    const replace = vi.fn();
    const close = vi.fn();
    const popup = {
      close,
      closed: false,
      location: {
        replace,
      },
    } as unknown as Window;

    vi.spyOn(window, "open").mockReturnValue(popup);

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();

        if (url === "/api/scienceswarm-auth/status") {
          const signedIn = fetchMock.mock.calls.some(
            ([requestUrl]) => requestUrl === "/api/scienceswarm-auth/session",
          );

          return new Response(
            JSON.stringify({
              detail: signedIn ? "Connected" : "",
              expiresAt: signedIn ? "2026-04-20T00:00:00.000Z" : null,
              signedIn,
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            },
          );
        }

        if (url === "/api/scienceswarm-auth/start") {
          return new Response(
            JSON.stringify({
              authUrl:
                "https://scienceswarm.ai/sign-in?redirect_url=https%3A%2F%2Fscienceswarm.ai%2Fauth%2Flocal-bridge",
              state: "state-123",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            },
          );
        }

        if (url === "/api/scienceswarm-auth/session") {
          expect(init).toEqual({
            body: JSON.stringify({
              state: "state-123",
              token: "jwt-token",
            }),
            headers: {
              "Content-Type": "application/json",
            },
            method: "POST",
          });

          return new Response(
            JSON.stringify({
              expiresAt: "2026-04-20T00:00:00.000Z",
              signedIn: true,
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            },
          );
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    render(<ScienceSwarmLocalAuthProbe />);

    await waitFor(() => {
      expect(screen.getByTestId("loaded").textContent).toBe("loaded");
      expect(screen.getByTestId("signed-in").textContent).toBe("signed-out");
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            state: "state-123",
            token: "jwt-token",
            type: "scienceswarm.local-auth.success",
          },
          origin: "https://scienceswarm.ai",
        }),
      );
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/scienceswarm-auth/session", {
        body: JSON.stringify({
          state: "state-123",
          token: "jwt-token",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("signed-in").textContent).toBe("signed-in");
    });

    expect(screen.getByTestId("detail").textContent).toBe("");
    expect(close).toHaveBeenCalled();
  });
});
