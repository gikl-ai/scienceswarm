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
    expect(output).toContain("Frontend health: ok (https)");
    expect(output).toContain("Open: https://127.0.0.1:43994/dashboard/project");
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

  it("prints actionable restart guidance before handing off to the dev server", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scienceswarm-cli-restart-"));
    const binRoot = path.join(tmpRoot, "bin");
    const openLogPath = path.join(tmpRoot, "open.log");
    fs.mkdirSync(binRoot, { recursive: true });
    fs.writeFileSync(
      path.join(binRoot, "curl"),
      `#!/usr/bin/env bash
case "$4" in
  http://*:44001/api/health|https://*:44001/api/health)
    exit 0
    ;;
esac
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
    fs.writeFileSync(
      path.join(binRoot, "npx"),
      `#!/usr/bin/env bash
if [ "$1" = "tsx" ]; then
  exit 0
fi
if [ "$1" = "next" ] && [ "$2" = "dev" ]; then
  printf 'fake next dev ready\\n'
  sleep 1
  exit 0
fi
exit 0
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const output = runCli(["restart", "--browser", "safari"], {
      SCIENCESWARM_DIR: tmpRoot,
      BRAIN_ROOT: path.join(tmpRoot, "brain"),
      CI: "",
      ENABLE_DREAM_RUNNER: "false",
      FRONTEND_HOST: "127.0.0.1",
      FRONTEND_PORT: "44001",
      FRONTEND_PUBLIC_HOST: "127.0.0.1",
      FRONTEND_USE_HTTPS: "false",
      HOME: tmpRoot,
      PATH: `${binRoot}:/usr/bin:/bin:/usr/sbin:/sbin`,
      SCIENCESWARM_NO_OPEN: "false",
      SCIENCESWARM_OPEN_WAIT_ATTEMPTS: "1",
      SCIENCESWARM_OPEN_WAIT_SECONDS: "0",
    });

    expect(output).toContain("ScienceSwarm restart");
    expect(output).toContain("Opens the dashboard automatically after the frontend health check passes.");
    expect(output).toContain("If the browser does not appear:");
    expect(output).toContain("Open dashboard manually: ./scienceswarm open");
    expect(output).toContain("Dashboard: http://127.0.0.1:44001/dashboard/project");
    expect(output).toContain("Protocol:  use http:// only on this port; https:// will fail.");
    expect(output).toContain("Keep this terminal open. It is the live ScienceSwarm server log.");
    expect(output).toContain("ScienceSwarm will open dashboard in safari after the frontend is healthy.");
    expect(output).toContain("Opening http://127.0.0.1:44001/dashboard/project in Safari");
    expect(output).toContain("fake next dev ready");
    expect(fs.readFileSync(openLogPath, "utf8").trim()).toBe(
      "-a Safari http://127.0.0.1:44001/dashboard/project",
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
