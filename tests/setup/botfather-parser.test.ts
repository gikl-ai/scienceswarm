import { describe, it, expect } from "vitest";
import { parseBotFatherReply } from "@/lib/telegram/botfather-parser";
import {
  TEST_TELEGRAM_BOT_TOKEN_ALT,
  TEST_TELEGRAM_BOT_TOKEN_BOTFATHER,
} from "../helpers/telegram-fixtures";

describe("parseBotFatherReply", () => {
  it("detects the name prompt", () => {
    const reply =
      "Alright, a new bot. How are we going to call it? Please choose a name for your bot.";
    expect(parseBotFatherReply(reply)).toEqual({ state: "needs-name" });
  });

  it("detects the username prompt", () => {
    const reply =
      "Good. Now let's choose a username for your bot. It must end in `bot`. Like this, for example: TetrisBot or tetris_bot.";
    expect(parseBotFatherReply(reply)).toEqual({ state: "needs-username" });
  });

  it("detects username-taken rejection", () => {
    const reply =
      "Sorry, this username is already taken. Please try something different.";
    expect(parseBotFatherReply(reply)).toEqual({ state: "username-taken" });
  });

  it("detects username-invalid rejection", () => {
    const reply = "Sorry, the username must end in 'bot'.";
    expect(parseBotFatherReply(reply)).toEqual({ state: "username-invalid" });
  });

  it("extracts the HTTP API token from a successful creation message", () => {
    const reply = `Done! Congratulations on your new bot. You will find it at t.me/scienceswarm_seiji_bot. You can now add a description, about section and profile picture for your bot, see /help for a list of commands. By the way, when you've finished creating your cool bot, ping our Bot Support if you want a better username for it. Just make sure the bot is fully operational before you do this.

Use this token to access the HTTP API:
${TEST_TELEGRAM_BOT_TOKEN_BOTFATHER}

Keep your token secure and store it safely, it can be used by anyone to control your bot.`;
    expect(parseBotFatherReply(reply)).toEqual({
      state: "done",
      token: TEST_TELEGRAM_BOT_TOKEN_BOTFATHER,
      username: "scienceswarm_seiji_bot",
    });
  });

  it("returns 'unknown' for unfamiliar text", () => {
    expect(parseBotFatherReply("meow")).toEqual({ state: "unknown" });
  });

  it("picks the bot username (ending in 'bot'), not an earlier t.me link", () => {
    // Regression: BotFather's success message sometimes mentions
    // other t.me links (support, docs, BotFather itself) before the
    // newly-created bot's link. We must grab the one ending in `bot`,
    // not just the first t.me match.
    const reply = `Done! Congratulations on your new bot.

You will find it at t.me/BotFather once you're done — oh wait, that's me.
Actually your bot lives at t.me/wobblefinch_seiji_bot.

Use this token to access the HTTP API:
${TEST_TELEGRAM_BOT_TOKEN_BOTFATHER}

Keep your token secure.`;
    const parsed = parseBotFatherReply(reply);
    expect(parsed).toMatchObject({
      state: "done",
      username: "wobblefinch_seiji_bot",
    });
  });

  it("handles the done state with a realistic multi-paragraph message and alt username", () => {
    const reply = `Done! Congratulations on your new bot.

You will find it at t.me/wobblefinch_alice_bot.

Use this token to access the HTTP API:
${TEST_TELEGRAM_BOT_TOKEN_ALT}

Keep your token secure.`;
    const result = parseBotFatherReply(reply);
    expect(result).toMatchObject({
      state: "done",
      username: "wobblefinch_alice_bot",
    });
    if (result.state === "done") {
      expect(result.token).toBe(TEST_TELEGRAM_BOT_TOKEN_ALT);
    }
  });
});
