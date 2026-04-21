import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunOpenClaw = vi.hoisted(() => vi.fn());

vi.mock("@/lib/openclaw/runner", () => ({
  runOpenClaw: mockRunOpenClaw,
  resolveOpenClawMode: vi.fn(),
}));

import { approveTelegramPairingRequest } from "@/lib/openclaw/telegram-link";

describe("approveTelegramPairingRequest", () => {
  beforeEach(() => {
    mockRunOpenClaw.mockReset();
    mockRunOpenClaw.mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
      code: 0,
    });
  });

  it("omits --account when pairing metadata includes a non-string account id", async () => {
    await expect(
      approveTelegramPairingRequest({
        id: "8647564254",
        code: "PAIR1234",
        meta: {
          accountId: 42 as unknown as string,
        },
      }),
    ).resolves.toBe(true);

    expect(mockRunOpenClaw).toHaveBeenCalledWith(
      ["pairing", "approve", "telegram", "PAIR1234"],
      { timeoutMs: 10_000 },
    );
  });

  it("passes --account when pairing metadata includes a trimmed string account id", async () => {
    await expect(
      approveTelegramPairingRequest({
        id: "8647564254",
        code: "PAIR1234",
        meta: {
          accountId: " default ",
        },
      }),
    ).resolves.toBe(true);

    expect(mockRunOpenClaw).toHaveBeenCalledWith(
      ["pairing", "approve", "telegram", "PAIR1234", "--account", "default"],
      { timeoutMs: 10_000 },
    );
  });
});
