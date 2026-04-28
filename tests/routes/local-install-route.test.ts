import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("converges concurrent first requests on one local install id", async () => {
    const { GET } = await import("@/app/api/local-install/route");

    const responses = await Promise.all([GET(), GET(), GET(), GET()]);
    const payloads = await Promise.all(
      responses.map((response) => response.json() as Promise<{ localInstallId: string }>),
    );
    const ids = payloads.map((payload) => payload.localInstallId);

    expect(new Set(ids).size).toBe(1);
    await expect(readFile(path.join(dataRoot, "install-id"), "utf-8")).resolves.toBe(
      `${ids[0]}\n`,
    );
  });

  it("does not overwrite an existing unreadable install id after an exclusive-create race", async () => {
    const installIdPath = path.join(dataRoot, "install-id");
    await writeFile(installIdPath, "not a valid install id\n", "utf-8");
    const { getOrCreateLocalInstallId } = await import("@/lib/local-install-id");

    await expect(getOrCreateLocalInstallId()).rejects.toThrow(
      "Local install-id already exists but could not be read",
    );
    await expect(readFile(installIdPath, "utf-8")).resolves.toBe("not a valid install id\n");
  });

  it("rejects non-local requests", async () => {
    mockIsLocal.mockResolvedValue(false);
    const { GET } = await import("@/app/api/local-install/route");

    const response = await GET();

    expect(response.status).toBe(403);
  });
});
