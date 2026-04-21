/**
 * Tests for `src/lib/setup/install-tasks/openclaw.ts`.
 *
 * The task has two concerns now:
 *   1. Detect/install/update the pinned `openclaw` CLI.
 *   2. After the CLI is present, run upstream non-interactive onboarding in
 *      the ScienceSwarm state dir so gateway auth, workspace bootstrap files,
 *      and local Ollama defaults are initialized by OpenClaw itself.
 *
 * These tests stub `@/lib/openclaw/runner` so the task never shells out
 * to a real binary, and stub `node:child_process.spawn` so the built-in
 * `hasCli` path reports the CLI as already present — we don't want to
 * exercise the `npm install -g` branch here.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskYield } from "@/lib/setup/install-tasks/types";

// ─── Mocks ──────────────────────────────────────────────────────────────

const mockRunOpenClaw =
  vi.fn<(args: readonly string[], options?: unknown) => Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    code: number | null;
  }>>();

const mockResolveOpenClawMode = vi.fn<() => {
  kind: "state-dir";
  stateDir: string;
  configPath: string;
} | { kind: "profile"; profile: string }>();

vi.mock("@/lib/openclaw/runner", () => ({
  runOpenClaw: (args: readonly string[], options?: unknown) =>
    mockRunOpenClaw(args, options),
  resolveOpenClawMode: () => mockResolveOpenClawMode(),
}));

// Fake `which openclaw` so `hasCli` reports the binary as present
// without actually invoking any subprocess. The task only uses spawn
// for the CLI presence probe in this code path, so we don't need to
// model any other command.
type FakeSpawnResult = {
  stdout: EventEmitter;
  stderr: EventEmitter;
  on(event: "close" | "error", cb: (code?: number | Error) => void): void;
};

function makeFakeSpawn(options: {
  stdout?: string;
  stderr?: string;
  code?: number;
}): FakeSpawnResult {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const proc: FakeSpawnResult = {
    stdout,
    stderr,
    on(event, cb) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb as (arg?: unknown) => void);
    },
  };
  // Emit stdout then close on the next microtask so the async handlers
  // in `hasCli` observe both events in the right order.
  queueMicrotask(() => {
    if (options.stdout) stdout.emit("data", options.stdout);
    if (options.stderr) stderr.emit("data", options.stderr);
    for (const cb of listeners.close ?? []) cb(options.code ?? 0);
  });
  return proc;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string) => {
    if (cmd === "npm") return makeFakeSpawn({});
    return makeFakeSpawn({ stdout: "/usr/local/bin/openclaw\n" });
  }),
}));

// ─── Test helpers ───────────────────────────────────────────────────────

async function runTask(): Promise<TaskYield[]> {
  // Import lazily so every test picks up the current mock state. The
  // task module imports `runOpenClaw` at module load, so a lazy import
  // ensures the mocked version is bound.
  const { openclawTask } = await import(
    "@/lib/setup/install-tasks/openclaw"
  );
  const out: TaskYield[] = [];
  for await (const event of openclawTask.run({
    handle: "test-user",
    repoRoot: "/tmp/fake-repo",
  })) {
    out.push(event);
  }
  return out;
}

const STATE_DIR = "/tmp/scienceswarm-test/openclaw";
const WORKSPACE_DIR = `${STATE_DIR}/workspace`;
const PINNED_VERSION = "2026.4.14";

beforeEach(async () => {
  vi.resetModules();
  await fs.rm(STATE_DIR, { recursive: true, force: true });
  mockRunOpenClaw.mockReset();
  mockResolveOpenClawMode.mockReset();
  mockResolveOpenClawMode.mockReturnValue({
    kind: "state-dir",
    stateDir: STATE_DIR,
    configPath: `${STATE_DIR}/openclaw.json`,
  });
  mockRunOpenClaw.mockImplementation(async (args) => {
    if (args[0] === "--version") {
      return {
        ok: true,
        stdout: `OpenClaw ${PINNED_VERSION} (test)\n`,
        stderr: "",
        code: 0,
      };
    }
    return {
      ok: true,
      stdout: "",
      stderr: "",
      code: 0,
    };
  });
  // Ensure OPENCLAW_PORT is unset so getOpenClawPort() returns the
  // canonical DEFAULT_PORTS.openclaw = 18789.
  delete process.env.OPENCLAW_PORT;
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe("openclawTask upstream onboarding", () => {
  it("verifies the pinned CLI then runs non-interactive state-dir onboarding", async () => {
    await runTask();

    expect(mockRunOpenClaw).toHaveBeenCalledTimes(2);

    const firstCall = mockRunOpenClaw.mock.calls[0];
    const secondCall = mockRunOpenClaw.mock.calls[1];

    expect(firstCall[0]).toEqual(["--version"]);
    expect(firstCall[1]).toEqual({ timeoutMs: 5_000 });
    expect(secondCall[0]).toEqual([
      "onboard",
      "--non-interactive",
      "--accept-risk",
      "--mode",
      "local",
      "--auth-choice",
      "ollama",
      "--gateway-bind",
      "loopback",
      "--gateway-port",
      "18789",
      "--workspace",
      WORKSPACE_DIR,
      "--skip-channels",
      "--skip-daemon",
      "--skip-skills",
      "--skip-ui",
      "--skip-health",
      "--json",
    ]);
    expect(secondCall[1]).toEqual({
      timeoutMs: 300_000,
      extraEnv: { OLLAMA_API_KEY: "ollama-local" },
    });
  });

  it("emits a succeeded event without leaking local state paths", async () => {
    const events = await runTask();

    const succeeded = events.filter((e) => e.status === "succeeded");
    expect(succeeded).toHaveLength(1);
    const final = succeeded[0];
    expect(final).toBeDefined();
    expect(final.detail).toBe("OpenClaw runtime is ready for this ScienceSwarm workspace.");
    expect(final.detail).not.toContain(STATE_DIR);
    expect(final.detail).not.toContain("/usr/local/bin/openclaw");
  });

  it("does not rerun upstream onboarding when state-dir OpenClaw is already initialized", async () => {
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });
    await fs.writeFile(
      `${STATE_DIR}/openclaw.json`,
      JSON.stringify({
        gateway: {
          mode: "local",
          port: 18789,
          auth: { mode: "token", token: "test-token" },
        },
      }),
      "utf8",
    );

    const events = await runTask();

    expect(mockRunOpenClaw).toHaveBeenCalledTimes(1);
    expect(mockRunOpenClaw.mock.calls[0]?.[0]).toEqual(["--version"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Using existing OpenClaw workspace and gateway config…",
      }),
    );
    expect(events.some((event) => event.status === "succeeded")).toBe(true);
  });

  it("reruns upstream onboarding when the saved gateway port is stale", async () => {
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });
    await fs.writeFile(
      `${STATE_DIR}/openclaw.json`,
      JSON.stringify({
        gateway: {
          mode: "local",
          port: 12345,
          auth: { mode: "token", token: "test-token" },
        },
      }),
      "utf8",
    );

    const events = await runTask();

    expect(mockRunOpenClaw).toHaveBeenCalledTimes(2);
    expect(mockRunOpenClaw.mock.calls[0]?.[0]).toEqual(["--version"]);
    expect(mockRunOpenClaw.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(["--gateway-port", "18789"]),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Using existing OpenClaw workspace and gateway config…",
      }),
    );
    expect(events.some((event) => event.status === "succeeded")).toBe(true);
  });

  it("fails the task when upstream onboarding fails", async () => {
    mockRunOpenClaw.mockImplementation(async (args) => {
      if (args[0] === "--version") {
        return {
          ok: true,
          stdout: `OpenClaw ${PINNED_VERSION} (test)\n`,
          stderr: "",
          code: 0,
        };
      }
      return {
        ok: false,
        stdout: "",
        stderr: "risk acknowledgement missing",
        code: 1,
      };
    });

    const events = await runTask();

    expect(mockRunOpenClaw).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("openclaw onboard failed"),
      }),
    );
    expect(events.some((e) => e.status === "succeeded")).toBe(false);
  });

  it("honors OPENCLAW_PORT override when running onboarding", async () => {
    process.env.OPENCLAW_PORT = "23456";
    try {
      await runTask();
      const secondCall = mockRunOpenClaw.mock.calls[1];
      expect(secondCall[0]).toContain("--gateway-port");
      expect(secondCall[0]).toContain("23456");
    } finally {
      delete process.env.OPENCLAW_PORT;
    }
  });

  it("updates an existing stale OpenClaw CLI before onboarding", async () => {
    const mockSpawn = vi.mocked(spawn);
    mockRunOpenClaw.mockImplementation(async (args) => {
      if (args[0] === "--version") {
        const versionCallCount = mockRunOpenClaw.mock.calls.filter(
          ([callArgs]) => callArgs[0] === "--version",
        ).length;
        return {
          ok: true,
          stdout: `OpenClaw ${versionCallCount === 1 ? "2026.4.11" : PINNED_VERSION} (test)\n`,
          stderr: "",
          code: 0,
        };
      }
      return { ok: true, stdout: "", stderr: "", code: 0 };
    });

    const events = await runTask();

    expect(mockSpawn).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", `openclaw@${PINNED_VERSION}`],
      expect.any(Object),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: `Updating OpenClaw 2026.4.11 to ${PINNED_VERSION}…`,
      }),
    );
    expect(events.some((e) => e.status === "succeeded")).toBe(true);
  });
});
