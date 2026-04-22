import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as brainInitModule from "@/brain/init";
import { resetBrainStore } from "@/brain/store";
import * as brainStoreModule from "@/brain/store";
import * as brainSearchModule from "@/brain/search";
import { writeProjectManifest } from "@/lib/state/project-manifests";
import { hashContent } from "@/lib/workspace-manager";
import type { ProjectManifest } from "@/brain/types";
import type { ProjectWatchConfig } from "@/lib/watch/types";
import { resolvePgliteDatabasePath } from "@/lib/capture/materialize-memory";

let TEST_ROOT = "";

// ── Mocks ─────────────────────────────────────────────

// Mock loadBrainConfig to use our test root
const mockLoadBrainConfig = vi.fn();
vi.mock("@/brain/config", () => ({
  loadBrainConfig: () => mockLoadBrainConfig(),
  resolveBrainRoot: () => TEST_ROOT,
  brainExists: () => true,
}));

// Mock createLLMClient to avoid real API calls
vi.mock("@/brain/llm", () => ({
  createLLMClient: () => ({
    async complete() {
      return {
        content: [
          "---",
          "title: Test Page",
          "date: 2026-04-07",
          "type: note",
          "para: resources",
          "tags: [test]",
          "---",
          "",
          "# Test Page",
          "",
          "Test content.",
        ].join("\n"),
        cost: {
          inputTokens: 100,
          outputTokens: 50,
          estimatedUsd: 0.01,
          model: "test",
        },
      };
    },
  }),
}));

// ── Helpers ───────────────────────────────────────────

function makeTestConfig() {
  return {
    root: TEST_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function assignTestRoot(): string {
  TEST_ROOT = mkdtempSync(join(tmpdir(), "scienceswarm-brain-test-api-"));
  return TEST_ROOT;
}

async function setupBrain() {
  await resetBrainStore();
  assignTestRoot();
  vi.stubEnv("SCIENCESWARM_DIR", TEST_ROOT);
  // Decision 3A: capture writes thread getCurrentUserHandle() and
  // throw loudly if SCIENCESWARM_USER_HANDLE is unset. Stub it here so
  // every capture route test gets a sane default handle.
  vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
  brainInitModule.initBrain({ root: TEST_ROOT, name: "Test Researcher" });
  mockLoadBrainConfig.mockReturnValue(makeTestConfig());
}

async function teardownBrain() {
  await resetBrainStore();
  if (TEST_ROOT) {
    rmSync(TEST_ROOT, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
  TEST_ROOT = "";
  mockLoadBrainConfig.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
}

// Materialize-memory now writes through gbrain instead of disk. Tests
// that assert on the materialized body open the same PGLite database
// the production materializer uses — resolved via the shared
// `resolvePgliteDatabasePath` helper so the reader and writer can never
// drift apart (the `<brainRoot>/db` vs `<brainRoot>/brain.pglite` drift
// that flagged Track A's preflight fix).
async function readGbrainPageBody(slug: string): Promise<string | null> {
  const { createRuntimeEngine } = await import("@/brain/stores/gbrain-runtime.mjs");
  const databasePath = resolvePgliteDatabasePath(TEST_ROOT);
  interface ReaderEngine {
    connect(config: { engine: "pglite"; database_path?: string }): Promise<void>;
    initSchema(): Promise<void>;
    disconnect(): Promise<void>;
    getPage(slug: string): Promise<{ compiled_truth: string } | null>;
  }
  const engine = (await createRuntimeEngine({
    engine: "pglite",
    database_path: databasePath,
  })) as ReaderEngine;
  await engine.connect({ engine: "pglite", database_path: databasePath });
  await engine.initSchema();
  try {
    const page = await engine.getPage(slug);
    return page?.compiled_truth ?? null;
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

function pageSlugFromMaterializedPath(pseudoPath: string): string {
  const base = pseudoPath.split("/").pop() ?? "";
  return base.replace(/\.md$/, "");
}

function makeManifest(slug: string): ProjectManifest {
  return {
    version: 1,
    projectId: slug,
    slug,
    title: slug,
    privacy: "cloud-ok",
    status: "active",
    projectPagePath: `wiki/projects/${slug}.md`,
    sourceRefs: [],
    decisionPaths: [],
    taskPaths: [],
    artifactPaths: [],
    frontierPaths: [],
    activeThreads: [],
    dedupeKeys: [],
    updatedAt: "2026-04-08T00:00:00.000Z",
  };
}

// ── Tests ─────────────────────────────────────────────

// POST /api/brain/init tests removed — the HTTP route was deleted as
// part of the simple-onboarding cleanup; brain initialization now flows
// through `/api/setup/bootstrap` (see tests/setup/) and the `brain_init`
// MCP tool (see tests/brain/mcp-server.test.ts).
//
// POST /api/brain/ingest and POST /api/brain/observe tests removed —
// those routes were deleted in Phase B (PR #239). Capture now flows
// through brain_capture (gbrain `put_page` proxy) and /api/brain/capture.

describe("POST /api/brain/capture", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("returns 400 when content is missing", async () => {
    const { POST } = await import("@/app/api/brain/capture/route");

    const request = new Request("http://localhost/api/brain/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid channel", async () => {
    const { POST } = await import("@/app/api/brain/capture/route");

    const request = new Request("http://localhost/api/brain/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Capture this note",
        channel: "discord",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("channel");
    expect(data.error).toContain("openclaw");
  });

  it("accepts channel: openclaw", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const { POST } = await import("@/app/api/brain/capture/route");

    const request = new Request("http://localhost/api/brain/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "We decided to sequence the alpha cohort next.",
        userId: "openclaw-user-1",
        project: "alpha",
        channel: "openclaw",
      }),
    });

    const response = await POST(request);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.status).toBe("saved");
    expect(data.channel).toBe("openclaw");
    expect(data.project).toBe("alpha");
  });

  it("returns 400 for unsafe project slugs", async () => {
    const { POST } = await import("@/app/api/brain/capture/route");

    const request = new Request("http://localhost/api/brain/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Capture this note",
        project: "../escape",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("safe bare slug");
  });

  it("captures through the shared service path", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const { POST } = await import("@/app/api/brain/capture/route");

    const request = new Request("http://localhost/api/brain/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "We decided to sequence the alpha cohort next.",
        userId: "web-user-1",
        project: "alpha",
        channel: "web",
      }),
    });

    const response = await POST(request);
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.status).toBe("saved");
    expect(data.project).toBe("alpha");
    expect(data.materializedPath).toMatch(/^wiki\/decisions\//);
  });

  it("preserves materialized path context for compilation source slugs", async () => {
    const { sourceSlugFromMaterializedPath } = await import("@/lib/brain-capture-paths");

    expect(
      sourceSlugFromMaterializedPath(
        join(TEST_ROOT, "wiki", "notes", "2026-04-18-capture.md"),
        TEST_ROOT,
      ),
    ).toBe("wiki/notes/2026-04-18-capture");
    expect(sourceSlugFromMaterializedPath("wiki/decisions/alpha.md", TEST_ROOT)).toBe(
      "wiki/decisions/alpha",
    );
  });

  it("resolves a pending web capture after clarification", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    await writeProjectManifest(makeManifest("beta"), join(TEST_ROOT, "state"));

    const { POST: capturePost } = await import("@/app/api/brain/capture/route");
    const { POST: resolvePost } = await import("@/app/api/brain/capture/resolve/route");

    const captureResponse = await capturePost(
      new Request("http://localhost/api/brain/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "note: signal drift fixed by fresh batch",
          userId: "web-user-1",
          channel: "web",
          project: null,
        }),
      }),
    );

    const captureData = await captureResponse.json();
    expect(captureResponse.status).toBe(200);
    expect(captureData.status).toBe("needs-clarification");
    expect(captureData.project).toBeNull();

    const resolveResponse = await resolvePost(
      new Request("http://localhost/api/brain/capture/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          captureId: captureData.captureId,
          project: "alpha",
          rawPath: captureData.rawPath,
        }),
      }),
    );

    const resolveData = await resolveResponse.json();
    expect(resolveResponse.status).toBe(200);
    expect(resolveData.status).toBe("saved");
    expect(resolveData.project).toBe("alpha");
    expect(resolveData.requiresClarification).toBe(false);
    expect(resolveData.materializedPath).toMatch(/^wiki\/resources\//);
  });

  it("resolves a pending openclaw capture after clarification", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    await writeProjectManifest(makeManifest("beta"), join(TEST_ROOT, "state"));

    const { POST: capturePost } = await import("@/app/api/brain/capture/route");
    const { POST: resolvePost } = await import("@/app/api/brain/capture/resolve/route");

    const captureResponse = await capturePost(
      new Request("http://localhost/api/brain/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "routed from openclaw, project TBD",
          userId: "openclaw-user-1",
          channel: "openclaw",
          project: null,
        }),
      }),
    );

    const captureData = await captureResponse.json();
    expect(captureResponse.status).toBe(200);
    expect(captureData.status).toBe("needs-clarification");
    expect(captureData.channel).toBe("openclaw");
    expect(captureData.rawPath).toMatch(/^raw\/captures\/openclaw\//);

    const resolveResponse = await resolvePost(
      new Request("http://localhost/api/brain/capture/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          captureId: captureData.captureId,
          project: "alpha",
          rawPath: captureData.rawPath,
          channel: "openclaw",
        }),
      }),
    );

    const resolveData = await resolveResponse.json();
    expect(resolveResponse.status).toBe(200);
    expect(resolveData.status).toBe("saved");
    expect(resolveData.project).toBe("alpha");
    expect(resolveData.channel).toBe("openclaw");
    expect(resolveData.requiresClarification).toBe(false);
    expect(resolveData.materializedPath).toMatch(/^wiki\/resources\//);
  });

  it("resolve route rejects unknown channel values", async () => {
    const { POST: resolvePost } = await import("@/app/api/brain/capture/resolve/route");

    const response = await resolvePost(
      new Request("http://localhost/api/brain/capture/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          captureId: "cap_test",
          project: "alpha",
          channel: "discord",
        }),
      }),
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("channel");
    expect(data.error).toContain("openclaw");
  });

  it("ignores a tampered rawPath and resolves by captureId", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    await writeProjectManifest(makeManifest("beta"), join(TEST_ROOT, "state"));

    const { POST: capturePost } = await import("@/app/api/brain/capture/route");
    const { POST: resolvePost } = await import("@/app/api/brain/capture/resolve/route");

    const firstCapture = await capturePost(
      new Request("http://localhost/api/brain/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "First ambiguous web capture",
          userId: "web-user-1",
          channel: "web",
          project: null,
        }),
      }),
    );
    const secondCapture = await capturePost(
      new Request("http://localhost/api/brain/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Second ambiguous web capture",
          userId: "web-user-1",
          channel: "web",
          project: null,
        }),
      }),
    );

    const firstData = await firstCapture.json();
    const secondData = await secondCapture.json();

    const resolveResponse = await resolvePost(
      new Request("http://localhost/api/brain/capture/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          captureId: firstData.captureId,
          project: "alpha",
          rawPath: secondData.rawPath,
        }),
      }),
    );

    const resolveData = await resolveResponse.json();
    expect(resolveResponse.status).toBe(200);
    expect(resolveData.captureId).toBe(firstData.captureId);
    expect(resolveData.rawPath).toBe(firstData.rawPath);
    const slug = pageSlugFromMaterializedPath(resolveData.materializedPath as string);
    const body = await readGbrainPageBody(slug);
    expect(body).not.toBeNull();
    expect(body!).toContain("First ambiguous web capture");
  });
});

