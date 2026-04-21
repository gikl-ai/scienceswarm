import { describe, expect, it } from "vitest";

import { isTelegramBotTokenShape } from "@/lib/telegram/bot-token";
import { TEST_TELEGRAM_BOT_TOKEN } from "../helpers/telegram-fixtures";

describe("telegram bot token validation", () => {
  it("accepts Telegram bot token-shaped values", () => {
    expect(isTelegramBotTokenShape(TEST_TELEGRAM_BOT_TOKEN)).toBe(true);
  });

  it("rejects malformed bot token values", () => {
    expect(isTelegramBotTokenShape("not-a-token")).toBe(false);
    expect(isTelegramBotTokenShape("123456789:short")).toBe(false);
  });
});
