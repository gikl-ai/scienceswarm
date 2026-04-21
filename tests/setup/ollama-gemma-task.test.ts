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
  const { ollamaGemmaTask } = await import(
    "@/lib/setup/install-tasks/ollama-gemma"
  );
  const events: TaskYield[] = [];
  for await (const event of ollamaGemmaTask.run({
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
});

describe("ollamaGemmaTask", () => {
  it("starts Ollama before pulling gemma4 when the daemon is stopped", async () => {
    let listCalls = 0;
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "ollama") {
        return fakeProcess({ stdout: "/opt/homebrew/bin/ollama\n" });
      }
      if (command === "/opt/homebrew/bin/ollama" && args[0] === "--version") {
        return fakeProcess({ stdout: "ollama version is 0.11.6\n" });
      }
      if (command === "/opt/homebrew/bin/ollama" && args[0] === "list") {
        listCalls += 1;
        return listCalls === 1
          ? fakeProcess({ stderr: "could not connect to ollama app", code: 1 })
          : fakeProcess({ stdout: "NAME ID SIZE MODIFIED\n" });
      }
      if (command === "open" && args.join(" ") === "-ga Ollama") {
        return fakeProcess({});
      }
      if (command === "/opt/homebrew/bin/ollama" && args[0] === "pull") {
        return fakeProcess({ stdout: "success\n" });
      }
      return fakeProcess({ code: 1 });
    });

    const events = await runTask();

    expect(events).toContainEqual(
      expect.objectContaining({
        status: "running",
        detail: "Starting Ollama…",
      }),
    );
    expect(events.at(-1)).toMatchObject({ status: "succeeded" });
    expect(spawnMock).toHaveBeenCalledWith(
      "open",
      ["-ga", "Ollama"],
      expect.anything(),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "/opt/homebrew/bin/ollama",
      ["pull", "gemma4:latest"],
      expect.anything(),
    );
  });

  it("does not pull again when gemma4:latest is already installed", async () => {
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "ollama") {
        return fakeProcess({ stdout: "/opt/homebrew/bin/ollama\n" });
      }
      if (command === "/opt/homebrew/bin/ollama" && args[0] === "--version") {
        return fakeProcess({ stdout: "ollama version is 0.11.6\n" });
      }
      if (command === "/opt/homebrew/bin/ollama" && args[0] === "list") {
        return fakeProcess({
          stdout: "NAME ID SIZE MODIFIED\ngemma4:latest abc123 9GB now\n",
        });
      }
      return fakeProcess({ code: 1 });
    });

    const events = await runTask();

    expect(events.at(-1)).toMatchObject({
      status: "succeeded",
      detail: "gemma4:latest ready.",
    });
    expect(spawnMock).not.toHaveBeenCalledWith(
      "/opt/homebrew/bin/ollama",
      ["pull", "gemma4:latest"],
      expect.anything(),
    );
  });

  it("strips progress escape codes from pull failures", async () => {
    spawnMock.mockImplementation((command: string, args: string[] = []) => {
      if (command === "which" && args[0] === "ollama") {
        return fakeProcess({ stdout: "/opt/homebrew/bin/ollama\n" });
      }
      if (command === "/opt/homebrew/bin/ollama" && args[0] === "--version") {
        return fakeProcess({ stdout: "ollama version is 0.11.6\n" });
      }
      if (command === "/opt/homebrew/bin/ollama" && args[0] === "list") {
        return fakeProcess({ stdout: "NAME ID SIZE MODIFIED\n" });
      }
      if (command === "/opt/homebrew/bin/ollama" && args[0] === "pull") {
        return fakeProcess({
          stderr: "\u001b[?25lpulling manifest\rpulling manifest: file does not exist",
          code: 1,
        });
      }
      return fakeProcess({ code: 1 });
    });

    const events = await runTask();
    const failed = events.at(-1);

    expect(failed).toMatchObject({ status: "failed" });
    expect(failed?.error).toContain("pulling manifest: file does not exist");
    expect(failed?.error).not.toContain("\u001b");
    expect(failed?.error).not.toContain("\r");
  });
});