describe("GET/POST /api/brain/watch-config", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("returns 400 when project is missing", async () => {
    const { GET } = await import("@/app/api/brain/watch-config/route");

    const request = new Request("http://localhost/api/brain/watch-config");
    const response = await GET(request);

    expect(response.status).toBe(400);
  });

  it("returns a default watch config for existing projects without saved config", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const { GET } = await import("@/app/api/brain/watch-config/route");

    const request = new Request("http://localhost/api/brain/watch-config?project=alpha");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.project).toBe("alpha");
    expect(data.saved).toBe(false);
    expect(data.config).toEqual({
      version: 1,
      keywords: [],
      promotionThreshold: 5,
      stagingThreshold: 2,
      schedule: {
        enabled: false,
        cadence: "daily",
        time: "08:00",
        timezone: "local",
      },
      sources: [],
    });
  });

  it("saves and returns normalized watch config", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const { POST } = await import("@/app/api/brain/watch-config/route");

    const payload: ProjectWatchConfig = {
      version: 1,
      keywords: [" CRISPR ", "sequencing", "crispr"],
      promotionThreshold: 6,
      stagingThreshold: 2,
      sources: [
        {
          id: "feed-1",
          type: "rss",
          label: " Genome Web ",
          url: " https://example.com/feed.xml ",
          limit: 99,
        },
      ],
    };

    const request = new Request("http://localhost/api/brain/watch-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha",
        config: payload,
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.saved).toBe(true);
    expect(data.config.keywords).toEqual(["crispr", "sequencing"]);
    expect(data.config.sources[0]).toMatchObject({
      id: "feed-1",
      type: "rss",
      label: "Genome Web",
      url: "https://example.com/feed.xml",
      limit: 50,
    });
    expect(data.config.promotionThreshold).toBe(6);
    expect(data.config.stagingThreshold).toBe(2);
  });

  it("saves prompt-first web search watch config", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const { POST } = await import("@/app/api/brain/watch-config/route");

    const request = new Request("http://localhost/api/brain/watch-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha",
        config: {
          version: 1,
          objective: "Track daily AI news.",
          compiledPrompt: "Search for and compile today's most important AI news.",
          searchQueries: [" AI news today ", "OpenAI Anthropic news today"],
          keywords: [" AI ", "OpenAI"],
          promotionThreshold: 5,
          stagingThreshold: 2,
          sources: [
            {
              id: "web-1",
              type: "web_search",
              label: " Web ",
              query: " ",
              limit: 8,
            },
          ],
        } satisfies ProjectWatchConfig,
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.config.objective).toBe("Track daily AI news.");
    expect(data.config.executionMode).toBe("openclaw");
    expect(data.config.searchQueries).toEqual(["AI news today", "OpenAI Anthropic news today"]);
    expect(data.config.sources[0]).toMatchObject({
      id: "web-1",
      type: "web_search",
      label: "Web",
      query: "Search for and compile today's most important AI news.",
      limit: 8,
    });
  });

  it("schedules prompt-first watch configs at the selected minute", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const [{ POST }, { deleteJob, getJob }] = await Promise.all([
      import("@/app/api/brain/watch-config/route"),
      import("@/lib/scheduler"),
    ]);

    const request = new Request("http://localhost/api/brain/watch-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha",
        config: {
          version: 1,
          objective: "Track daily AI news.",
          compiledPrompt: "Search for and compile today's most important AI news.",
          searchQueries: ["AI news today"],
          keywords: ["AI"],
          promotionThreshold: 5,
          stagingThreshold: 2,
          schedule: {
            enabled: true,
            cadence: "daily",
            time: "08:30",
            timezone: "America/Los_Angeles",
          },
          sources: [
            {
              id: "web-1",
              type: "web_search",
              query: "Search for and compile today's most important AI news.",
            },
          ],
        } satisfies ProjectWatchConfig,
      }),
    });

    const response = await POST(request);
    const data = await response.json();
    const jobId = data.config.schedule.schedulerJobId;

    expect(response.status).toBe(200);
    expect(data.config.executionMode).toBe("openclaw");
    expect(getJob(jobId)?.schedule).toBe("30 8 * * *");
    expect(getJob(jobId)?.timezone).toBe("America/Los_Angeles");
    deleteJob(jobId);
  });

  it("saves multi-day weekly watch schedules into the canonical config and scheduler cron", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const [{ POST }, { deleteJob, getJob }] = await Promise.all([
      import("@/app/api/brain/watch-config/route"),
      import("@/lib/scheduler"),
    ]);

    const request = new Request("http://localhost/api/brain/watch-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha",
        config: {
          version: 1,
          objective: "Track frontier AI research twice a week.",
          compiledPrompt: "Use a research-first briefing with sections for Papers, Datasets, Methods, and Tools.",
          searchQueries: ["frontier ai research papers datasets methods tools"],
          keywords: ["frontier ai"],
          promotionThreshold: 5,
          stagingThreshold: 2,
          schedule: {
            enabled: true,
            cadence: "weekly",
            time: "06:15",
            timezone: "America/Los_Angeles",
            daysOfWeek: [4, 2, 4],
          },
          sources: [
            {
              id: "web-1",
              type: "web_search",
              query: "frontier ai research papers datasets methods tools",
            },
          ],
        } satisfies ProjectWatchConfig,
      }),
    });

    const response = await POST(request);
    const data = await response.json();
    const jobId = data.config.schedule.schedulerJobId;

    expect(response.status).toBe(200);
    expect(data.config.schedule).toMatchObject({
      enabled: true,
      cadence: "weekly",
      time: "06:15",
      timezone: "America/Los_Angeles",
      daysOfWeek: [2, 4],
    });
    expect(getJob(jobId)?.schedule).toBe("15 6 * * 2,4");
    deleteJob(jobId);
  });

  it("removes stale scheduler jobs when a watch schedule is cleared", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const [{ POST }, { deleteJob, getJob, scheduleJob }, { writeProjectWatchConfig }] = await Promise.all([
      import("@/app/api/brain/watch-config/route"),
      import("@/lib/scheduler"),
      import("@/lib/watch/store"),
    ]);

    const oldJobId = scheduleJob({
      name: "Frontier Watch: alpha",
      type: "recurring",
      schedule: "0 8 * * *",
      action: {
        type: "frontier-watch",
        config: { project: "alpha" },
      },
    });
    await writeProjectWatchConfig(
      "alpha",
      {
        version: 1,
        keywords: ["ai"],
        promotionThreshold: 5,
        stagingThreshold: 2,
        schedule: {
          enabled: true,
          cadence: "daily",
          time: "08:00",
          timezone: "local",
          schedulerJobId: oldJobId,
        },
        sources: [
          {
            id: "web-1",
            type: "web_search",
            query: "AI news today",
          },
        ],
      },
      join(TEST_ROOT, "state"),
    );

    const request = new Request("http://localhost/api/brain/watch-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha",
        config: {
          version: 1,
          keywords: ["ai"],
          promotionThreshold: 5,
          stagingThreshold: 2,
          sources: [
            {
              id: "web-1",
              type: "web_search",
              query: "AI news today",
            },
          ],
        } satisfies ProjectWatchConfig,
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.config.schedule).toBeUndefined();
    expect(getJob(oldJobId)).toBeUndefined();
    deleteJob(oldJobId);
  });

  it("composes a watch plan from a natural language objective", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const { POST } = await import("@/app/api/brain/watch-config/compose/route");

    const request = new Request("http://localhost/api/brain/watch-config/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha",
        objective: "Track daily AI model releases and research breakthroughs.",
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.plan.compiledPrompt).toContain("Search for and compile");
    expect(data.plan.searchQueries.length).toBeGreaterThan(0);
  });

  it("bootstraps missing project brain state from project metadata before composing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const openScienceRoot = join(tmpdir(), "scienceswarm-watch-compose-project-bootstrap");
    const brainRoot = join(openScienceRoot, "brain");
    process.env.SCIENCESWARM_DIR = openScienceRoot;
    rmSync(openScienceRoot, { recursive: true, force: true });
    brainInitModule.initBrain({ root: brainRoot, name: "Test Researcher" });
    mockLoadBrainConfig.mockReturnValue({
      ...makeTestConfig(),
      root: brainRoot,
    });
    mkdirSync(join(openScienceRoot, "projects", "alpha"), { recursive: true });
    writeFileSync(
      join(openScienceRoot, "projects", "alpha", "project.json"),
      JSON.stringify({
        id: "alpha",
        slug: "alpha",
        name: "Alpha Project",
        description: "Track frontier AI work.",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastActive: "2026-04-09T12:00:00.000Z",
        status: "active",
      }),
    );

    try {
      const { POST } = await import("@/app/api/brain/watch-config/compose/route");

      const request = new Request("http://localhost/api/brain/watch-config/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: "alpha",
          objective: "Track daily AI model releases and research breakthroughs.",
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.plan.keywords).toContain("model releases");
      expect(
        readFileSync(join(openScienceRoot, "projects", "alpha", ".brain", "state", "manifest.json"), "utf-8"),
      ).toContain('"title": "Alpha Project"');
    } finally {
      delete process.env.SCIENCESWARM_DIR;
      rmSync(openScienceRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-string watch compose timezones", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const { POST } = await import("@/app/api/brain/watch-config/compose/route");

    const request = new Request("http://localhost/api/brain/watch-config/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha",
        objective: "Track daily AI model releases.",
        timezone: { name: "America/Los_Angeles" },
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("timezone");
  });

  it("coerces invalid thresholds into a consistent range", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const { POST } = await import("@/app/api/brain/watch-config/route");

    const request = new Request("http://localhost/api/brain/watch-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha",
        config: {
          version: 1,
          keywords: [],
          promotionThreshold: -1,
          stagingThreshold: 3,
          sources: [],
        } satisfies ProjectWatchConfig,
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.config.stagingThreshold).toBe(3);
    expect(data.config.promotionThreshold).toBe(3);
  });

  it("rejects incomplete watch sources", async () => {
    await writeProjectManifest(makeManifest("alpha"), join(TEST_ROOT, "state"));
    const { POST } = await import("@/app/api/brain/watch-config/route");

    const request = new Request("http://localhost/api/brain/watch-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "alpha",
        config: {
          version: 1,
          keywords: [],
          promotionThreshold: 5,
          stagingThreshold: 2,
          sources: [
            {
              id: "feed-1",
              type: "rss",
              url: "   ",
            },
          ],
        } satisfies ProjectWatchConfig,
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("requires a URL");
  });

  it("rejects unsafe project slugs", async () => {
    const { POST } = await import("@/app/api/brain/watch-config/route");

    const request = new Request("http://localhost/api/brain/watch-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "../escape",
        config: {
          version: 1,
          keywords: [],
          promotionThreshold: 5,
          stagingThreshold: 2,
          sources: [],
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

describe("GET /api/brain/search", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("returns 503 when no brain configured", async () => {
    mockLoadBrainConfig.mockReturnValue(null);
    const { GET } = await import("@/app/api/brain/search/route");

    const request = new Request(
      "http://localhost/api/brain/search?query=test"
    );
    const response = await GET(request);
    expect(response.status).toBe(503);
  });

  it("returns 400 when query is missing (non-list mode)", async () => {
    const { GET } = await import("@/app/api/brain/search/route");

    const request = new Request("http://localhost/api/brain/search");
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("query");
  });

  it("returns 400 for invalid mode", async () => {
    const { GET } = await import("@/app/api/brain/search/route");

    const request = new Request(
      "http://localhost/api/brain/search?query=test&mode=invalid"
    );
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid mode");
  });

  it("returns 400 for invalid detail", async () => {
    const { GET } = await import("@/app/api/brain/search/route");

    const request = new Request(
      "http://localhost/api/brain/search?query=test&detail=exhaustive"
    );
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid detail");
  });

  it("returns 400 for invalid profile", async () => {
    const { GET } = await import("@/app/api/brain/search/route");

    const request = new Request(
      "http://localhost/api/brain/search?query=test&profile=slow",
    );
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid profile");
  });

  it("returns 400 for empty detail", async () => {
    const { GET } = await import("@/app/api/brain/search/route");

    const request = new Request(
      "http://localhost/api/brain/search?query=test&detail="
    );
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid detail");
  });

  it("passes valid detail through to brain search", async () => {
    const searchSpy = vi.spyOn(brainSearchModule, "search").mockResolvedValue([
      {
        path: "wiki/resources/crispr-note.md",
        title: "CRISPR Note",
        snippet: "High detail result.",
        relevance: 0.9,
        type: "note",
        chunkId: 123,
        chunkIndex: 2,
      },
    ]);

    const { GET } = await import("@/app/api/brain/search/route");
    const request = new Request(
      "http://localhost/api/brain/search?query=CRISPR&mode=qmd&limit=5&detail=high"
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(searchSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        query: "CRISPR",
        mode: "qmd",
        limit: 5,
        detail: "high",
      }),
    );
    const data = await response.json();
    expect(data[0]).toMatchObject({
      path: "wiki/resources/crispr-note",
      chunkId: 123,
      chunkIndex: 2,
    });
  });

  it("passes valid search profiles through to brain search", async () => {
    const searchSpy = vi.spyOn(brainSearchModule, "search").mockResolvedValue([]);

    const { GET } = await import("@/app/api/brain/search/route");
    const request = new Request(
      "http://localhost/api/brain/search?query=CRISPR&mode=qmd&profile=synthesis",
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(searchSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        query: "CRISPR",
        mode: "qmd",
        profile: "synthesis",
      }),
    );
  });

  it("normalizes compiled search view paths to public brain slugs", async () => {
    vi.spyOn(brainSearchModule, "search").mockResolvedValue([
      {
        path: "wiki/concepts/crispr-off-target.md",
        title: "CRISPR Off-Target Effects",
        snippet: "Compiled view result.",
        relevance: 0.95,
        type: "concept",
        compiledView: {
          pagePath: "wiki/concepts/crispr-off-target.md",
          summary: "Current compiled view.",
          sourceCounts: {
            papers: 1,
            notes: 0,
            experiments: 0,
            datasets: 0,
            other: 0,
          },
          totalSources: 1,
          lastUpdated: "2026-04-18T00:00:00.000Z",
        },
      },
    ]);

    const { GET } = await import("@/app/api/brain/search/route");
    const request = new Request(
      "http://localhost/api/brain/search?query=CRISPR&mode=qmd&limit=5&detail=high",
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data[0]).toMatchObject({
      path: "wiki/concepts/crispr-off-target",
      compiledView: {
        pagePath: "wiki/concepts/crispr-off-target",
      },
    });
  });

  it("searches and returns results array", async () => {
    // Create a page to be found
    mkdirSync(join(TEST_ROOT, "wiki/resources"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "wiki/resources/crispr-note.md"),
      "---\ntype: note\ntags: [crispr]\n---\n# CRISPR Note\nThis is about CRISPR."
    );

    const { GET } = await import("@/app/api/brain/search/route");
    const request = new Request(
      "http://localhost/api/brain/search?query=CRISPR&mode=grep&limit=5"
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it("allows list mode without query", async () => {
    const { GET } = await import("@/app/api/brain/search/route");

    const request = new Request(
      "http://localhost/api/brain/search?mode=list"
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it("returns 503 when qmd is selected but the store backend is unavailable", async () => {
    await resetBrainStore();

    vi.spyOn(brainStoreModule, "searchStoreWithTimeout").mockRejectedValue(
      new brainStoreModule.BrainBackendUnavailableError("Brain backend unavailable"),
    );

    const { GET } = await import("@/app/api/brain/search/route");
    const request = new Request(
      "http://localhost/api/brain/search?query=CRISPR&mode=qmd&limit=5"
    );

    const response = await GET(request);
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error).toBe("Brain backend unavailable");
  });

  it("returns 503 when qmd search times out", async () => {
    await resetBrainStore();

    vi.spyOn(brainStoreModule, "searchStoreWithTimeout").mockRejectedValue(
      new brainStoreModule.BrainSearchTimeoutError(),
    );

    const { GET } = await import("@/app/api/brain/search/route");
    const request = new Request(
      "http://localhost/api/brain/search?query=CRISPR&mode=qmd&limit=5"
    );

    const response = await GET(request);
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.error).toBe("Brain search timed out");
  });
});

describe("GET /api/brain/status", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("returns 503 when no brain configured", async () => {
    mockLoadBrainConfig.mockReturnValue(null);
    const { GET } = await import("@/app/api/brain/status/route");

    const response = await GET();
    expect(response.status).toBe(503);
  });

  it("returns status with expected fields", async () => {
    const { GET } = await import("@/app/api/brain/status/route");

    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("monthCost");
    expect(data).toHaveProperty("budgetExceeded");
    expect(data).toHaveProperty("recentEvents");
    expect(data).toHaveProperty("pageCount");
    expect(typeof data.monthCost).toBe("number");
    expect(typeof data.budgetExceeded).toBe("boolean");
    expect(Array.isArray(data.recentEvents)).toBe(true);
    expect(typeof data.pageCount).toBe("number");
  });

  it("includes backend field in response", async () => {
    const { GET } = await import("@/app/api/brain/status/route");

    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("backend");
    expect(typeof data.backend).toBe("string");
  });

  it("reports pglite as the backend", async () => {
    const { GET } = await import("@/app/api/brain/status/route");
    const response = await GET();
    const data = await response.json();
    expect(data.backend).toBe("pglite");
  });

  it("trusts a healthy store page count even when it is zero", async () => {
    vi.spyOn(brainSearchModule, "countPages").mockResolvedValue(3);
    vi.spyOn(brainStoreModule, "ensureBrainStoreReady").mockResolvedValue();
    vi.spyOn(brainStoreModule, "getBrainStore").mockReturnValue({
      search: vi.fn(),
      getPage: vi.fn(),
      getTimeline: vi.fn().mockResolvedValue([]),
      getLinks: vi.fn().mockResolvedValue([]),
      getBacklinks: vi.fn().mockResolvedValue([]),
      importCorpus: vi.fn(),
      listPages: vi.fn().mockResolvedValue([]),
      health: vi.fn().mockResolvedValue({ ok: true, pageCount: 0 }),
      dispose: vi.fn(),
    });

    const { GET } = await import("@/app/api/brain/status/route");
    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.pageCount).toBe(0);
    expect(data.store).toMatchObject({ ok: true, pageCount: 0 });
  });

  // ───────────────────────────────────────────────────
  // Radar visibility (TODO #2 from the eng review)
  // ───────────────────────────────────────────────────
  //
  // The /api/brain/status endpoint also surfaces the research-radar
  // skill runner's last-execution timestamp. It reads
  // `<config.root>/.radar-last-run.json`, computes `age_ms`, and
  // returns `stale: true` when the run is older than 2x the schedule
  // interval. The dashboard's brain-overview card displays the result
  // so a crashed runner is visible instead of silently rotting.

  it("returns radar: null when the runner has never executed", async () => {
    const { GET } = await import("@/app/api/brain/status/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("radar");
    expect(data.radar).toBeNull();
  });

  it("reports stale: false when the last run is fresh", async () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    writeFileSync(
      join(TEST_ROOT, ".radar-last-run.json"),
      JSON.stringify({
        timestamp: tenSecondsAgo,
        concepts_processed: 3,
        errors_count: 0,
        schedule_interval_ms: 30 * 60_000,
      }),
    );

    const { GET } = await import("@/app/api/brain/status/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.radar).not.toBeNull();
    expect(data.radar.last_run).toBe(tenSecondsAgo);
    expect(data.radar.concepts_processed).toBe(3);
    expect(data.radar.errors).toBe(0);
    expect(data.radar.stale).toBe(false);
    expect(data.radar.age_ms).toBeGreaterThan(-1);
    expect(data.radar.age_ms).toBeLessThan(60 * 60_000);
    expect(data.radar.schedule_interval_ms).toBe(30 * 60_000);
  });

  it("reports stale: true when the last run is older than 2x the interval", async () => {
    // Schedule interval 30 minutes; mark the last run as 4 hours ago.
    // 4h > 2 * 30min so the route must flip the stale flag.
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    writeFileSync(
      join(TEST_ROOT, ".radar-last-run.json"),
      JSON.stringify({
        timestamp: fourHoursAgo,
        concepts_processed: 5,
        errors_count: 1,
        schedule_interval_ms: 30 * 60_000,
      }),
    );

    const { GET } = await import("@/app/api/brain/status/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.radar).not.toBeNull();
    expect(data.radar.stale).toBe(true);
    expect(data.radar.errors).toBe(1);
    expect(data.radar.age_ms).toBeGreaterThan(2 * 30 * 60_000);
  });

  it("returns radar: null when the pointer file is malformed JSON", async () => {
    writeFileSync(join(TEST_ROOT, ".radar-last-run.json"), "{ this is not json");
    const { GET } = await import("@/app/api/brain/status/route");
    const response = await GET();
    const data = await response.json();
    expect(data.radar).toBeNull();
  });

  it("returns radar: null when required fields are missing", async () => {
    writeFileSync(
      join(TEST_ROOT, ".radar-last-run.json"),
      JSON.stringify({ timestamp: "yes" }), // missing the count + interval fields
    );
    const { GET } = await import("@/app/api/brain/status/route");
    const response = await GET();
    const data = await response.json();
    expect(data.radar).toBeNull();
  });
});

describe("GET /api/brain/dream", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("returns lastRun null when the dream sidecar has never executed", async () => {
    const { GET } = await import("@/app/api/brain/dream/route");
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ lastRun: null });
  });

  it("returns the structured dream last-run pointer", async () => {
    writeFileSync(
      join(TEST_ROOT, ".dream-last-run.json"),
      JSON.stringify({
        timestamp: "2026-04-18T08:30:00.000Z",
        mode: "full",
        pages_compiled: 1,
        contradictions_found: 1,
        backlinks_added: 2,
        duration_ms: 1234,
        duration_ms_per_stage: { total: 1234 },
        errors: [],
        partial: false,
        headline: {
          generatedAt: "2026-04-18T08:30:00.000Z",
          windowStart: "2026-04-17T08:30:00.000Z",
          windowEnd: "2026-04-18T08:30:00.000Z",
          headline: "While you slept: 1 new paper 1 contradiction with your current beliefs 0 stale work items 2 new cross-references.",
          newSignals: 1,
          newPapers: 1,
          sourceBreakdown: {
            paper: 1,
            zotero: 0,
            lab_data: 0,
            meeting: 0,
            chat: 0,
            note: 0,
            task: 0,
            other: 0,
          },
          topicsRecompiled: 1,
          contradictionsFound: 1,
          staleExperiments: 0,
          crossReferencesAdded: 2,
          brokenBacklinksFixed: 2,
          staleTimelinesConsolidated: 1,
          compiledTopics: [],
          signals: [],
          staleExperimentDetails: [],
        },
      }),
    );

    const { GET } = await import("@/app/api/brain/dream/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.lastRun).toMatchObject({
      pages_compiled: 1,
      contradictions_found: 1,
      backlinks_added: 2,
      partial: false,
      headline: expect.objectContaining({
        newPapers: 1,
        topicsRecompiled: 1,
        crossReferencesAdded: 2,
      }),
    });
  });

  it("rejects malformed dream last-run pointer fields", async () => {
    writeFileSync(
      join(TEST_ROOT, ".dream-last-run.json"),
      JSON.stringify({
        timestamp: "2026-04-18T08:30:00.000Z",
        mode: "full",
        pages_compiled: 1,
        contradictions_found: 1,
        backlinks_added: 2,
        duration_ms: 1234,
        duration_ms_per_stage: { total: "slow" },
        errors: [],
        partial: false,
        skipped: "no",
      }),
    );

    const { GET } = await import("@/app/api/brain/dream/route");
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ lastRun: null });
  });

  it("drops malformed optional dream headline fields", async () => {
    writeFileSync(
      join(TEST_ROOT, ".dream-last-run.json"),
      JSON.stringify({
        timestamp: "2026-04-18T08:30:00.000Z",
        mode: "full",
        pages_compiled: 1,
        contradictions_found: 1,
        backlinks_added: 2,
        duration_ms: 1234,
        duration_ms_per_stage: { total: 1234 },
        errors: [],
        partial: false,
        headline: {
          generatedAt: "2026-04-18T08:30:00.000Z",
          windowStart: "2026-04-17T08:30:00.000Z",
          windowEnd: "2026-04-18T08:30:00.000Z",
          headline: "While you slept: broken",
          newSignals: "one",
        },
      }),
    );

    const { GET } = await import("@/app/api/brain/dream/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.lastRun).toMatchObject({
      pages_compiled: 1,
      contradictions_found: 1,
      backlinks_added: 2,
      partial: false,
    });
    expect(data.lastRun.headline).toBeUndefined();
  });

  it("keeps manual dream runs successful when the best-effort last-run write fails", async () => {
    vi.resetModules();
    vi.doMock("@/brain/dream-cycle", () => ({
      runDreamCycle: vi.fn(async () => ({
        pagesCompiled: 2,
        contradictionsFound: 1,
        backlinksAdded: 3,
        durationMs: 42,
        cost: null,
        report: "ok",
        errors: [],
        headline: null,
      })),
    }));
    vi.doMock("@/brain/dream-report", () => ({
      readDreamLastRun: vi.fn(),
      writeDreamLastRun: vi.fn(() => {
        throw new Error("/private/tmp/secret-dream-pointer.json");
      }),
    }));

    try {
      const { POST } = await import("@/app/api/brain/dream/route");
      const response = await POST(
        new Request("http://localhost/api/brain/dream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "full" }),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toMatchObject({
        pagesCompiled: 2,
        contradictionsFound: 1,
        backlinksAdded: 3,
      });
      expect(JSON.stringify(data)).not.toContain("secret-dream-pointer");
    } finally {
      vi.doUnmock("@/brain/dream-cycle");
      vi.doUnmock("@/brain/dream-report");
      vi.resetModules();
    }
  });

  it("returns recoverable guidance instead of raw failure text when a manual run fails", async () => {
    vi.resetModules();
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.doMock("@/brain/dream-cycle", () => ({
      runDreamCycle: vi.fn(async () => {
        throw new Error(
          "Ollama chat failed (500): local model unavailable\n    at /Users/example/project-alpha/src/brain/dream-cycle.ts:42",
        );
      }),
    }));
    vi.doMock("@/brain/dream-report", () => ({
      readDreamLastRun: vi.fn(),
      writeDreamLastRun: vi.fn(),
    }));

    try {
      const { POST } = await import("@/app/api/brain/dream/route");
      const response = await POST(
        new Request("http://localhost/api/brain/dream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "full" }),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data).toMatchObject({
        error: "Dream Cycle could not complete.",
        code: "dream_cycle_local_model_unavailable",
        cause:
          "The configured local model service did not complete the synthesis request.",
        nextAction: expect.stringContaining("Retry Dream Cycle"),
      });
      expect(JSON.stringify(data)).not.toContain("project-alpha");
      expect(JSON.stringify(data)).not.toContain("\n    at ");
    } finally {
      vi.doUnmock("@/brain/dream-cycle");
      vi.doUnmock("@/brain/dream-report");
      vi.resetModules();
    }
  });

  it("does not misclassify generic local-provider Dream Cycle failures as Ollama failures", async () => {
    vi.resetModules();
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.doMock("@/brain/dream-cycle", () => ({
      runDreamCycle: vi.fn(async () => {
        throw new Error(
          "Unexpected dream runtime failure at /Users/example/project-alpha/src/brain/dream-cycle.ts:42",
        );
      }),
    }));
    vi.doMock("@/brain/dream-report", () => ({
      readDreamLastRun: vi.fn(),
      writeDreamLastRun: vi.fn(),
    }));

    try {
      const { POST } = await import("@/app/api/brain/dream/route");
      const response = await POST(
        new Request("http://localhost/api/brain/dream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "full" }),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data).toMatchObject({
        error: "Dream Cycle could not complete.",
        code: "dream_cycle_failed",
        cause:
          "The configured Dream Cycle runtime did not complete the synthesis request.",
        nextAction: expect.stringContaining("Retry Dream Cycle"),
      });
      expect(JSON.stringify(data)).not.toContain("Ollama");
      expect(JSON.stringify(data)).not.toContain("project-alpha");
      expect(JSON.stringify(data)).not.toContain("\n    at ");
    } finally {
      vi.doUnmock("@/brain/dream-cycle");
      vi.doUnmock("@/brain/dream-report");
      vi.resetModules();
    }
  });

  it("does not misclassify strict-local policy failures as Ollama failures", async () => {
    vi.resetModules();
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.doMock("@/brain/dream-cycle", () => ({
      runDreamCycle: vi.fn(async () => {
        const error = new Error(
          "Strict local-only mode blocks brain LLM completion without a local runtime.",
        );
        error.name = "StrictLocalPolicyError";
        throw error;
      }),
    }));
    vi.doMock("@/brain/dream-report", () => ({
      readDreamLastRun: vi.fn(),
      writeDreamLastRun: vi.fn(),
    }));

    try {
      const { POST } = await import("@/app/api/brain/dream/route");
      const response = await POST(
        new Request("http://localhost/api/brain/dream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "full" }),
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data).toMatchObject({
        error: "Dream Cycle could not complete.",
        code: "dream_cycle_failed",
        cause:
          "The configured Dream Cycle runtime did not complete the synthesis request.",
        nextAction: expect.stringContaining("Retry Dream Cycle"),
      });
      expect(JSON.stringify(data)).not.toContain("Ollama");
      expect(JSON.stringify(data)).not.toContain("Strict local-only mode");
    } finally {
      vi.doUnmock("@/brain/dream-cycle");
      vi.doUnmock("@/brain/dream-report");
      vi.resetModules();
    }
  });

  it("classifies local brain-store failures separately and persists the failed run", async () => {
    vi.resetModules();
    vi.stubEnv("LLM_PROVIDER", "local");
    vi.doMock("@/brain/dream-cycle", () => ({
      runDreamCycle: vi.fn(async () => {
        const error = new Error("Brain backend unavailable");
        error.name = "BrainBackendUnavailableError";
        throw error;
      }),
    }));

    try {
      const { POST } = await import("@/app/api/brain/dream/route");
      const response = await POST(
        new Request("http://localhost/api/brain/dream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "full" }),
        }),
      );
      const data = await response.json();
      const pointer = JSON.parse(readFileSync(join(TEST_ROOT, ".dream-last-run.json"), "utf-8"));

      expect(response.status).toBe(503);
      expect(data).toMatchObject({
        error: "Dream Cycle could not complete.",
        code: "dream_cycle_brain_store_unavailable",
        cause: "The local brain store did not complete the synthesis request.",
        nextAction: expect.stringContaining("restore the local brain store"),
      });
      expect(pointer).toMatchObject({
        mode: "full",
        partial: true,
        errors: ["The local brain store did not complete the synthesis request."],
        reason: expect.stringContaining("restore the local brain store"),
      });
    } finally {
      vi.doUnmock("@/brain/dream-cycle");
      vi.resetModules();
    }
  });
});

