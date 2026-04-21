// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenClawSection,
  type OpenClawInitialStatus,
} from "@/components/setup/openclaw-section";

/**
 * Shape of the `/api/settings/openclaw` mock. Each test overrides the
 * fields it cares about — everything else falls back to a safe
 * "not installed" default so a test that only asserts on the
 * initial pill doesn't have to think about POST behaviour.
 */
interface Fixture {
  getStatus?: OpenClawInitialStatus | (() => OpenClawInitialStatus);
  postResponse?:
    | { status: number; body: Record<string, unknown> }
    | ((action: string) => {
        status: number;
        body: Record<string, unknown>;
      });
}

function stubFetch(fixture: Fixture) {
  const { getStatus, postResponse } = fixture;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? "GET";

    if (url === "/api/settings/openclaw" && method === "GET") {
      const current: OpenClawInitialStatus =
        typeof getStatus === "function"
          ? getStatus()
          : getStatus ?? {
              installed: false,
              configured: false,
              running: false,
            };
      return Response.json(current);
    }

    if (url === "/api/settings/openclaw" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        action?: string;
      };
      const resolved =
        typeof postResponse === "function"
          ? postResponse(body.action ?? "")
          : postResponse ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(resolved.body), {
        status: resolved.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unhandled fetch: ${method} ${url}`);
  });
}

describe("OpenClawSection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders 'Not installed' pill when initialStatus.installed is false", () => {
    vi.stubGlobal("fetch", stubFetch({}));
    render(
      <OpenClawSection
        initialStatus={{ installed: false, configured: false, running: false }}
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    const pill = screen.getByTestId("openclaw-status-pill");
    expect(pill).toHaveTextContent("Not installed");
    expect(pill.getAttribute("data-tone")).toBe("neutral");
    expect(
      screen.getByRole("radio", { name: /OpenClaw \(recommended\)/i }),
    ).toBeChecked();
    expect(screen.queryByRole("radio", { name: /Skip/i })).not.toBeInTheDocument();
  });

  it("shows a checking spinner while the initial OpenClaw status is still loading", () => {
    vi.stubGlobal("fetch", stubFetch({}));
    render(
      <OpenClawSection
        initialStatus={null}
        initialStatusLoading
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    const pill = screen.getByTestId("openclaw-status-pill");
    expect(pill).toHaveTextContent("Checking");
    expect(screen.getByTestId("openclaw-status-spinner")).toBeInTheDocument();
  });

  it("normalizes legacy initialBackend='none' to OpenClaw for the parent state", async () => {
    vi.stubGlobal("fetch", stubFetch({}));
    const onBackendChange = vi.fn();

    render(
      <OpenClawSection
        initialStatus={null}
        initialBackend="none"
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
        onBackendChange={onBackendChange}
      />,
    );

    await waitFor(() => {
      expect(onBackendChange).toHaveBeenCalledWith("openclaw");
    });
  });

  it("defaults the radio to 'OpenClaw' when the initial status reports installed", () => {
    vi.stubGlobal("fetch", stubFetch({}));
    render(
      <OpenClawSection
        initialStatus={{ installed: true, configured: false, running: false }}
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    // Flow UI should be visible without any user interaction.
    expect(screen.getByTestId("openclaw-flow")).toBeInTheDocument();
    expect(screen.getByTestId("openclaw-status-pill")).toHaveTextContent(
      "Installed",
    );
  });

  it("clicking Install POSTs {action:'install'} and then refetches GET status", async () => {
    // Server state flips to installed on the first GET after the
    // POST lands. That lets the assertion confirm the component
    // actually refetched rather than trusting the POST echo.
    let installed = false;
    const fetchMock = stubFetch({
      getStatus: () => ({
        installed,
        configured: false,
        running: false,
      }),
      postResponse: (action) => {
        if (action === "install") installed = true;
        return { status: 200, body: { ok: true, step: action } };
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OpenClawSection
        initialStatus={{ installed: false, configured: false, running: false }}
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    fireEvent.click(screen.getByTestId("openclaw-install-button"));

    // The POST body must carry the exact action name the server
    // switches on — if this regresses the API returns a 400.
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          url === "/api/settings/openclaw" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(
        String((postCall?.[1] as RequestInit).body ?? "{}"),
      ) as { action?: string };
      expect(body.action).toBe("install");
    });

    // And the subsequent GET is what drives the pill update, so
    // seeing "Installed" proves the refetch happened.
    await waitFor(() => {
      expect(screen.getByTestId("openclaw-status-pill")).toHaveTextContent(
        "Installed",
      );
    });

    // Sanity check the GET count: at least one refetch after the POST.
    const getCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/settings/openclaw" &&
        ((init as RequestInit | undefined)?.method ?? "GET") === "GET",
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("disables Configure when hasSavedOpenAiKey is false and surfaces the tooltip", () => {
    vi.stubGlobal("fetch", stubFetch({}));
    render(
      <OpenClawSection
        initialStatus={{ installed: true, configured: false, running: false }}
        hasOpenAiKey={false}
        hasSavedOpenAiKey={false}
      />,
    );

    const button = screen.getByTestId(
      "openclaw-configure-button",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The tooltip copy is load-bearing for a11y since the button is
    // visibly disabled with no other affordance.
    expect(button.title).toBe("OpenAI key needed");
    // And a visible hint is rendered alongside for sighted users.
    expect(screen.getByTestId("openclaw-key-hint")).toBeInTheDocument();
  });

  it("keeps Configure enabled in local mode without any saved OpenAI key", () => {
    vi.stubGlobal("fetch", stubFetch({}));
    render(
      <OpenClawSection
        initialStatus={{ installed: true, configured: false, running: false }}
        hasOpenAiKey={false}
        hasSavedOpenAiKey={false}
        llmProvider="local"
      />,
    );

    const button = screen.getByTestId(
      "openclaw-configure-button",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("");
    expect(screen.queryByTestId("openclaw-key-hint")).not.toBeInTheDocument();
  });

  it("disables Configure with 'save first' hint when user has typed but not saved an OpenAI key", () => {
    // Regression guard: the server's Configure action reads
    // OPENAI_API_KEY from `.env` on disk, so a typed-but-unsaved key
    // must not enable the button — otherwise the user hits an opaque
    // 500. The hint must tell them to save first.
    vi.stubGlobal("fetch", stubFetch({}));
    render(
      <OpenClawSection
        initialStatus={{ installed: true, configured: false, running: false }}
        hasOpenAiKey={true}
        hasSavedOpenAiKey={false}
      />,
    );

    const button = screen.getByTestId(
      "openclaw-configure-button",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("OpenAI key needed — save first");

    const hint = screen.getByTestId("openclaw-key-hint");
    expect(hint.textContent).toContain("save first");
  });

  it("re-syncs the radio to a late-arriving initialBackend prop when the user hasn't acted", () => {
    // Cubic P2 (PR #208): `/api/setup/status` resolves async, so the
    // parent initially passes `initialBackend={agentBackend}` with the
    // default `"none"` — the probe only fills in `nanoclaw` after the
    // status GET completes. Setup no longer exposes a Skip path, so the
    // legacy `"none"` value must normalize to the required OpenClaw
    // default until the real backend arrives.
    vi.stubGlobal("fetch", stubFetch({}));
    const { rerender } = render(
      <OpenClawSection
        initialStatus={null}
        initialBackend="none"
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    expect(
      (
        screen.getByRole("radio", {
          name: /OpenClaw \(recommended\)/i,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    // Status resolves and the parent re-renders with the live on-disk
    // backend. The child must reflect this without needing a remount.
    rerender(
      <OpenClawSection
        initialStatus={null}
        initialBackend="nanoclaw"
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    expect(
      (screen.getByRole("radio", { name: /NanoClaw/i }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole("radio", {
          name: /OpenClaw \(recommended\)/i,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it("preserves the user's radio click across a subsequent initialBackend prop change", () => {
    // Companion to the re-sync test: once the user explicitly picks a
    // backend, a later `initialBackend` update (e.g. if the parent
    // refetches status) must NOT clobber their choice. This is the
    // `userActed` half of the derive-during-render pattern.
    vi.stubGlobal("fetch", stubFetch({}));
    const { rerender } = render(
      <OpenClawSection
        initialStatus={null}
        initialBackend="none"
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    // User clicks NanoClaw.
    fireEvent.click(screen.getByRole("radio", { name: /NanoClaw/i }));
    expect(
      (
        screen.getByRole("radio", {
          name: /NanoClaw/i,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    // Parent re-renders with a different initialBackend. User's pick
    // must win.
    rerender(
      <OpenClawSection
        initialStatus={null}
        initialBackend="openclaw"
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    expect(
      (
        screen.getByRole("radio", {
          name: /NanoClaw/i,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole("radio", {
          name: /OpenClaw \(recommended\)/i,
        }) as HTMLInputElement
      )
        .checked,
    ).toBe(false);
  });

  it("honours initialBackend='nanoclaw' regardless of the probe result", () => {
    // A returning user whose `.env` holds `AGENT_BACKEND=nanoclaw`
    // must land on the NanoClaw radio even if the OpenClaw CLI is
    // not installed locally. Without this seed the probe-only
    // fallback would silently flip them to "Skip".
    vi.stubGlobal("fetch", stubFetch({}));
    render(
      <OpenClawSection
        initialStatus={{ installed: false, configured: false, running: false }}
        initialBackend="nanoclaw"
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    const nanoclawRadio = screen.getByRole("radio", {
      name: /NanoClaw/i,
    }) as HTMLInputElement;
    expect(nanoclawRadio.checked).toBe(true);

    const openclawRadio = screen.getByRole("radio", {
      name: /OpenClaw \(recommended\)/i,
    }) as HTMLInputElement;
    expect(openclawRadio.checked).toBe(false);
  });

  it("shows truncated error + copy-command box when the action returns 500", async () => {
    // A deliberately-long error message so the truncation branch
    // fires. Anything above 300 chars should be cut with an ellipsis.
    const longError = "boom ".repeat(100);
    vi.stubGlobal(
      "fetch",
      stubFetch({
        postResponse: {
          status: 500,
          body: { error: longError },
        },
      }),
    );

    render(
      <OpenClawSection
        initialStatus={{ installed: false, configured: false, running: false }}
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    fireEvent.click(screen.getByTestId("openclaw-install-button"));

    // Error block appears only on failure.
    const errorNode = await screen.findByTestId("openclaw-error-message");
    expect(errorNode.textContent).toBeTruthy();
    // 300-char cap + 1 ellipsis character.
    expect(errorNode.textContent!.length).toBeLessThanOrEqual(301);
    expect(errorNode.textContent).toContain("boom");

    // The fallback `npm install -g openclaw` command is rendered
    // verbatim so the user can copy it straight into their terminal.
    const commandBox = screen.getByTestId("openclaw-install-command");
    expect(commandBox.textContent?.trim()).toBe("npm install -g openclaw");

    // Mandatory backend setup still offers a truthful fallback path.
    expect(
      screen.getByTestId("openclaw-switch-nanoclaw-button"),
    ).toBeInTheDocument();
  });

  it("can hide backend choice and the NanoClaw fallback for onboarding", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        postResponse: {
          status: 500,
          body: { error: "install failed" },
        },
      }),
    );

    render(
      <OpenClawSection
        initialStatus={{ installed: false, configured: false, running: false }}
        initialBackend="nanoclaw"
        hasOpenAiKey={false}
        hasSavedOpenAiKey={false}
        llmProvider="local"
        showBackendChoice={false}
        showNanoClawFallback={false}
      />,
    );

    expect(screen.getByTestId("openclaw-flow")).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: /OpenClaw \(recommended\)/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: /NanoClaw/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("openclaw-install-button"));

    expect(await screen.findByTestId("openclaw-error-message")).toBeInTheDocument();
    expect(
      screen.queryByTestId("openclaw-switch-nanoclaw-button"),
    ).not.toBeInTheDocument();
  });

  it("emits onBackendChange only for the two allowed backends", () => {
    vi.stubGlobal("fetch", stubFetch({}));
    const onBackendChange = vi.fn<(value: "openclaw" | "nanoclaw" | "none") => void>();

    render(
      <OpenClawSection
        initialStatus={{ installed: false, configured: false, running: false }}
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
        onBackendChange={onBackendChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /NanoClaw/i }));
    expect(onBackendChange).toHaveBeenCalledWith("nanoclaw");

    fireEvent.click(
      screen.getByRole("radio", { name: /OpenClaw \(recommended\)/i }),
    );
    expect(onBackendChange).toHaveBeenLastCalledWith("openclaw");
  });

  it("install success transitions the pill from 'Not installed' to 'Installed'", async () => {
    let installed = false;
    vi.stubGlobal(
      "fetch",
      stubFetch({
        getStatus: () => ({
          installed,
          configured: false,
          running: false,
        }),
        postResponse: (action) => {
          if (action === "install") installed = true;
          return { status: 200, body: { ok: true } };
        },
      }),
    );

    render(
      <OpenClawSection
        initialStatus={{ installed: false, configured: false, running: false }}
        hasOpenAiKey={true}
        hasSavedOpenAiKey={true}
      />,
    );

    // Before the click, we expect the neutral "Not installed" pill.
    expect(screen.getByTestId("openclaw-status-pill")).toHaveTextContent(
      "Not installed",
    );

    fireEvent.click(screen.getByTestId("openclaw-install-button"));

    await waitFor(() => {
      expect(screen.getByTestId("openclaw-status-pill")).toHaveTextContent(
        "Installed",
      );
    });

    // And the Install button is disabled once the CLI is present —
    // the user can't accidentally retrigger an npm install.
    expect(
      (screen.getByTestId("openclaw-install-button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows manual Start when auto-start finishes but OpenClaw is still stopped", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        getStatus: {
          installed: true,
          configured: true,
          running: false,
        },
        postResponse: (action) => {
          expect(action).toBe("start");
          return { status: 200, body: { ok: true, running: false } };
        },
      }),
    );

    render(
      <OpenClawSection
        initialStatus={{ installed: true, configured: true, running: false }}
        hasOpenAiKey={false}
        hasSavedOpenAiKey={false}
        llmProvider="local"
        showBackendChoice={false}
        showNanoClawFallback={false}
        autoStart
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("openclaw-error-message")).toHaveTextContent(
        "did not become reachable automatically",
      );
    });

    expect(screen.getByTestId("openclaw-start-button")).toBeInTheDocument();
    expect(screen.getByTestId("openclaw-start-button")).not.toBeDisabled();
    expect(screen.queryByTestId("openclaw-install-command")).not.toBeInTheDocument();
  });

  it("shows a spinner while Configure is in flight and a green ready indicator once running", async () => {
    const deferred: { resolve?: () => void } = {};
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/settings/openclaw" && method === "POST") {
        return new Promise<Response>((resolve) => {
          deferred.resolve = () => {
            resolve(Response.json({ ok: true }));
          };
        });
      }

      if (url === "/api/settings/openclaw" && method === "GET") {
        return Promise.resolve(Response.json({
          installed: true,
          configured: true,
          running: true,
        }));
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OpenClawSection
        initialStatus={{ installed: true, configured: false, running: false }}
        hasOpenAiKey={false}
        hasSavedOpenAiKey={false}
        llmProvider="local"
      />,
    );

    fireEvent.click(screen.getByTestId("openclaw-configure-button"));

    await waitFor(() => {
      expect(screen.getByTestId("openclaw-configure-spinner")).toBeInTheDocument();
      expect(screen.getByTestId("openclaw-status-spinner")).toBeInTheDocument();
    });

    deferred.resolve?.();

    await waitFor(() => {
      expect(screen.getByTestId("openclaw-status-pill")).toHaveTextContent("Running");
      expect(screen.getByTestId("openclaw-status-ready-indicator")).toBeInTheDocument();
    });
  });
});
