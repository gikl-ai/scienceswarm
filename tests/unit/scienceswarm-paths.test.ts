import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expandHomeDir,
  getScienceSwarmBrainRoot,
  getScienceSwarmDataRoot,
  getScienceSwarmProjectBrainRoot,
  getScienceSwarmProjectBrainStateRoot,
  getScienceSwarmProjectBrainWikiRoot,
  getScienceSwarmProjectRoot,
  getScienceSwarmProjectsRoot,
  getScienceSwarmStateRoot,
  getScienceSwarmWorkspaceRoot,
  resolveConfiguredPath,
} from "@/lib/scienceswarm-paths";

afterEach(() => {
  delete process.env.SCIENCESWARM_DIR;
});

describe("scienceswarm-paths", () => {
  it("expands ~/ paths", () => {
    expect(expandHomeDir("~/scienceswarm")).toBe(
      path.join(os.homedir(), "scienceswarm")
    );
  });

  it("resolves configured paths with home expansion", () => {
    expect(resolveConfiguredPath("~/scienceswarm-data")).toBe(
      path.join(os.homedir(), "scienceswarm-data")
    );
  });

  it("defaults the data root to ~/.scienceswarm", () => {
    expect(getScienceSwarmDataRoot()).toBe(path.join(os.homedir(), ".scienceswarm"));
  });

  it("uses SCIENCESWARM_DIR for project and workspace roots", () => {
    process.env.SCIENCESWARM_DIR = "~/Library/Application Support/ScienceSwarm";

    expect(getScienceSwarmDataRoot()).toBe(
      path.join(os.homedir(), "Library/Application Support/ScienceSwarm")
    );
    expect(getScienceSwarmProjectsRoot()).toBe(
      path.join(os.homedir(), "Library/Application Support/ScienceSwarm", "projects")
    );
    expect(getScienceSwarmProjectRoot("project-alpha")).toBe(
      path.join(os.homedir(), "Library/Application Support/ScienceSwarm", "projects", "project-alpha")
    );
    expect(getScienceSwarmProjectBrainRoot("project-alpha")).toBe(
      path.join(os.homedir(), "Library/Application Support/ScienceSwarm", "projects", "project-alpha", ".brain")
    );
    expect(getScienceSwarmProjectBrainWikiRoot("project-alpha")).toBe(
      path.join(
        os.homedir(),
        "Library/Application Support/ScienceSwarm",
        "projects",
        "project-alpha",
        ".brain",
        "wiki",
      )
    );
    expect(getScienceSwarmProjectBrainStateRoot("project-alpha")).toBe(
      path.join(
        os.homedir(),
        "Library/Application Support/ScienceSwarm",
        "projects",
        "project-alpha",
        ".brain",
        "state",
      )
    );
    expect(getScienceSwarmWorkspaceRoot()).toBe(
      path.join(os.homedir(), "Library/Application Support/ScienceSwarm", "workspace")
    );
    expect(getScienceSwarmBrainRoot()).toBe(
      path.join(os.homedir(), "Library/Application Support/ScienceSwarm", "brain")
    );
    expect(getScienceSwarmStateRoot()).toBe(
      path.join(os.homedir(), "Library/Application Support/ScienceSwarm", "brain", "state")
    );
  });

  it("rejects unsafe project slugs when building project-local paths", () => {
    expect(() => getScienceSwarmProjectRoot("../escape")).toThrow("Invalid project slug");
    expect(() => getScienceSwarmProjectBrainRoot("../escape")).toThrow("Invalid project slug");
  });
});