describe("GET /api/brain/read", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("returns 503 when no brain configured", async () => {
    mockLoadBrainConfig.mockReturnValue(null);
    const { GET } = await import("@/app/api/brain/read/route");

    const request = new Request(
      "http://localhost/api/brain/read?path=wiki/home.md"
    );
    const response = await GET(request);
    expect(response.status).toBe(503);
  });

  it("returns 400 when path is missing", async () => {
    const { GET } = await import("@/app/api/brain/read/route");

    const request = new Request("http://localhost/api/brain/read");
    const response = await GET(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("path");
  });

  it("returns 403 on path traversal attempt", async () => {
    const { GET } = await import("@/app/api/brain/read/route");

    const request = new Request(
      "http://localhost/api/brain/read?path=../../etc/passwd"
    );
    const response = await GET(request);
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain("traversal");
  });

  it("returns 403 on path traversal with encoded dots", async () => {
    const { GET } = await import("@/app/api/brain/read/route");

    const request = new Request(
      "http://localhost/api/brain/read?path=wiki/../../../etc/shadow"
    );
    const response = await GET(request);
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain("traversal");
  });

  it("returns 404 when file does not exist", async () => {
    const { GET } = await import("@/app/api/brain/read/route");

    const request = new Request(
      "http://localhost/api/brain/read?path=wiki/nonexistent.md"
    );
    const response = await GET(request);
    expect(response.status).toBe(404);
  });

  it("reads an existing brain file", async () => {
    const { GET } = await import("@/app/api/brain/read/route");

    const request = new Request(
      "http://localhost/api/brain/read?path=wiki/home.md"
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.path).toBe("wiki/home");
    expect(typeof data.content).toBe("string");
    expect(data.content.length).toBeGreaterThan(0);
  });

  it("accepts the public slug returned by filesystem reads", async () => {
    const { GET } = await import("@/app/api/brain/read/route");

    const request = new Request(
      "http://localhost/api/brain/read?path=wiki/home"
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.path).toBe("wiki/home");
    expect(typeof data.content).toBe("string");
    expect(data.content.length).toBeGreaterThan(0);
  });

  it("returns gbrain-only compiled pages before trying disk realpath", async () => {
    vi.stubEnv("BRAIN_ROOT", TEST_ROOT);
    await resetBrainStore();
    await brainStoreModule.ensureBrainStoreReady();
    const adapter = brainStoreModule.getBrainStore() as unknown as {
      engine: {
        putPage(
          slug: string,
          page: {
            type: string;
            title: string;
            compiled_truth: string;
            timeline?: string;
            frontmatter?: Record<string, unknown>;
          },
        ): Promise<void>;
        addTimelineEntry(
          slug: string,
          entry: { date: string; source?: string; summary: string; detail?: string },
        ): Promise<void>;
        addLink(from: string, to: string, context?: string, linkType?: string): Promise<void>;
      };
    };

    await adapter.engine.putPage("wiki/concepts/rlhf-alignment", {
      type: "concept",
      title: "RLHF alignment",
      compiled_truth: "RLHF is a contested alignment approach.",
      frontmatter: { project: "alignment" },
    });
    await adapter.engine.putPage("papers/deceptive-rlhf", {
      type: "paper",
      title: "Deceptive RLHF",
      compiled_truth: "RLHF can optimize reward models into deceptive alignment.",
      frontmatter: { project: "alignment" },
    });
    await adapter.engine.addTimelineEntry("wiki/concepts/rlhf-alignment", {
      date: "2026-04-18",
      source: "papers/deceptive-rlhf",
      summary: "Compiled truth updated from Deceptive RLHF",
      detail: "1 contradiction surfaced.",
    });
    await adapter.engine.addLink(
      "wiki/concepts/rlhf-alignment",
      "papers/deceptive-rlhf",
      "evidence",
      "contradicts",
    );

    const { GET } = await import("@/app/api/brain/read/route");
    const request = new Request(
      "http://localhost/api/brain/read?path=wiki/concepts/rlhf-alignment.md",
    );

    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.path).toBe("wiki/concepts/rlhf-alignment");
    expect(data.compiled_truth).toContain("contested");
    expect(data.frontmatter).toMatchObject({ project: "alignment" });
    expect(data.timeline).toEqual([
      expect.objectContaining({
        date: "2026-04-18",
        summary: "Compiled truth updated from Deceptive RLHF",
      }),
    ]);
    expect(data.links).toEqual([
      expect.objectContaining({
        kind: "contradicts",
        slug: "papers/deceptive-rlhf",
        fromSlug: "wiki/concepts/rlhf-alignment",
        toSlug: "papers/deceptive-rlhf",
        title: "Deceptive RLHF",
      }),
    ]);
  });

  it("falls back to filesystem when the store backend is unavailable", async () => {
    await resetBrainStore();

    vi.spyOn(brainStoreModule, "getBrainStore").mockReturnValue({
      search: vi.fn(),
      getPage: vi.fn().mockRejectedValue(
        new brainStoreModule.BrainBackendUnavailableError("Brain backend unavailable"),
      ),
      getTimeline: vi.fn().mockResolvedValue([]),
      getLinks: vi.fn().mockResolvedValue([]),
      getBacklinks: vi.fn().mockResolvedValue([]),
      importCorpus: vi.fn(),
      listPages: vi.fn().mockResolvedValue([]),
      health: vi.fn(),
      dispose: vi.fn(),
    });

    const { GET } = await import("@/app/api/brain/read/route");
    const request = new Request(
      "http://localhost/api/brain/read?path=wiki/home.md"
    );

    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.path).toBe("wiki/home");
    expect(data.content).toContain("#");
  });

  it("falls back to filesystem content when a page is not indexed yet", async () => {
    await resetBrainStore();

    vi.spyOn(brainStoreModule, "getBrainStore").mockReturnValue({
      search: vi.fn(),
      getPage: vi.fn().mockResolvedValue(null),
      getTimeline: vi.fn().mockResolvedValue([]),
      getLinks: vi.fn().mockResolvedValue([]),
      getBacklinks: vi.fn().mockResolvedValue([]),
      importCorpus: vi.fn(),
      listPages: vi.fn().mockResolvedValue([]),
      health: vi.fn(),
      dispose: vi.fn(),
    });

    const { GET } = await import("@/app/api/brain/read/route");
    const request = new Request(
      "http://localhost/api/brain/read?path=wiki/home.md"
    );

    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.path).toBe("wiki/home");
    expect(data.content).toContain("#");
  });
});

