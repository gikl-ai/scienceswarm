import { createRequire } from "node:module";

import { RuntimeHostError } from "../errors";
import {
  buildRuntimeCliFailureUserMessage,
  normalizeCliOutput,
  type NormalizedCliOutput,
} from "./output-normalizer";
import {
  RuntimeCliAuthRequiredError,
  type CliTransport,
  type CliTransportRunRequest,
  type CliTransportRunResult,
} from "./cli";

interface OptionalPtyProcess {
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

interface OptionalPtyModule {
  spawn(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      cols?: number;
      rows?: number;
    },
  ): OptionalPtyProcess;
}

export interface PtyTransportOptions {
  module?: OptionalPtyModule | null;
  cols?: number;
  rows?: number;
}

export class RuntimePtyUnavailableError extends RuntimeHostError {
  constructor(input: { hostId?: string; command?: string; detail?: string } = {}) {
    super({
      code: "RUNTIME_HOST_UNAVAILABLE",
      status: 503,
      message: input.detail ?? "PTY transport is unavailable.",
      userMessage: "PTY transport is unavailable.",
      recoverable: true,
      context: {
        ...input,
        transportError: "PTY_UNAVAILABLE",
      },
    });
    this.name = "RuntimePtyUnavailableError";
  }
}

export class PtyCliTransport implements CliTransport {
  private readonly ptyModule: OptionalPtyModule | null;
  private readonly cols: number;
  private readonly rows: number;

  constructor(options: PtyTransportOptions = {}) {
    this.ptyModule = options.module === undefined
      ? loadOptionalPtyModule()
      : options.module;
    this.cols = options.cols ?? 120;
    this.rows = options.rows ?? 40;
  }

  async run(request: CliTransportRunRequest): Promise<CliTransportRunResult> {
    if (!this.ptyModule) {
      throw new RuntimePtyUnavailableError({
        hostId: request.hostId,
        command: request.command,
      });
    }

    const args = request.args ?? [];
    const timeoutMs = request.timeoutMs ?? 30_000;
    const output = await this.collectOutput(request, args, timeoutMs);

    return {
      command: request.command,
      args,
      exitCode: 0,
      signal: null,
      output,
    };
  }

  private async collectOutput(
    request: CliTransportRunRequest,
    args: string[],
    timeoutMs: number,
  ): Promise<NormalizedCliOutput> {
    const pty = this.ptyModule;
    if (!pty) {
      throw new RuntimePtyUnavailableError({
        hostId: request.hostId,
        command: request.command,
      });
    }

    return await new Promise((resolve, reject) => {
      const chunks: string[] = [];
      const process = pty.spawn(request.command, args, {
        cwd: request.cwd,
        env: request.env,
        cols: this.cols,
        rows: this.rows,
      });
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let forceKillTimer: NodeJS.Timeout | null = null;
      const clearTimers = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }
      };
      const killProcess = (signal: string) => {
        try {
          process.kill(signal);
        } catch {
          // The PTY may have already exited between timeout scheduling and kill.
        }
      };
      const rejectTimeout = () => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        reject(
          new RuntimeHostError({
            code: "RUNTIME_TRANSPORT_ERROR",
            status: 504,
            message: `PTY runtime command timed out after ${timeoutMs}ms.`,
            userMessage: "The AI destination timed out.",
            recoverable: true,
            context: {
              hostId: request.hostId,
              command: request.command,
              timeoutMs,
              transportError: "TIMEOUT",
            },
          }),
        );
      };
      timer = setTimeout(() => {
        killProcess("SIGTERM");
        forceKillTimer = setTimeout(() => killProcess("SIGKILL"), 250);
        forceKillTimer.unref?.();
        rejectTimeout();
      }, timeoutMs);

      process.onData((data) => chunks.push(data));
      process.onExit((event) => {
        clearTimers();
        if (settled) return;
        settled = true;
        const output = normalizeCliOutput({
          stdout: chunks.join(""),
          requireJson: request.requireJson,
        });
        if (output.authChallenge) {
          reject(
            new RuntimeCliAuthRequiredError({
              hostId: request.hostId,
              command: request.command,
              detail: output.text,
            }),
          );
          return;
        }
        if (event.signal) {
          reject(
            new RuntimeHostError({
              code: "RUNTIME_TRANSPORT_ERROR",
              status: 502,
              message: `PTY runtime command exited due to signal ${event.signal}.`,
              userMessage: "The AI destination command was interrupted.",
              recoverable: true,
              context: {
                hostId: request.hostId,
                command: request.command,
                signal: event.signal,
                transportError: "SIGNAL",
              },
            }),
          );
          return;
        }
        if (event.exitCode !== 0) {
          reject(
            new RuntimeHostError({
              code: "RUNTIME_TRANSPORT_ERROR",
              status: 502,
              message: `PTY runtime command exited with code ${event.exitCode}.`,
              userMessage: buildRuntimeCliFailureUserMessage({
                hostId: request.hostId,
                command: request.command,
                output,
              }),
              recoverable: true,
              context: {
                hostId: request.hostId,
                command: request.command,
                exitCode: event.exitCode,
                transportError: "NON_ZERO_EXIT",
              },
            }),
          );
          return;
        }
        resolve(output);
      });

      if (request.input) {
        process.write(request.input);
      }
    });
  }
}

function loadOptionalPtyModule(): OptionalPtyModule | null {
  try {
    const require = createRequire(import.meta.url);
    return require("node-pty") as OptionalPtyModule;
  } catch {
    return null;
  }
}

export function createPtyCliTransport(
  options: PtyTransportOptions = {},
): PtyCliTransport {
  return new PtyCliTransport(options);
}
