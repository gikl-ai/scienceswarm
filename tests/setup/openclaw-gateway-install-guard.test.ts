/**
 * Three-block guard test for the wrapper-only invariant and gateway-install
 * env forwarding. This is Codex's highest-priority regression test:
 *
 *   Block 1 — static scan: no exec/execFile/spawn of "openclaw" outside runner.ts
 *   Block 2 — unit: runOpenClaw + spawnOpenClaw forward env for gateway install
 *   Block 3 — macOS integration: real openclaw gateway install plist check (skippable)
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Block 1: wrapper-only invariant (static scan) ──────────────────────

describe("wrapper-only invariant", () => {
  const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");
  const RUNNER_PATH = path.join(SRC_ROOT, "lib", "openclaw", "runner.ts");
  const INDEX_PATH = path.join(SRC_ROOT, "lib", "openclaw", "index.ts");

  const VIOLATION_RE =
    /(?:exec|execFile|execFileSync|spawn|spawnSync)\s*\(\s*["']openclaw["']/;

  function walkTsFiles(dir: string): string[] {
    if (path.basename(dir) === "__test-brain__") {
      return [];
    }
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return results;
      }
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") {
        results.push(...walkTsFiles(full));
      } else if (/\.tsx?$/.test(entry.name)) {
        results.push(full);
      }
    }
    return results;
  }

  it("no exec/execFile/spawn of 'openclaw' binary outside runner.ts", () => {
    const files = walkTsFiles(SRC_ROOT).filter(
      (f) => f !== RUNNER_PATH && f !== INDEX_PATH,
    );

    const violations: string[] = [];
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, "utf8");
      for (const [i, line] of content.split("\n").entries()) {
        if (VIOLATION_RE.test(line)) {
          violations.push(
            `${filePath}:${i + 1}: ${line.trim().slice(0, 200)}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

// ─── Block 2: env forwarding for gateway install (mocked spawn) ─────────

const mocks = vi.hoisted(() => {
  const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
  const execFilePromise = vi.fn();
  const execFileMock = Object.assign(vi.fn(), {
    [promisifyCustom]: execFilePromise,
  });
  return {
    execFileMock,
    execFilePromise,
    execFileSyncMock: vi.fn(),
    spawnMock: vi.fn(),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    execFile: mocks.execFileMock,
    execFileSync: mocks.execFileSyncMock,
    spawn: mocks.spawnMock,
  };
});

import {
  runOpenClaw,
  spawnOpenClaw,
} from "@/lib/openclaw/runner";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of [
    "OPENCLAW_PROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "SCIENCESWARM_DIR",
  ]) {
    delete process.env[key];
  }
}

describe("gateway install env forwarding", () => {
  let tmpRoot: string;

  beforeEach(() => {
    resetEnv();
    mocks.execFilePromise.mockReset();
    mocks.spawnMock.mockReset();
    tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-gateway-install-"),
    );
    process.env.SCIENCESWARM_DIR = tmpRoot;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      process.env[key] = value;
    }
  });

  it("runOpenClaw forwards OPENCLAW_STATE_DIR + CONFIG_PATH in state-dir mode", async () => {
    mocks.execFilePromise.mockResolvedValue({ stdout: "ok", stderr: "" });

    await runOpenClaw(["gateway", "install"]);

    const call = mocks.execFilePromise.mock.calls[0];
    const [_bin, argv, opts] = call as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(opts.env.OPENCLAW_STATE_DIR).toBe(path.join(tmpRoot, "openclaw"));
    expect(opts.env.OPENCLAW_CONFIG_PATH).toBe(
      path.join(tmpRoot, "openclaw", "openclaw.json"),
    );
    expect(argv).not.toContain("--profile");
  });

  it("runOpenClaw clears state-dir env vars in profile mode", async () => {
    process.env.OPENCLAW_PROFILE = "test-gateway-install";
    process.env.OPENCLAW_STATE_DIR = "/leftover";
    process.env.OPENCLAW_CONFIG_PATH = "/leftover/openclaw.json";

    mocks.execFilePromise.mockResolvedValue({ stdout: "ok", stderr: "" });

    await runOpenClaw(["gateway", "install"]);

    const call = mocks.execFilePromise.mock.calls[0];
    const [_bin, argv, opts] = call as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(opts.env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(opts.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
    expect(argv.slice(0, 4)).toEqual([
      "--profile",
      "test-gateway-install",
      "gateway",
      "install",
    ]);
  });

  it("spawnOpenClaw forwards state-dir env vars", () => {
    const fakeChild = Object.assign(new EventEmitter(), {
      pid: 42,
      kill: vi.fn(),
    });
    mocks.spawnMock.mockReturnValue(fakeChild);

    spawnOpenClaw(["gateway", "install"]);

    const [_bin, _argv, opts] = mocks.spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(opts.env.OPENCLAW_STATE_DIR).toBe(path.join(tmpRoot, "openclaw"));
    expect(opts.env.OPENCLAW_CONFIG_PATH).toBe(
      path.join(tmpRoot, "openclaw", "openclaw.json"),
    );
  });

  it("spawnOpenClaw clears state-dir env vars in profile mode", () => {
    process.env.OPENCLAW_PROFILE = "foo";
    const fakeChild = Object.assign(new EventEmitter(), {
      pid: 43,
      kill: vi.fn(),
    });
    mocks.spawnMock.mockReturnValue(fakeChild);

    spawnOpenClaw(["gateway", "install"]);

    const [_bin, argv, opts] = mocks.spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(opts.env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(opts.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
    expect(argv.slice(0, 2)).toEqual(["--profile", "foo"]);
  });
});

// ─── Block 3: macOS launchd plist integration (skip if not darwin) ──────

describe.runIf(process.platform === "darwin")(
  "launchd plist env forwarding (macOS only)",
  () => {
    it.skip("upstream openclaw gateway install does not yet support --dry-run or --dest; replace this skip with a real integration test when one of those hooks lands", () => {
      // When upstream adds --dry-run or --dest, replace this skip with
      // a real integration test that spawns openclaw gateway install
      // against a temp dest dir and asserts the generated plist contains
      // OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH keys matching the
      // resolved state dir.
    });
  },
);