describe("GET /api/brain/guide", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("returns 503 when no brain configured", async () => {
    mockLoadBrainConfig.mockReturnValue(null);
    const { GET } = await import("@/app/api/brain/guide/route");

    const request = new Request("http://localhost/api/brain/guide");
    const response = await GET(request);
    expect(response.status).toBe(503);
  });

  it("returns briefing with expected fields", async () => {
    const { GET } = await import("@/app/api/brain/guide/route");

    const request = new Request("http://localhost/api/brain/guide");
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("stats");
    expect(data).toHaveProperty("recentChanges");
    expect(data).toHaveProperty("activeExperiments");
    expect(data.stats).toHaveProperty("pageCount");
    expect(data.stats).toHaveProperty("monthCostUsd");
    expect(data.stats).toHaveProperty("monthBudgetUsd");
  });

  it("includes focus suggestions when focus param provided", async () => {
    // Create a CRISPR page to be found
    mkdirSync(join(TEST_ROOT, "wiki/resources"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "wiki/resources/crispr-guide.md"),
      "---\ntype: note\ntags: [crispr]\n---\n# CRISPR Guide\nA guide about CRISPR."
    );

    const { GET } = await import("@/app/api/brain/guide/route");

    const request = new Request(
      "http://localhost/api/brain/guide?focus=CRISPR"
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.focus).toBe("CRISPR");
    expect(data).toHaveProperty("suggestions");
  });
});

