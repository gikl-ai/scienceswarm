import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIsLocal = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: () => mockIsLocal(),
}));

let dataRoot: string;

describe("local install route", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockIsLocal.mockResolvedValue(true);
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-install-id-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
  });

  afterEach(async () => {
    delete process.env.SCIENCESWARM_DIR;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("creates and reuses a local install id under the active data root", async () => {
    const { GET } = await import("@/app/api/local-install/route");

    const first = await GET();
    const second = await GET();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstJson = await first.json() as { localInstallId: string };
    const secondJson = await second.json() as { localInstallId: string };

    expect(firstJson.localInstallId).toMatch(/^[a-f0-9-]{36}$/);
    expect(secondJson.localInstallId).toBe(firstJson.localInstallId);
    await expect(readFile(path.join(dataRoot, "install-id"), "utf-8")).resolves.toBe(
      `${firstJson.localInstallId}\n`,
    );
  });

  it("rejects non-local requests", async () => {
    mockIsLocal.mockResolvedValue(false);
    const { GET } = await import("@/app/api/local-install/route");

    const response = await GET();

    expect(response.status).toBe(403);
  });
});
