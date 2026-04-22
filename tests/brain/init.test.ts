import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "fs";
import { basename, join, resolve } from "path";
import { tmpdir } from "os";
import { initBrain } from "@/brain/init";

const TEST_ROOT = join(tmpdir(), "scienceswarm-brain-test-init");

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("initBrain", () => {
  it("creates the full directory structure", () => {
    const result = initBrain({ root: TEST_ROOT });
    expect(result.created).toBe(true);

    // Check key directories exist
    expect(existsSync(join(TEST_ROOT, "raw/papers"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "raw/observations"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki/concepts"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki/observations"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki/entities/papers"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki/decisions"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki/tasks"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki/entities/artifacts"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki/entities/frontier"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki/experiments"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki/hypotheses"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki/schema"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "raw/imports"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "raw/captures/telegram"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "raw/projects"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "raw/decisions"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "raw/tasks"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "raw/artifacts"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "raw/frontier"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "state/projects"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "state/channels/telegram"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "state/schedules"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "topics"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "methods"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "packets"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "journals"))).toBe(true);
  });

  it("creates BRAIN.md with researcher info", () => {
    initBrain({
      root: TEST_ROOT,
      name: "Dr. Test",
      field: "Computational Biology",
      institution: "MIT",
    });

    const brainMd = readFileSync(join(TEST_ROOT, "BRAIN.md"), "utf-8");
    expect(brainMd).toContain("Dr. Test");
    expect(brainMd).toContain("Computational Biology");
    expect(brainMd).toContain("MIT");
  });

  it("creates home.md in wiki/", () => {
    initBrain({ root: TEST_ROOT });
    const home = readFileSync(join(TEST_ROOT, "wiki/home.md"), "utf-8");
    expect(home).toContain("# Your Brain");
    expect(home).toContain("Alerts");
    expect(home).toContain("Active Experiments");
    expect(home).toContain("Brain Stats");
  });

  it("creates overview.md for original design compatibility", () => {
    initBrain({ root: TEST_ROOT });
    const overview = readFileSync(join(TEST_ROOT, "wiki/overview.md"), "utf-8");
    expect(overview).toContain("Brain Overview");
    expect(overview).toContain("[[home]]");
  });

  it("creates index.md in wiki/", () => {
    initBrain({ root: TEST_ROOT });
    const index = readFileSync(join(TEST_ROOT, "wiki/index.md"), "utf-8");
    expect(index).toContain("# Brain Index");
    expect(index).toContain("## Projects");
    expect(index).toContain("## Decisions");
    expect(index).toContain("## Tasks");
    expect(index).toContain("## Artifacts");
    expect(index).toContain("## Frontier");
    expect(index).toContain("## Hypotheses");
  });

  it("creates empty events.jsonl", () => {
    initBrain({ root: TEST_ROOT });
    const events = readFileSync(join(TEST_ROOT, "wiki/events.jsonl"), "utf-8");
    expect(events).toBe("");
  });

  it("creates log.md", () => {
    initBrain({ root: TEST_ROOT });
    const log = readFileSync(join(TEST_ROOT, "wiki/log.md"), "utf-8");
    expect(log).toContain("# Brain Log");
  });

  it("creates .gitignore", () => {
    initBrain({ root: TEST_ROOT });
    expect(existsSync(join(TEST_ROOT, ".gitignore"))).toBe(true);
  });

  it("is idempotent — does not overwrite existing brain", () => {
    initBrain({ root: TEST_ROOT, name: "Original" });
    const result = initBrain({ root: TEST_ROOT, name: "Overwrite" });

    expect(result.created).toBe(false);
    const brainMd = readFileSync(join(TEST_ROOT, "BRAIN.md"), "utf-8");
    expect(brainMd).toContain("Original");
    expect(brainMd).not.toContain("Overwrite");
  });

  it("supports the generic scientist preset override", () => {
    initBrain({
      root: TEST_ROOT,
      brainPreset: "generic_scientist",
    });

    expect(existsSync(join(TEST_ROOT, "concepts"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "conferences"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "ideas"))).toBe(true);
  });

  it("normalizes roots before writing scaffold files", () => {
    const normalizedRoot = join(tmpdir(), "scienceswarm-brain-test-init-normalized");
    const inputRoot = join(normalizedRoot, "..", basename(normalizedRoot));
    rmSync(normalizedRoot, { recursive: true, force: true });

    try {
      const result = initBrain({ root: inputRoot });

      expect(result.root).toBe(resolve(normalizedRoot));
      expect(existsSync(join(normalizedRoot, "BRAIN.md"))).toBe(true);
      expect(existsSync(join(normalizedRoot, "wiki/home.md"))).toBe(true);
    } finally {
      rmSync(normalizedRoot, { recursive: true, force: true });
    }
  });
});
