import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mocks = vi.hoisted(() => ({
  runOpenClaw: vi.fn(),
  spawnOpenClaw: vi.fn(),
  writeGatewayPid: vi.fn(),
  resolveOpenClawMode: vi.fn(),
  telegramCredentialsConfigured: vi.fn(),
  sendCode: vi.fn(),
  submitCode: vi.fn(),
  abortSession: vi.fn(),
  createBotViaBotFather: vi.fn(),
  saveSession: vi.fn(),
  getMe: vi.fn(),
  getWebhookInfo: vi.fn(),
  deleteWebhook: vi.fn(),
  getUpdates: vi.fn(),
  generateNonce: vi.fn(),
  buildStartDeeplink: vi.fn(),
}));

vi.mock("@/lib/openclaw/runner", () => ({
  runOpenClaw: mocks.runOpenClaw,
  spawnOpenClaw: mocks.spawnOpenClaw,
  writeGatewayPid: mocks.writeGatewayPid,
  resolveOpenClawMode: mocks.resolveOpenClawMode,
}));

vi.mock("@/lib/telegram/constants", () => ({
  telegramCredentialsConfigured: mocks.telegramCredentialsConfigured,
}));

vi.mock("@/lib/telegram/sign-in", () => ({
  sendCode: mocks.sendCode,
  submitCode: mocks.submitCode,
  abortSession: mocks.abortSession,
}));

vi.mock("@/lib/telegram/create-bot", () => ({
  createBotViaBotFather: mocks.createBotViaBotFather,
}));

vi.mock("@/lib/telegram/session-store", () => ({
  TelegramSessionStore: class {
    async save(session: string): Promise<void> {
      await mocks.saveSession(session);
    }
  },
}));

vi.mock("@/lib/telegram/bot-api", () => {
  class TelegramBotApiError extends Error {
    constructor(
      message: string,
      readonly errorCode?: number,
    ) {
      super(message);
      this.name = "TelegramBotApiError";
    }

    get unauthorized(): boolean {
      return this.errorCode === 401;
    }

    get conflict(): boolean {
      return this.errorCode === 409;
    }
  }

  return {
    TelegramBotApiError,
    getMe: mocks.getMe,
    getWebhookInfo: mocks.getWebhookInfo,
    deleteWebhook: mocks.deleteWebhook,
    getUpdates: mocks.getUpdates,
    generateNonce: mocks.generateNonce,
    buildStartDeeplink: mocks.buildStartDeeplink,
  };
});

import {
  pendingCodes,
  telegramBotTask,
} from "@/lib/setup/install-tasks/telegram-bot";
import { TelegramBotApiError } from "@/lib/telegram/bot-api";

