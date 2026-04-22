import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock, runOpenClawMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  runOpenClawMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

vi.mock("@/lib/openclaw/runner", () => ({
  runOpenClaw: runOpenClawMock,
}));

describe("market plugin installs", () => {
  const originalScienceSwarmDir = process.env.SCIENCESWARM_DIR;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    runOpenClawMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
    if (originalScienceSwarmDir === undefined) {
      delete process.env.SCIENCESWARM_DIR;
    } else {
      process.env.SCIENCESWARM_DIR = originalScienceSwarmDir;
    }
  });

  it("installs a GitHub market plugin into local host surfaces and records provenance", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "market-plugin-install-"));
    const repoRoot = mkdtempSync(path.join(tmpdir(), "market-plugin-repo-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    const cacheDir = seedCachedPluginRepo(dataRoot);

    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args.includes("rev-parse")) {
        return "27651a43bf55185d924f7a1fc49043a0a8be65a0\n";
      }
      return "";
    });
    runOpenClawMock.mockImplementation(async () => {
      mkdirSync(path.join(dataRoot, "openclaw", "extensions", "life-science-research"), { recursive: true });
      return { ok: true, stdout: "installed", stderr: "", code: 0 };
    });

    const market = await import("@/lib/plugins/market");
    const plugin = await market.installMarketPluginFromGitHub({
      repo: "openai/plugins",
      ref: "main",
      path: "plugins/life-science-research",
    }, repoRoot);

    expect(cacheDir.endsWith(path.join("cache", "skills", "repos", "openai_plugins__main"))).toBe(true);
    expect(plugin).toMatchObject({
      id: "life-science-research",
      source: {
        repo: "openai/plugins",
        requestedRef: "main",
        resolvedCommit: "27651a43bf55185d924f7a1fc49043a0a8be65a0",
      },
      hosts: {
        openclaw: {
          status: "installed",
        },
        codex: {
          status: "installed",
        },
        "claude-code": {
          status: "installed",
        },
      },
      trust: {
        scriptFileCount: 1,
        executableFileCount: 1,
      },
    });
    expect(plugin.skills.map((skill) => skill.slug)).toEqual(["opentargets-skill"]);

    expect(runOpenClawMock).toHaveBeenCalledWith(
      [
        "plugins",
        "install",
        "--force",
        path.join(dataRoot, "market", "plugins", "life-science-research", "bundle"),
      ],
      { timeoutMs: 120_000 },
    );

    const codexSkillRoot = path.join(repoRoot, ".codex", "skills", "opentargets-skill");
    const claudeSkillRoot = path.join(repoRoot, ".claude", "skills", "opentargets-skill");
    expect(existsSync(path.join(codexSkillRoot, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(codexSkillRoot, "scripts", "query.py"))).toBe(true);
    expect(existsSync(path.join(claudeSkillRoot, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(repoRoot, ".codex", ".gitignore"))).toBe(true);
    expect(readFileSync(path.join(repoRoot, ".codex", ".gitignore"), "utf-8")).toContain("skills/");

    const installManifestPath = path.join(
      dataRoot,
      "market",
      "plugins",
      "life-science-research",
      "install.json",
    );
    expect(existsSync(installManifestPath)).toBe(true);
    expect(readFileSync(installManifestPath, "utf-8")).toContain('"resolvedCommit": "27651a43bf55185d924f7a1fc49043a0a8be65a0"');

    const listed = await market.listInstalledMarketPlugins(repoRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("life-science-research");
  });

  it("reinstalls a recorded market plugin from the pinned bundle snapshot", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "market-plugin-reinstall-"));
    const repoRoot = mkdtempSync(path.join(tmpdir(), "market-plugin-repo-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    const bundleRoot = seedInstalledPluginBundle(dataRoot);
    const metadataRoot = path.join(dataRoot, "market", "plugins", "life-science-research");
    const installPath = path.join(dataRoot, "openclaw", "extensions", "life-science-research");

    writeFileSync(
      path.join(metadataRoot, "install.json"),
      JSON.stringify(buildInstalledPluginRecord({
        bundleRoot,
        repoRoot,
        installPath,
      }), null, 2) + "\n",
      "utf-8",
    );

    runOpenClawMock.mockImplementation(async () => {
      mkdirSync(installPath, { recursive: true });
      return { ok: true, stdout: "", stderr: "", code: 0 };
    });

    const market = await import("@/lib/plugins/market");
    const plugin = await market.reinstallMarketPlugin("life-science-research", repoRoot);

    expect(runOpenClawMock).toHaveBeenCalledWith(
      ["plugins", "install", "--force", bundleRoot],
      { timeoutMs: 120_000 },
    );
    expect(plugin.updatedAt).toBeTruthy();
    expect(existsSync(path.join(repoRoot, ".codex", "skills", "opentargets-skill", "scripts", "query.py"))).toBe(true);
  });

  it("uninstalls a recorded market plugin and removes its metadata plus local host projections", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "market-plugin-uninstall-"));
    const repoRoot = mkdtempSync(path.join(tmpdir(), "market-plugin-repo-"));
    process.env.SCIENCESWARM_DIR = dataRoot;
    const bundleRoot = seedInstalledPluginBundle(dataRoot);
    const metadataRoot = path.join(dataRoot, "market", "plugins", "life-science-research");
    const installPath = path.join(dataRoot, "openclaw", "extensions", "life-science-research");
    mkdirSync(installPath, { recursive: true });
    mkdirSync(path.join(repoRoot, ".codex", "skills", "opentargets-skill"), { recursive: true });
    mkdirSync(path.join(repoRoot, ".claude", "skills", "opentargets-skill"), { recursive: true });

    writeFileSync(
      path.join(metadataRoot, "install.json"),
      JSON.stringify(buildInstalledPluginRecord({
        bundleRoot,
        repoRoot,
        installPath,
      }), null, 2) + "\n",
      "utf-8",
    );

    runOpenClawMock.mockResolvedValue({ ok: true, stdout: "", stderr: "", code: 0 });

    const market = await import("@/lib/plugins/market");
    await market.uninstallMarketPlugin("life-science-research", repoRoot);

    expect(runOpenClawMock).toHaveBeenCalledWith(
      ["plugins", "uninstall", "life-science-research", "--force"],
      { timeoutMs: 120_000 },
    );
    expect(existsSync(metadataRoot)).toBe(false);
    expect(existsSync(path.join(repoRoot, ".codex", "skills", "opentargets-skill"))).toBe(false);
    expect(existsSync(path.join(repoRoot, ".claude", "skills", "opentargets-skill"))).toBe(false);
  });
});

