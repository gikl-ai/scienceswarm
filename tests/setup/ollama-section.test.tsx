// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { OllamaSection } from "@/components/setup/ollama-section";
import type { OllamaStatusSummary } from "@/lib/setup/config-status";

// Minimal raw-probe shape accepted by the component — mirrors both the
// `OllamaStatusSummary` returned by `/api/setup/status` and the
// `binaryInstalled`-flavored shape from `/api/settings?action=local-health`.
interface RawProbeFixture {
  installed?: boolean;
  binaryInstalled?: boolean;
  running?: boolean;
  hasRecommendedModel?: boolean;
  installCommand?: string | null;
  startCommand?: string | null;
  models?: string[];
}

interface FetchFixtures {
  settings?: { ollamaModel?: string };
  localHealth?: RawProbeFixture | (() => RawProbeFixture);
  installOllama?: { ok?: boolean; installing?: boolean; alreadyInstalled?: boolean; error?: string };
  pullModel?: { ok?: boolean; pulling?: boolean; alreadyPresent?: boolean; error?: string };
  pullStatus?:
    | { pulling?: boolean; error?: string | null }
    | (() => { pulling?: boolean; error?: string | null });
  startOllama?: { ok?: boolean; starting?: boolean; error?: string };
}

function stubFetch(fixtures: FetchFixtures) {
  const state = {
    settings: {
      ollamaModel: fixtures.settings?.ollamaModel ?? "gemma4",
    },
  };

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? "GET";
    if (url === "/api/settings" && method === "GET") {
      return Response.json(state.settings);
    }
    if (url !== "/api/settings" || method !== "POST") {
      throw new Error(`Unhandled fetch: ${method} ${url}`);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      action?: string;
      ollamaModel?: string;
    };
    if (body.action === "local-health") {
      const health =
        typeof fixtures.localHealth === "function"
          ? fixtures.localHealth()
          : fixtures.localHealth ?? {};
      return Response.json(health);
    }
    if (body.action === "install-ollama") {
      return Response.json(
        fixtures.installOllama ?? { ok: true, installing: true },
      );
    }
    if (body.action === "pull-model") {
      return Response.json(
        fixtures.pullModel ?? { ok: true, pulling: true },
      );
    }
    if (body.action === "pull-status") {
      const status =
        typeof fixtures.pullStatus === "function"
          ? fixtures.pullStatus()
          : fixtures.pullStatus ?? { pulling: false, error: null };
      return Response.json(status);
    }
    if (body.action === "start-ollama") {
      return Response.json(
        fixtures.startOllama ?? { ok: true, starting: true },
      );
    }
    if (body.action === "save-ollama-model") {
      state.settings.ollamaModel = body.ollamaModel ?? state.settings.ollamaModel;
      return Response.json({ ok: true, ollamaModel: state.settings.ollamaModel });
    }
    throw new Error(`Unhandled settings action: ${body.action}`);
  });
}

function summaryFrom(raw: RawProbeFixture): OllamaStatusSummary {
  return {
    installed: raw.installed ?? raw.binaryInstalled ?? false,
    running: raw.running ?? false,
    hasRecommendedModel: raw.hasRecommendedModel ?? false,
    models: raw.models,
    installCommand: raw.installCommand ?? undefined,
    startCommand: raw.startCommand ?? undefined,
  };
}

