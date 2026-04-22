import { afterEach, describe, expect, it, vi } from "vitest";

const { isLocalRequestMock } = vi.hoisted(() => ({
  isLocalRequestMock: vi.fn(),
}));

vi.mock("@/lib/local-guard", () => ({
  isLocalRequest: isLocalRequestMock,
}));

import {
  DELETE as uninstallPlugin,
  PUT as refreshPlugin,
} from "@/app/api/market/plugins/[plugin]/route";
import { POST as inspectPlugin } from "@/app/api/market/plugins/inspect/route";
import { GET as listPlugins, POST as installPlugin } from "@/app/api/market/plugins/route";
import * as marketLib from "@/lib/plugins/market";

describe("market plugins routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    isLocalRequestMock.mockReset();
  });

  it("lists installed market plugins for local requests", async () => {
    isLocalRequestMock.mockResolvedValue(true);
    vi.spyOn(marketLib, "listInstalledMarketPlugins").mockResolvedValue([
      buildInstalledPlugin("life-science-research"),
    ]);

    const response = await listPlugins(new Request("http://localhost/api/market/plugins"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0]).toMatchObject({
      id: "life-science-research",
      source: {
        repo: "openai/plugins",
      },
    });
  });

  it("rejects remote market plugin listings", async () => {
    isLocalRequestMock.mockResolvedValue(false);

    const response = await listPlugins(new Request("https://example.com/api/market/plugins"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe("Forbidden");
  });

  it("inspects a market plugin from GitHub for local requests", async () => {
    isLocalRequestMock.mockResolvedValue(true);
    const inspectSpy = vi.spyOn(marketLib, "inspectMarketPluginFromGitHub").mockResolvedValue(
      buildPreview("life-science-research"),
    );

    const response = await inspectPlugin(
      new Request("http://localhost/api/market/plugins/inspect", {
        method: "POST",
        body: JSON.stringify({
          repo: "openai/plugins",
          ref: "main",
          path: "plugins/life-science-research",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preview.id).toBe("life-science-research");
    expect(inspectSpy).toHaveBeenCalledWith({
      repo: "openai/plugins",
      ref: "main",
      path: "plugins/life-science-research",
    });
  });

  it("installs a market plugin from GitHub for local requests", async () => {
    isLocalRequestMock.mockResolvedValue(true);
    vi.spyOn(marketLib, "installMarketPluginFromGitHub").mockResolvedValue(
      buildInstalledPlugin("life-science-research"),
    );

    const response = await installPlugin(
      new Request("http://localhost/api/market/plugins", {
        method: "POST",
        body: JSON.stringify({
          repo: "openai/plugins",
          ref: "main",
          path: "plugins/life-science-research",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.plugin.id).toBe("life-science-research");
    expect(marketLib.installMarketPluginFromGitHub).toHaveBeenCalledWith({
      repo: "openai/plugins",
      ref: "main",
      path: "plugins/life-science-research",
    });
  });

  it("returns validation errors from market plugin install", async () => {
    isLocalRequestMock.mockResolvedValue(true);
    vi.spyOn(marketLib, "installMarketPluginFromGitHub").mockRejectedValue(
      new marketLib.MarketPluginValidationError("bad plugin bundle"),
    );

    const response = await installPlugin(
      new Request("http://localhost/api/market/plugins", {
        method: "POST",
        body: JSON.stringify({
          repo: "openai/plugins",
          path: "plugins/life-science-research",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("bad plugin bundle");
  });

  it("reinstalls a market plugin", async () => {
    isLocalRequestMock.mockResolvedValue(true);
    const reinstallSpy = vi.spyOn(marketLib, "reinstallMarketPlugin").mockResolvedValue(
      buildInstalledPlugin("life-science-research"),
    );

    const response = await refreshPlugin(
      new Request("http://localhost/api/market/plugins/life-science-research", {
        method: "PUT",
        body: JSON.stringify({ action: "reinstall" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ plugin: "life-science-research" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toContain("Reinstalled");
    expect(reinstallSpy).toHaveBeenCalledWith("life-science-research");
  });

  it("updates a market plugin from upstream", async () => {
    isLocalRequestMock.mockResolvedValue(true);
    const updateSpy = vi.spyOn(marketLib, "updateMarketPluginFromGitHub").mockResolvedValue(
      buildInstalledPlugin("life-science-research"),
    );

    const response = await refreshPlugin(
      new Request("http://localhost/api/market/plugins/life-science-research", {
        method: "PUT",
        body: JSON.stringify({ action: "update" }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ plugin: "life-science-research" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toContain("Updated");
    expect(updateSpy).toHaveBeenCalledWith("life-science-research");
  });

  it("uninstalls a market plugin", async () => {
    isLocalRequestMock.mockResolvedValue(true);
    const uninstallSpy = vi.spyOn(marketLib, "uninstallMarketPlugin").mockResolvedValue();

    const response = await uninstallPlugin(
      new Request("http://localhost/api/market/plugins/life-science-research", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ plugin: "life-science-research" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toContain("Removed the local market plugin install");
    expect(uninstallSpy).toHaveBeenCalledWith("life-science-research");
  });
});

function buildPreview(id: string) {
  return {
    id,
    name: id,
    displayName: "Life Science Research",
    description: "General life-sciences research workflows.",
    pluginVersion: "0.1.0",
    bundleFormat: "codex" as const,
    license: "Proprietary",
    skillsPath: "skills",
    skills: [
      {
        slug: "opentargets-skill",
        description: "Query Open Targets.",
        runtime: null,
        emoji: null,
      },
    ],
    source: {
      kind: "github" as const,
      repo: "openai/plugins",
      requestedRef: "main",
      resolvedCommit: "27651a43bf55185d924f7a1fc49043a0a8be65a0",
      path: "plugins/life-science-research",
    },
    trust: {
      totalFiles: 7,
      scriptFileCount: 1,
      executableFileCount: 1,
      agentFileCount: 0,
      referenceFileCount: 0,
      assetFileCount: 1,
      scriptFiles: ["skills/opentargets-skill/scripts/query.py"],
      detectedRuntimes: ["python"],
    },
    hosts: {
      openclaw: {
        installRoot: "/tmp/openclaw/extensions/life-science-research",
        projectedSkills: [
          {
            sourceSlug: "opentargets-skill",
            hostSlug: "opentargets-skill",
            installPath: "/tmp/openclaw/extensions/life-science-research/skills/opentargets-skill",
            mode: "direct" as const,
          },
        ],
      },
      codex: {
        installRoot: "/tmp/repo/.codex/skills",
        projectedSkills: [
          {
            sourceSlug: "opentargets-skill",
            hostSlug: "opentargets-skill",
            installPath: "/tmp/repo/.codex/skills/opentargets-skill",
            mode: "direct" as const,
          },
        ],
      },
      "claude-code": {
        installRoot: "/tmp/repo/.claude/skills",
        projectedSkills: [
          {
            sourceSlug: "opentargets-skill",
            hostSlug: "opentargets-skill",
            installPath: "/tmp/repo/.claude/skills/opentargets-skill",
            mode: "direct" as const,
          },
        ],
      },
    },
  };
}

function buildInstalledPlugin(id: string) {
  return {
    ...buildPreview(id),
    bundlePath: "/tmp/.scienceswarm/market/plugins/life-science-research/bundle",
    pluginManifestPath:
      "/tmp/.scienceswarm/market/plugins/life-science-research/bundle/.codex-plugin/plugin.json",
    installedAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T12:00:00.000Z",
    hosts: {
      openclaw: {
        status: "installed" as const,
        installRoot: "/tmp/openclaw/extensions/life-science-research",
        projectedSkills: [
          {
            sourceSlug: "opentargets-skill",
            hostSlug: "opentargets-skill",
            installPath: "/tmp/openclaw/extensions/life-science-research/skills/opentargets-skill",
            mode: "direct" as const,
          },
        ],
      },
      codex: {
        status: "installed" as const,
        installRoot: "/tmp/repo/.codex/skills",
        projectedSkills: [
          {
            sourceSlug: "opentargets-skill",
            hostSlug: "opentargets-skill",
            installPath: "/tmp/repo/.codex/skills/opentargets-skill",
            mode: "direct" as const,
          },
        ],
      },
      "claude-code": {
        status: "installed" as const,
        installRoot: "/tmp/repo/.claude/skills",
        projectedSkills: [
          {
            sourceSlug: "opentargets-skill",
            hostSlug: "opentargets-skill",
            installPath: "/tmp/repo/.claude/skills/opentargets-skill",
            mode: "direct" as const,
          },
        ],
      },
    },
  };
}
