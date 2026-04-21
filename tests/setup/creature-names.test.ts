import { describe, it, expect } from "vitest";
import {
  CREATURE_WORDS,
  randomCreature,
  creatureDisplayName,
  creatureUsername,
} from "@/lib/telegram/creature-names";

describe("creature-names", () => {
  it("has at least 40 creatures so collisions are rare", () => {
    expect(CREATURE_WORDS.length).toBeGreaterThanOrEqual(40);
  });

  it("every creature word is lowercase letters only", () => {
    for (const word of CREATURE_WORDS) {
      expect(word).toMatch(/^[a-z]{3,20}$/);
    }
  });

  it("randomCreature returns a member of the wordlist", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(CREATURE_WORDS).toContain(randomCreature());
    }
  });

  it("creatureDisplayName capitalizes and produces a short tagline", () => {
    const name = creatureDisplayName("wobblefinch");
    expect(name).toContain("Wobblefinch");
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it("creatureUsername is Telegram-legal: 5-32 chars, alphanum+underscore, ends in bot", () => {
    const u = creatureUsername("wobblefinch", "seiji", "");
    expect(u).toMatch(/^[a-zA-Z0-9_]{5,32}$/);
    expect(u.endsWith("bot")).toBe(true);
  });

  it("creatureUsername accepts a collision suffix", () => {
    const a = creatureUsername("wobblefinch", "seiji", "");
    const b = creatureUsername("wobblefinch", "seiji", "x9k2");
    expect(a).not.toBe(b);
    expect(b).toMatch(/x9k2/);
    expect(b.length).toBeLessThanOrEqual(32);
  });

  it("creatureUsername truncates long handles so the total fits 32 chars", () => {
    const u = creatureUsername(
      "thistlehornwyrm",
      "averylonghandlehereindeed",
      "",
    );
    expect(u.length).toBeLessThanOrEqual(32);
  });

  it("creatureUsername strips non-alphanumeric from handle", () => {
    const u = creatureUsername("wobblefinch", "s.e@i_j-i", "");
    // "@" and "-" and "." should be gone; only "seiji" remains in the handle slot
    expect(u).toMatch(/^wobblefinch_seiji_bot$/);
  });

  it("creatureUsername skips the handle slot instead of emitting '__bot' when handle is empty", () => {
    // Regression: an empty (or all-non-alphanumeric) handle used to
    // produce `<creature>__bot` with a double underscore. Rare in
    // practice — the API validator rejects empty handles — but worth
    // being defensive about.
    expect(creatureUsername("wobblefinch", "", "")).toBe("wobblefinch_bot");
    expect(creatureUsername("wobblefinch", "---", "")).toBe("wobblefinch_bot");
    // Still no double underscore when a suffix is present.
    expect(creatureUsername("wobblefinch", "", "x9k2")).toBe(
      "wobblefinch_x9k2_bot",
    );
  });
});