describe("OllamaSection", () => {
  beforeEach(() => {
    // Stub the clipboard so copy buttons don't blow up in jsdom.
    if (!("clipboard" in navigator)) {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn(async () => undefined) },
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the 'not installed' state with install command and ollama.com/download fallback", () => {
    vi.stubGlobal("fetch", stubFetch({}));
    const initial = summaryFrom({
      installed: false,
      installCommand: "'/opt/homebrew/bin/brew' install ollama",
    });

    render(<OllamaSection initialStatus={initial} />);

    const cmd = screen.getByTestId("ollama-install-command");
    expect(cmd.textContent).toContain("brew");
    expect(cmd.textContent).toContain("install ollama");

    const urlLink = screen.getByTestId("ollama-install-url") as HTMLAnchorElement;
    expect(urlLink.href).toContain("ollama.com/download");

    expect(screen.getByTestId("ollama-reprobe-installed")).toBeTruthy();
    expect(screen.getByTestId("ollama-install-button")).toBeTruthy();
    expect(screen.queryByTestId("ollama-ready")).toBeNull();
  });

  it("renders a one-click Install button in 'not installed' and POSTs install-ollama", async () => {
    const fetchMock = stubFetch({
      installOllama: { ok: true, installing: true },
      localHealth: { installed: false, running: false },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OllamaSection
        initialStatus={summaryFrom({
          installed: false,
          installCommand: "'/opt/homebrew/bin/brew' install ollama",
        })}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("ollama-install-button"));
    });

    const installCall = fetchMock.mock.calls.find((args) => {
      const init = args[1] as RequestInit | undefined;
      if (init?.method !== "POST") return false;
      const body = JSON.parse(String(init.body ?? "{}")) as { action?: string };
      return body.action === "install-ollama";
    });
    expect(installCall).toBeTruthy();
  });

  it("shows a spinner while the initial Ollama probe is still unknown", () => {
    vi.stubGlobal("fetch", stubFetch({}));

    render(<OllamaSection initialStatus={null} />);

    expect(screen.getByTestId("ollama-probe-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("ollama-unknown-hint")).toHaveTextContent(
      "Checking for a local Ollama install",
    );
  });

  it("renders a one-click Start button in 'installed, not running' and POSTs start-ollama", async () => {
    // Old UX required users to copy-paste a nohup command into a
    // terminal. New UX: a single Start button calls the existing
    // `start-ollama` settings action server-side and the component
    // polls local-health until the daemon is up.
    const fetchMock = stubFetch({
      startOllama: { ok: true, starting: true },
      localHealth: { installed: true, running: false },
    });
    vi.stubGlobal("fetch", fetchMock);

    const initial = summaryFrom({
      installed: true,
      running: false,
      startCommand: "'/opt/homebrew/bin/brew' services start ollama",
    });

    render(<OllamaSection initialStatus={initial} />);

    const startButton = screen.getByTestId("ollama-start-button");
    expect(startButton.textContent).toContain("Start Ollama");

    await act(async () => {
      fireEvent.click(startButton);
    });

    const startCall = fetchMock.mock.calls.find((args) => {
      const init = args[1] as RequestInit | undefined;
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
      return body.action === "start-ollama";
    });
    expect(startCall).toBeTruthy();
    // Copy-command path is gone from the happy path — the start
    // command should not be visible until an error surfaces it.
    expect(screen.queryByTestId("ollama-start-command")).toBeNull();
    expect(screen.queryByTestId("ollama-reprobe-running")).toBeNull();
    expect(screen.queryByTestId("ollama-install-command")).toBeNull();
  });

  it("shows a spinner while Start Ollama is in flight", async () => {
    const deferred: { resolve?: () => void } = {};
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "GET") {
        return Promise.resolve(Response.json({ ollamaModel: "gemma4" }));
      }
      if (url !== "/api/settings" || method !== "POST") {
        throw new Error(`Unhandled fetch: ${method} ${url}`);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
      if (body.action === "start-ollama") {
        return new Promise<Response>((resolve) => {
          deferred.resolve = () => resolve(Response.json({ ok: true, starting: true }));
        });
      }
      if (body.action === "local-health") {
        return Promise.resolve(Response.json({
          installed: true,
          running: false,
          hasRecommendedModel: false,
          models: [],
        }));
      }
      throw new Error(`Unhandled settings action: ${body.action}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OllamaSection
        initialStatus={summaryFrom({
          installed: true,
          running: false,
          hasRecommendedModel: false,
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("ollama-start-button"));

    expect(await screen.findByTestId("ollama-start-spinner")).toBeInTheDocument();

    deferred.resolve?.();
  });

  it("renders the Pull button when running but the recommended model is missing, and POSTs pull-model on click", async () => {
    const fetchMock = stubFetch({
      pullModel: { ok: true, pulling: true },
      // Keep the first pull-status poll reporting pulling so the button
      // stays busy — we only assert that the POST happened and the
      // pulling UI is visible.
      pullStatus: { pulling: true, error: null },
    });
    vi.stubGlobal("fetch", fetchMock);

    const initial = summaryFrom({
      installed: true,
      running: true,
      hasRecommendedModel: false,
    });

    render(<OllamaSection initialStatus={initial} />);

    const pullButton = screen.getByTestId("ollama-pull-button");
    expect(pullButton.textContent).toContain("Pull gemma4");

    await act(async () => {
      fireEvent.click(pullButton);
    });

    // The POST to pull-model was issued with the right model.
    const pullCall = fetchMock.mock.calls.find((args) => {
      const init = args[1] as RequestInit | undefined;
      if (init?.method !== "POST") return false;
      const body = JSON.parse(String(init.body ?? "{}")) as {
        action?: string;
      };
      return body.action === "pull-model";
    });
    expect(pullCall).toBeDefined();
    const parsed = JSON.parse(
      String((pullCall![1] as RequestInit).body),
    ) as { ollamaModel?: string };
    expect(parsed.ollamaModel).toBe("gemma4");

    // Pulling UI is live.
    expect(screen.getByTestId("ollama-pull-progress")).toBeTruthy();
  });

  it("renders the green-check ready state when the recommended model is present", () => {
    vi.stubGlobal("fetch", stubFetch({}));
    const initial = summaryFrom({
      installed: true,
      running: true,
      hasRecommendedModel: true,
    });

    render(<OllamaSection initialStatus={initial} />);

    const ready = screen.getByTestId("ollama-ready");
    expect(ready.textContent).toContain("gemma4 ready");
    expect(screen.queryByTestId("ollama-pull-button")).toBeNull();
    expect(screen.queryByTestId("ollama-install-command")).toBeNull();
  });

  it("fires onModelSelected exactly once when the model transitions to ready", async () => {
    vi.stubGlobal("fetch", stubFetch({}));
    const onModelSelected = vi.fn();
    const initial = summaryFrom({
      installed: true,
      running: true,
      hasRecommendedModel: true,
    });

    const { rerender } = render(
      <OllamaSection
        initialStatus={initial}
        onModelSelected={onModelSelected}
      />,
    );

    // A re-render while already-ready must not trigger a duplicate fire.
    rerender(
      <OllamaSection
        initialStatus={initial}
        onModelSelected={onModelSelected}
      />,
    );

    await vi.waitFor(() => {
      expect(onModelSelected).toHaveBeenCalledTimes(1);
    });
    expect(onModelSelected).toHaveBeenCalledWith("gemma4");
  });

  it("re-seeds the local probe when parent passes an updated initialStatus (pre-interaction)", () => {
    // The /setup page fetches status async and re-renders this
    // section once the probe resolves. Without the hydration effect,
    // the component stayed on whatever initial snapshot it saw on
    // mount (often null), even after the parent provided a fresh
    // status. Re-render with a concrete status and assert the
    // derived UI now reflects it.
    vi.stubGlobal("fetch", stubFetch({}));

    const { rerender, container } = render(
      <OllamaSection initialStatus={null} />,
    );
    // Initial render with null prop lands on the "unknown" state.
    expect(
      (container.querySelector("[data-testid=\"ollama-section\"]") as HTMLElement)
        .dataset.state,
    ).toBe("unknown");

    const updated = summaryFrom({
      installed: true,
      running: true,
      hasRecommendedModel: false,
    });
    rerender(<OllamaSection initialStatus={updated} />);

    // After the parent-provided update, the component reflects the
    // running-missing-model state and shows the pull CTA.
    expect(
      (container.querySelector("[data-testid=\"ollama-section\"]") as HTMLElement)
        .dataset.state,
    ).toBe("running-missing-model");
    expect(screen.getByTestId("ollama-pull-button")).toBeTruthy();
  });

  it("advances through states as polling returns updated probe data", async () => {
    // First probe (from initialStatus): not installed.
    // Polled probes: installed-not-running → running-missing-model.
    // We drive the poll loop by triggering the reprobe button, which
    // issues an immediate fetch and then schedules follow-ups.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const probeScript: RawProbeFixture[] = [
      {
        binaryInstalled: true,
        running: false,
        hasRecommendedModel: false,
        startCommand: "systemctl --user start ollama",
      },
      {
        binaryInstalled: true,
        running: true,
        hasRecommendedModel: false,
      },
    ];
    let probeCursor = 0;
    const fetchMock = stubFetch({
      localHealth: () =>
        probeScript[Math.min(probeCursor++, probeScript.length - 1)],
    });
    vi.stubGlobal("fetch", fetchMock);

    const initial = summaryFrom({ installed: false });
    render(<OllamaSection initialStatus={initial} />);

    // Start in the not-installed view.
    expect(screen.getByTestId("ollama-not-installed")).toBeTruthy();

    // Click "I've installed it" — one probe now, then polled probes.
    await act(async () => {
      fireEvent.click(screen.getByTestId("ollama-reprobe-installed"));
    });

    // The immediate reprobe transitions us to installed-not-running.
    await vi.waitFor(() => {
      expect(
        screen.queryByTestId("ollama-installed-not-running"),
      ).not.toBeNull();
    });

    // Advance timers so the follow-up poll fires; next probe returns
    // `running: true`, which should surface the pull UI.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });

    await vi.waitFor(() => {
      expect(
        screen.queryByTestId("ollama-running-missing-model"),
      ).not.toBeNull();
    });
  });

  it("persists a gemma4:26b selection and pulls that exact model", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const localHealth = {
      installed: true,
      running: true,
      hasRecommendedModel: true,
      models: ["gemma4:latest"],
    };
    const fetchMock = stubFetch({
      settings: { ollamaModel: "gemma4" },
      pullModel: { ok: true, pulling: true },
      pullStatus: { pulling: false, error: null },
      localHealth,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OllamaSection
        initialStatus={summaryFrom({
          installed: true,
          running: true,
          hasRecommendedModel: true,
          models: ["gemma4:latest"],
        })}
      />,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("ollama-ready").textContent).toContain("gemma4:latest ready");
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("ollama-model-select"), {
        target: { value: "gemma4:26b" },
      });
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId("ollama-configured-model")).toHaveTextContent("gemma4:26b");
      expect(screen.getByTestId("ollama-pull-button")).toHaveTextContent("Pull gemma4:26b");
    });

    const saveCall = fetchMock.mock.calls.find((args) => {
      const init = args[1] as RequestInit | undefined;
      if (init?.method !== "POST") return false;
      const body = JSON.parse(String(init.body ?? "{}")) as { action?: string };
      return body.action === "save-ollama-model";
    });
    expect(saveCall).toBeDefined();
    expect(JSON.parse(String((saveCall![1] as RequestInit).body))).toMatchObject({
      ollamaModel: "gemma4:26b",
    });

    localHealth.models = ["gemma4:latest", "gemma4:26b"];

    await act(async () => {
      fireEvent.click(screen.getByTestId("ollama-pull-button"));
      await vi.advanceTimersByTimeAsync(2_500);
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId("ollama-ready")).toHaveTextContent("gemma4:26b ready");
    });

    const pullCall = fetchMock.mock.calls.find((args) => {
      const init = args[1] as RequestInit | undefined;
      if (init?.method !== "POST") return false;
      const body = JSON.parse(String(init.body ?? "{}")) as { action?: string };
      return body.action === "pull-model";
    });
    expect(pullCall).toBeDefined();
    expect(JSON.parse(String((pullCall![1] as RequestInit).body))).toMatchObject({
      ollamaModel: "gemma4:26b",
    });
  });

  it("keeps a non-default configured model pending when the exact tag is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        settings: { ollamaModel: "qwen3:4b" },
        localHealth: {
          installed: true,
          running: true,
          hasRecommendedModel: true,
          models: [],
        },
      }),
    );

    const onModelSelected = vi.fn();
    render(
      <OllamaSection
        initialStatus={summaryFrom({
          installed: true,
          running: true,
          hasRecommendedModel: true,
        })}
        onModelSelected={onModelSelected}
      />,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId("ollama-configured-model")).toHaveTextContent(
        "qwen3:4b",
      );
    });

    expect(screen.getByTestId("ollama-pull-button")).toHaveTextContent("Pull qwen3:4b");
    expect(onModelSelected).not.toHaveBeenCalledWith("qwen3:4b");
    expect(onModelSelected).not.toHaveBeenCalledWith("gemma4");
  });

  it("hides the model picker in fixed-model mode and still shows Gemma as ready", () => {
    vi.stubGlobal("fetch", stubFetch({}));

    render(
      <OllamaSection
        initialStatus={summaryFrom({
          installed: true,
          running: true,
          hasRecommendedModel: true,
          models: ["gemma4:latest", "qwen3:4b"],
        })}
        fixedModel="gemma4"
      />,
    );

    expect(screen.getByTestId("ollama-ready")).toHaveTextContent(
      "gemma4:latest ready",
    );
    expect(screen.getByTestId("ollama-selected-model")).toHaveTextContent(
      "gemma4:latest",
    );
    expect(screen.getByText("Required local model")).toBeInTheDocument();
    expect(
      screen.queryByTestId("ollama-model-picker"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("ollama-model-select")).not.toBeInTheDocument();
  });

  it("waits for the saved configured model before auto-remediation pulls", async () => {
    const deferred: { resolve?: () => void } = {};
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/settings" && method === "GET") {
        return new Promise<Response>((resolve) => {
          deferred.resolve = () => resolve(Response.json({ ollamaModel: "gemma4:26b" }));
        });
      }

      if (url !== "/api/settings" || method !== "POST") {
        throw new Error(`Unhandled fetch: ${method} ${url}`);
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as {
        action?: string;
        ollamaModel?: string;
      };

      if (body.action === "local-health") {
        return Promise.resolve(Response.json({
          installed: true,
          running: true,
          hasRecommendedModel: false,
          models: [],
        }));
      }

      if (body.action === "pull-model") {
        return Promise.resolve(Response.json({ ok: true, pulling: true }));
      }

      if (body.action === "pull-status") {
        return Promise.resolve(Response.json({ pulling: true, error: null }));
      }

      throw new Error(`Unhandled settings action: ${body.action}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OllamaSection
        initialStatus={summaryFrom({
          installed: true,
          running: true,
          hasRecommendedModel: false,
          models: [],
        })}
        autoRemediate
      />,
    );

    expect(fetchMock.mock.calls.some((args) => {
      const init = args[1] as RequestInit | undefined;
      if (init?.method !== "POST") return false;
      const body = JSON.parse(String(init.body ?? "{}")) as { action?: string };
      return body.action === "pull-model";
    })).toBe(false);

    await act(async () => {
      deferred.resolve?.();
    });

    await vi.waitFor(() => {
      const pullCall = fetchMock.mock.calls.find((args) => {
        const init = args[1] as RequestInit | undefined;
        if (init?.method !== "POST") return false;
        const body = JSON.parse(String(init.body ?? "{}")) as { action?: string };
        return body.action === "pull-model";
      });
      expect(pullCall).toBeDefined();
      expect(JSON.parse(String((pullCall![1] as RequestInit).body))).toMatchObject({
        ollamaModel: "gemma4:26b",
      });
    });
  });
});
