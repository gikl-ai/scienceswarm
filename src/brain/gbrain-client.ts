/**
 * gbrain CLI client — minimal wrapper around `gbrain put <slug>`.
 *
 * This is the write-path boundary for brain_capture: ScienceSwarm proxies
 * captures to gbrain, which owns chunking, embeddings, tag reconciliation,
 * and symlink guards so the execution/runtime boundary stays predictable.
 *
 * Kept intentionally thin: no retry, no queueing, no singleton state. The
 * spawn function is injectable so tests can substitute a fake without
 * hitting a subprocess.
 */

import { spawn, type SpawnOptions, type ChildProcess } from "child_process";

type NodeSpawnFn = typeof spawn;

export interface GbrainPutResult {
  stdout: string;
  stderr: string;
}

export interface GbrainPutError extends Error {
  code?: string;
  exitCode?: number | null;
  stderr?: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

export interface GbrainClientOptions {
  /** Override path to the gbrain binary. Defaults to GBRAIN_BIN or "gbrain". */
  bin?: string;
  /** Injectable spawn for tests. Defaults to child_process.spawn. */
  spawnFn?: SpawnFn;
  /**
   * Wall-clock timeout for a single `gbrain put` invocation. If the subprocess
   * does not close within this window, it is SIGTERM'd and the promise rejects.
   * Bounds worst-case latency for the MCP tool call. Defaults to 30s.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export interface GbrainLinkOptions {
  linkType?: string;
  context?: string;
}

export interface GbrainClient {
  putPage(slug: string, content: string): Promise<GbrainPutResult>;
  linkPages(
    from: string,
    to: string,
    options?: GbrainLinkOptions,
  ): Promise<GbrainPutResult>;
}

function resolveBin(bin?: string): string {
  return bin ?? process.env.GBRAIN_BIN?.trim() ?? "gbrain";
}

export function createGbrainClient(options: GbrainClientOptions = {}): GbrainClient {
  const bin = resolveBin(options.bin);
  const defaultSpawn: SpawnFn = (cmd, args, opts) =>
    (spawn as NodeSpawnFn)(cmd, [...args], opts ?? {});
  const spawnFn: SpawnFn = options.spawnFn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function runSubprocess(
    args: readonly string[],
    stdinContent: string | null,
    label: string,
    slug: string,
  ): Promise<GbrainPutResult> {
    return new Promise<GbrainPutResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnFn(bin, args, {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(err);
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timeoutHandle =
        timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              child.kill();
              reject(
                new Error(
                  `gbrain ${label} timed out after ${timeoutMs}ms (slug=${slug})`,
                ),
              );
            }, timeoutMs)
          : null;

      const clearTimer = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimer();
        const wrapped: GbrainPutError = Object.assign(
          new Error(err.message),
          { code: err.code, stderr },
        );
        reject(wrapped);
      });

      child.on("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimer();
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const wrapped: GbrainPutError = Object.assign(
          new Error(
            `gbrain ${label} exited with code ${code ?? "null"}: ${stderr.trim() || "(no stderr)"}`,
          ),
          { exitCode: code, stderr },
        );
        reject(wrapped);
      });

      if (child.stdin) {
        if (stdinContent !== null) {
          child.stdin.end(stdinContent);
        } else {
          child.stdin.end();
        }
      } else {
        if (settled) return;
        settled = true;
        clearTimer();
        child.kill();
        reject(
          new Error(
            `gbrain ${label}: stdin unavailable — process was not spawned with stdio:pipe`,
          ),
        );
      }
    });
  }

  return {
    putPage(slug, content) {
      return runSubprocess(["put", slug], content, "put", slug);
    },
    linkPages(from, to, options = {}) {
      const args = ["link", from, to];
      if (options.linkType) args.push("--link_type", options.linkType);
      if (options.context) args.push("--context", options.context);
      return runSubprocess(args, null, "link", `${from}->${to}`);
    },
  };
}
