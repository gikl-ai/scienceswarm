import { describe, expect, it, vi } from "vitest";

import {
  LocalCliTransport,
  RuntimeCliAuthRequiredError,
  RuntimeCliMissingError,
  RuntimeCliTimeoutError,
  detectCliHealth,
} from "@/lib/runtime-hosts/transport/cli";
import {
  RuntimePtyUnavailableError,
  createPtyCliTransport,
} from "@/lib/runtime-hosts/transport/pty";
import {
  RuntimeCliMalformedOutputError,
  normalizeCliOutput,
  stripAnsi,
} from "@/lib/runtime-hosts/transport/output-normalizer";

describe("runtime host CLI transport", () => {
  it("normalizes ANSI, carriage returns, JSON, and JSONL output", () => {
    expect(stripAnsi("\u001b[32mok\u001b[0m")).toBe("ok");

    const output = normalizeCliOutput({
      stdout: "\u001b[36m{\"message\":\"hello\"}\u001b[0m\r\n{\"text\":\"world\"}",
    });

    expect(output.lines).toEqual(['{"message":"hello"}', '{"text":"world"}']);
    expect(output.jsonLines).toHaveLength(2);
    expect(output.text).toBe("hello\nworld");
  });

  it("keeps non-JSON stdout as normalized text", () => {
    const output = normalizeCliOutput({
      stdout: "\u001b[33mPlain answer\u001b[0m\r\n",
    });

    expect(output.text).toBe("Plain answer");
    expect(output.json).toBeNull();
  });

  it("throws a typed malformed-output error when JSON is required", () => {
    expect(() =>
      normalizeCliOutput({
        stdout: "not json",
        requireJson: true,
      })
    ).toThrow(RuntimeCliMalformedOutputError);
  });

  it("detects auth challenges in stdout or stderr", () => {
    const output = normalizeCliOutput({
      stderr: "Please log in to continue.",
    });

    expect(output.authChallenge).toBe(true);
  });

  it("runs a local subprocess and returns normalized output", async () => {
    const transport = new LocalCliTransport();

    const result = await transport.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('\\u001b[32mhello\\u001b[0m')"],
      timeoutMs: 2_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output.text).toBe("hello");
  });

  it("emits stdout lines before returning the buffered subprocess result", async () => {
    const transport = new LocalCliTransport();
    const lines: string[] = [];

    const result = await transport.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('one\\n'); process.stdout.write('two')"],
      timeoutMs: 2_000,
      onStdoutLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(["one", "two"]);
    expect(result.output.text).toBe("one\ntwo");
  });

  it("preserves split multibyte UTF-8 characters while emitting stdout lines", async () => {
    const transport = new LocalCliTransport();
    const lines: string[] = [];
    const expectedLine = JSON.stringify({ text: "hello 🧪" });

    const result = await transport.run({
      command: process.execPath,
      args: [
        "-e",
        [
          "const payload = Buffer.from(JSON.stringify({ text: 'hello 🧪' }) + '\\n');",
          "const emoji = Buffer.from('🧪');",
          "const split = payload.indexOf(emoji) + 2;",
          "process.stdout.write(payload.subarray(0, split));",
          "setTimeout(() => process.stdout.write(payload.subarray(split)), 5);",
        ].join(" "),
      ],
      timeoutMs: 2_000,
      onStdoutLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([expectedLine]);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({ text: "hello 🧪" });
    expect(result.output.text).toBe("hello 🧪");
  });

  it("maps a missing command to a typed missing-CLI error and unavailable health", async () => {
    const command = "scienceswarm-definitely-missing-cli-20260422";
    const transport = new LocalCliTransport();

    await expect(
      transport.run({
        hostId: "codex",
        command,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(RuntimeCliMissingError);

    await expect(
      detectCliHealth({
        hostId: "codex",
        command,
        transport,
        timeoutMs: 500,
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      detail: expect.stringContaining("not installed"),
    });
  });

  it("maps auth challenge output to a typed auth-required error", async () => {
    const transport = new LocalCliTransport();

    await expect(
      transport.run({
        hostId: "claude-code",
        command: process.execPath,
        args: ["-e", "process.stderr.write('Authentication required')"],
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(RuntimeCliAuthRequiredError);
  });

  it("allows successful stdout that mentions login text in model content", async () => {
    const transport = new LocalCliTransport();

    await expect(
      transport.run({
        hostId: "codex",
        command: process.execPath,
        args: ["-e", "process.stdout.write('The answer mentions login required as text')"],
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      output: {
        text: "The answer mentions login required as text",
      },
    });
  });

  it("surfaces Claude Code gbrain MCP failures with actionable detail", async () => {
    const transport = new LocalCliTransport();

    await expect(
      transport.run({
        hostId: "claude-code",
        command: process.execPath,
        args: [
          "-e",
          "process.stderr.write('Runtime MCP access token is required.'); process.exit(1)",
        ],
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({
      userMessage: expect.stringContaining("scoped gbrain tools"),
    });
  });

  it("maps signal-terminated subprocesses to transport errors", async () => {
    const transport = new LocalCliTransport();

    await expect(
      transport.run({
        hostId: "codex",
        command: process.execPath,
        args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("signal SIGTERM");
  });

  it("cancels a tracked local subprocess by runtime session id", async () => {
    const transport = new LocalCliTransport();
    const run = transport.run({
      hostId: "claude-code",
      sessionId: "rt-session-cancellable",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5_000)"],
      timeoutMs: 10_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(transport.cancel("rt-session-cancellable")).resolves.toBe(true);
    await expect(run).rejects.toThrow("signal SIGTERM");
    await expect(transport.cancel("rt-session-cancellable")).resolves.toBe(false);
  });

  it("times out hung subprocesses with a typed timeout error", async () => {
    const transport = new LocalCliTransport();

    await expect(
      transport.run({
        hostId: "gemini-cli",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 5_000)"],
        timeoutMs: 50,
      }),
    ).rejects.toThrow(RuntimeCliTimeoutError);
  });

  it("maps missing PTY native bindings to a typed unavailable error", async () => {
    const transport = createPtyCliTransport({ module: null });

    await expect(
      transport.run({
        hostId: "codex",
        command: "codex",
      }),
    ).rejects.toThrow(RuntimePtyUnavailableError);
  });

  it("maps PTY auth challenge output before generic non-zero failures", async () => {
    const transport = createPtyCliTransport({
      module: {
        spawn() {
          let onData: (data: string) => void = () => {};
          return {
            onData(callback: (data: string) => void) {
              onData = callback;
            },
            onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
              queueMicrotask(() => {
                onData("Authentication required");
                callback({ exitCode: 1 });
              });
            },
            write() {},
            kill() {},
          };
        },
      },
    });

    await expect(
      transport.run({
        hostId: "gemini-cli",
        command: "gemini",
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(RuntimeCliAuthRequiredError);
  });

  it("force kills PTY subprocesses after timeout grace period", async () => {
    vi.useFakeTimers();
    const signals: string[] = [];
    const transport = createPtyCliTransport({
      module: {
        spawn() {
          return {
            onData() {},
            onExit() {},
            write() {},
            kill(signal?: string) {
              signals.push(signal ?? "");
            },
          };
        },
      },
    });

    try {
      const run = transport.run({
        hostId: "gemini-cli",
        command: "gemini",
        timeoutMs: 10,
      });
      const rejection = expect(run).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(signals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(250);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
