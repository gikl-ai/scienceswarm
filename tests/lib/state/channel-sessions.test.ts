import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  getChannelSessionPath,
  readChannelSession,
  updateChannelSession,
  writeChannelSession,
} from "@/lib/state/channel-sessions";
import type { ChannelSessionState } from "@/brain/types";

const ROOT = join(tmpdir(), "scienceswarm-state-channel-session");

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("channel-sessions", () => {
  it("writes, reads, and updates a telegram session", async () => {
    const session: ChannelSessionState = {
      version: 1,
      channel: "telegram",
      userId: "123",
      activeProject: "alpha",
      pendingClarification: {
        captureId: "capture-1",
        question: "Which project?",
        choices: ["alpha", "beta"],
      },
      recentCaptureIds: ["capture-1"],
      updatedAt: "2026-04-08T00:00:00.000Z",
    };

    await writeChannelSession(session, ROOT);
    const loaded = await readChannelSession("telegram", "123", ROOT);
    expect(loaded).toEqual(session);
    expect(readFileSync(getChannelSessionPath("telegram", "123", ROOT), "utf-8")).toContain('"activeProject": "alpha"');

    const updated = await updateChannelSession(
      "telegram",
      "123",
      (current) => ({
        ...(current ?? session),
        activeProject: null,
        recentCaptureIds: ["capture-2"],
        updatedAt: "2026-04-08T01:00:00.000Z",
      }),
      ROOT,
    );

    expect(updated.activeProject).toBeNull();
    expect(updated.recentCaptureIds).toEqual(["capture-2"]);
  });

  it("rejects unsafe user IDs", async () => {
    await expect(readChannelSession("telegram", "../escape", ROOT)).rejects.toThrow(
      "Invalid channel userId",
    );
  });
});