describe("POST /api/brain/import-project", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("commits an approved preview into the configured brain", async () => {
    const { POST } = await import("@/app/api/brain/import-project/route");

    const request = new Request("http://localhost/api/brain/import-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: {
          name: "Alpha Project",
          basePath: "/tmp/alpha-project",
          totalFiles: 1,
          files: [
            {
              path: "notes/summary.md",
              name: "summary.md",
              type: "md",
              size: 24,
              content: "# Summary\nAlpha notes",
              hash: "hash-summary",
            },
          ],
          analysis: "Approved import preview",
        },
        preview: {
          analysis: "Approved import preview",
          backend: "local-scan",
          files: [
            {
              path: "notes/summary.md",
              type: "md",
              size: 24,
              hash: "hash-summary",
              classification: "text",
              projectCandidates: ["alpha-project"],
              warnings: [],
            },
          ],
          projects: [
            {
              slug: "alpha-project",
              title: "Alpha Project",
              confidence: "high",
              reason: "Imported from Alpha Project",
              sourcePaths: ["notes/summary.md"],
            },
          ],
          duplicateGroups: [],
          warnings: [],
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.project).toBe("alpha-project");
    expect(data.projectPagePath).toBe("wiki/projects/alpha-project.md");
    expect(data.sourcePagePaths).toEqual([
      `wiki/resources/imports/alpha-project/notes-summary-${hashContent("notes/summary.md").slice(0, 8)}.md`,
    ]);
    expect(
      readFileSync(join(TEST_ROOT, "projects", "alpha-project", ".brain", data.projectPagePath), "utf-8"),
    ).toContain("Alpha Project");
    expect(readFileSync(data.manifestPath, "utf-8")).toContain('"slug": "alpha-project"');
  });

  it("rejects unsafe project slugs", async () => {
    const { POST } = await import("@/app/api/brain/import-project/route");

    const request = new Request("http://localhost/api/brain/import-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: {
          name: "Alpha Project",
          totalFiles: 0,
          files: [],
        },
        preview: {
          analysis: "Approved import preview",
          backend: "local-scan",
          files: [],
          projects: [],
          duplicateGroups: [],
          warnings: [],
        },
        projectSlug: "../escape",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("returns a sanitized error when import attribution is not configured", async () => {
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "");
    const { POST } = await import("@/app/api/brain/import-project/route");

    const request = new Request("http://localhost/api/brain/import-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: {
          name: "Alpha Project",
          totalFiles: 0,
          files: [],
        },
        preview: {
          analysis: "Approved import preview",
          backend: "local-scan",
          files: [],
          projects: [],
          duplicateGroups: [],
          warnings: [],
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Server attribution is not configured",
    });
  });

  it("ignores untrusted sourcePath fields from browser import payloads", async () => {
    const sourceDir = join(TEST_ROOT, "server-only");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "secret.md");
    writeFileSync(sourcePath, "# Server-only source\nnot browser content\n", "utf-8");

    const { POST } = await import("@/app/api/brain/import-project/route");

    const request = new Request("http://localhost/api/brain/import-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: {
          name: "Alpha Project",
          basePath: "/tmp/alpha-project",
          totalFiles: 1,
          files: [
            {
              path: "notes/summary.md",
              name: "summary.md",
              type: "md",
              size: 24,
              content: "# Browser content\nsafe import preview\n",
              sourcePath,
              hash: "hash-summary",
            },
          ],
          analysis: "Approved import preview",
        },
        preview: {
          analysis: "Approved import preview",
          backend: "local-scan",
          files: [
            {
              path: "notes/summary.md",
              type: "md",
              size: 24,
              hash: "hash-summary",
              classification: "text",
              projectCandidates: ["alpha-project"],
              warnings: [],
            },
          ],
          projects: [
            {
              slug: "alpha-project",
              title: "Alpha Project",
              confidence: "high",
              reason: "Imported from Alpha Project",
              sourcePaths: ["notes/summary.md"],
            },
          ],
          duplicateGroups: [],
          warnings: [],
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(
      readFileSync(join(TEST_ROOT, "projects", "alpha-project", "notes", "summary.md"), "utf-8"),
    ).toBe("# Browser content\nsafe import preview\n");
  });

  it("commits files with a gbrain-direct indexing compatibility response", async () => {
    const { POST } = await import("@/app/api/brain/import-project/route");

    const request = new Request("http://localhost/api/brain/import-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: {
          name: "Alpha Project",
          basePath: "/tmp/alpha-project",
          totalFiles: 1,
          files: [
            {
              path: "notes/summary.md",
              name: "summary.md",
              type: "md",
              size: 24,
              content: "# Summary\nAlpha notes",
              hash: "hash-summary",
            },
          ],
          analysis: "Approved import preview",
        },
        preview: {
          analysis: "Approved import preview",
          backend: "local-scan",
          files: [
            {
              path: "notes/summary.md",
              type: "md",
              size: 24,
              hash: "hash-summary",
              classification: "text",
              projectCandidates: ["alpha-project"],
              warnings: [],
            },
          ],
          projects: [
            {
              slug: "alpha-project",
              title: "Alpha Project",
              confidence: "high",
              reason: "Imported from Alpha Project",
              sourcePaths: ["notes/summary.md"],
            },
          ],
          duplicateGroups: [],
          warnings: [],
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.project).toBe("alpha-project");
    expect(data.indexing).toEqual({
      ok: true,
      imported: 2,
      skipped: 0,
      errors: [],
      durationMs: 0,
      mode: "gbrain-direct",
    });
    expect(
      readFileSync(join(TEST_ROOT, "projects", "alpha-project", ".brain", data.projectPagePath), "utf-8"),
    ).toContain("Alpha Project");
  });

  it("does not re-import the legacy disk corpus after direct gbrain commit", async () => {
    const { POST } = await import("@/app/api/brain/import-project/route");

    const request = new Request("http://localhost/api/brain/import-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: {
          name: "Alpha Project",
          basePath: "/tmp/alpha-project",
          totalFiles: 1,
          files: [
            {
              path: "notes/summary.md",
              name: "summary.md",
              type: "md",
              size: 24,
              content: "# Summary\nAlpha notes",
              hash: "hash-summary",
            },
          ],
          analysis: "Approved import preview",
        },
        preview: {
          analysis: "Approved import preview",
          backend: "local-scan",
          files: [
            {
              path: "notes/summary.md",
              type: "md",
              size: 24,
              hash: "hash-summary",
              classification: "text",
              projectCandidates: ["alpha-project"],
              warnings: [],
            },
          ],
          projects: [
            {
              slug: "alpha-project",
              title: "Alpha Project",
              confidence: "high",
              reason: "Imported from Alpha Project",
              sourcePaths: ["notes/summary.md"],
            },
          ],
          duplicateGroups: [],
          warnings: [],
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.project).toBe("alpha-project");
    expect(data.indexing).toEqual({
      ok: true,
      imported: 2,
      skipped: 0,
      errors: [],
      durationMs: 0,
      mode: "gbrain-direct",
    });
    expect(
      readFileSync(join(TEST_ROOT, "projects", "alpha-project", ".brain", data.projectPagePath), "utf-8"),
    ).toContain("Alpha Project");
  });
});

