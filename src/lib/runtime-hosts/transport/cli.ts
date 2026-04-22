import { spawn } from "node:child_process";

import type { RuntimeHostAuthStatus, RuntimeHostHealth } from "../contracts";
import { RuntimeHostError } from "../errors";
import {
  normalizeCliOutput,
  type NormalizedCliOutput,
} from "./output-normalizer";

export interface CliTransportRunRequest {
  hostId?: string;
  command: string;
  args?: string[];
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  requireJson?: boolean;
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
      userMessage: "Runtime host requires authentication.",
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
      userMessage: "Runtime host timed out.",
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
  async run(request: CliTransportRunRequest): Promise<CliTransportRunResult> {
    const args = request.args ?? [];
    const timeoutMs = request.timeoutMs ?? 30_000;

    return await new Promise<CliTransportRunResult>((resolve, reject) => {
      const child = spawn(request.command, args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finishReject(
          new RuntimeCliTimeoutError({
            hostId: request.hostId,
            command: request.command,
            timeoutMs,
          }),
        );
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
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
        clearTimeout(timer);
        if (settled) return;
        settled = true;

        const output = normalizeCliOutput({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
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
        if (exitCode && exitCode !== 0) {
          reject(
            new RuntimeHostError({
              code: "RUNTIME_TRANSPORT_ERROR",
              status: 502,
              message: `Runtime CLI exited with code ${exitCode}: ${request.command}`,
              userMessage: "Runtime host command failed.",
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
}

export async function detectCliHealth(input: {
  hostId: string;
  command: string;
  args?: string[];
  transport?: CliTransport;
  timeoutMs?: number;
}): Promise<RuntimeHostHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const result = await (input.transport ?? new LocalCliTransport()).run({
      hostId: input.hostId,
      command: input.command,
      args: input.args ?? ["--version"],
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
