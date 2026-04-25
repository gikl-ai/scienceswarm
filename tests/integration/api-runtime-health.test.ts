import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/runtime/health/route";
import {
  __resetRuntimeApiServicesForTests,
  __setRuntimeApiServicesForTests,
} from "@/app/api/runtime/_shared";
import type {
  ResearchRuntimeHost,
  RuntimeHostProfile,
  RuntimeTurnRequest,
} from "@/lib/runtime-hosts/contracts";
import { scienceSwarmGbrainBin } from "@/lib/gbrain/source-of-truth";
import { requireRuntimeHostProfile } from "@/lib/runtime-hosts/registry";

let tempRoots: string[] = [];

function adapter(profile: RuntimeHostProfile): ResearchRuntimeHost {
  return {
    profile: () => profile,
    health: async () => ({
      status: "ready",
      checkedAt: "2026-04-22T12:00:00.000Z",
      detail: `${profile.id} ready`,
    }),
    authStatus: async () => ({
      status: "not-required",
      authMode: profile.authMode,
      provider: profile.authProvider,
    }),
    privacyProfile: async () => ({
      privacyClass: profile.privacyClass,
      adapterProof: profile.privacyClass === "hosted"
        ? "declared-hosted"
        : "declared-local",
    }),
    sendTurn: async (request: RuntimeTurnRequest) => ({
      hostId: profile.id,
      sessionId: request.conversationId ?? "session-1",
      message: "ok",
    }),
    executeTask: async (request: RuntimeTurnRequest) => ({
      id: request.conversationId ?? "session-1",
      hostId: profile.id,
      projectId: request.projectId,
      conversationId: request.conversationId,
      mode: request.mode,
      status: "completed",
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:00:00.000Z",
      preview: request.preview,
    }),
    cancel: async (sessionId: string) => ({ sessionId, cancelled: true }),
    listSessions: async () => [],
    streamEvents: async function* () {},
    artifactImportHints: async () => [],
  };
}

beforeEach(() => {
  __setRuntimeApiServicesForTests({
    adapters: [
      adapter(requireRuntimeHostProfile("openclaw")),
      adapter(requireRuntimeHostProfile("codex")),
    ],
    now: () => new Date("2026-04-22T12:00:00.000Z"),
  });
});

afterEach(() => {
  __resetRuntimeApiServicesForTests();
  vi.unstubAllEnvs();
});

afterEach(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots = [];
});

async function makeGbrainRepo(expectedVersion: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "scienceswarm-health-gbrain-"));
  tempRoots.push(root);
  await mkdir(path.join(root, "node_modules", "gbrain"), { recursive: true });
  await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/gbrain": {
          version: expectedVersion,
          resolved: "git+ssh://git@github.com/garrytan/gbrain.git#abc123",
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(root, "node_modules", "gbrain", "package.json"),
    JSON.stringify({
      name: "gbrain",
      version: expectedVersion,
    }),
    "utf8",
  );
  await writeFile(scienceSwarmGbrainBin(root), "#!/usr/bin/env node\n", "utf8");
  return root;
}

describe("GET /api/runtime/health", () => {
  it("returns host health, auth, capability, and MCP profile data", async () => {
    const response = await GET(new Request("http://localhost/api/runtime/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    const codex = body.hosts.find(
      (host: { profile: { id: string } }) => host.profile.id === "codex",
    );
    expect(codex).toMatchObject({
      profile: {
        id: "codex",
        authMode: "subscription-native",
        capabilities: expect.arrayContaining(["chat", "task", "mcp-tools"]),
        mcpTools: expect.arrayContaining(["gbrain_search", "gbrain_capture"]),
      },
      health: { status: "ready" },
      auth: { status: "not-required" },
    });
    expect(body.gbrain.package).toMatchObject({
      expectedVersion: expect.any(String),
      binPath: expect.stringContaining("node_modules"),
    });
    expect(body.checkedAt).toBe("2026-04-22T12:00:00.000Z");
  });

  it("uses SCIENCESWARM_REPO_ROOT for the gbrain package state", async () => {
    const repoRoot = await makeGbrainRepo("9.9.9");
    vi.stubEnv("SCIENCESWARM_REPO_ROOT", repoRoot);

    const response = await GET(new Request("http://localhost/api/runtime/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.gbrain.package).toMatchObject({
      repoRoot,
      expectedVersion: "9.9.9",
      installedVersion: "9.9.9",
      inSync: true,
    });
  });

  it("rejects non-local runtime health requests", async () => {
    const response = await GET(new Request("https://example.com/api/runtime/health"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      code: "RUNTIME_INVALID_REQUEST",
      recoverable: false,
    });
  });
});
