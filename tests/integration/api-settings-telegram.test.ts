import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_TELEGRAM_BOT_TOKEN } from "../helpers/telegram-fixtures";

const mockIsLocalRequest = vi.hoisted(() => vi.fn());
const mockGetOpenClawStatus = vi.hoisted(() => vi.fn());
const mockTelegramRun = vi.hoisted(() => vi.fn());
const mockListPendingTelegramPairingRequests = vi.hoisted(() => vi.fn());
const mockSelectLatestPendingTelegramPairing = vi.hoisted(() => vi.fn());
const mockApproveTelegramPairingRequest = vi.hoisted(() => vi.fn());
const mockPreapproveTelegramUserId = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockParseEnvFile = vi.hoisted(() => vi.fn());
const mockMergeEnvValues = vi.hoisted(() => vi.fn());
const mockSerializeEnvDocument = vi.hoisted(() => vi.fn());
const mockWriteEnvFileAtomic = vi.hoisted(() => vi.fn());

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: mockIsLocalRequest,
}));

vi.mock("@/lib/openclaw-status", () => ({
  getOpenClawStatus: mockGetOpenClawStatus,
}));

vi.mock("@/lib/openclaw/telegram-link", () => ({
  listPendingTelegramPairingRequests: mockListPendingTelegramPairingRequests,
  selectLatestPendingTelegramPairing: mockSelectLatestPendingTelegramPairing,
  approveTelegramPairingRequest: mockApproveTelegramPairingRequest,
  preapproveTelegramUserId: mockPreapproveTelegramUserId,
}));

