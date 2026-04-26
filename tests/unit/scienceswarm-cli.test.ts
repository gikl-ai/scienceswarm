import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

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

function runCliFailure(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("bash", [cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: "utf8",
  });
  if (result.status === 0) {
    throw new Error(`expected scienceswarm ${args.join(" ")} to fail`);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
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
    expect(output).toContain("Frontend health: ok (https)");
    expect(output).toContain("Open: https://127.0.0.1:43994/dashboard/study");
    expect(output).toContain("Setup: https://127.0.0.1:43994/setup");
    expect(fs.readFileSync(curlLogPath, "utf8").trim()).toBe(
      "-kfsS --max-time 2 https://127.0.0.1:43994/api/health",
    );
  });

  it("opens the detected healthy local URL in the browser", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-open-"));
    const binRoot = path.join(tmpRoot, "bin");
    const openLogPath = path.join(tmpRoot, "open.log");
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(
      path.join(binRoot, "curl"),
      `#!/usr/bin/env bash
if [ "$1" = "-fsS" ] && [ "$2" = "--max-time" ] && [ "$3" = "2" ] && [ "$4" = "http://127.0.0.1:43998/api/health" ]; then
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(binRoot, "open"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" > ${JSON.stringify(openLogPath)}
exit 0
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const output = runCli(["open", "setup"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43998",
      HOME: tmpRoot,
      PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    });

    expect(output).toContain("Opening http://127.0.0.1:43998/setup in Google Chrome");
    expect(fs.readFileSync(openLogPath, "utf8").trim()).toBe(
      "-a Google Chrome http://127.0.0.1:43998/setup",
    );
  });

  it("opens a named browser when requested", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-open-browser-"));
    const binRoot = path.join(tmpRoot, "bin");
    const openLogPath = path.join(tmpRoot, "open.log");
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(
      path.join(binRoot, "curl"),
      `#!/usr/bin/env bash
if [ "$1" = "-fsS" ] && [ "$2" = "--max-time" ] && [ "$3" = "2" ] && [ "$4" = "http://127.0.0.1:43999/api/health" ]; then
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(binRoot, "open"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" > ${JSON.stringify(openLogPath)}
exit 0
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const output = runCli(["open", "safari", "setup"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43999",
      HOME: tmpRoot,
      PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    });

    expect(output).toContain("Opening http://127.0.0.1:43999/setup in Safari");
    expect(fs.readFileSync(openLogPath, "utf8").trim()).toBe(
      "-a Safari http://127.0.0.1:43999/setup",
    );
  });

  it("prints open help without loading runtime env", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-open-help-"));
    const binRoot = path.join(tmpRoot, "bin");
    const npxLogPath = path.join(tmpRoot, "npx.log");
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(
      path.join(binRoot, "npx"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" > ${JSON.stringify(npxLogPath)}
exit 42
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const output = runCli(["open", "--help"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43990",
      HOME: tmpRoot,
      PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    });

    expect(output).toContain("Usage: scienceswarm open");
    expect(output).toContain("--browser <browser>");
    expect(fs.existsSync(npxLogPath)).toBe(false);
  });

  it("uses localhost when opening a WSL browser from Windows", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-wsl-open-"));
    const binRoot = path.join(tmpRoot, "bin");
    const wslviewLogPath = path.join(tmpRoot, "wslview.log");
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(
      path.join(binRoot, "curl"),
      `#!/usr/bin/env bash
if [ "$1" = "-fsS" ] && [ "$2" = "--max-time" ] && [ "$3" = "2" ] && [ "$4" = "http://127.0.0.1:43989/api/health" ]; then
  exit 0
fi
exit 1
`,
      { encoding: "utf8", mode: 0o755 },
    );
    for (const command of ["open", "xdg-open"]) {
      fs.writeFileSync(
        path.join(binRoot, command),
        `#!/usr/bin/env bash
exit 1
`,
        { encoding: "utf8", mode: 0o755 },
      );
    }
    fs.writeFileSync(
      path.join(binRoot, "wslview"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" > ${JSON.stringify(wslviewLogPath)}
exit 0
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const output = runCli(["open", "default"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43989",
      HOME: tmpRoot,
      PATH: `${binRoot}:/bin:/usr/bin`,
    });

    expect(output).toContain(
      "Opening http://127.0.0.1:43989/dashboard/study in the system default browser",
    );
    expect(fs.readFileSync(wslviewLogPath, "utf8").trim()).toBe(
      "http://localhost:43989/dashboard/study",
    );
  });

  it("documents restart auto-open controls without starting the foreground server", () => {
    const output = runCli(["restart", "--help"]);

    expect(output).toContain("Usage: scienceswarm restart");
    expect(output).toContain("--no-open");
    expect(output).toContain("--browser <name>");
    expect(output).toContain("--open <dashboard|setup|/path>");
    expect(output).toContain("opens the dashboard when healthy");
  });

  it("validates restart options before stopping a managed launcher", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-restart-validate-"));
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

    const result = runCliFailure(["restart", "--no_open"], {
      SCIENCESWARM_DIR: tmpRoot,
      FRONTEND_PORT: "43988",
      HOME: tmpRoot,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown restart option '--no_open'");
    expect(processIsAlive(helper.pid)).toBe(true);
    expect(fs.existsSync(path.join(runRoot, "launcher.pid"))).toBe(true);
  });

  it("wires start.sh to auto-open after the frontend health check", () => {
    const startScript = fs.readFileSync(path.join(repoRoot, "start.sh"), "utf8");

    expect(startScript).toContain("auto_open_when_frontend_ready()");
    expect(startScript).toContain("frontend_probe_host()");
    expect(startScript).toContain("probe_frontend_health");
    expect(startScript).toContain("./scienceswarm open");
    expect(startScript).toContain("start_auto_open_watcher");
    expect(startScript).toContain("SCIENCESWARM_NO_OPEN=true");
    expect(startScript).toMatch(/frontend_health_url\(\)[\s\S]*frontend_probe_host/);
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
  it("prefers http probing when local https is disabled", () => {
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
      FRONTEND_USE_HTTPS: "false",
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
      FRONTEND_USE_HTTPS: "false",
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
