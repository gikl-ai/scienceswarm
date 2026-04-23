import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_RADAR_STATE_DIR = process.env.RADAR_STATE_DIR;

async function importRoute() {
  vi.resetModules();
  return await import("@/app/api/radar/route");
}

describe("GET /api/radar", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;

    if (ORIGINAL_RADAR_STATE_DIR === undefined) {
      delete process.env.RADAR_STATE_DIR;
    } else {
      process.env.RADAR_STATE_DIR = ORIGINAL_RADAR_STATE_DIR;
    }
  });

  it("returns 200 null when no radar is configured yet", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "scienceswarm-radar-route-"));
    roots.push(root);
    process.env.RADAR_STATE_DIR = root;

    const { GET } = await importRoute();
    const response = await GET(new Request("http://localhost/api/radar"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it("returns the active radar when one exists", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "scienceswarm-radar-route-"));
    roots.push(root);
    process.env.RADAR_STATE_DIR = root;
    const radarDir = path.join(root, "radar");
    const radar = {
      id: "radar-1",
      topics: [],
      sources: [],
      schedule: { cron: "0 6 * * *", timezone: "UTC", fetchLeadMinutes: 120 },
      channels: { dashboard: true, telegram: false, email: false },
      filters: [],
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    };
    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(radarDir, { recursive: true });
      await writeFile(
        path.join(radarDir, "active-radar.json"),
        JSON.stringify(radar),
        "utf-8",
      );
    });

    const { GET } = await importRoute();
    const response = await GET(new Request("http://localhost/api/radar"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "radar-1" });
  });
});
