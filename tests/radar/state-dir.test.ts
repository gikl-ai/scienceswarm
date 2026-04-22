import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRadarStateDir } from "@/lib/radar/state-dir";

const ORIGINAL_BRAIN_ROOT = process.env.BRAIN_ROOT;
const ORIGINAL_RADAR_STATE_DIR = process.env.RADAR_STATE_DIR;
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

afterEach(() => {
  restoreEnv("BRAIN_ROOT", ORIGINAL_BRAIN_ROOT);
  restoreEnv("RADAR_STATE_DIR", ORIGINAL_RADAR_STATE_DIR);
  restoreEnv("SCIENCESWARM_DIR", ORIGINAL_SCIENCESWARM_DIR);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("getRadarStateDir", () => {
  it("falls back to the canonical gbrain root instead of a relative state folder", () => {
    delete process.env.BRAIN_ROOT;
    delete process.env.RADAR_STATE_DIR;
    process.env.SCIENCESWARM_DIR = "/tmp/scienceswarm-radar-state";

    expect(getRadarStateDir()).toBe(
      path.join("/tmp/scienceswarm-radar-state", "brain"),
    );
  });

  it("preserves explicit radar and brain overrides", () => {
    process.env.SCIENCESWARM_DIR = "/tmp/scienceswarm-radar-state";
    process.env.BRAIN_ROOT = "/tmp/custom-brain";

    expect(getRadarStateDir()).toBe("/tmp/custom-brain");

    process.env.RADAR_STATE_DIR = "/tmp/custom-radar";
    expect(getRadarStateDir()).toBe("/tmp/custom-radar");
  });
});
