import { describe, expect, it } from "vitest";
import crypto from "crypto";
import { verifySlackRequest } from "@/lib/slack-auth";

describe("slack-auth", () => {
  const SIGNING_SECRET = "test-signing-secret-12345";

  function makeValidSignature(timestamp: string, body: string): string {
    const basestring = `v0:${timestamp}:${body}`;
    return (
      "v0=" +
      crypto.createHmac("sha256", SIGNING_SECRET).update(basestring).digest("hex")
    );
  }

  function currentTimestamp(): string {
    return String(Math.floor(Date.now() / 1000));
  }

  // ── Valid signature ────────────────────────────────────────────

  describe("valid signature", () => {
    it("returns true for a correctly signed request", () => {
      const ts = currentTimestamp();
      const body = '{"text":"hello"}';
      const sig = makeValidSignature(ts, body);

      expect(verifySlackRequest(SIGNING_SECRET, ts, body, sig)).toBe(true);
    });

    it("works with empty body", () => {
      const ts = currentTimestamp();
      const body = "";
      const sig = makeValidSignature(ts, body);

      expect(verifySlackRequest(SIGNING_SECRET, ts, body, sig)).toBe(true);
    });
  });

  // ── Invalid signature ──────────────────────────────────────────

  describe("invalid signature", () => {
    it("returns false for wrong signature", () => {
      const ts = currentTimestamp();
      const body = '{"text":"hello"}';
      const wrongSig = "v0=" + "a".repeat(64);

      expect(verifySlackRequest(SIGNING_SECRET, ts, body, wrongSig)).toBe(false);
    });

    it("returns false when body is tampered", () => {
      const ts = currentTimestamp();
      const body = '{"text":"hello"}';
      const sig = makeValidSignature(ts, body);

      expect(verifySlackRequest(SIGNING_SECRET, ts, '{"text":"evil"}', sig)).toBe(
        false,
      );
    });

    it("returns false for wrong signing secret", () => {
      const ts = currentTimestamp();
      const body = '{"text":"hello"}';
      const sig = makeValidSignature(ts, body);

      expect(verifySlackRequest("wrong-secret", ts, body, sig)).toBe(false);
    });
  });

  // ── Replay attack protection ───────────────────────────────────

  describe("replay attack protection", () => {
    it("rejects timestamps older than 5 minutes", () => {
      const sixMinutesAgo = String(Math.floor(Date.now() / 1000) - 6 * 60);
      const body = '{"text":"hello"}';
      const sig = makeValidSignature(sixMinutesAgo, body);

      expect(verifySlackRequest(SIGNING_SECRET, sixMinutesAgo, body, sig)).toBe(
        false,
      );
    });

    it("accepts timestamps within 5 minutes", () => {
      const twoMinutesAgo = String(Math.floor(Date.now() / 1000) - 2 * 60);
      const body = '{"text":"hello"}';
      const sig = makeValidSignature(twoMinutesAgo, body);

      expect(verifySlackRequest(SIGNING_SECRET, twoMinutesAgo, body, sig)).toBe(
        true,
      );
    });
  });

  // ── Length mismatch ────────────────────────────────────────────

  describe("signature length mismatch", () => {
    it("returns false when signature has wrong length", () => {
      const ts = currentTimestamp();
      const body = '{"text":"hello"}';

      expect(verifySlackRequest(SIGNING_SECRET, ts, body, "v0=short")).toBe(false);
    });
  });
});