describe("GET /api/brain/brief", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("returns 400 when project is missing", async () => {
    const { GET } = await import("@/app/api/brain/brief/route");

    const request = new Request("http://localhost/api/brain/brief");
    const response = await GET(request);
    expect(response.status).toBe(400);
  });

  it("returns a project brief backed by manifest pages", async () => {
    const originalScienceSwarmDir = process.env.SCIENCESWARM_DIR;
    const briefRoot = join(TEST_ROOT, "brief-state");
    const briefBrainRoot = join(briefRoot, "brain");
    const stateRoot = join(briefBrainRoot, "state");
    process.env.SCIENCESWARM_DIR = briefRoot;

    mkdirSync(join(briefBrainRoot, "wiki/projects"), { recursive: true });
    mkdirSync(join(briefBrainRoot, "wiki/tasks"), { recursive: true });
    writeFileSync(
      join(briefBrainRoot, "wiki/projects/alpha.md"),
      "# Alpha\n\n## Summary\nAlpha project summary.\n\n## Next Move\nShip the brief route.",
    );
    writeFileSync(
      join(briefBrainRoot, "wiki/tasks/task-1.md"),
      "---\ntype: task\nstatus: open\n---\n# Task 1\n\n## Task\nShip the brief route.",
    );

    await writeProjectManifest(
      {
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [],
        decisionPaths: [],
        taskPaths: ["wiki/tasks/task-1.md"],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
      stateRoot,
    );

    mockLoadBrainConfig.mockReturnValue({
      root: briefBrainRoot,
      extractionModel: "test-model",
      synthesisModel: "test-model",
      rippleCap: 15,
      paperWatchBudget: 50,
      serendipityRate: 0.2,
    });
    const { GET } = await import("@/app/api/brain/brief/route");
    const request = new Request("http://localhost/api/brain/brief?project=alpha");
    const response = await GET(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.project).toBe("alpha");
    expect(Array.isArray(data.topMatters)).toBe(true);
    expect(Array.isArray(data.dueTasks)).toBe(true);
    expect(Array.isArray(data.frontier)).toBe(true);
    expect(data.nextMove).toEqual(
      expect.objectContaining({
        recommendation: expect.any(String),
      }),
    );
    expect(data.dueTasks[0].title).toContain("Task 1");

    if (originalScienceSwarmDir) process.env.SCIENCESWARM_DIR = originalScienceSwarmDir;
    else delete process.env.SCIENCESWARM_DIR;
  });
});

