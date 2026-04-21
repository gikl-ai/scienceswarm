import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TelegramBotApiError,
  buildStartDeeplink,
  deleteWebhook,
  getMe,
  getUpdates,
  getWebhookInfo,
} from "@/lib/telegram/bot-api";

function telegramResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("telegram bot api helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls getMe and returns the bot identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      telegramResponse({
        ok: true,
        result: { id: 123, username: "science_bot", first_name: "Science" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getMe("123:token")).resolves.toEqual({
      id: 123,
      username: "science_bot",
      first_name: "Science",
    });

    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.toString()).toBe("https://api.telegram.org/bot123:token/getMe");
  });

  it("surfaces invalid tokens as unauthorized errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        telegramResponse(
          {
            ok: false,
            error_code: 401,
            description: "Unauthorized",
          },
          401,
        ),
      ),
    );

    await expect(getMe("bad")).rejects.toMatchObject({
      unauthorized: true,
      errorCode: 401,
    } satisfies Partial<TelegramBotApiError>);
  });

  it("surfaces polling conflicts from getUpdates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        telegramResponse(
          {
            ok: false,
            error_code: 409,
            description: "Conflict: terminated by other getUpdates request",
          },
          409,
        ),
      ),
    );

    await expect(
      getUpdates("123:token", { timeout: 30 }),
    ).rejects.toMatchObject({
      conflict: true,
      errorCode: 409,
    } satisfies Partial<TelegramBotApiError>);
  });

  it("passes webhook and update polling parameters through Telegram query params", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        telegramResponse({
          ok: true,
          result: { url: "https://example.test/hook", pending_update_count: 4 },
        }),
      )
      .mockResolvedValueOnce(telegramResponse({ ok: true, result: true }))
      .mockResolvedValueOnce(telegramResponse({ ok: true, result: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getWebhookInfo("123:token")).resolves.toMatchObject({
      url: "https://example.test/hook",
    });
    await deleteWebhook("123:token", true);
    await getUpdates("123:token", {
      offset: 42,
      timeout: 0,
      allowed_updates: ["message"],
    });

    const deleteUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(deleteUrl.pathname).toBe("/bot123:token/deleteWebhook");
    expect(deleteUrl.searchParams.get("drop_pending_updates")).toBe("true");

    const updatesUrl = fetchMock.mock.calls[2]?.[0] as URL;
    expect(updatesUrl.pathname).toBe("/bot123:token/getUpdates");
    expect(updatesUrl.searchParams.get("offset")).toBe("42");
    expect(updatesUrl.searchParams.get("timeout")).toBe("0");
    expect(updatesUrl.searchParams.get("allowed_updates")).toBe(
      JSON.stringify(["message"]),
    );
  });

  it("omits undefined query parameters instead of serializing them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      telegramResponse({
        ok: true,
        result: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getUpdates("123:token", {
      offset: undefined,
      timeout: 30,
      allowed_updates: ["message"],
    });

    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.has("offset")).toBe(false);
    expect(url.searchParams.get("timeout")).toBe("30");
  });

  it("builds Telegram start deeplinks from the canonical username", () => {
    expect(buildStartDeeplink("@science_bot", "abc123")).toBe(
      "https://t.me/science_bot?start=abc123",
    );
  });
});
