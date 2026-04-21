import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = path.join(tmpdir(), "scienceswarm-radar-briefing-route");
const ORIGINAL_BRAIN_ROOT = process.env.BRAIN_ROOT;
const ORIGINAL_RADAR_STATE_DIR = process.env.RADAR_STATE_DIR;

async function importRoute() {
  return await import("@/app/api/radar/briefing/route");
}

describe("GET /api/radar/briefing", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    process.env.BRAIN_ROOT = ROOT;
    delete process.env.RADAR_STATE_DIR;
  });

  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();

    if (ORIGINAL_BRAIN_ROOT !== undefined) {
      process.env.BRAIN_ROOT = ORIGINAL_BRAIN_ROOT;
    } else {
      delete process.env.BRAIN_ROOT;
    }

    if (ORIGINAL_RADAR_STATE_DIR !== undefined) {
      process.env.RADAR_STATE_DIR = ORIGINAL_RADAR_STATE_DIR;
    } else {
      delete process.env.RADAR_STATE_DIR;
    }
  });

  it("returns 200 null when no cached briefing exists yet", async () => {
    const { GET } = await importRoute();
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toBeNull();
  });

  it("returns the cached briefing when present", async () => {
    const radarDir = path.join(ROOT, "radar");
    mkdirSync(radarDir, { recursive: true });
    writeFileSync(
      path.join(radarDir, "latest-briefing.json"),
      JSON.stringify({
        id: "briefing-1",
        generatedAt: "2026-04-13T12:00:00.000Z",
        matters: [],
        horizon: [],
        nothingToday: true,
        stats: { signalsFetched: 0, sourcesFailed: [] },
      }),
      "utf-8",
    );

    const { GET } = await importRoute();
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "briefing-1",
      nothingToday: true,
    });
  });

  it("returns 500 when the cached briefing is unreadable", async () => {
    const radarDir = path.join(ROOT, "radar");
    mkdirSync(radarDir, { recursive: true });
    writeFileSync(path.join(radarDir, "latest-briefing.json"), "{bad json", "utf-8");

    const { GET } = await importRoute();
    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Failed to load briefing.",
    });
  });
});
