import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskYield } from "@/lib/setup/install-tasks/types";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type FakeProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  unref: () => void;
};

function fakeProcess(options: {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: Error;
}): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.unref = vi.fn();
  queueMicrotask(() => {
    if (!options.error) proc.emit("spawn");
    if (options.stdout) proc.stdout.emit("data", options.stdout);
    if (options.stderr) proc.stderr.emit("data", options.stderr);
    if (options.error) {
      proc.emit("error", options.error);
      return;
    }
    proc.emit("close", options.code ?? 0);
  });
  return proc;
}

async function runTask(): Promise<TaskYield[]> {
  const { openhandsDockerTask } = await import(
    "@/lib/setup/install-tasks/openhands-docker"
  );
  const events: TaskYield[] = [];
  for await (const event of openhandsDockerTask.run({
    handle: "researcher",
    repoRoot: "/tmp/repo",
  })) {
    events.push(event);
  }
  return events;
}

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

beforeEach(() => {
  vi.resetModules();
  spawnMock.mockReset();
  setPlatform("darwin");
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("openhandsDockerTask", () => {
  it("starts Docker Desktop when the CLI exists but the daemon is stopped", async () => {
    vi.stubEnv("SCIENCESWARM_SKIP_RUNTIME_DOWNLOADS", "1");
    let infoCalls = 0;
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "docker") {
        return fakeProcess({ stdout: "/usr/local/bin/docker\n" });
      }
      if (command === "/usr/local/bin/docker" && args[0] === "--version") {
        return fakeProcess({ stdout: "Docker version 28.5.1\n" });
      }
      if (command === "/usr/local/bin/docker" && args[0] === "info") {
        infoCalls += 1;
        return infoCalls === 1
          ? fakeProcess({ stderr: "Cannot connect to Docker daemon", code: 1 })
          : fakeProcess({ stdout: "Server: Docker Desktop\n" });
      }
      if (command === "open" && args.join(" ") === "-ga Docker") {
        return fakeProcess({});
      }
      return fakeProcess({ code: 1 });
    });

    const events = await runTask();

    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Starting Docker Desktop…",
      }),
    );
    expect(events.at(-1)).toMatchObject({
      status: "succeeded",
      detail: expect.stringContaining("OpenHands image download was skipped"),
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "open",
      ["-ga", "Docker"],
      expect.anything(),
    );
  });

  it("honors an explicit zero Docker startup timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENHANDS_DOCKER_START_TIMEOUT_MS", "0");

    let infoCalls = 0;
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "docker") {
        return fakeProcess({ stdout: "/usr/local/bin/docker\n" });
      }
      if (command === "/usr/local/bin/docker" && args[0] === "--version") {
        return fakeProcess({ stdout: "Docker version 28.5.1\n" });
      }
      if (command === "/usr/local/bin/docker" && args[0] === "info") {
        infoCalls += 1;
        return fakeProcess({ stderr: "Cannot connect to Docker daemon", code: 1 });
      }
      if (command === "open" && args.join(" ") === "-ga Docker") {
        return fakeProcess({});
      }
      if (command === "/usr/local/bin/docker" && args[0] === "pull") {
        return fakeProcess({ stdout: "Image should not be pulled\n" });
      }
      return fakeProcess({ code: 1 });
    });

    const eventsPromise = runTask();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    const events = await eventsPromise;

    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: expect.stringContaining("Waiting for Docker to become ready (0s elapsed)"),
      }),
    );
    expect(events.at(-1)).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("Docker is installed but the daemon is not ready yet"),
    });
    expect(infoCalls).toBe(2);
    expect(spawnMock).not.toHaveBeenCalledWith(
      "/usr/local/bin/docker",
      ["pull", expect.any(String)],
      expect.anything(),
    );
  });

  it("falls back to common Docker CLI paths when PATH lookup misses", async () => {
    vi.stubEnv("SCIENCESWARM_SKIP_RUNTIME_DOWNLOADS", "1");
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "docker") {
        return fakeProcess({ code: 1 });
      }
      if (command === "/usr/local/bin/docker" && args[0] === "--version") {
        return fakeProcess({ stdout: "Docker version 28.5.1\n" });
      }
      if (command === "/usr/local/bin/docker" && args[0] === "info") {
        return fakeProcess({ stdout: "Server: Docker Desktop\n" });
      }
      return fakeProcess({ code: 1 });
    });

    const events = await runTask();

    expect(events.at(-1)).toMatchObject({ status: "succeeded" });
    expect(spawnMock).not.toHaveBeenCalledWith(
      "/usr/local/bin/docker",
      ["pull", expect.any(String)],
      expect.anything(),
    );
  });

  it("pulls the OpenHands image and starts the managed container when Docker is ready", async () => {
    vi.stubEnv("SCIENCESWARM_DIR", "/tmp/scienceswarm-openhands-docker-test");
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockRejectedValueOnce(new Error("not running yet"))
        .mockResolvedValue({ ok: true, status: 200 }),
    );

    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "docker") {
        return fakeProcess({ stdout: "/usr/local/bin/docker\n" });
      }
      if (command === "/usr/local/bin/docker" && args[0] === "--version") {
        return fakeProcess({ stdout: "Docker version 28.5.1\n" });
      }
      if (command === "/usr/local/bin/docker" && args[0] === "info") {
        return fakeProcess({ stdout: "Server: Docker Desktop\n" });
      }
      if (command === "/usr/local/bin/docker" && args.join(" ") === "image inspect test-openhands:latest") {
        return fakeProcess({ code: 1 });
      }
      if (command === "/usr/local/bin/docker" && args.join(" ") === "pull test-openhands:latest") {
        return fakeProcess({ stdout: "pulled\n" });
      }
      if (command === "/usr/local/bin/docker" && args.join(" ") === `rm -f scienceswarm-agent`) {
        return fakeProcess({});
      }
      if (command === "/usr/local/bin/docker" && args[0] === "run") {
        return fakeProcess({ stdout: "container-id\n" });
      }
      return fakeProcess({ code: 1 });
    });
    vi.stubEnv("OPENHANDS_IMAGE", "test-openhands:latest");

    const events = await runTask();

    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Downloading the pinned OpenHands runtime image…",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Starting the local OpenHands service…",
      }),
    );
    expect(events.at(-1)).toMatchObject({
      status: "succeeded",
      detail: expect.stringContaining("OpenHands container started"),
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/docker",
      ["pull", "test-openhands:latest"],
      expect.anything(),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/docker",
      expect.arrayContaining([
        "run",
        "-d",
        "--rm",
        "--name",
        "scienceswarm-agent",
        "test-openhands:latest",
      ]),
      expect.anything(),
    );
  });

  it("does not restart OpenHands when the local service is already reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "docker") {
        return fakeProcess({ stdout: "/usr/local/bin/docker\n" });
      }
      if (command === "/usr/local/bin/docker" && args[0] === "--version") {
        return fakeProcess({ stdout: "Docker version 28.5.1\n" });
      }
      if (command === "/usr/local/bin/docker" && args[0] === "info") {
        return fakeProcess({ stdout: "Server: Docker Desktop\n" });
      }
      if (command === "/usr/local/bin/docker" && args.join(" ") === "image inspect test-openhands:latest") {
        return fakeProcess({ stdout: "image exists\n" });
      }
      return fakeProcess({ code: 1 });
    });
    vi.stubEnv("OPENHANDS_IMAGE", "test-openhands:latest");

    const events = await runTask();

    expect(events.at(-1)).toMatchObject({
      status: "succeeded",
      detail: "OpenHands is already reachable.",
    });
    expect(spawnMock).not.toHaveBeenCalledWith(
      "/usr/local/bin/docker",
      ["rm", "-f", "scienceswarm-agent"],
      expect.anything(),
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      "/usr/local/bin/docker",
      expect.arrayContaining(["run"]),
      expect.anything(),
    );
  });

  it("skips the optional OpenHands step on Linux when Docker is missing", async () => {
    setPlatform("linux");
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "docker") {
        return fakeProcess({ code: 1 });
      }
      return fakeProcess({ code: 1 });
    });

    const events = await runTask();

    expect(events.at(-1)).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("OpenHands code execution needs Docker"),
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "which",
      ["docker"],
      expect.anything(),
    );
  });

  it("skips the optional OpenHands step on macOS when no Docker CLI is present", async () => {
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "docker") {
        return fakeProcess({ code: 1 });
      }
      return fakeProcess({ code: 1 });
    });

    const events = await runTask();

    expect(events.at(-1)).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("Docker Desktop is not installed"),
    });
    expect(spawnMock).not.toHaveBeenCalledWith(
      "/opt/homebrew/bin/brew",
      ["install", "--cask", "docker"],
      expect.anything(),
    );
  });

  it("skips quickly when Docker Desktop is still unavailable on Apple Silicon", async () => {
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "docker") {
        return fakeProcess({ code: 1 });
      }
      return fakeProcess({ code: 1 });
    });

    const events = await runTask();

    expect(events.at(-1)).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("needs Docker"),
    });
  });
});