describe("/api/brain/research-landscape", () => {
  beforeEach(setupBrain);
  afterEach(teardownBrain);

  it("returns the last-run pointer on GET", async () => {
    const researchPacketsModule = await import("@/lib/research-packets");
    vi.spyOn(researchPacketsModule, "readResearchLandscapeLastRun")
      .mockResolvedValue({
        timestamp: "2026-04-22T15:30:00.000Z",
        status: "completed",
        query: "graph neural networks",
        packet_slug: "packets/2026-04-22-graph-neural-networks-abcd1234",
        journal_slug: "journals/2026-04-22-graph-neural-networks-abcd1234",
        collected_candidates: 8,
        retained_candidates: 4,
        duplicates_dropped: 2,
        partial: false,
        source_failures: [],
      });
    const { GET } = await import("@/app/api/brain/research-landscape/route");

    const response = await GET();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.lastRun).toEqual(
      expect.objectContaining({
        query: "graph neural networks",
        packet_slug: expect.stringContaining("packets/"),
      }),
    );
  });

  it("runs the deterministic packet workflow on POST", async () => {
    const researchPacketsModule = await import("@/lib/research-packets");
    vi.spyOn(researchPacketsModule, "runResearchLandscape")
      .mockResolvedValue({
        status: "completed",
        query: "graph neural networks",
        exactTitle: undefined,
        project: "alpha",
        packet: {
          slug: "packets/2026-04-22-graph-neural-networks-abcd1234",
          diskPath: `${TEST_ROOT}/packets/2026-04-22-graph-neural-networks-abcd1234.md`,
          title: "Research Packet: graph neural networks",
          write_status: "persisted",
        },
        journal: {
          slug: "journals/2026-04-22-graph-neural-networks-abcd1234",
          diskPath: `${TEST_ROOT}/journals/2026-04-22-graph-neural-networks-abcd1234.md`,
          title: "Research Landscape Journal: graph neural networks",
          write_status: "persisted",
        },
        pointerPath: `${TEST_ROOT}/.research-landscape-last-run.json`,
        sourceRuns: [],
        collectedCandidates: 0,
        retainedCandidates: 0,
        duplicatesDropped: 0,
        retainedWrites: [],
        failures: [],
      });
    const { POST } = await import("@/app/api/brain/research-landscape/route");

    const request = new Request("http://localhost/api/brain/research-landscape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "graph neural networks",
        project: "alpha",
        sources: ["pubmed", "openalex"],
        per_source_limit: 5,
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe("completed");
    expect(data.packet.slug).toContain("packets/");
    expect(researchPacketsModule.runResearchLandscape).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "graph neural networks",
        project: "alpha",
        sources: ["pubmed", "openalex"],
        perSourceLimit: 5,
      }),
      expect.objectContaining({
        brainRoot: TEST_ROOT,
      }),
    );
  });
});
