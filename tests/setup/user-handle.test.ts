import { describe, expect, it } from "vitest";

import {
  createGeneratedUserHandle,
  isValidUserHandle,
} from "@/lib/setup/user-handle";

describe("user handle helpers", () => {
  it("accepts the setup handle character set", () => {
    expect(isValidUserHandle("researcher-abc123")).toBe(true);
    expect(isValidUserHandle("alice_2.0")).toBe(true);
  });

  it("rejects invalid or empty handles", () => {
    expect(isValidUserHandle("")).toBe(false);
    expect(isValidUserHandle("has spaces")).toBe(false);
    expect(isValidUserHandle("@alice")).toBe(false);
    expect(isValidUserHandle("x".repeat(65))).toBe(false);
  });

  it("generates a stable valid handle from an opaque seed", () => {
    expect(createGeneratedUserHandle("550e8400-e29b-41d4")).toBe(
      "researcher-550e8400",
    );
  });
});