describe("telegramBotTask OpenClaw wiring", () => {
  let repoRoot: string;
  let openclawStateDir: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-telegram-task-"),
    );
    await fs.writeFile(path.join(repoRoot, ".env"), "", "utf8");
    openclawStateDir = path.join(repoRoot, ".scienceswarm", "openclaw");

    mocks.runOpenClaw.mockReset();
    mocks.spawnOpenClaw.mockReset();
    mocks.writeGatewayPid.mockReset();
    mocks.resolveOpenClawMode.mockReset();
    mocks.telegramCredentialsConfigured.mockReset();
    mocks.sendCode.mockReset();
    mocks.submitCode.mockReset();
    mocks.abortSession.mockReset();
    mocks.createBotViaBotFather.mockReset();
    mocks.saveSession.mockReset();
    mocks.getMe.mockReset();
    mocks.getWebhookInfo.mockReset();
    mocks.deleteWebhook.mockReset();
    mocks.getUpdates.mockReset();
    mocks.generateNonce.mockReset();
    mocks.buildStartDeeplink.mockReset();

    mocks.resolveOpenClawMode.mockReturnValue({
      kind: "state-dir",
      stateDir: openclawStateDir,
      configPath: path.join(openclawStateDir, "openclaw.json"),
    });
    mocks.telegramCredentialsConfigured.mockReturnValue(true);
    mocks.sendCode.mockResolvedValue({ sessionId: "session-123" });
    mocks.submitCode.mockResolvedValue({
      sessionString: "telegram-session",
      client: {
        getMe: vi.fn().mockResolvedValue({ id: 8647564254 }),
        disconnect: vi.fn().mockResolvedValue(undefined),
      },
    });
    mocks.createBotViaBotFather.mockResolvedValue({
      token: "123:bot-token",
      username: "mistbun_seiji_bot",
      creature: "mistbun",
      displayName: "Mistbun — your ScienceSwarm claw",
    });
    mocks.runOpenClaw.mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
      code: 0,
    });
    mocks.spawnOpenClaw.mockReturnValue({
      pid: 4242,
      unref: vi.fn(),
    });
    mocks.getMe.mockResolvedValue({
      id: 12345,
      username: "mistbun_seiji_bot",
      first_name: "Mistbun",
    });
    mocks.getWebhookInfo.mockResolvedValue({ url: "", pending_update_count: 0 });
    mocks.deleteWebhook.mockResolvedValue(undefined);
    mocks.getUpdates.mockResolvedValue([]);
    mocks.generateNonce.mockReturnValue("claim-nonce");
    mocks.buildStartDeeplink.mockImplementation(
      (username: string, nonce: string) =>
        `https://t.me/${username}?start=${nonce}`,
    );
  });

  afterEach(async () => {
    pendingCodes.clear();
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("reuses an existing bot from .env without hitting BotFather again", async () => {
    mocks.getMe.mockResolvedValueOnce({
      id: 12345,
      username: "plumpbadger_seiji_z1d7_bot",
      first_name: "Plumpbadger",
    });
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=123:bot-token",
        "TELEGRAM_BOT_USERNAME=plumpbadger_seiji_z1d7_bot",
        "TELEGRAM_BOT_CREATURE=plumpbadger",
        "TELEGRAM_USER_ID=8647564254",
        "",
      ].join("\n"),
      "utf8",
    );

    const events: Array<{ status: string; detail?: string }> = [];
    for await (const event of telegramBotTask.run({
      handle: "seiji",
      phone: "+15555550123",
      repoRoot,
    })) {
      events.push(event);
    }

    expect(mocks.sendCode).not.toHaveBeenCalled();
    expect(mocks.submitCode).not.toHaveBeenCalled();
    expect(mocks.createBotViaBotFather).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Reusing existing Telegram bot token…",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "succeeded",
        detail:
          "Plumpbadger — your ScienceSwarm claw — https://t.me/plumpbadger_seiji_z1d7_bot",
      }),
    );
  });

  it("honors explicit fresh mode and creates a new bot even when .env already has one", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=123:old-token",
        "TELEGRAM_BOT_USERNAME=old_bot",
        "TELEGRAM_BOT_CREATURE=oldcreature",
        "TELEGRAM_USER_ID=8647564254",
        "",
      ].join("\n"),
      "utf8",
    );

    const events: Array<{ status: string; detail?: string }> = [];
    const iterator = telegramBotTask.run({
      handle: "seiji",
      phone: "+15555550123",
      telegramMode: "fresh",
      repoRoot,
    });

    await iterator.next();
    const waiting = await iterator.next();
    expect(waiting.value).toMatchObject({
      status: "waiting-for-input",
      sessionId: "session-123",
    });

    const resumedPromise = iterator.next();
    pendingCodes.get("session-123")?.("123456");
    const resumed = await resumedPromise;
    if (!resumed.done) {
      events.push(resumed.value);
    }

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(mocks.sendCode).toHaveBeenCalledWith("+15555550123");
    expect(mocks.createBotViaBotFather).toHaveBeenCalled();
    expect(mocks.runOpenClaw).toHaveBeenCalledWith(
      ["channels", "add", "--channel", "telegram", "--token", "123:bot-token"],
      { timeoutMs: 15_000 },
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "succeeded",
        detail: "Mistbun — your ScienceSwarm claw — https://t.me/mistbun_seiji_bot",
      }),
    );
  });

  it("does not mutate Telegram or OpenClaw channel wiring for existing profile mode bots", async () => {
    mocks.getMe.mockResolvedValueOnce({
      id: 12345,
      username: "project_alpha_bot",
      first_name: "Project Alpha",
    });
    mocks.resolveOpenClawMode.mockReturnValue({
      kind: "profile",
      profile: "project-alpha",
    });
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=123:bot-token",
        "TELEGRAM_BOT_USERNAME=project_alpha_bot",
        "TELEGRAM_BOT_CREATURE=project-alpha",
        "",
      ].join("\n"),
      "utf8",
    );

    const events: Array<{ status: string; detail?: string }> = [];
    for await (const event of telegramBotTask.run({
      handle: "seiji",
      phone: "+15555550123",
      repoRoot,
    })) {
      events.push(event);
    }

    expect(mocks.sendCode).not.toHaveBeenCalled();
    expect(mocks.submitCode).not.toHaveBeenCalled();
    expect(mocks.createBotViaBotFather).not.toHaveBeenCalled();
    expect(mocks.runOpenClaw).not.toHaveBeenCalled();
    expect(mocks.spawnOpenClaw).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        status: "running",
        detail: "Validating saved Telegram bot token…",
      },
      {
        status: "running",
        detail: 'Using existing OpenClaw profile "project-alpha" for Telegram.',
      },
      {
        status: "succeeded",
        detail:
          "Project-alpha — your ScienceSwarm claw — https://t.me/project_alpha_bot",
      },
    ]);
  });

  it("recovers TELEGRAM_USER_ID for a pasted existing bot token with a nonce claim", async () => {
    mocks.getMe.mockResolvedValueOnce({
      id: 12345,
      username: "plumpbadger_seiji_z1d7_bot",
      first_name: "Plumpbadger",
    });
    mocks.getUpdates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          update_id: 10,
          message: {
            text: "/start claim-nonce",
            from: { id: 8647564254 },
          },
        },
      ]);
    const iterator = telegramBotTask.run({
      handle: "seiji",
      existingBot: { token: "123:bot-token" },
      repoRoot,
    });

    await iterator.next();
    await iterator.next();
    const waiting = await iterator.next();
    expect(waiting.value).toMatchObject({
      status: "waiting-for-input",
      needs: "telegram-nonce-claim",
      nonceClaim: {
        deeplink:
          "https://t.me/plumpbadger_seiji_z1d7_bot?start=claim-nonce",
        botUsername: "plumpbadger_seiji_z1d7_bot",
      },
    });

    const events: Array<{ status: string; detail?: string }> = [];
    const resumed = await iterator.next();
    if (!resumed.done) {
      events.push(resumed.value);
    }

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(mocks.sendCode).not.toHaveBeenCalled();
    expect(mocks.submitCode).not.toHaveBeenCalled();
    expect(mocks.createBotViaBotFather).not.toHaveBeenCalled();
    expect(mocks.getWebhookInfo).toHaveBeenCalledWith("123:bot-token");
    expect(mocks.getUpdates).toHaveBeenCalledWith("123:bot-token", {
      timeout: 0,
      allowed_updates: ["message"],
    });
    const envContents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(envContents).toMatch(/^TELEGRAM_USER_ID=8647564254$/m);
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Reusing existing Telegram bot token…",
      }),
    );
  });

  it("pairs a saved bot without TELEGRAM_USER_ID through OpenClaw before succeeding", async () => {
    mocks.getMe.mockResolvedValueOnce({
      id: 12345,
      username: "plumpbadger_seiji_z1d7_bot",
      first_name: "Plumpbadger",
    });
    mocks.runOpenClaw.mockImplementation(async (args: readonly string[]) => {
      if (args[0] === "pairing" && args[1] === "list") {
        return {
          ok: true,
          stdout: JSON.stringify({
            channel: "telegram",
            requests: [
              {
                id: "8647564254",
                code: "PAIR1234",
                createdAt: "2026-04-19T18:26:42.170Z",
                lastSeenAt: "2026-04-19T18:43:26.736Z",
                meta: {
                  username: "project_alpha",
                  firstName: "Project",
                  lastName: "Alpha",
                  accountId: "default",
                },
              },
            ],
          }),
          stderr: "",
          code: 0,
        };
      }
      return {
        ok: true,
        stdout: "",
        stderr: "",
        code: 0,
      };
    });
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=123:bot-token",
        "TELEGRAM_BOT_USERNAME=plumpbadger_seiji_z1d7_bot",
        "TELEGRAM_BOT_CREATURE=plumpbadger",
        "",
      ].join("\n"),
      "utf8",
    );

    const events: Array<{ status: string; detail?: string }> = [];
    for await (const event of telegramBotTask.run({
      handle: "seiji",
      repoRoot,
    })) {
      events.push(event);
    }

    expect(mocks.getWebhookInfo).not.toHaveBeenCalled();
    expect(mocks.getUpdates).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "waiting-for-input",
        needs: "telegram-nonce-claim",
        nonceClaim: {
          deeplink: "https://t.me/plumpbadger_seiji_z1d7_bot",
          botUsername: "plumpbadger_seiji_z1d7_bot",
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Reusing existing Telegram bot token…",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Approving your Telegram account in OpenClaw…",
      }),
    );
    expect(mocks.runOpenClaw).toHaveBeenCalledWith(
      ["pairing", "approve", "telegram", "PAIR1234", "--account", "default"],
      { timeoutMs: 10_000 },
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "succeeded",
        detail:
          "Plumpbadger — your ScienceSwarm claw — https://t.me/plumpbadger_seiji_z1d7_bot",
      }),
    );
    const envContents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(envContents).toMatch(/^TELEGRAM_USER_ID=8647564254$/m);
  });

  it("clears saved Telegram bot metadata when the token is invalid", async () => {
    mocks.getMe.mockRejectedValueOnce(
      new TelegramBotApiError("Unauthorized", 401),
    );
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=123:bot-token",
        "TELEGRAM_BOT_USERNAME=old_bot",
        "TELEGRAM_BOT_CREATURE=oldcreature",
        "TELEGRAM_USER_ID=8647564254",
        "",
      ].join("\n"),
      "utf8",
    );

    const events: Array<{ status: string; error?: string }> = [];
    for await (const event of telegramBotTask.run({
      handle: "seiji",
      repoRoot,
    })) {
      events.push(event);
    }

    expect(mocks.sendCode).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error:
          "Telegram bot token is no longer valid. Start over with a fresh install or paste a new token.",
      }),
    );
    const envContents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(envContents).not.toMatch(/^TELEGRAM_BOT_TOKEN=/m);
    expect(envContents).not.toMatch(/^TELEGRAM_BOT_USERNAME=/m);
    expect(envContents).not.toMatch(/^TELEGRAM_BOT_CREATURE=/m);
    expect(envContents).not.toMatch(/^TELEGRAM_USER_ID=/m);
  });

  it("does not clear a saved bot when a different pasted token is invalid", async () => {
    mocks.getMe.mockRejectedValueOnce(
      new TelegramBotApiError("Unauthorized", 401),
    );
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=123:old-token",
        "TELEGRAM_BOT_USERNAME=old_bot",
        "TELEGRAM_BOT_CREATURE=oldcreature",
        "TELEGRAM_USER_ID=8647564254",
        "",
      ].join("\n"),
      "utf8",
    );

    const events: Array<{ status: string; error?: string }> = [];
    for await (const event of telegramBotTask.run({
      handle: "seiji",
      existingBot: { token: "456:pasted-invalid-token" },
      repoRoot,
    })) {
      events.push(event);
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error:
          "Telegram bot token is no longer valid. Start over with a fresh install or paste a new token.",
      }),
    );
    const envContents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(envContents).toMatch(/^TELEGRAM_BOT_TOKEN=123:old-token$/m);
    expect(envContents).toMatch(/^TELEGRAM_BOT_USERNAME=old_bot$/m);
    expect(envContents).toMatch(/^TELEGRAM_USER_ID=8647564254$/m);
  });

  it("installs and starts the gateway service so Telegram polling survives setup completion", async () => {
    const iterator = telegramBotTask.run({
      handle: "seiji",
      phone: "+15555550123",
      repoRoot,
    });

    await iterator.next();
    const waiting = await iterator.next();
    expect(waiting.value).toMatchObject({
      status: "waiting-for-input",
      sessionId: "session-123",
    });

    const events: Array<{ status: string; detail?: string }> = [];
    const firstResumedStep = iterator.next();
    expect(pendingCodes.has("session-123")).toBe(true);
    pendingCodes.get("session-123")?.("123456");

    const resumed = await firstResumedStep;
    if (!resumed.done) {
      events.push(resumed.value);
    }

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    expect(mocks.runOpenClaw).toHaveBeenCalledWith(
      [
        "config",
        "set",
        "channels.telegram.allowFrom",
        JSON.stringify(["8647564254"]),
        "--strict-json",
      ],
      { timeoutMs: 10_000 },
    );
    expect(mocks.runOpenClaw).toHaveBeenCalledWith(
      ["config", "set", "channels.telegram.dmPolicy", "allowlist"],
      { timeoutMs: 10_000 },
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Restarting OpenClaw gateway to pick up the bot token…",
      }),
    );
    expect(mocks.runOpenClaw).toHaveBeenCalledWith(
      ["gateway", "install", "--force", "--port", "18789"],
      { timeoutMs: 30_000 },
    );
    expect(mocks.runOpenClaw).toHaveBeenCalledWith(
      ["gateway", "start"],
      { timeoutMs: 30_000 },
    );
    expect(mocks.spawnOpenClaw).not.toHaveBeenCalled();
    expect(mocks.writeGatewayPid).not.toHaveBeenCalled();
  });

  it("does not surface raw stderr from channels-add token failures", async () => {
    // We now register the bot via `openclaw channels add --channel
    // telegram --token <token>`, not `openclaw config set
    // channels.telegram.botToken <token>`. If that call fails, the
    // failing argv may echo the bot token back in stderr, so the
    // user-facing warning must redact it.
    mocks.runOpenClaw.mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "failed to add channel with token 123:bot-token",
      code: 1,
    });

    const iterator = telegramBotTask.run({
      handle: "seiji",
      phone: "+15555550123",
      repoRoot,
    });

    await iterator.next();
    await iterator.next();

    const firstResumedStep = iterator.next();
    expect(pendingCodes.has("session-123")).toBe(true);
    pendingCodes.get("session-123")?.("123456");

    const events: Array<{ status: string; detail?: string }> = [];
    const resumed = await firstResumedStep;
    if (!resumed.done) {
      events.push(resumed.value);
    }

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }

    const warning = events.find((event) =>
      event.detail?.includes("could not register the Telegram bot with OpenClaw"),
    );
    expect(warning?.detail).toContain(
      "Check OpenClaw logs to finish wiring the bot.",
    );
    // Crucially: the raw token must NOT appear in the user-facing warning.
    expect(warning?.detail).not.toContain("123:bot-token");
  });

  it("disconnects Telegram when metadata persistence fails", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    mocks.submitCode.mockResolvedValueOnce({
      sessionString: "telegram-session",
      client: {
        getMe: vi.fn().mockResolvedValue({ id: 8647564254 }),
        disconnect,
      },
    });

    await fs.chmod(repoRoot, 0o500);
    try {
      const iterator = telegramBotTask.run({
        handle: "seiji",
        phone: "+15555550123",
        repoRoot,
      });

      await iterator.next();
      await iterator.next();

      const firstResumedStep = iterator.next();
      expect(pendingCodes.has("session-123")).toBe(true);
      pendingCodes.get("session-123")?.("123456");

      const events: Array<{ status: string; error?: string }> = [];
      const resumed = await firstResumedStep;
      if (!resumed.done) {
        events.push(resumed.value);
      }

      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        events.push(next.value);
      }

      expect(events).toContainEqual(
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("Failed to save Telegram metadata"),
        }),
      );
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      await fs.chmod(repoRoot, 0o700);
    }
  });

  it("writes allowFrom and flips dmPolicy to allowlist when the Telegram user id is known", async () => {
    const iterator = telegramBotTask.run({
      handle: "seiji",
      phone: "+15555550123",
      repoRoot,
    });

    await iterator.next();
    await iterator.next();

    const firstResumedStep = iterator.next();
    expect(pendingCodes.has("session-123")).toBe(true);
    pendingCodes.get("session-123")?.("123456");
    await firstResumedStep;

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
    }

    expect(mocks.runOpenClaw).toHaveBeenCalledWith(
      [
        "config",
        "set",
        "channels.telegram.allowFrom",
        JSON.stringify(["8647564254"]),
        "--strict-json",
      ],
      { timeoutMs: 10_000 },
    );
    expect(mocks.runOpenClaw).toHaveBeenCalledWith(
      ["config", "set", "channels.telegram.dmPolicy", "allowlist"],
      { timeoutMs: 10_000 },
    );
    const allowFrom = JSON.parse(
      await fs.readFile(
        path.join(
          openclawStateDir,
          "credentials",
          "telegram-default-allowFrom.json",
        ),
        "utf8",
      ),
    ) as { allowFrom: string[] };
    expect(allowFrom.allowFrom).toContain("8647564254");
    const credentialsStat = await fs.stat(
      path.join(openclawStateDir, "credentials"),
    );
    expect(credentialsStat.mode & 0o777).toBe(0o700);
  });

  it("merges existing OpenClaw config allowFrom entries", async () => {
    mocks.runOpenClaw.mockImplementation(async (args: readonly string[]) => {
      if (
        args[0] === "config" &&
        args[1] === "get" &&
        args[2] === "channels.telegram.allowFrom"
      ) {
        return {
          ok: true,
          stdout: JSON.stringify(["1111111111"]),
          stderr: "",
          code: 0,
        };
      }
      return {
        ok: true,
        stdout: "",
        stderr: "",
        code: 0,
      };
    });

    const iterator = telegramBotTask.run({
      handle: "seiji",
      phone: "+15555550123",
      repoRoot,
    });

    await iterator.next();
    await iterator.next();

    const firstResumedStep = iterator.next();
    expect(pendingCodes.has("session-123")).toBe(true);
    pendingCodes.get("session-123")?.("123456");
    await firstResumedStep;

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
    }

    expect(mocks.runOpenClaw).toHaveBeenCalledWith(
      [
        "config",
        "set",
        "channels.telegram.allowFrom",
        JSON.stringify(["1111111111", "8647564254"]),
        "--strict-json",
      ],
      { timeoutMs: 10_000 },
    );
  });
});
