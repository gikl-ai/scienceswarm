import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramTextContext } from "@/lib/telegram-capture-handler";

describe("radar Telegram strict-local policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not call hosted LLM intent fallback in strict local-only mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SCIENCESWARM_STRICT_LOCAL_ONLY", "1");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const { handleRadarMessage } = await import("@/lib/radar/telegram");
    const ctx: TelegramTextContext = {
      message: { text: "please decide whether this belongs on the radar" },
      reply: vi.fn(),
    };

    const handled = await handleRadarMessage(ctx);

    expect(handled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
