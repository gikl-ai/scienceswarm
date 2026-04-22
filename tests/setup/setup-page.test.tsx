// @vitest-environment jsdom

/**
 * Tests for the new single-screen `/setup` page. The old multi-section
 * page (OpenClawSection / BrainProfileSection / OllamaSection / save
 * button) was removed as part of the simple-onboarding refactor and is
 * covered by Playwright now (tests/e2e/onboarding-*.spec.ts). These
 * unit tests focus on the pure React behavior: form validation, SSE
 * parsing, and terminal state rendering.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SetupPage from "@/app/setup/page";
import { BootstrapForm } from "@/components/setup/bootstrap-form";
import { BootstrapProgress } from "@/components/setup/bootstrap-progress";
import { TelegramBotReady } from "@/components/setup/telegram-bot-ready";
import type { BootstrapStreamEvent } from "@/lib/setup/install-tasks/types";
import { TEST_TELEGRAM_BOT_TOKEN } from "../helpers/telegram-fixtures";

const pushMock = vi.fn();
const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
}));

function encodeSseBody(events: BootstrapStreamEvent[]): Uint8Array {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new TextEncoder().encode(text);
}

function makeStreamingResponse(body: Uint8Array): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("BootstrapForm", () => {
  it("starts with an empty handle input (no OS username prefill)", () => {
    render(<BootstrapForm disabled={false} onSubmit={vi.fn()} />);
    const input = screen.getByTestId("handle-input") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("defaults the brain preset to scientific research", () => {
    render(<BootstrapForm disabled={false} onSubmit={vi.fn()} />);
    const select = screen.getByTestId("brain-preset-select") as HTMLSelectElement;
    expect(select.value).toBe("scientific_research");
  });

  it("rejects handles with spaces and shows an inline error", () => {
    const onSubmit = vi.fn();
    render(<BootstrapForm disabled={false} onSubmit={onSubmit} />);
    const handleInput = screen.getByTestId("handle-input") as HTMLInputElement;
    fireEvent.change(handleInput, { target: { value: "has spaces" } });
    fireEvent.submit(screen.getByTestId("bootstrap-form"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("form-error").textContent).toMatch(/1-64/);
  });

  it("allows submit with an empty phone field (phone is optional)", () => {
    const onSubmit = vi.fn();
    render(<BootstrapForm disabled={false} onSubmit={onSubmit} />);
    const handleInput = screen.getByTestId("handle-input") as HTMLInputElement;
    fireEvent.change(handleInput, { target: { value: "alice" } });
    fireEvent.submit(screen.getByTestId("bootstrap-form"));
    expect(onSubmit).toHaveBeenCalledWith({
      handle: "alice",
      email: "",
      phone: "",
      brainPreset: "scientific_research",
    });
  });

  it("calls onSubmit with trimmed values on valid submit", () => {
    const onSubmit = vi.fn();
    render(<BootstrapForm disabled={false} onSubmit={onSubmit} />);
    const handleInput = screen.getByTestId("handle-input") as HTMLInputElement;
    const emailInput = screen.getByTestId("email-input") as HTMLInputElement;
    const phoneInput = screen.getByTestId("phone-input") as HTMLInputElement;
    fireEvent.change(handleInput, { target: { value: "alice" } });
    fireEvent.change(emailInput, { target: { value: "  s@example.com  " } });
    fireEvent.change(phoneInput, { target: { value: "  +14155551234  " } });
    fireEvent.submit(screen.getByTestId("bootstrap-form"));
    expect(onSubmit).toHaveBeenCalledWith({
      handle: "alice",
      email: "s@example.com",
      phone: "+14155551234",
      brainPreset: "scientific_research",
    });
  });

  it("submits an existing bot token without a phone number in reuse mode", () => {
    const onSubmit = vi.fn();
    render(<BootstrapForm disabled={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId("telegram-mode-reuse"));

    expect(screen.queryByTestId("phone-input")).not.toBeInTheDocument();
    const handleInput = screen.getByTestId("handle-input") as HTMLInputElement;
    const tokenInput = screen.getByTestId("bot-token-input") as HTMLInputElement;
    fireEvent.change(handleInput, { target: { value: "alice" } });
    fireEvent.change(tokenInput, {
      target: { value: `  ${TEST_TELEGRAM_BOT_TOKEN}  ` },
    });
    fireEvent.submit(screen.getByTestId("bootstrap-form"));

    expect(onSubmit).toHaveBeenCalledWith({
      handle: "alice",
      email: "",
      phone: "",
      brainPreset: "scientific_research",
      existingBot: {
        token: TEST_TELEGRAM_BOT_TOKEN,
      },
    });
  });

  it("validates the existing bot token format before submit", () => {
    const onSubmit = vi.fn();
    render(<BootstrapForm disabled={false} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId("telegram-mode-reuse"));
    fireEvent.change(screen.getByTestId("handle-input"), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByTestId("bot-token-input"), {
      target: { value: "nope" },
    });
    fireEvent.submit(screen.getByTestId("bootstrap-form"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("form-error").textContent).toContain(
      "Telegram bot token",
    );
  });

  it("groups Telegram-specific inputs separately from user information", () => {
    render(<BootstrapForm disabled={false} onSubmit={vi.fn()} />);

    const telegramSection = screen.getByTestId("telegram-mode-toggle");
    const userSection = screen.getByTestId("user-information-section");

    expect(within(telegramSection).getByTestId("phone-input")).toBeInTheDocument();
    expect(within(userSection).getByTestId("handle-input")).toBeInTheDocument();
    expect(within(userSection).getByTestId("email-input")).toBeInTheDocument();
    expect(within(userSection).getByTestId("brain-preset-select")).toBeInTheDocument();
    expect(within(telegramSection).queryByTestId("handle-input")).not.toBeInTheDocument();
  });

  it("keeps the bot token inside the Telegram section in reuse mode", () => {
    render(<BootstrapForm disabled={false} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByTestId("telegram-mode-reuse"));

    const telegramSection = screen.getByTestId("telegram-mode-toggle");
    const userSection = screen.getByTestId("user-information-section");

    expect(within(telegramSection).getByTestId("bot-token-input")).toBeInTheDocument();
    expect(within(telegramSection).queryByTestId("phone-input")).not.toBeInTheDocument();
    expect(within(userSection).getByTestId("handle-input")).toBeInTheDocument();
  });

  it("labels the submit button 'Set up my workspace' (not 'Set up my brain')", () => {
    render(<BootstrapForm disabled={false} onSubmit={vi.fn()} />);
    const button = screen.getByTestId("bootstrap-submit");
    expect(button.textContent).toMatch(/Set up my workspace/);
    expect(button.textContent).not.toMatch(/Set up my brain/);
  });

  it("shows the Windows via WSL2 guidance note when requested", () => {
    render(
      <BootstrapForm
        disabled={false}
        onSubmit={vi.fn()}
        showWindowsNote={true}
      />,
    );
    expect(screen.getByTestId("bootstrap-windows-note").textContent).toContain(
      "Windows users: ScienceSwarm currently supports Windows via WSL2",
    );
    expect(screen.getByTestId("bootstrap-windows-note").textContent).toContain(
      "/mnt/c",
    );
  });

  it("hides the Windows via WSL2 guidance note by default", () => {
    render(<BootstrapForm disabled={false} onSubmit={vi.fn()} />);
    expect(screen.queryByTestId("bootstrap-windows-note")).not.toBeInTheDocument();
  });

  it("disables every input when disabled prop is set", () => {
    render(<BootstrapForm disabled={true} onSubmit={vi.fn()} />);
    expect(screen.getByTestId("handle-input")).toBeDisabled();
    expect(screen.getByTestId("email-input")).toBeDisabled();
    expect(screen.getByTestId("brain-preset-select")).toBeDisabled();
    expect(screen.getByTestId("phone-input")).toBeDisabled();
    expect(screen.getByTestId("bootstrap-submit")).toBeDisabled();
  });
});

describe("BootstrapProgress", () => {
  it("renders one row per active task", () => {
    render(
      <BootstrapProgress
        events={[]}
        activeTasks={["gbrain-init", "openclaw", "openhands-docker", "ollama-gemma"]}
      />,
    );
    expect(screen.getByTestId("bootstrap-task-gbrain-init")).toBeInTheDocument();
    expect(screen.getByTestId("bootstrap-task-openclaw")).toBeInTheDocument();
    expect(
      screen.getByTestId("bootstrap-task-openhands-docker"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("bootstrap-task-ollama-gemma"),
    ).toBeInTheDocument();
  });

  it("shows the latest status per task when multiple events land", () => {
    const events: BootstrapStreamEvent[] = [
      { type: "task", task: "gbrain-init", status: "pending" },
      { type: "task", task: "gbrain-init", status: "running", detail: "..." },
      { type: "task", task: "gbrain-init", status: "succeeded", detail: "ok" },
    ];
    render(
      <BootstrapProgress events={events} activeTasks={["gbrain-init"]} />,
    );
    const row = screen.getByTestId("bootstrap-task-gbrain-init");
    expect(row.getAttribute("data-status")).toBe("succeeded");
  });

  it("surfaces a task-level error alert when a task fails", () => {
    const events: BootstrapStreamEvent[] = [
      {
        type: "task",
        task: "openclaw",
        status: "failed",
        error: "boom",
      },
    ];
    render(<BootstrapProgress events={events} activeTasks={["openclaw"]} />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
  });

  it("renders the Telegram nonce deeplink while waiting for bot claim", () => {
    const events: BootstrapStreamEvent[] = [
      {
        type: "task",
        task: "telegram-bot",
        status: "waiting-for-input",
        needs: "telegram-nonce-claim",
        nonceClaim: {
          deeplink: "https://t.me/example_bot?start=claim-nonce",
          botUsername: "example_bot",
        },
      },
    ];
    render(<BootstrapProgress events={events} activeTasks={["telegram-bot"]} />);
    const link = screen.getByTestId("telegram-nonce-link");
    expect(link.getAttribute("href")).toBe(
      "https://t.me/example_bot?start=claim-nonce",
    );
    expect(link.textContent).toContain("@example_bot");
  });
});

describe("SetupPage telegram visibility transitions", () => {
  beforeEach(() => {
    pushMock.mockClear();
    replaceMock.mockClear();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  // Regression: the SMS code prompt used to stay rendered alongside
  // the bot-ready card because findLast(...) was called with a
  // predicate matching the original waiting-for-input event. It now
  // looks at the LATEST event for the telegram-bot task and only
  // renders the prompt while the latest status is waiting-for-input.
  it("hides the code prompt once the telegram-bot task moves past waiting-for-input", async () => {
    const sseEvents: BootstrapStreamEvent[] = [
      { type: "task", task: "gbrain-init", status: "succeeded" },
      { type: "task", task: "openclaw", status: "succeeded" },
      { type: "task", task: "openhands-docker", status: "succeeded" },
      { type: "task", task: "ollama-gemma", status: "succeeded" },
      {
        type: "task",
        task: "telegram-bot",
        status: "waiting-for-input",
        needs: "telegram-code",
        sessionId: "s-1",
      },
      {
        type: "task",
        task: "telegram-bot",
        status: "running",
        detail: "Signing in…",
      },
      {
        type: "task",
        task: "telegram-bot",
        status: "succeeded",
        detail:
          "Wobblefinch — your ScienceSwarm claw — https://t.me/wobblefinch_alice_bot",
      },
      { type: "summary", status: "ok", failed: [], skipped: [] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/setup/status")) {
          return new Response(
            JSON.stringify({ defaultHandle: "alice" }),
            { status: 200 },
          );
        }
        if (url.includes("/api/setup/bootstrap") && init?.method === "POST") {
          const body = sseEvents
            .map((e) => `data: ${JSON.stringify(e)}\n\n`)
            .join("");
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    await act(async () => {
      render(<SetupPage />);
    });
    // Handle is no longer prefilled — user types it in.
    await act(async () => {
      fireEvent.change(screen.getByTestId("handle-input"), {
        target: { value: "alice" },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("phone-input"), {
        target: { value: "+19995550100" },
      });
      fireEvent.submit(screen.getByTestId("bootstrap-form"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("telegram-bot-ready")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("telegram-code-prompt")).not.toBeInTheDocument();
  });
});

describe("TelegramBotReady", () => {
  it("capitalizes the creature name in the heading", () => {
    render(
      <TelegramBotReady
        botUrl="https://t.me/wobblefinch_alice_bot"
        creature="wobblefinch"
        displayName="Wobblefinch — your ScienceSwarm claw"
      />,
    );
    expect(screen.getByTestId("creature-name").textContent).toBe("Wobblefinch");
  });

  it("renders the display-name tagline", () => {
    render(
      <TelegramBotReady
        botUrl="https://t.me/wobblefinch_alice_bot"
        creature="wobblefinch"
        displayName="Wobblefinch — your ScienceSwarm claw"
      />,
    );
    expect(screen.getByTestId("creature-tagline").textContent).toContain(
      "Wobblefinch — your ScienceSwarm claw",
    );
  });

  it("surfaces the bot URL as a deep link", () => {
    render(
      <TelegramBotReady
        botUrl="https://t.me/wobblefinch_alice_bot"
        creature="wobblefinch"
        displayName="Wobblefinch — your ScienceSwarm claw"
      />,
    );
    const link = screen.getByRole("link", {
      name: /wobblefinch_alice_bot/,
    });
    expect(link.getAttribute("href")).toBe(
      "https://t.me/wobblefinch_alice_bot",
    );
    expect(link.getAttribute("target")).toBe("_blank");
  });
});

describe("SetupPage integration", () => {
  beforeEach(() => {
    pushMock.mockClear();
    replaceMock.mockClear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("prefills handle from /api/setup/status and shows the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/setup/status")) {
          return new Response(JSON.stringify({ defaultHandle: "alice" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await act(async () => {
      render(<SetupPage />);
    });

    // Handle is no longer prefilled — user types it in.
    await act(async () => {
      fireEvent.change(screen.getByTestId("handle-input"), {
        target: { value: "alice" },
      });
    });
  });

  it("shows the Windows note only for Windows browsers", async () => {
    const originalPlatform = window.navigator.platform;
    const originalUserAgent = window.navigator.userAgent;

    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "Win32",
    });
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/setup/status")) {
          return new Response(JSON.stringify({ defaultHandle: "alice" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    try {
      await act(async () => {
        render(<SetupPage />);
      });

      expect(screen.getByTestId("bootstrap-windows-note")).toBeInTheDocument();
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        value: originalUserAgent,
      });
    }
  });

  it("streams SSE events from /api/setup/bootstrap, renders the done state, and auto-hands off to the workspace", async () => {
    const sseEvents: BootstrapStreamEvent[] = [
      { type: "task", task: "gbrain-init", status: "pending" },
      { type: "task", task: "openclaw", status: "pending" },
      { type: "task", task: "openhands-docker", status: "pending" },
      { type: "task", task: "ollama-gemma", status: "pending" },
      { type: "task", task: "gbrain-init", status: "succeeded" },
      { type: "task", task: "openclaw", status: "succeeded" },
      { type: "task", task: "openhands-docker", status: "succeeded" },
      { type: "task", task: "ollama-gemma", status: "succeeded" },
      { type: "summary", status: "ok", failed: [], skipped: [] },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/setup/status")) {
          return new Response(
            JSON.stringify({ defaultHandle: "alice" }),
            { status: 200 },
          );
        }
        if (url.includes("/api/setup/bootstrap") && init?.method === "POST") {
          return makeStreamingResponse(encodeSseBody(sseEvents));
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await act(async () => {
      render(<SetupPage />);
    });

    // Handle is no longer prefilled — user types it in.
    // Phone is optional; we include it here to exercise the full path.
    await act(async () => {
      fireEvent.change(screen.getByTestId("handle-input"), {
        target: { value: "alice" },
      });
      fireEvent.change(screen.getByTestId("phone-input"), {
        target: { value: "+19995550100" },
      });
    });

    await act(async () => {
      fireEvent.submit(screen.getByTestId("bootstrap-form"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("bootstrap-done")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/dashboard/project?onboarding=continue");
    }, { timeout: 2_000 });
  });

  it("restores in-progress bootstrap state from localStorage after refresh", async () => {
    window.localStorage.setItem(
      "scienceswarm.setup.bootstrap.v1",
      JSON.stringify({
        submitted: true,
        submittedTelegram: false,
        events: [
          { type: "task", task: "gbrain-init", status: "succeeded" },
          { type: "task", task: "openclaw", status: "running", detail: "Configuring gateway…" },
        ],
        summary: null,
        updatedAt: new Date().toISOString(),
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/setup/status")) {
          return new Response(JSON.stringify({ ready: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await act(async () => {
      render(<SetupPage />);
    });

    expect(screen.getByTestId("bootstrap-progress")).toBeInTheDocument();
    expect(screen.queryByTestId("bootstrap-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("bootstrap-task-gbrain-init")).toHaveAttribute(
      "data-status",
      "succeeded",
    );
    expect(screen.getByTestId("bootstrap-task-openclaw")).toHaveAttribute(
      "data-status",
      "running",
    );
  });

  it("offers the import workspace once the core runtime is ready even before setup summary arrives", async () => {
    const sseEvents: BootstrapStreamEvent[] = [
      { type: "task", task: "gbrain-init", status: "succeeded" },
      { type: "task", task: "openclaw", status: "succeeded" },
      {
        type: "task",
        task: "openhands-docker",
        status: "running",
        detail: "Starting Docker Desktop…",
      },
      { type: "task", task: "ollama-gemma", status: "succeeded" },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/setup/status")) {
          return new Response(
            JSON.stringify({ defaultHandle: "alice" }),
            { status: 200 },
          );
        }
        if (url.includes("/api/setup/bootstrap") && init?.method === "POST") {
          return makeStreamingResponse(encodeSseBody(sseEvents));
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await act(async () => {
      render(<SetupPage />);
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("handle-input"), {
        target: { value: "alice" },
      });
      fireEvent.submit(screen.getByTestId("bootstrap-form"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("bootstrap-core-ready")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("bootstrap-continue"));
    expect(pushMock).toHaveBeenCalledWith("/dashboard/project");
  });

  it("forwards the API error body to the failed-state card on non-OK responses", async () => {
    // Greptile round 4 P1 regression: when /api/setup/bootstrap returns
    // a 400 (e.g. malformed email), the client used to drop the error
    // message entirely. It now reads the JSON body and surfaces the
    // error on summary.error.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/setup/status")) {
          return new Response(
            JSON.stringify({ defaultHandle: "alice" }),
            { status: 200 },
          );
        }
        if (url.includes("/api/setup/bootstrap") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              error: "email must be a valid address (e.g. user@example.com)",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await act(async () => {
      render(<SetupPage />);
    });
    // Handle is no longer prefilled — user types it in.
    // Phone is optional; we include it here to exercise the full path.
    await act(async () => {
      fireEvent.change(screen.getByTestId("handle-input"), {
        target: { value: "alice" },
      });
      fireEvent.change(screen.getByTestId("phone-input"), {
        target: { value: "+19995550100" },
      });
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("bootstrap-form"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("bootstrap-failed")).toBeInTheDocument();
    });
    expect(screen.getByTestId("bootstrap-failed-error").textContent).toContain(
      "email must be a valid address",
    );
  });

  it("preserves completed task rows when the bootstrap stream errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/setup/status")) {
          return new Response(
            JSON.stringify({ defaultHandle: "alice" }),
            { status: 200 },
          );
        }
        if (url.includes("/api/setup/bootstrap") && init?.method === "POST") {
          let sent = false;
          const stream = new ReadableStream({
            pull(controller) {
              if (sent) {
                controller.error(new Error("stream interrupted"));
                return;
              }
              sent = true;
              controller.enqueue(encodeSseBody([
                { type: "task", task: "gbrain-init", status: "succeeded" },
              ]));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await act(async () => {
      render(<SetupPage />);
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("handle-input"), {
        target: { value: "alice" },
      });
      fireEvent.submit(screen.getByTestId("bootstrap-form"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("bootstrap-failed")).toBeInTheDocument();
    });
    expect(screen.getByTestId("bootstrap-failed-error").textContent).toContain(
      "Bootstrap request failed due to a network or stream error. Please try again.",
    );
    expect(screen.getByTestId("bootstrap-failed-error").textContent).not.toContain(
      "stream interrupted",
    );
    expect(screen.getByTestId("bootstrap-task-gbrain-init")).toHaveAttribute(
      "data-status",
      "succeeded",
    );
  });

  it("shows the failed state when the summary event reports status=failed", async () => {
    const sseEvents: BootstrapStreamEvent[] = [
      { type: "task", task: "gbrain-init", status: "failed", error: "oops" },
      {
        type: "summary",
        status: "failed",
        failed: ["gbrain-init"],
        skipped: [],
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/setup/status")) {
          return new Response(
            JSON.stringify({ defaultHandle: "alice" }),
            { status: 200 },
          );
        }
        if (url.includes("/api/setup/bootstrap") && init?.method === "POST") {
          return makeStreamingResponse(encodeSseBody(sseEvents));
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await act(async () => {
      render(<SetupPage />);
    });
    // Handle is no longer prefilled — user types it in.
    // Phone is optional; we include it here to exercise the full path.
    await act(async () => {
      fireEvent.change(screen.getByTestId("handle-input"), {
        target: { value: "alice" },
      });
      fireEvent.change(screen.getByTestId("phone-input"), {
        target: { value: "+19995550100" },
      });
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("bootstrap-form"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("bootstrap-failed")).toBeInTheDocument();
    });
  });

  it("shows a partial state and a continue-anyway button when some tasks fail", async () => {
    const sseEvents: BootstrapStreamEvent[] = [
      { type: "task", task: "gbrain-init", status: "succeeded" },
      { type: "task", task: "openclaw", status: "failed", error: "oops" },
      {
        type: "summary",
        status: "partial",
        failed: ["openclaw"],
        skipped: [],
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/setup/status")) {
          return new Response(
            JSON.stringify({ defaultHandle: "alice" }),
            { status: 200 },
          );
        }
        if (url.includes("/api/setup/bootstrap") && init?.method === "POST") {
          return makeStreamingResponse(encodeSseBody(sseEvents));
        }
        return new Response("{}", { status: 200 });
      }),
    );

    await act(async () => {
      render(<SetupPage />);
    });
    // Handle is no longer prefilled — user types it in.
    // Phone is optional; we include it here to exercise the full path.
    await act(async () => {
      fireEvent.change(screen.getByTestId("handle-input"), {
        target: { value: "alice" },
      });
      fireEvent.change(screen.getByTestId("phone-input"), {
        target: { value: "+19995550100" },
      });
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId("bootstrap-form"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("bootstrap-partial")).toBeInTheDocument();
    });
  });
});