vi.mock("@/lib/setup/install-tasks/telegram-bot", () => ({
  telegramBotTask: {
    run: mockTelegramRun,
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

vi.mock("@/lib/setup/env-writer", () => ({
  parseEnvFile: mockParseEnvFile,
  mergeEnvValues: mockMergeEnvValues,
  serializeEnvDocument: mockSerializeEnvDocument,
  writeEnvFileAtomic: mockWriteEnvFileAtomic,
}));

import { GET, POST } from "@/app/api/settings/telegram/route";

function parseSseFrames(body: string): unknown[] {
  return body
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data:\s*/, "")) as unknown);
}

describe("POST /api/settings/telegram", () => {
  beforeEach(() => {
    mockIsLocalRequest.mockResolvedValue(true);
    mockGetOpenClawStatus.mockResolvedValue({
      installed: true,
      configured: true,
      running: true,
      version: "2026.4.5",
      model: "openai/gpt-5.4",
      configPath: "~/.scienceswarm/openclaw/openclaw.json",
      source: "system",
      steps: { install: true, configure: true, start: true },
    });
    mockTelegramRun.mockReset();
    mockListPendingTelegramPairingRequests.mockReset();
    mockSelectLatestPendingTelegramPairing.mockReset();
    mockApproveTelegramPairingRequest.mockReset();
    mockPreapproveTelegramUserId.mockReset();
    mockReadFile.mockReset();
    mockParseEnvFile.mockReset();
    mockMergeEnvValues.mockReset();
    mockSerializeEnvDocument.mockReset();
    mockWriteEnvFileAtomic.mockReset();
    mockReadFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    mockParseEnvFile.mockReturnValue({ lines: [], newline: "\n", trailingNewline: true });
    mockMergeEnvValues.mockReturnValue({ lines: [], newline: "\n", trailingNewline: true });
    mockSerializeEnvDocument.mockReturnValue("TELEGRAM_USER_ID=8325267942\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("streams Telegram setup events for a reused bot token", async () => {
    let capturedInput: unknown = null;
    mockTelegramRun.mockImplementationOnce(async function* (input: unknown) {
      capturedInput = input;
      yield {
        status: "running",
        detail: "Reusing existing Telegram bot token…",
      };
      yield {
        status: "succeeded",
        detail: "Mistbun — your ScienceSwarm claw — https://t.me/mistbun_test_bot",
      };
    });

    const response = await POST(
      new Request("http://localhost/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "reuse",
          handle: "seiji",
          email: "s@example.com",
          botToken: TEST_TELEGRAM_BOT_TOKEN,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(capturedInput).toMatchObject({
      handle: "seiji",
      telegramMode: "reuse",
      existingBot: {
        token: TEST_TELEGRAM_BOT_TOKEN,
      },
      repoRoot: process.cwd(),
    });

    const frames = parseSseFrames(await response.text());
    expect(frames).toEqual([
      {
        type: "task",
        task: "telegram-bot",
        status: "running",
        detail: "Reusing existing Telegram bot token…",
      },
      {
        type: "task",
        task: "telegram-bot",
        status: "succeeded",
        detail: "Mistbun — your ScienceSwarm claw — https://t.me/mistbun_test_bot",
      },
      {
        type: "summary",
        status: "ok",
        failed: [],
        skipped: [],
      },
    ]);
  });

  it("rejects Settings Telegram wiring when OpenClaw is external", async () => {
    mockGetOpenClawStatus.mockResolvedValueOnce({
      installed: true,
      configured: true,
      running: true,
      version: null,
      model: null,
      configPath: null,
      source: "external",
      steps: { install: true, configure: true, start: true },
    });

    const response = await POST(
      new Request("http://localhost/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "reuse",
          handle: "seiji",
          botToken: TEST_TELEGRAM_BOT_TOKEN,
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "OpenClaw is attached to an external runtime. Configure Telegram on that OpenClaw instance directly.",
    });
    expect(mockTelegramRun).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON field types before touching the Telegram task", async () => {
    const response = await POST(
      new Request("http://localhost/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "reuse",
          handle: 123,
          botToken: TEST_TELEGRAM_BOT_TOKEN,
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid body",
    });
    expect(mockTelegramRun).not.toHaveBeenCalled();
  });

  it("approves the latest pending Telegram pairing and persists the user id", async () => {
    const pendingRequest = {
      id: "8325267942",
      code: "2JJCSUNN",
      meta: {
        username: "polarbear55555",
        firstName: "Seiji",
        accountId: "default",
      },
    };
    mockListPendingTelegramPairingRequests.mockResolvedValueOnce([pendingRequest]);
    mockSelectLatestPendingTelegramPairing.mockReturnValueOnce(pendingRequest);
    mockApproveTelegramPairingRequest.mockResolvedValueOnce(true);
    mockPreapproveTelegramUserId.mockResolvedValueOnce({
      allowlistReady: true,
      warning: null,
    });

    const response = await POST(
      new Request("http://localhost/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve-pending",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      userId: "8325267942",
      warning: null,
    });
    expect(mockApproveTelegramPairingRequest).toHaveBeenCalledWith(pendingRequest);
    expect(mockPreapproveTelegramUserId).toHaveBeenCalledWith("8325267942");
    expect(mockWriteEnvFileAtomic).toHaveBeenCalled();
  });
});

describe("GET /api/settings/telegram", () => {
  beforeEach(() => {
    mockIsLocalRequest.mockResolvedValue(true);
    mockGetOpenClawStatus.mockResolvedValue({
      installed: true,
      configured: true,
      running: true,
      version: "2026.4.5",
      model: "openai/gpt-5.4",
      configPath: "~/.scienceswarm/openclaw/openclaw.json",
      source: "system",
      steps: { install: true, configure: true, start: true },
    });
    mockListPendingTelegramPairingRequests.mockReset();
    mockSelectLatestPendingTelegramPairing.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the latest pending Telegram pairing summary", async () => {
    const pendingRequest = {
      id: "8325267942",
      code: "2JJCSUNN",
      meta: {
        username: "polarbear55555",
        firstName: "Seiji",
        lastName: "Yamamoto",
      },
      createdAt: "2026-04-20T18:00:00.000Z",
      lastSeenAt: "2026-04-20T18:01:00.000Z",
    };
    mockListPendingTelegramPairingRequests.mockResolvedValueOnce([pendingRequest]);
    mockSelectLatestPendingTelegramPairing.mockReturnValueOnce(pendingRequest);

    const response = await GET(new Request("http://localhost/api/settings/telegram"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pendingPairing: {
        userId: "8325267942",
        username: "polarbear55555",
        firstName: "Seiji",
        lastName: "Yamamoto",
        createdAt: "2026-04-20T18:00:00.000Z",
        lastSeenAt: "2026-04-20T18:01:00.000Z",
      },
    });
  });

  it("returns null pending pairing when OpenClaw is external", async () => {
    mockGetOpenClawStatus.mockResolvedValueOnce({
      installed: true,
      configured: true,
      running: true,
      version: null,
      model: null,
      configPath: null,
      source: "external",
      steps: { install: true, configure: true, start: true },
    });

    const response = await GET(new Request("http://localhost/api/settings/telegram"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ pendingPairing: null });
    expect(mockListPendingTelegramPairingRequests).not.toHaveBeenCalled();
  });
});
