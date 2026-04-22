import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyFeedbackToRadar: vi.fn(),
  getActiveRadar: vi.fn(),
  recordFeedback: vi.fn(),
  saveRadarMatchToBrain: vi.fn(),
}));

vi.mock("@/lib/radar/store", () => ({
  getActiveRadar: mocks.getActiveRadar,
}));

vi.mock("@/lib/radar/learn", () => ({
  applyFeedbackToRadar: mocks.applyFeedbackToRadar,
  recordFeedback: mocks.recordFeedback,
  saveRadarMatchToBrain: mocks.saveRadarMatchToBrain,
}));

const ORIGINAL_RADAR_STATE_DIR = process.env.RADAR_STATE_DIR;

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/radar/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/radar/feedback", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RADAR_STATE_DIR = "/tmp/scienceswarm-radar-test";
    mocks.applyFeedbackToRadar.mockReset();
    mocks.getActiveRadar.mockReset();
    mocks.recordFeedback.mockReset();
    mocks.saveRadarMatchToBrain.mockReset();
    mocks.getActiveRadar.mockResolvedValue({
      id: "radar-1",
      topics: [],
      sources: [],
    });
    mocks.recordFeedback.mockResolvedValue(undefined);
    mocks.applyFeedbackToRadar.mockResolvedValue({
      id: "radar-1",
      topics: [],
      sources: [],
    });
    mocks.saveRadarMatchToBrain.mockResolvedValue({
      savedPath: "wiki/entities/frontier/item.md",
    });
  });

  afterEach(() => {
    if (ORIGINAL_RADAR_STATE_DIR === undefined) {
      delete process.env.RADAR_STATE_DIR;
    } else {
      process.env.RADAR_STATE_DIR = ORIGINAL_RADAR_STATE_DIR;
    }
  });

  it("rejects malformed matchedTopics before recording feedback", async () => {
    const { POST } = await import("@/app/api/radar/feedback/route");
    const response = await POST(request({
      briefingId: "briefing-1",
      signalId: "signal-1",
      action: "more-like-this",
      matchedTopics: "EGFR resistance program",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "matchedTopics must be an array of non-empty strings when provided",
    });
    expect(mocks.getActiveRadar).not.toHaveBeenCalled();
    expect(mocks.recordFeedback).not.toHaveBeenCalled();
    expect(mocks.applyFeedbackToRadar).not.toHaveBeenCalled();
  });

  it("records feedback and applies normalized topic preferences after validation", async () => {
    const { POST } = await import("@/app/api/radar/feedback/route");
    const response = await POST(request({
      briefingId: "briefing-1",
      signalId: "signal-1",
      action: "more-like-this",
      matchedTopics: [" EGFR resistance program "],
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      preferenceApplied: true,
    });
    expect(mocks.recordFeedback).toHaveBeenCalledOnce();
    expect(mocks.applyFeedbackToRadar).toHaveBeenCalledWith(
      "/tmp/scienceswarm-radar-test",
      "radar-1",
      expect.objectContaining({
        briefingId: "briefing-1",
        signalId: "signal-1",
        action: "more-like-this",
      }),
      ["EGFR resistance program"],
    );
  });
});
