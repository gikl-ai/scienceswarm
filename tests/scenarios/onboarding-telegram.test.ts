/**
 * Scenario: Telegram onboarding journey
 *
 * Journey: setup -> capture hypothesis -> configure frontier watch
 *
 * ASPIRATIONAL — some steps WILL fail because features are not yet wired.
 * Each failure becomes a development task.
 */
import path from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import { writeProjectManifest } from "@/lib/state/project-manifests";
import type { BrainConfig, ProjectManifest } from "@/brain/types";
import {
  handleTelegramTextMessage,
} from "@/lib/telegram-capture-handler";
import { handleWatchConversation } from "@/lib/watch/conversation";

const ROOT = path.join(tmpdir(), "scienceswarm-scenario-telegram");

// ── Hoisted mocks ─────────────────────────────────────

const {
  parseFile,
  checkRateLimit,
  loadBrainConfig,
  connectGbrain,
  healthCheck,
  sendAgentMessage,
  scheduleJob,
  deleteJob,
  getJobs,
  scheduledJobs,
} = vi.hoisted(() => {
  const jobs: Array<Record<string, unknown>> = [];
  return {
    parseFile: vi.fn(),
    checkRateLimit: vi.fn(),
    loadBrainConfig: vi.fn(),
    connectGbrain: vi.fn(),
    healthCheck: vi.fn(),
    sendAgentMessage: vi.fn(),
    scheduledJobs: jobs,
    scheduleJob: vi.fn((job: Record<string, unknown>) => {
      const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      jobs.push({ ...job, id });
      return id;
    }),
    deleteJob: vi.fn((id: string) => {
      const index = jobs.findIndex((j) => j.id === id);
      if (index >= 0) jobs.splice(index, 1);
    }),
    getJobs: vi.fn(() => jobs),
  };
});

vi.mock("@/lib/file-parser", () => ({
  parseFile,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit,
}));

vi.mock("@/brain/config", () => ({
  loadBrainConfig,
}));

vi.mock("@/brain/connect-gbrain", () => ({
  connectGbrain,
}));

vi.mock("@/lib/openclaw", () => ({
  healthCheck,
  sendAgentMessage,
}));

vi.mock("@/lib/scheduler", () => ({
  scheduleJob,
  deleteJob,
  getJobs,
}));

// ── Helpers ───────────────────────────────────────────

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
    updatedAt: "2026-04-11T00:00:00.000Z",
  };
}

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

beforeEach(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  // Decision 3A: capture writes thread getCurrentUserHandle().
  vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
  initBrain({ root: ROOT, name: "Test Researcher" });
  await writeProjectManifest(manifest("sae-research"), path.join(ROOT, "state"));
  await writeProjectManifest(manifest("assay-drift"), path.join(ROOT, "state"));
  checkRateLimit.mockReturnValue({ allowed: true, resetMs: 0 });
  loadBrainConfig.mockReturnValue(makeConfig());
  connectGbrain.mockResolvedValue({
    success: true,
    message: "connected",
    brainRoot: ROOT,
    wikiCreated: true,
  });
  vi.stubEnv("OPENAI_API_KEY", "");
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  parseFile.mockReset();
  checkRateLimit.mockReset();
  loadBrainConfig.mockReset();
  connectGbrain.mockReset();
  healthCheck.mockReset();
  sendAgentMessage.mockReset();
  scheduleJob.mockClear();
  deleteJob.mockClear();
  getJobs.mockClear();
  scheduledJobs.splice(0);
});

describe("Telegram onboarding: setup -> capture -> frontier watch", () => {
  it("step 1: 'set up my brain' initializes brain via Telegram", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);

    await handleTelegramTextMessage({
      from: { id: 100 },
      message: { text: "set up my brain" },
      reply,
    });

    expect(connectGbrain).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Your research brain is ready!"),
      expect.any(Object),
    );
  });

  it("step 2: capture a hypothesis and confirm it saved", async () => {
    // First message: raw hypothesis text -> clarification asking for project
    const firstReply = vi.fn().mockResolvedValue(undefined);
    await handleTelegramTextMessage({
      from: { id: 100 },
      message: {
        text: "Hypothesis: TopK activation preserves rare feature patterns better than L1 penalty in sparse autoencoders",
      },
      reply: firstReply,
    });

    expect(firstReply).toHaveBeenCalledWith(
      expect.stringContaining("Which study should this capture belong to?"),
      expect.any(Object),
    );

    // Second message: user picks the project
    const secondReply = vi.fn().mockResolvedValue(undefined);
    await handleTelegramTextMessage({
      from: { id: 100 },
      message: { text: "sae-research" },
      reply: secondReply,
    });

    expect(secondReply).toHaveBeenCalledWith(
      expect.stringContaining("Capture saved."),
      expect.any(Object),
    );
  });

  it("step 3: configure frontier watch via natural language", async () => {
    const result = await handleWatchConversation({
      config: makeConfig(),
      channel: "telegram",
      userId: "100",
      message:
        "Track sparse autoencoder research news every weekday at 8am for project sae-research",
      timezone: "America/Los_Angeles",
    });

    expect(result.handled).toBe(true);
    expect(result.response).toContain("Configured");
    expect(result.response).toContain("frontier watch");
  });
});
