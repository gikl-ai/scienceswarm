import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveBrainRoot, loadBrainConfig, brainExists } from "@/brain/config";

const TEST_DATA_ROOT = join(tmpdir(), "scienceswarm-brain-test-config");
const TEST_ROOT = join(TEST_DATA_ROOT, "brain");

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  process.env.SCIENCESWARM_DIR = TEST_DATA_ROOT;
});

afterEach(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  delete process.env.BRAIN_ROOT;
  delete process.env.SCIENCESWARM_DIR;
});

describe("resolveBrainRoot", () => {
  it("returns the default brain root when BRAIN_ROOT is not set", () => {
    delete process.env.BRAIN_ROOT;
    expect(resolveBrainRoot()).toBe(TEST_ROOT);
  });

  it("returns null when BRAIN_ROOT points to nonexistent directory", () => {
    process.env.BRAIN_ROOT = "/nonexistent/path/brain";
    expect(resolveBrainRoot()).toBeNull();
  });

  it("returns the path when BRAIN_ROOT exists", () => {
    process.env.BRAIN_ROOT = TEST_ROOT;
    expect(resolveBrainRoot()).toBe(TEST_ROOT);
  });
});

describe("brainExists", () => {
  it("returns false when no initialized brain exists at the default root", () => {
    delete process.env.BRAIN_ROOT;
    rmSync(TEST_ROOT, { recursive: true, force: true });
    expect(brainExists()).toBe(false);
  });

  it("returns false when BRAIN_ROOT exists but no BRAIN.md", () => {
    process.env.BRAIN_ROOT = TEST_ROOT;
    expect(brainExists()).toBe(false);
  });

  it("returns true when BRAIN.md exists", () => {
    process.env.BRAIN_ROOT = TEST_ROOT;
    writeFileSync(join(TEST_ROOT, "BRAIN.md"), "# BRAIN");
    expect(brainExists()).toBe(true);
  });
});

describe("loadBrainConfig", () => {
  it("returns null when neither BRAIN_ROOT nor the default brain root exists", () => {
    delete process.env.BRAIN_ROOT;
    rmSync(TEST_ROOT, { recursive: true, force: true });
    expect(loadBrainConfig()).toBeNull();
  });

  it("returns defaults when BRAIN.md has no preferences section", () => {
    process.env.BRAIN_ROOT = TEST_ROOT;
    writeFileSync(join(TEST_ROOT, "BRAIN.md"), "# BRAIN\n\n## Owner\nName: Test");
    const config = loadBrainConfig();
    expect(config).not.toBeNull();
    expect(config!.root).toBe(TEST_ROOT);
    expect(config!.rippleCap).toBe(15);
    expect(config!.serendipityRate).toBe(0.2);
    expect(config!.paperWatchBudget).toBe(50);
  });

  it("ignores invalid (NaN) preference values and uses defaults", () => {
    process.env.BRAIN_ROOT = TEST_ROOT;
    writeFileSync(
      join(TEST_ROOT, "BRAIN.md"),
      [
        "# BRAIN",
        "",
        "## Preferences",
        "serendipity_rate: not-a-number",
        "paper_watch_budget: abc",
        "ripple_cap: ???",
      ].join("\n")
    );
    const config = loadBrainConfig();
    expect(config).not.toBeNull();
    expect(config!.serendipityRate).toBe(0.2);
    expect(config!.paperWatchBudget).toBe(50);
    expect(config!.rippleCap).toBe(15);
  });

  it("parses preferences from BRAIN.md", () => {
    process.env.BRAIN_ROOT = TEST_ROOT;
    writeFileSync(
      join(TEST_ROOT, "BRAIN.md"),
      [
        "# BRAIN",
        "",
        "## Preferences",
        "serendipity_rate: 0.35    # higher than default",
        "paper_watch_budget: 100",
        "ripple_cap: 20",
        "",
        "## Active Context",
        "Currently working on CRISPR.",
      ].join("\n")
    );
    const config = loadBrainConfig();
    expect(config).not.toBeNull();
    expect(config!.serendipityRate).toBe(0.35);
    expect(config!.paperWatchBudget).toBe(100);
    expect(config!.rippleCap).toBe(20);
  });
});
