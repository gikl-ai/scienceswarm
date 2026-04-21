// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { RadarOnboardingCard } from "@/components/radar/radar-onboarding-card";

const INFERRED_TOPICS = [
  { name: "CRISPR delivery", description: "Gene editing delivery mechanisms", weight: 0.9, origin: "inferred" as const },
  { name: "protein folding", description: "Protein structure prediction", weight: 0.85, origin: "inferred" as const },
  { name: "lab automation", description: "Robotic lab workflows", weight: 0.7, origin: "inferred" as const },
];

function stubFetch(options: {
  radarExists?: boolean;
  topics?: typeof INFERRED_TOPICS;
  activateError?: string;
} = {}) {
  const { radarExists = false, topics = INFERRED_TOPICS, activateError } = options;

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";

    if (url === "/api/radar" && method === "GET") {
      if (radarExists) {
        return Response.json({
          id: "radar-1",
          topics: [],
          sources: [],
          schedule: { cron: "0 6 * * *", timezone: "America/Los_Angeles", fetchLeadMinutes: 120 },
          channels: { dashboard: true, telegram: false, email: false },
          filters: [],
          createdAt: "2026-04-11T00:00:00Z",
          updatedAt: "2026-04-11T00:00:00Z",
        });
      }
      return Response.json({ error: "No radar configured" }, { status: 404 });
    }

    if (url === "/api/radar/infer-topics" && method === "GET") {
      return Response.json({ topics });
    }

    if (url === "/api/radar" && method === "POST") {
      if (activateError) {
        return Response.json({ error: activateError }, { status: 500 });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        id: "radar-new",
        topics: body.topics ?? [],
        sources: [],
        schedule: { cron: "0 6 * * *", timezone: "America/Los_Angeles", fetchLeadMinutes: 120 },
        channels: body.channels ?? { dashboard: true, telegram: false, email: false },
        filters: [],
        createdAt: "2026-04-11T00:00:00Z",
        updatedAt: "2026-04-11T00:00:00Z",
      }, { status: 201 });
    }

    throw new Error(`Unhandled fetch: ${method} ${url}`);
  });
}

