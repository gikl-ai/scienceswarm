/**
 * Regression test for the "No pending session" bug during Telegram
 * bot onboarding in `next dev --webpack`.
 *
 * Before the fix: `pendingCodes` was a plain module-level `new Map()`.
 * Next.js dev mode can compile each route handler into its own webpack
 * chunk, which means the `telegram-bot.ts` module gets imported twice
 * — once by the bootstrap route and once by the telegram-code route —
 * yielding two different Map instances. `set` in one was invisible to
 * `get` in the other, and the user's code submission always 404'd.
 *
 * This test simulates that split by calling `vi.resetModules()` and
 * re-importing the module between `set` and `get`. The module-level
 * Map strategy fails this test; the `globalThis`-pinned Map passes
 * it. That's exactly the invariant the fix needs to hold.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const TELEGRAM_BOT_MODULE = "@/lib/setup/install-tasks/telegram-bot";

async function importFresh(): Promise<typeof import("@/lib/setup/install-tasks/telegram-bot")> {
  vi.resetModules();
  return import(TELEGRAM_BOT_MODULE);
}

describe("pendingCodes global sharing", () => {
  afterEach(() => {
    // Scrub any leftover entries so tests don't cross-contaminate.
    // Reach the real Map via the globalThis symbol the module uses.
    const key = "__scienceswarmTelegramPendingCodes";
    const g = globalThis as typeof globalThis & {
      [k: string]: Map<string, (code: string) => void> | undefined;
    };
    g[key]?.clear();
  });

  it("reuses the same Map instance across module re-imports", async () => {
    const first = await importFresh();
    const second = await importFresh();

    // With a plain `new Map()` at module scope these are different
    // instances after `vi.resetModules()`. With the globalThis pin
    // they are the same object.
    expect(second.pendingCodes).toBe(first.pendingCodes);
  });

  it("a resolver set on a re-imported Map is readable from the original", async () => {
    const first = await importFresh();

    let received: string | null = null;
    const resolver = (code: string) => {
      received = code;
    };
    first.pendingCodes.set("sess-1", resolver);

    // Simulate the telegram-code route being compiled into a different
    // chunk and getting its own view of the module.
    const second = await importFresh();
    const hit = second.pendingCodes.get("sess-1");

    expect(hit).toBe(resolver);
    hit?.("123456");
    expect(received).toBe("123456");
  });

  it("a resolver set on the re-imported Map is readable from the original", async () => {
    const first = await importFresh();
    const second = await importFresh();

    let received: string | null = null;
    second.pendingCodes.set("sess-2", (code) => {
      received = code;
    });

    // Original view must see it too — this is the direction that
    // matters for the real bug: bootstrap sets, telegram-code gets.
    const hit = first.pendingCodes.get("sess-2");
    expect(hit).toBeDefined();
    hit?.("654321");
    expect(received).toBe("654321");
  });

  it("delete on one Map affects the other", async () => {
    const first = await importFresh();
    const second = await importFresh();

    first.pendingCodes.set("sess-3", () => {});
    expect(second.pendingCodes.has("sess-3")).toBe(true);

    second.pendingCodes.delete("sess-3");
    expect(first.pendingCodes.has("sess-3")).toBe(false);
  });
});
