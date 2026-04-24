import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "scienceswarm");

function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): string {
  return execFileSync("bash", [cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!processIsAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processIsAlive(pid);
}

const cleanupPids = new Set<number>();

afterEach(() => {
  for (const pid of cleanupPids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Ignore already-exited test helpers.
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore already-exited test helpers.
    }
  }
  cleanupPids.clear();
});

describe("scienceswarm CLI", () => {
  it("prints the command help", () => {
    const output = runCli(["help"]);
    expect(output).toContain("Usage:");
    expect(output).toContain("scienceswarm <command> [args]");
    expect(output).toContain("restart");
    expect(output).toContain("doctor");
  });

  it("reports a stopped runtime when no launcher pid exists", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-status-"));
    const output = runCli(["status"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43991",
      HOME: tmpRoot,
    });

    expect(output).toContain("ScienceSwarm status");
    expect(output).toContain(`Data root: ${tmpRoot}`);
    expect(output).toContain("Frontend: stopped");
    expect(output).toContain("OpenHands: stopped");
  });

  it("reports a suspended launcher instead of a healthy running frontend", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-suspended-"));
    const runRoot = path.join(tmpRoot, "run");
    fs.mkdirSync(runRoot, { recursive: true });

    const helper = spawn("bash", ["-lc", "exec -a start.sh sleep 300"], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HOME: tmpRoot,
      },
    });
    helper.unref();
    if (typeof helper.pid !== "number") {
      throw new Error("expected detached helper pid");
    }
    cleanupPids.add(helper.pid);
    process.kill(-helper.pid, "SIGSTOP");
    fs.writeFileSync(path.join(runRoot, "launcher.pid"), `${helper.pid}\n`, "utf8");

    const output = runCli(["status"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43996",
      HOME: tmpRoot,
    });

    expect(output).toContain(`Frontend: suspended (launcher pid ${helper.pid})`);
    process.kill(-helper.pid, "SIGCONT");
  });

  it("probes frontend health over https when local https is enabled", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-https-"));
    const binRoot = path.join(tmpRoot, "bin");
    const curlLogPath = path.join(tmpRoot, "curl.log");
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(
      path.join(binRoot, "curl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" > ${JSON.stringify(curlLogPath)}
if [ "$1" = "-kfsS" ] && [ "$2" = "--max-time" ] && [ "$3" = "2" ] && [ "$4" = "https://127.0.0.1:43994/api/health" ]; then
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const output = runCli(["status"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43994",
      FRONTEND_USE_HTTPS: "true",
      HOME: tmpRoot,
      PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    });

    expect(output).toContain("Frontend health: ok");
    expect(fs.readFileSync(curlLogPath, "utf8").trim()).toBe(
      "-kfsS --max-time 2 https://127.0.0.1:43994/api/health",
    );
  });

  it("falls back to http probing when https mode is enabled but the https probe fails", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-https-then-http-"));
    const binRoot = path.join(tmpRoot, "bin");
    const curlLogPath = path.join(tmpRoot, "curl.log");
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(
      path.join(binRoot, "curl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(curlLogPath)}
if [ "$1" = "-fsS" ] && [ "$2" = "--max-time" ] && [ "$3" = "2" ] && [ "$4" = "http://127.0.0.1:43997/api/health" ]; then
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const output = runCli(["status"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43997",
      FRONTEND_USE_HTTPS: "true",
      HOME: tmpRoot,
      PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    });

    expect(output).toContain("Frontend health: ok");
    expect(fs.readFileSync(curlLogPath, "utf8").trim().split("\n")).toEqual([
      "-kfsS --max-time 2 https://127.0.0.1:43997/api/health",
      "-fsS --max-time 2 http://127.0.0.1:43997/api/health",
    ]);
  });

  it("prefers http probing by default when https mode is not enabled", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-http-fallback-"));
    const binRoot = path.join(tmpRoot, "bin");
    const curlLogPath = path.join(tmpRoot, "curl.log");
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(
      path.join(binRoot, "curl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(curlLogPath)}
if [ "$1" = "-fsS" ] && [ "$2" = "--max-time" ] && [ "$3" = "2" ] && [ "$4" = "http://127.0.0.1:43995/api/health" ]; then
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const output = runCli(["status"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43995",
      HOME: tmpRoot,
      PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    });

    expect(output).toContain("Frontend health: ok");
    expect(fs.readFileSync(curlLogPath, "utf8").trim().split("\n")).toEqual([
      "-fsS --max-time 2 http://127.0.0.1:43995/api/health",
    ]);
  });

  it("falls back to https probing when http is preferred but unavailable", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-https-fallback-"));
    const binRoot = path.join(tmpRoot, "bin");
    const curlLogPath = path.join(tmpRoot, "curl.log");
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(
      path.join(binRoot, "curl"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(curlLogPath)}
if [ "$1" = "-kfsS" ] && [ "$2" = "--max-time" ] && [ "$3" = "2" ] && [ "$4" = "https://127.0.0.1:43996/api/health" ]; then
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const output = runCli(["status"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43996",
      HOME: tmpRoot,
      PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    });

    expect(output).toContain("Frontend health: ok");
    expect(fs.readFileSync(curlLogPath, "utf8").trim().split("\n")).toEqual([
      "-fsS --max-time 2 http://127.0.0.1:43996/api/health",
      "-kfsS --max-time 2 https://127.0.0.1:43996/api/health",
    ]);
  });

  it("reports an exited OpenHands container as stopped instead of running", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-container-"));
    const runRoot = path.join(tmpRoot, "run");
    const binRoot = path.join(tmpRoot, "bin");
    fs.mkdirSync(runRoot, { recursive: true });
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(path.join(runRoot, "openhands.cid"), "deadbeef\n", "utf8");
    fs.writeFileSync(
      path.join(binRoot, "docker"),
      `#!/usr/bin/env bash
if [ "$1" = "inspect" ] && [ "$2" = "-f" ] && [ "$3" = "{{.State.Running}}" ] && [ "$4" = "deadbeef" ]; then
  printf 'false\\n'
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const output = runCli(["status"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43993",
      HOME: tmpRoot,
      PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    });

    expect(output).toContain("OpenHands: stopped (container present)");
    expect(fs.existsSync(path.join(runRoot, "openhands.cid"))).toBe(true);
  });

  it("stops a managed launcher from its pid file", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-stop-"));
    const runRoot = path.join(tmpRoot, "run");
    fs.mkdirSync(runRoot, { recursive: true });

    const helper = spawn("bash", ["-lc", "exec -a start.sh sleep 300"], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HOME: tmpRoot,
      },
    });
    helper.unref();
    if (typeof helper.pid !== "number") {
      throw new Error("expected detached helper pid");
    }
    cleanupPids.add(helper.pid);
    fs.writeFileSync(path.join(runRoot, "launcher.pid"), `${helper.pid}\n`, "utf8");

    const output = runCli(["stop"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43992",
      HOME: tmpRoot,
    });

    expect(output).toContain("Stopping ScienceSwarm launcher");
    expect(fs.existsSync(path.join(runRoot, "launcher.pid"))).toBe(false);
    expect(await waitForProcessExit(helper.pid)).toBe(true);
    cleanupPids.delete(helper.pid);
  });
});
