import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMClient } from "@/brain/llm";
import type { MorningBrief } from "@/brain/types";

const mocks = vi.hoisted(() => ({
  buildMorningBrief: vi.fn(),
  formatTelegramBrief: vi.fn(),
  enrichBriefingWithActions: vi.fn(),
  getBrainConfig: vi.fn(),
  getLLMClient: vi.fn(),
}));

vi.mock("@/brain/research-briefing", () => ({
  buildMorningBrief: mocks.buildMorningBrief,
  formatTelegramBrief: mocks.formatTelegramBrief,
}));

vi.mock("@/brain/briefing-actions", () => ({
  enrichBriefingWithActions: mocks.enrichBriefingWithActions,
}));

vi.mock("@/app/api/brain/_shared", () => ({
  getBrainConfig: mocks.getBrainConfig,
  getLLMClient: mocks.getLLMClient,
  isErrorResponse: (value: unknown) => value instanceof Response,
}));

const config = {
  root: "/brain",
  extractionModel: "test-extract",
  synthesisModel: "test-synth",
  rippleCap: 15,
  paperWatchBudget: 50,
  serendipityRate: 0.2,
};

const llm = { complete: vi.fn() };

function makeBrief(summary = "Brief ready"): MorningBrief {
  return {
    generatedAt: "2026-04-22T12:00:00.000Z",
    greeting: "Good morning.",
    topMatters: [
      {
        summary,
        whyItMatters: "It matters.",
        evidence: [],
        urgency: "awareness",
      },
    ],
    contradictions: [],
    frontier: [],
    staleThreads: [],
    openQuestions: [],
    nextMove: {
      recommendation: "Review the brief.",
      reasoning: "The route returned a full brief.",
      assumptions: [],
      missingEvidence: [],
    },
    stats: {
      brainPages: 1,
      newPagesYesterday: 0,
      capturesYesterday: 0,
      enrichmentsYesterday: 0,
    },
  };
}

async function importRoute() {
  vi.resetModules();
  return await import("@/app/api/brain/morning-brief/route");
}

describe("GET /api/brain/morning-brief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SCIENCESWARM_MORNING_BRIEF_TIMEOUT_MS;
    mocks.getBrainConfig.mockReturnValue(config);
    mocks.getLLMClient.mockReturnValue(llm);
    mocks.formatTelegramBrief.mockReturnValue("Morning Brief");
    mocks.enrichBriefingWithActions.mockImplementation((brief: MorningBrief) => ({
      text: brief.greeting,
      actions: [],
    }));
  });

  it("coalesces concurrent GET requests into one generation", async () => {
    let resolveBrief: (brief: MorningBrief) => void = () => undefined;
    mocks.buildMorningBrief.mockReturnValue(
      new Promise<MorningBrief>((resolve) => {
        resolveBrief = resolve;
      }),
    );

    const { GET } = await importRoute();
    const request = new Request("http://localhost/api/brain/morning-brief");
    const first = GET(request);
    const second = GET(request);

    await Promise.resolve();
    expect(mocks.buildMorningBrief).toHaveBeenCalledTimes(1);

    resolveBrief(makeBrief());
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.headers.get("X-ScienceSwarm-Brief-Status"))).toEqual([
      "generated",
      "generated",
    ]);
  });

  it("returns a bounded degraded brief when generation exceeds the route budget", async () => {
    process.env.SCIENCESWARM_MORNING_BRIEF_TIMEOUT_MS = "1";
    mocks.buildMorningBrief.mockReturnValue(new Promise<MorningBrief>(() => undefined));

    const { GET } = await importRoute();
    const startedAt = Date.now();
    const response = await GET(new Request("http://localhost/api/brain/morning-brief"));
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(response.headers.get("X-ScienceSwarm-Brief-Status")).toBe("degraded");
    expect(elapsedMs).toBeLessThan(500);
    const body = (await response.json()) as MorningBrief;
    expect(body.topMatters[0].summary).toContain("Full morning brief");
  });

  it("maps LLM setup failures to a structured 503 instead of throwing", async () => {
    mocks.getLLMClient.mockImplementation(() => {
      throw new Error("Missing OPENAI_API_KEY environment variable.");
    });

    const { GET } = await importRoute();
    const response = await GET(new Request("http://localhost/api/brain/morning-brief"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "llm_unavailable",
      error: "Morning brief generation requires a configured LLM provider.",
    });
    expect(mocks.buildMorningBrief).not.toHaveBeenCalled();
  });

  it.each([
    "Missing ANTHROPIC_API_KEY environment variable.",
    "Ollama chat failed (401): unauthorized model host.",
    "Gemini API key quota exceeded.",
    "OpenAI API rate limit exceeded.",
  ])("maps generation-time provider failure %s to a structured 503", async (message) => {
    mocks.buildMorningBrief.mockRejectedValue(new Error(message));

    const { GET } = await importRoute();
    const response = await GET(new Request("http://localhost/api/brain/morning-brief"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "llm_unavailable",
      error: "Morning brief generation requires a configured LLM provider.",
      cause: message,
    });
  });

  it.each([
    "Incorrect API key provided.",
    "Rate limit exceeded for current organization.",
    "Request failed with status 401 Unauthorized.",
  ])("maps generic llm.complete failure %s to a structured 503", async (message) => {
    mocks.buildMorningBrief.mockImplementation(
      async (_config: unknown, providerAwareLlm: LLMClient) => {
        await providerAwareLlm.complete({ system: "test", user: "test" });
        return makeBrief();
      },
    );
    llm.complete.mockRejectedValue(new Error(message));

    const { GET } = await importRoute();
    const response = await GET(new Request("http://localhost/api/brain/morning-brief"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "llm_unavailable",
      error: "Morning brief generation requires a configured LLM provider.",
      cause: message,
    });
  });

  it.each([
    "Paper repository returned 403 Forbidden for Anthropic Institute paper",
    "Google Gemini paper metadata fetch failed",
    "Semantic Scholar rate limit hit for Gemini benchmark corpus",
  ])("keeps research-domain failure %s as a generation error", async (message) => {
    mocks.buildMorningBrief.mockRejectedValue(new Error(message));

    const { GET } = await importRoute();
    const response = await GET(new Request("http://localhost/api/brain/morning-brief"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: message,
    });
  });
});
