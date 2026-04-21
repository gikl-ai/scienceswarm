import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import type { BrainConfig, ProjectManifest } from "@/brain/types";
import { writeProjectManifest, readProjectManifest } from "@/lib/state/project-manifests";
import { readProjectWatchConfig } from "@/lib/watch/store";
import { handleWatchConversation } from "@/lib/watch/conversation";
import { runOpenClawFrontierWatch } from "@/lib/watch/openclaw-executor";

const {
  healthCheck,
  sendAgentMessage,
  scheduleJob,
  deleteJob,
  getJobs,
  scheduledJobs,
} = vi.hoisted(() => {
  const jobs: Array<Record<string, unknown>> = [];
  return {
    healthCheck: vi.fn(),
    sendAgentMessage: vi.fn(),
    scheduledJobs: jobs,
    scheduleJob: vi.fn((job: Record<string, unknown>) => {
      const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      jobs.push({ ...job, id });
      return id;
    }),
    deleteJob: vi.fn((id: string) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index >= 0) jobs.splice(index, 1);
    }),
    getJobs: vi.fn(() => jobs),
  };
});

vi.mock("@/lib/openclaw", () => ({
  healthCheck,
  sendAgentMessage,
}));

vi.mock("@/lib/scheduler", () => ({
  scheduleJob,
  deleteJob,
  getJobs,
}));

const ROOT = join(tmpdir(), "scienceswarm-watch-conversation");