describe("RadarOnboardingCard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", stubFetch());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders null when a radar already exists", async () => {
    vi.stubGlobal("fetch", stubFetch({ radarExists: true }));

    const { container } = render(<RadarOnboardingCard />);

    await waitFor(() => {
      expect(container.innerHTML).toBe("");
    });
  });

  it("shows inferred topics as pre-checked checkboxes", async () => {
    render(<RadarOnboardingCard />);

    for (const topic of INFERRED_TOPICS) {
      const checkbox = await screen.findByRole("checkbox", { name: topic.name });
      expect(checkbox).toBeChecked();
    }
  });

  it("shows eyebrow, heading, and body text in setup state", async () => {
    render(<RadarOnboardingCard />);

    expect(await screen.findByText("RESEARCH RADAR")).toBeInTheDocument();
    expect(screen.getByText("Your daily research briefing")).toBeInTheDocument();
    expect(
      screen.getByText(/Based on your brain, here.s what we.ll watch for you each morning/),
    ).toBeInTheDocument();
  });

  it("allows unchecking a topic", async () => {
    render(<RadarOnboardingCard />);

    const checkbox = await screen.findByRole("checkbox", { name: "CRISPR delivery" });
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it("adds a custom topic via the text input on Enter", async () => {
    render(<RadarOnboardingCard />);

    await screen.findByRole("checkbox", { name: "CRISPR delivery" });

    const input = screen.getByPlaceholderText("e.g. protein folding, CRISPR delivery");
    fireEvent.change(input, { target: { value: "scaling laws" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    const newCheckbox = await screen.findByRole("checkbox", { name: "scaling laws" });
    expect(newCheckbox).toBeChecked();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not add empty or duplicate custom topics", async () => {
    render(<RadarOnboardingCard />);

    await screen.findByRole("checkbox", { name: "CRISPR delivery" });

    const input = screen.getByPlaceholderText("e.g. protein folding, CRISPR delivery");

    // Empty input — total checkboxes = 3 topics + 1 telegram toggle
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(screen.getAllByRole("checkbox").length).toBe(INFERRED_TOPICS.length + 1);

    // Duplicate
    fireEvent.change(input, { target: { value: "CRISPR delivery" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(screen.getAllByRole("checkbox", { name: "CRISPR delivery" }).length).toBe(1);
  });

  it("shows telegram toggle off by default", async () => {
    render(<RadarOnboardingCard />);

    await screen.findByRole("checkbox", { name: "CRISPR delivery" });

    const telegramToggle = screen.getByRole("checkbox", { name: /telegram/i });
    expect(telegramToggle).not.toBeChecked();
  });

  it("transitions to confirmation state after clicking Start my radar", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<RadarOnboardingCard />);

    await screen.findByRole("checkbox", { name: "CRISPR delivery" });

    fireEvent.click(screen.getByRole("button", { name: "Start my radar" }));

    expect(
      await screen.findByText(/Radar active/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your first briefing arrives tomorrow at 6 AM/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Customize schedule, sources, or topics/ }),
    ).toHaveAttribute("href", "/dashboard/settings");

    // Verify POST was called with topics and channels
    const postCall = fetchMock.mock.calls.find(
      (call) =>
        call[0] === "/api/radar" &&
        (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const postBody = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(postBody.topics.length).toBe(INFERRED_TOPICS.length);
    expect(postBody.channels.dashboard).toBe(true);
    expect(postBody.channels.telegram).toBe(false);
  });

  it("sends telegram: true when the toggle is enabled before activation", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<RadarOnboardingCard />);

    await screen.findByRole("checkbox", { name: "CRISPR delivery" });

    fireEvent.click(screen.getByRole("checkbox", { name: /telegram/i }));
    fireEvent.click(screen.getByRole("button", { name: "Start my radar" }));

    await screen.findByText(/Radar active/);

    const postCall = fetchMock.mock.calls.find(
      (call) =>
        call[0] === "/api/radar" &&
        (call[1] as RequestInit | undefined)?.method === "POST",
    );
    const postBody = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(postBody.channels.telegram).toBe(true);
  });

  it("shows error message when activation fails", async () => {
    vi.stubGlobal("fetch", stubFetch({ activateError: "Brain store unavailable" }));

    render(<RadarOnboardingCard />);

    await screen.findByRole("checkbox", { name: "CRISPR delivery" });

    fireEvent.click(screen.getByRole("button", { name: "Start my radar" }));

    expect(await screen.findByText("Brain store unavailable")).toBeInTheDocument();
    // Should still show setup state, not confirmation
    expect(screen.getByRole("button", { name: "Start my radar" })).toBeInTheDocument();
  });

  it("dismisses the card when Maybe later is clicked", async () => {
    const onDismiss = vi.fn();
    render(<RadarOnboardingCard onDismiss={onDismiss} />);

    await screen.findByRole("checkbox", { name: "CRISPR delivery" });

    fireEvent.click(screen.getByRole("button", { name: "Maybe later" }));

    expect(onDismiss).toHaveBeenCalled();
  });

  it("handles empty inferred topics gracefully", async () => {
    vi.stubGlobal("fetch", stubFetch({ topics: [] }));

    render(<RadarOnboardingCard />);

    expect(await screen.findByText("Your daily research briefing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start my radar" })).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox").length).toBe(1); // Only the telegram toggle
  });

  it("only sends checked topics on activation", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<RadarOnboardingCard />);

    // Uncheck the first topic
    const checkbox = await screen.findByRole("checkbox", { name: "CRISPR delivery" });
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByRole("button", { name: "Start my radar" }));

    await screen.findByText(/Radar active/);

    const postCall = fetchMock.mock.calls.find(
      (call) =>
        call[0] === "/api/radar" &&
        (call[1] as RequestInit | undefined)?.method === "POST",
    );
    const postBody = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(postBody.topics.length).toBe(2);
    expect(postBody.topics.find((t: { name: string }) => t.name === "CRISPR delivery")).toBeUndefined();
  });

  it("limits displayed topics to 5", async () => {
    const manyTopics = Array.from({ length: 8 }, (_, i) => ({
      name: `topic-${i}`,
      description: `Description ${i}`,
      weight: 0.8,
      origin: "inferred" as const,
    }));

    vi.stubGlobal("fetch", stubFetch({ topics: manyTopics }));

    render(<RadarOnboardingCard />);

    await screen.findByRole("checkbox", { name: "topic-0" });

    // Should show max 5 topic checkboxes, plus 1 telegram toggle = 6 total
    const checkboxes = screen.getAllByRole("checkbox");
    // 5 topic checkboxes + 1 telegram toggle
    expect(checkboxes.length).toBe(6);
  });
});
