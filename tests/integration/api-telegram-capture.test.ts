import path from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrain } from "@/brain/init";
import { writeProjectManifest } from "@/lib/state/project-manifests";
import type { ProjectManifest } from "@/brain/types";
import {
  handleTelegramDocumentMessage,
  handleTelegramTextMessage,
} from "@/lib/telegram-capture-handler";

const ROOT = path.join(tmpdir(), "scienceswarm-telegram-capture");

const {
  parseFile,
  checkRateLimit,
  loadBrainConfig,
  connectGbrain,
} = vi.hoisted(() => ({
  parseFile: vi.fn(),
  checkRateLimit: vi.fn(),
  loadBrainConfig: vi.fn(),
  connectGbrain: vi.fn(),
}));

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

function manifest(slug: string): ProjectManifest {
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

beforeEach(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  // Decision 3A: capture writes thread getCurrentUserHandle().
  process.env.SCIENCESWARM_USER_HANDLE = "@test-researcher";
  initBrain({ root: ROOT, name: "Test Researcher" });
  await writeProjectManifest(manifest("alpha"), path.join(ROOT, "state"));
  await writeProjectManifest(manifest("beta"), path.join(ROOT, "state"));
  checkRateLimit.mockReturnValue({ allowed: true, resetMs: 0 });
  loadBrainConfig.mockReturnValue({
    root: ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  });
  connectGbrain.mockResolvedValue({
    success: true,
    message: "connected",
    brainRoot: ROOT,
    wikiCreated: true,
  });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.SCIENCESWARM_USER_HANDLE;
  vi.unstubAllGlobals();
  parseFile.mockReset();
  checkRateLimit.mockReset();
  loadBrainConfig.mockReset();
  connectGbrain.mockReset();
});

describe("telegram capture handlers", () => {
  it("uses the clarification flow for text captures", async () => {
    const firstReply = vi.fn().mockResolvedValue(undefined);
    await handleTelegramTextMessage({
      from: { id: 123 },
      message: { text: "Need to follow up on the assay." },
      reply: firstReply,
    });

    expect(firstReply).toHaveBeenCalledWith(
      expect.stringContaining("Which study should this capture belong to?"),
      expect.any(Object),
    );

    const secondReply = vi.fn().mockResolvedValue(undefined);
    await handleTelegramTextMessage({
      from: { id: 123 },
      message: { text: "alpha" },
      reply: secondReply,
    });

    expect(secondReply).toHaveBeenCalledWith(
      expect.stringContaining("Capture saved."),
      expect.any(Object),
    );
  });

  it("processes uploaded documents through the same capture pipeline", async () => {
    parseFile.mockResolvedValue({
      text: "Decision: proceed with alpha sequencing.",
      pages: 2,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(Buffer.from("pdf-bytes")),
    ));

    const reply = vi.fn().mockResolvedValue(undefined);
    await handleTelegramDocumentMessage({
      from: { id: 456 },
      message: {
        document: {
          file_id: "file-1",
          file_name: "plan.pdf",
          file_size: 128,
        },
      },
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: "documents/plan.pdf" }),
      },
      reply,
    }, "telegram-token");

    expect(parseFile).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Which study should this capture belong to?"),
      expect.any(Object),
    );
  });

  it("setup always succeeds with PGLite — no pre-initialization required", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);

    await handleTelegramTextMessage({
      from: { id: 777 },
      message: { text: "set up my research brain" },
      reply,
    });

    expect(connectGbrain).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Your research brain is ready!"),
      expect.any(Object),
    );
    expect(loadBrainConfig).not.toHaveBeenCalled();
  });

  it("setup is idempotent — repeated requests succeed", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    await handleTelegramTextMessage({
      from: { id: 888 },
      message: { text: "set up my brain" },
      reply,
    });

    expect(connectGbrain).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Your research brain is ready!"),
      expect.any(Object),
    );
    expect(loadBrainConfig).not.toHaveBeenCalled();
  });

  it("reports setup failures with a setup-specific message", async () => {
    connectGbrain.mockResolvedValue({
      success: false,
      message: "PGLite init failed",
      brainRoot: ROOT,
    });

    const reply = vi.fn().mockResolvedValue(undefined);
    await handleTelegramTextMessage({
      from: { id: 889 },
      message: { text: "set up my brain" },
      reply,
    });

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("I couldn't initialize your research brain yet."),
      expect.any(Object),
    );
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("PGLite init failed"),
      expect.any(Object),
    );
    expect(loadBrainConfig).not.toHaveBeenCalled();
  });

  it("does not parse failed Telegram file downloads", async () => {
    parseFile.mockResolvedValue({
      text: "This should not be parsed.",
      pages: 1,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("Bad gateway", { status: 502 }),
    ));

    const reply = vi.fn().mockResolvedValue(undefined);
    await handleTelegramDocumentMessage({
      from: { id: 456 },
      message: {
        document: {
          file_id: "file-1",
          file_name: "plan.pdf",
          file_size: 128,
        },
      },
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: "documents/plan.pdf" }),
      },
      reply,
    }, "telegram-token");

    expect(parseFile).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      "Could not download the file from Telegram.",
      expect.any(Object),
    );
  });
});