function buildInstalledPluginRecord(input: {
  bundleRoot: string;
  repoRoot: string;
  installPath: string;
}) {
  return {
    id: "life-science-research",
    name: "life-science-research",
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
    bundlePath: input.bundleRoot,
    pluginManifestPath: path.join(input.bundleRoot, ".codex-plugin", "plugin.json"),
    installedAt: "2026-04-22T00:00:00.000Z",
    updatedAt: null,
    source: {
      kind: "github" as const,
      repo: "openai/plugins",
      requestedRef: "main",
      resolvedCommit: "27651a43bf55185d924f7a1fc49043a0a8be65a0",
      path: "plugins/life-science-research",
    },
    trust: {
      totalFiles: 4,
      scriptFileCount: 1,
      executableFileCount: 1,
      agentFileCount: 0,
      referenceFileCount: 0,
      assetFileCount: 0,
      scriptFiles: ["skills/opentargets-skill/scripts/query.py"],
      detectedRuntimes: ["python"],
    },
    hosts: {
      openclaw: {
        status: "installed" as const,
        installRoot: input.installPath,
        projectedSkills: [
          {
            sourceSlug: "opentargets-skill",
            hostSlug: "opentargets-skill",
            installPath: path.join(input.installPath, "skills", "opentargets-skill"),
            mode: "direct" as const,
          },
        ],
      },
      codex: {
        status: "installed" as const,
        installRoot: path.join(input.repoRoot, ".codex", "skills"),
        projectedSkills: [
          {
            sourceSlug: "opentargets-skill",
            hostSlug: "opentargets-skill",
            installPath: path.join(input.repoRoot, ".codex", "skills", "opentargets-skill"),
            mode: "direct" as const,
          },
        ],
      },
      "claude-code": {
        status: "installed" as const,
        installRoot: path.join(input.repoRoot, ".claude", "skills"),
        projectedSkills: [
          {
            sourceSlug: "opentargets-skill",
            hostSlug: "opentargets-skill",
            installPath: path.join(input.repoRoot, ".claude", "skills", "opentargets-skill"),
            mode: "direct" as const,
          },
        ],
      },
    },
  };
}

function seedCachedPluginRepo(dataRoot: string): string {
  const cacheDir = path.join(dataRoot, "cache", "skills", "repos", "openai_plugins__main");
  mkdirSync(path.join(cacheDir, "plugins", "life-science-research", ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(cacheDir, "plugins", "life-science-research", "skills", "opentargets-skill", "scripts"), { recursive: true });
  writeFileSync(
    path.join(cacheDir, "plugins", "life-science-research", ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "life-science-research",
      description: "General life-sciences research workflows.",
      version: "0.1.0",
      license: "Proprietary",
      interface: {
        displayName: "Life Science Research",
      },
      skills: "./skills/",
    }, null, 2) + "\n",
    "utf-8",
  );
  writeFileSync(
    path.join(cacheDir, "plugins", "life-science-research", "skills", "opentargets-skill", "SKILL.md"),
    `---
name: opentargets-skill
description: Query Open Targets.
---

# Open Targets
`,
    "utf-8",
  );
  writeFileSync(
    path.join(cacheDir, "plugins", "life-science-research", "skills", "opentargets-skill", "scripts", "query.py"),
    "print('query')\n",
    "utf-8",
  );
  return cacheDir;
}

function seedInstalledPluginBundle(dataRoot: string): string {
  const bundleRoot = path.join(dataRoot, "market", "plugins", "life-science-research", "bundle");
  mkdirSync(path.join(bundleRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(bundleRoot, "skills", "opentargets-skill", "scripts"), { recursive: true });
  writeFileSync(
    path.join(bundleRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "life-science-research",
      description: "General life-sciences research workflows.",
      version: "0.1.0",
      license: "Proprietary",
      interface: {
        displayName: "Life Science Research",
      },
      skills: "./skills/",
    }, null, 2) + "\n",
    "utf-8",
  );
  writeFileSync(
    path.join(bundleRoot, "skills", "opentargets-skill", "SKILL.md"),
    `---
name: opentargets-skill
description: Query Open Targets.
---

# Open Targets
`,
    "utf-8",
  );
  writeFileSync(
    path.join(bundleRoot, "skills", "opentargets-skill", "scripts", "query.py"),
    "print('query')\n",
    "utf-8",
  );
  return bundleRoot;
}
