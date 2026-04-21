/**
 * Parity test: the TS resolver (resolveOpenClawMode from runner.ts) and the
 * bash resolver (scripts/openclaw-env.sh) MUST produce identical output for
 * every combination of SCIENCESWARM_DIR and OPENCLAW_PROFILE. If a maintainer
 * edits one without the other, this test fails at CI time.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveOpenClawMode, writeGatewayPid } from "@/lib/openclaw/runner";

const SHELL_RESOLVER = path.resolve(
  __dirname,
  "..",
  "..",
  "scripts",
  "openclaw-env.sh",
);

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of [
    "OPENCLAW_PROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "SCIENCESWARM_DIR",
    "SCIENCESWARM_OPENCLAW_MODE",
  ]) {
    delete process.env[key];
  }
}

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-parity-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetEnv();
  tmpDirs = [];
});

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

interface ShellResult {
  mode: string;
  stateDir: string;
  configPath: string;
}

function runShellResolver(env: Record<string, string | undefined>): ShellResult {
  const shellEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) {
      shellEnv[k] = v;
    } else {
      delete shellEnv[k];
    }
  }

  const script = [
    `source "${SHELL_RESOLVER}"`,
    "openclaw_resolve_env",
    'echo "${SCIENCESWARM_OPENCLAW_MODE:-}"',
    'echo "${OPENCLAW_STATE_DIR:-}"',
    'echo "${OPENCLAW_CONFIG_PATH:-}"',
  ].join("; ");

  const stdout = execFileSync("bash", ["-c", script], {
    env: shellEnv,
    encoding: "utf8",
    timeout: 5000,
  });

  const lines = stdout.trim().split("\n");
  return {
    mode: lines[0] ?? "",
    stateDir: lines[1] ?? "",
    configPath: lines[2] ?? "",
  };
}

function runShellGatewayPidPath(
  env: Record<string, string | undefined>,
): string {
  const shellEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) {
      shellEnv[k] = v;
    } else {
      delete shellEnv[k];
    }
  }

  const script = [
    `source "${SHELL_RESOLVER}"`,
    'printf "%s\\n" "$(openclaw_gateway_pid_file)"',
  ].join("; ");

  return execFileSync("bash", ["-c", script], {
    env: shellEnv,
    encoding: "utf8",
    timeout: 5000,
  }).trim();
}

interface MatrixRow {
  label: string;
  scienceswarmDir: string | undefined;
  openclawProfile: string | undefined;
  expectedMode: "state-dir" | "profile";
}

const matrix: MatrixRow[] = [
  {
    label: "default (both unset)",
    scienceswarmDir: undefined,
    openclawProfile: undefined,
    expectedMode: "state-dir",
  },
  {
    label: "custom SCIENCESWARM_DIR, no profile",
    scienceswarmDir: "TMPDIR_PLACEHOLDER",
    openclawProfile: undefined,
    expectedMode: "state-dir",
  },
  {
    label: "profile mode (project-alpha)",
    scienceswarmDir: undefined,
    openclawProfile: "project-alpha",
    expectedMode: "profile",
  },
  {
    label: "profile mode with custom SCIENCESWARM_DIR",
    scienceswarmDir: "TMPDIR_PLACEHOLDER",
    openclawProfile: "foo",
    expectedMode: "profile",
  },
  {
    label: "whitespace-only OPENCLAW_PROFILE treated as unset",
    scienceswarmDir: undefined,
    openclawProfile: "   ",
    expectedMode: "state-dir",
  },
  {
    label: "empty OPENCLAW_PROFILE treated as unset",
    scienceswarmDir: undefined,
    openclawProfile: "",
    expectedMode: "state-dir",
  },
];

describe.runIf(process.platform !== "win32")(
  "shell/TS parity — openclaw-env.sh vs runner.ts",
  () => {
    it.each(matrix)("$label", (row) => {
      const fakeHome = makeTmpDir();
      const tmpDir =
        row.scienceswarmDir === "TMPDIR_PLACEHOLDER" ? makeTmpDir() : undefined;
      const scienceswarmDir = tmpDir ?? row.scienceswarmDir;

      // Set TS env
      process.env.HOME = fakeHome;
      if (scienceswarmDir !== undefined) {
        process.env.SCIENCESWARM_DIR = scienceswarmDir;
      }
      if (row.openclawProfile !== undefined) {
        process.env.OPENCLAW_PROFILE = row.openclawProfile;
      }

      // Run TS resolver
      const tsMode = resolveOpenClawMode();

      // Run shell resolver with the same env
      const shellEnv: Record<string, string | undefined> = {
        HOME: fakeHome,
        SCIENCESWARM_DIR: scienceswarmDir,
        OPENCLAW_PROFILE: row.openclawProfile,
      };
      if (scienceswarmDir === undefined) shellEnv.SCIENCESWARM_DIR = undefined;
      if (row.openclawProfile === undefined) shellEnv.OPENCLAW_PROFILE = undefined;

      const shell = runShellResolver(shellEnv);

      // Assert mode agreement
      expect(tsMode.kind).toBe(row.expectedMode);
      expect(shell.mode).toBe(row.expectedMode);

      if (row.expectedMode === "state-dir") {
        if (tsMode.kind !== "state-dir") throw new Error("narrow");
        // TS and shell must agree on the exact state dir and config path
        expect(tsMode.stateDir).toBe(shell.stateDir);
        expect(tsMode.configPath).toBe(shell.configPath);
        // Sanity: the state dir ends with /openclaw
        expect(tsMode.stateDir).toMatch(/\/openclaw$/);
      } else {
        // Profile mode: both resolvers must NOT export state-dir env vars
        expect(shell.stateDir).toBe("");
        expect(shell.configPath).toBe("");
      }
    });

    it("shell resolver replaces a legacy symlinked state dir with a real directory copy", () => {
      const tmpDir = makeTmpDir();
      process.env.HOME = tmpDir;
      const legacyDir = path.join(tmpDir, "legacy-openclaw");
      const dataRoot = path.join(tmpDir, "data");
      const stateDir = path.join(dataRoot, "openclaw");

      fs.mkdirSync(path.join(legacyDir, "credentials"), { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, "openclaw.json"),
        JSON.stringify({ gateway: { port: 18789 } }),
        "utf8",
      );
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.symlinkSync(legacyDir, stateDir);

      runShellResolver({ HOME: tmpDir, SCIENCESWARM_DIR: dataRoot });

      const stat = fs.lstatSync(stateDir);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);
      expect(
        fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"),
      ).toContain('"port":18789');
      fs.writeFileSync(path.join(stateDir, "marker"), "new", "utf8");
      expect(fs.existsSync(path.join(legacyDir, "marker"))).toBe(false);
    });

    it.each([
      "project-alpha",
      "../project alpha/../../beta",
      "café-research",
    ])("matches the runner's gateway pid path for profile %s", (profile) => {
      const fakeHome = makeTmpDir();
      const tmpDir = makeTmpDir();

      process.env.HOME = fakeHome;
      process.env.TMPDIR = tmpDir;

      writeGatewayPid(123, { kind: "profile", profile });

      const createdFiles = fs
        .readdirSync(tmpDir)
        .filter((entry) => entry.startsWith("openclaw-gateway-"));
      expect(createdFiles).toHaveLength(1);

      const tsPidPath = path.join(tmpDir, createdFiles[0]!);
      const shellPidPath = runShellGatewayPidPath({
        HOME: fakeHome,
        OPENCLAW_PROFILE: profile,
        TMPDIR: tmpDir,
      });

      expect(shellPidPath).toBe(tsPidPath);
    });
  },
);
