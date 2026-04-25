import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { RuntimeHostAuthStatus, RuntimeHostHealth } from "../contracts";
import { RuntimeHostError } from "../errors";
import {
  isCliAuthChallengeText,
  normalizeCliOutput,
  type NormalizedCliOutput,
} from "./output-normalizer";

export interface CliTransportRunRequest {
  hostId?: string;
  sessionId?: string;
  command: string;
  args?: string[];
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  requireJson?: boolean;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface CliTransportRunResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: NormalizedCliOutput;
}

export interface CliTransport {
  run(request: CliTransportRunRequest): Promise<CliTransportRunResult>;
  cancel?(sessionId: string): Promise<boolean>;
}

function appendPathEntries(
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!env) return env;
  const currentPath = env.PATH ?? env.Path ?? "";
  const home = homedir();
  const candidates = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global/bin"),
    path.join(home, ".local/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".bun/bin"),
  ];
  const existing = new Set(currentPath.split(path.delimiter).filter(Boolean));
  const extra = candidates.filter((entry) => !existing.has(entry));
  if (extra.length === 0) return env;
  return {
    ...env,
    PATH: [currentPath, ...extra].filter(Boolean).join(path.delimiter),
  };
}

class LineEmitter {
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly onLine?: (line: string) => void) {}

  push(chunk: Buffer): void {
    if (!this.onLine) return;
    this.pending += this.decoder.write(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) this.onLine(line);
    }
  }

  flush(): void {
    if (!this.onLine) return;
    this.pending += this.decoder.end().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (this.pending.trim()) this.onLine(this.pending);
    this.pending = "";
  }
}

export class RuntimeCliMissingError extends RuntimeHostError {
  constructor(input: { hostId?: string; command: string }) {
    super({
      code: "RUNTIME_HOST_UNAVAILABLE",
      status: 503,
      message: `Runtime CLI is not installed or not on PATH: ${input.command}`,
      userMessage: "Runtime CLI is not installed or not on PATH.",
      recoverable: true,
      context: {
        ...input,
        transportError: "MISSING_CLI",
      },
    });
    this.name = "RuntimeCliMissingError";
  }
}

export class RuntimeCliAuthRequiredError extends RuntimeHostError {
  constructor(input: { hostId?: string; command: string; detail?: string }) {
    super({
      code: "RUNTIME_HOST_AUTH_REQUIRED",
      status: 401,
      message: input.detail ?? `Runtime CLI requires authentication: ${input.command}`,
      userMessage: "This AI destination requires authentication.",
      recoverable: true,
      context: {
        ...input,
        transportError: "AUTH_REQUIRED",
      },
    });
    this.name = "RuntimeCliAuthRequiredError";
  }
}

export class RuntimeCliTimeoutError extends RuntimeHostError {
  constructor(input: { hostId?: string; command: string; timeoutMs: number }) {
    super({
      code: "RUNTIME_TRANSPORT_ERROR",
      status: 504,
      message: `Runtime CLI timed out after ${input.timeoutMs}ms: ${input.command}`,
      userMessage: "The AI destination timed out.",
      recoverable: true,
      context: {
        ...input,
        transportError: "TIMEOUT",
      },
    });
    this.name = "RuntimeCliTimeoutError";
  }
}

export class LocalCliTransport implements CliTransport {
  private readonly activeProcesses = new Map<
    string,
    {
      child: ChildProcessWithoutNullStreams;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  async run(request: CliTransportRunRequest): Promise<CliTransportRunResult> {
    const args = request.args ?? [];
    const timeoutMs = request.timeoutMs ?? 30_000;

    return await new Promise<CliTransportRunResult>((resolve, reject) => {
      const child = spawn(request.command, args, {
        cwd: request.cwd,
        env: appendPathEntries(request.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (request.sessionId) {
        this.activeProcesses.set(request.sessionId, {
          child,
          forceKillTimer: null,
        });
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const stdoutLines = new LineEmitter(request.onStdoutLine);
      const stderrLines = new LineEmitter(request.onStderrLine);
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
      const clearActiveProcess = () => {
        if (!request.sessionId) return;
        const activeProcess = this.activeProcesses.get(request.sessionId);
        if (
          activeProcess
          && activeProcess.child === child
        ) {
          if (activeProcess.forceKillTimer) {
            clearTimeout(activeProcess.forceKillTimer);
          }
          this.activeProcesses.delete(request.sessionId);
        }
      };

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        clearActiveProcess();
        reject(error);
      };
      const finishTimeout = () => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        clearActiveProcess();
        reject(
          new RuntimeCliTimeoutError({
            hostId: request.hostId,
            command: request.command,
            timeoutMs,
          }),
        );
      };
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
        forceKillTimer.unref?.();
        finishTimeout();
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        stdoutLines.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        stderrLines.push(chunk);
      });
      child.on("error", (error) => {
        clearTimers();
        clearActiveProcess();
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          finishReject(
            new RuntimeCliMissingError({
              hostId: request.hostId,
              command: request.command,
            }),
          );
          return;
        }
        finishReject(error);
      });
      child.on("close", (exitCode, signal) => {
        clearTimers();
        clearActiveProcess();
        if (settled) return;
        settled = true;
        stdoutLines.flush();
        stderrLines.flush();

        const output = normalizeCliOutput({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          requireJson: request.requireJson,
        });
        const authChallenge = isCliAuthChallengeText(output.stderr)
          || (exitCode !== null && exitCode !== 0 && output.authChallenge);
        if (authChallenge) {
          reject(
            new RuntimeCliAuthRequiredError({
              hostId: request.hostId,
              command: request.command,
              detail: output.text,
            }),
          );
          return;
        }
        if (signal) {
          reject(
            new RuntimeHostError({
              code: "RUNTIME_TRANSPORT_ERROR",
              status: 502,
              message: `Runtime CLI exited due to signal ${signal}: ${request.command}`,
              userMessage: "The AI destination command was interrupted.",
              recoverable: true,
              context: {
                hostId: request.hostId,
                command: request.command,
                signal,
                stderr: output.stderr,
                transportError: "SIGNAL",
              },
            }),
          );
          return;
        }
        if (exitCode !== null && exitCode !== 0) {
          reject(
            new RuntimeHostError({
              code: "RUNTIME_TRANSPORT_ERROR",
              status: 502,
              message: `Runtime CLI exited with code ${exitCode}: ${request.command}`,
              userMessage: "The AI destination command failed.",
              recoverable: true,
              context: {
                hostId: request.hostId,
                command: request.command,
                exitCode,
                stderr: output.stderr,
                transportError: "NON_ZERO_EXIT",
              },
            }),
          );
          return;
        }

        resolve({
          command: request.command,
          args,
          exitCode,
          signal,
          output,
        });
      });

      if (request.input) {
        child.stdin?.write(request.input);
      }
      child.stdin?.end();
    });
  }