function makeConfig(): BrainConfig {
  return {
    root: ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function manifest(slug: string): ProjectManifest {
  return {
    version: 1,
    projectId: slug,
    slug,
    title: `${slug} project`,
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
    updatedAt: "2026-04-09T00:00:00.000Z",
  };
}

beforeEach(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  initBrain({ root: ROOT, name: "Test Researcher" });
  await writeProjectManifest(manifest("alpha"), join(ROOT, "state"));
  vi.stubEnv("OPENAI_API_KEY", "");
  healthCheck.mockReset();
  sendAgentMessage.mockReset();
  scheduleJob.mockClear();
  deleteJob.mockClear();
  getJobs.mockClear();
  scheduledJobs.splice(0);
});

afterEach(() => {
  scheduledJobs.splice(0);
  rmSync(ROOT, { recursive: true, force: true });
  vi.unstubAllEnvs();
  healthCheck.mockReset();
  sendAgentMessage.mockReset();
});

describe("handleWatchConversation", () => {
  it("configures a scheduled OpenClaw frontier watch from natural language", async () => {
    const result = await handleWatchConversation({
      config: makeConfig(),
      channel: "telegram",
      userId: "123",
      message: "Track AI model release news every weekday at 8am for project alpha",
      timezone: "America/Los_Angeles",
    });

    const saved = await readProjectWatchConfig("alpha", join(ROOT, "state"));
    const job = getJobs().find((entry) => entry.id === saved?.schedule?.schedulerJobId);

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Configured an OpenClaw-powered frontier watch");
    expect(result.response).toContain("/dashboard/settings?project=alpha#frontier-watch");
    expect(saved?.executionMode).toBe("openclaw");
    expect(saved?.deliveryChannel).toBe("telegram");
    expect(saved?.schedule).toMatchObject({
      enabled: true,
      cadence: "weekdays",
      time: "08:00",
      timezone: "America/Los_Angeles",
    });
    expect(job?.action).toMatchObject({
      type: "frontier-watch",
      config: { project: "alpha" },
    });
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("runs adhoc frontier searches through OpenClaw and stores the briefing", async () => {
    healthCheck.mockResolvedValue({
      status: "connected",
      gateway: "ws://127.0.0.1:18789",
      channels: ["telegram"],
      agents: 1,
      sessions: 1,
    });
    sendAgentMessage.mockResolvedValue("# Today's Top Stories\n\n- Source-backed result.");

    const result = await handleWatchConversation({
      config: makeConfig(),
      channel: "telegram",
      userId: "123",
      message: "Run an ad hoc frontier news scan now for project alpha",
    });
    const updatedManifest = await readProjectManifest("alpha", join(ROOT, "state"));

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Ran the OpenClaw frontier search");
    expect(result.response).toContain("Saved the briefing");
    expect(sendAgentMessage).toHaveBeenCalledWith(
      expect.stringContaining("Use OpenClaw's existing web/search/browser capabilities"),
      expect.objectContaining({
        agent: "main",
        session: "watch:alpha",
        channel: "telegram",
      }),
    );
    expect(sendAgentMessage.mock.calls[0]?.[1]?.deliver).toBeUndefined();
    expect(updatedManifest?.frontierPaths[0]).toMatch(/^wiki\/entities\/frontier\//);
  });

  it("supports multi-day weekly schedules and preserves research-first briefing sections", async () => {
    const result = await handleWatchConversation({
      config: makeConfig(),
      channel: "telegram",
      userId: "123",
      message: "Schedule a research-first frontier watch for project alpha every Tuesday and Thursday at 6:15am Pacific with sections for Papers, Datasets, Methods, and Tools.",
      timezone: "America/Los_Angeles",
    });

    const saved = await readProjectWatchConfig("alpha", join(ROOT, "state"));

    expect(result.handled).toBe(true);
    expect(saved?.schedule).toMatchObject({
      enabled: true,
      cadence: "weekly",
      time: "06:15",
      timezone: "America/Los_Angeles",
      daysOfWeek: [2, 4],
    });
    expect(saved?.compiledPrompt).toContain("1. Papers");
    expect(saved?.compiledPrompt).toContain("2. Datasets");
    expect(saved?.compiledPrompt).toContain("3. Methods");
    expect(saved?.compiledPrompt).toContain("4. Tools");
    expect(saved?.compiledPrompt).not.toContain("Top Stories");
  });

  it("ignores persisted delivery channels during scheduled runs without explicit reply context", async () => {
    healthCheck.mockResolvedValue({
      status: "connected",
      gateway: "ws://127.0.0.1:18789",
      channels: ["telegram"],
      agents: 1,
      sessions: 1,
    });
    sendAgentMessage.mockResolvedValue("# Papers\n\n- Source-backed result.");

    const result = await runOpenClawFrontierWatch({
      config: makeConfig(),
      manifest: manifest("alpha"),
      watchConfig: {
        version: 1,
        objective: "Track frontier research updates.",
        compiledPrompt: "Use a research-first briefing with sections for Papers and Tools.",
        deliveryChannel: "telegram",
        keywords: ["frontier research"],
        promotionThreshold: 5,
        stagingThreshold: 2,
        sources: [
          {
            id: "web-1",
            type: "web_search",
            query: "frontier research updates",
          },
        ],
      },
    });

    expect(sendAgentMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        agent: "main",
        session: "watch:alpha",
      }),
    );
    expect(sendAgentMessage.mock.calls[0]?.[1]?.channel).toBeUndefined();
    expect(result.delivered).toBe(false);
  });

  it("asks for the project when a watch request is ambiguous", async () => {
    await writeProjectManifest(manifest("beta"), join(ROOT, "state"));

    const result = await handleWatchConversation({
      config: makeConfig(),
      channel: "telegram",
      userId: "123",
      message: "Schedule frontier news every morning at 8am",
    });

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Which project");
    expect(result.response).toContain("alpha");
    expect(result.response).toContain("beta");
  });

  it("does not intercept ordinary capture text", async () => {
    const result = await handleWatchConversation({
      config: makeConfig(),
      channel: "telegram",
      userId: "123",
      message: "We decided to sequence the alpha cohort next.",
    });

    expect(result.handled).toBe(false);
  });

  it("does not intercept ordinary update or tracking messages", async () => {
    await expect(handleWatchConversation({
      config: makeConfig(),
      channel: "telegram",
      userId: "123",
      message: "Update me on the alpha project now.",
    })).resolves.toMatchObject({ handled: false });

    await expect(handleWatchConversation({
      config: makeConfig(),
      channel: "telegram",
      userId: "123",
      message: "Track the code changes from this morning.",
    })).resolves.toMatchObject({ handled: false });
  });
});
