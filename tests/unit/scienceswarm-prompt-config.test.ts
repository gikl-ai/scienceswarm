import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildScienceSwarmPromptContextText,
  loadScienceSwarmPromptConfig,
} from "@/lib/scienceswarm-prompt-config";

describe("scienceswarm-prompt-config", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-prompt-config-"));
    vi.stubEnv("SCIENCESWARM_DIR", tempRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads project SCIENCESWARM.md ahead of the workspace fallback", async () => {
    const workspaceRoot = path.join(tempRoot, "workspace");
    const projectRoot = path.join(tempRoot, "projects", "alpha-project");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "SCIENCESWARM.md"),
      "# Workspace Instructions\n\nWorkspace fallback.",
      "utf8",
    );
    await writeFile(
      path.join(projectRoot, "SCIENCESWARM.md"),
      [
        "---",
        "tools:",
        "  - workspace-read",
        "  - brain-read",
        "references:",
        "  - docs/project-brief.md",
        "---",
        "# Project Instructions",
        "",
        "Read `notes/context.md` when the task needs it.",
      ].join("\n"),
      "utf8",
    );

    const config = await loadScienceSwarmPromptConfig("alpha-project");

    expect(config).toEqual({
      path: path.join(projectRoot, "SCIENCESWARM.md"),
      instructions: "# Project Instructions\n\nRead `notes/context.md` when the task needs it.",
      configuredTools: ["workspace-read", "brain-read"],
      referencedFiles: ["docs/project-brief.md", "notes/context.md"],
    });
  });

  it("renders backend-specific tool guidance in the prompt context text", async () => {
    const workspaceRoot = path.join(tempRoot, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "SCIENCESWARM.md"),
      [
        "---",
        "allowedTools:",
        "  - workspace-read",
        "  - workspace-write",
        "---",
        "Keep responses concise.",
      ].join("\n"),
      "utf8",
    );

    const directContext = await buildScienceSwarmPromptContextText({
      projectId: null,
      backend: "direct",
    });
    const openClawContext = await buildScienceSwarmPromptContextText({
      projectId: null,
      backend: "openclaw",
    });

    expect(directContext).toContain("Tool capabilities available in this backend: none.");
    expect(directContext).toContain("workspace-read, workspace-write");
    expect(openClawContext).toContain("- workspace-read: Read explicitly requested workspace files.");
    expect(openClawContext).toContain("- workspace-write: Create or edit workspace files when the user asks.");
  });
});