  async cancel(sessionId: string): Promise<boolean> {
    const activeProcess = this.activeProcesses.get(sessionId);
    const child = activeProcess?.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return false;
    }

    child.kill("SIGTERM");
    if (activeProcess.forceKillTimer) {
      clearTimeout(activeProcess.forceKillTimer);
    }
    activeProcess.forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 250);
    activeProcess.forceKillTimer.unref?.();
    return true;
  }
}

export async function detectCliHealth(input: {
  hostId: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  transport?: CliTransport;
  timeoutMs?: number;
}): Promise<RuntimeHostHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const result = await (input.transport ?? new LocalCliTransport()).run({
      hostId: input.hostId,
      command: input.command,
      args: input.args ?? ["--version"],
      env: input.env,
      timeoutMs: input.timeoutMs ?? 5_000,
    });
    return {
      status: "ready",
      checkedAt,
      detail: result.output.text || `${input.command} is available.`,
      evidence: [
        {
          label: "command",
          value: input.command,
        },
      ],
    };
  } catch (error) {
    if (error instanceof RuntimeCliMissingError) {
      return {
        status: "unavailable",
        checkedAt,
        detail: error.userMessage,
        evidence: [{ label: "command", value: input.command }],
      };
    }
    if (error instanceof RuntimeCliAuthRequiredError) {
      return {
        status: "ready",
        checkedAt,
        detail: "CLI is installed but requires authentication.",
        evidence: [{ label: "command", value: input.command }],
      };
    }
    return {
      status: "unavailable",
      checkedAt,
      detail: error instanceof Error ? error.message : "CLI health check failed.",
      evidence: [{ label: "command", value: input.command }],
    };
  }
}

export async function detectCliAuthStatus(input: {
  authMode: RuntimeHostAuthStatus["authMode"];
  provider: RuntimeHostAuthStatus["provider"];
  hostId: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  transport?: CliTransport;
  timeoutMs?: number;
}): Promise<RuntimeHostAuthStatus> {
  if (!input.args?.length) {
    return {
      status: "unknown",
      authMode: input.authMode,
      provider: input.provider,
      detail: "CLI authentication is owned by the native host and is not stored by ScienceSwarm.",
    };
  }

  try {
    const result = await (input.transport ?? new LocalCliTransport()).run({
      hostId: input.hostId,
      command: input.command,
      args: input.args,
      env: input.env,
      timeoutMs: input.timeoutMs ?? 5_000,
    });
    return {
      status: result.output.authChallenge ? "missing" : "authenticated",
      authMode: input.authMode,
      provider: input.provider,
      accountLabel: result.output.text || undefined,
      detail: "CLI authentication is managed by the native host.",
    };
  } catch (error) {
    if (error instanceof RuntimeCliAuthRequiredError) {
      return {
        status: "missing",
        authMode: input.authMode,
        provider: input.provider,
        detail: error.userMessage,
      };
    }
    if (error instanceof RuntimeCliMissingError) {
      return {
        status: "missing",
        authMode: input.authMode,
        provider: input.provider,
        detail: error.userMessage,
      };
    }
    return {
      status: "unknown",
      authMode: input.authMode,
      provider: input.provider,
      detail: error instanceof Error ? error.message : "CLI auth check failed.",
    };
  }
}
