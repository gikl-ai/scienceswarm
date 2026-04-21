import { describe, expect, it, vi } from "vitest";
import { Api } from "telegram";

import { createBotViaBotFather } from "@/lib/telegram/create-bot";
import { TEST_TELEGRAM_BOT_TOKEN_BOTFATHER } from "../helpers/telegram-fixtures";

function makeBotFatherUser(): Api.User {
  return new Api.User({
    id: "93372553" as never,
    accessHash: "1" as never,
    firstName: "BotFather",
    username: "BotFather",
  });
}

describe("createBotViaBotFather", () => {
  it("falls back to a cached BotFather dialog when ResolveUsername is blocked", async () => {
    const botFather = makeBotFatherUser();
    let lastSent = "";
    let messageId = 0;

    const client = {
      getMe: vi.fn().mockResolvedValue({
        id: { toString: () => "8647564254" },
      }),
      invoke: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "400: USERNAME_NOT_OCCUPIED (caused by contacts.ResolveUsername)",
          ),
        ),
      getDialogs: vi.fn().mockResolvedValue([{ entity: botFather }]),
      sendMessage: vi.fn().mockImplementation(async (_peer, input) => {
        lastSent = input.message;
      }),
      getMessages: vi.fn().mockImplementation(async () => {
        if (lastSent === "") {
          return [{ id: 0, senderId: { toString: () => "93372553" }, message: "" }];
        }
        messageId += 1;
        if (lastSent === "/newbot") {
          return [
            {
              id: messageId,
              senderId: { toString: () => "93372553" },
              message:
                "Alright, a new bot. How are we going to call it? Please choose a name for your bot.",
            },
          ];
        }
        if (lastSent.includes("ScienceSwarm claw")) {
          return [
            {
              id: messageId,
              senderId: { toString: () => "93372553" },
              message:
                "Good. Now let's choose a username for your bot. It must end in `bot`.",
            },
          ];
        }
        return [
          {
            id: messageId,
            senderId: { toString: () => "93372553" },
            message: `Done! Congratulations on your new bot. You will find it at t.me/${lastSent}.

Use this token to access the HTTP API:
${TEST_TELEGRAM_BOT_TOKEN_BOTFATHER}`,
          },
        ];
      }),
    };

    const result = await createBotViaBotFather(client as never, "seiji");

    expect(client.getDialogs).toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith(botFather, {
      message: "/newbot",
    });
    expect(result.username).toMatch(/_seiji_bot$/);
    expect(result.token).toBe(TEST_TELEGRAM_BOT_TOKEN_BOTFATHER);
  });

  it("surfaces a manual-BotFather hint when lookup fails and no cached dialog exists", async () => {
    const client = {
      getMe: vi.fn().mockResolvedValue({
        id: { toString: () => "8647564254" },
      }),
      invoke: vi
        .fn()
        .mockRejectedValue(
          new Error("420: FROZEN_METHOD_INVALID (caused by contacts.Search)"),
        ),
      getDialogs: vi.fn().mockResolvedValue([]),
    };

    await expect(
      createBotViaBotFather(client as never, "seiji"),
    ).rejects.toThrow(/Open a BotFather chat manually in Telegram once, then retry/);
  });
});
