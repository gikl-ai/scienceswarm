#!/usr/bin/env npx tsx
/**
 * scripts/install-gbrain.ts — CLI wrapper around the gbrain installer.
 *
 * The installer logic itself lives in `src/lib/setup/gbrain-installer.ts`
 * so that the same code path is shared by:
 *   1. This CLI (run via `npm run install:gbrain` or `./scripts/install-gbrain.sh`).
 *   2. The `/setup` page's `POST /api/setup/install-brain` route, which
 *      streams progress events to the browser.
 *   3. The unit tests in `tests/unit/install-gbrain.test.ts`, which inject
 *      a fake environment so they exercise the full happy + error paths
 *      without touching the real machine.
 *
 * Usage:
 *   npx tsx scripts/install-gbrain.ts              # default brain root
 *   npx tsx scripts/install-gbrain.ts --json       # machine-readable progress
 *   npx tsx scripts/install-gbrain.ts --brain-root /path/to/brain
 *   npx tsx scripts/install-gbrain.ts --skip-network-check
 *
 * Exits 0 on success, 1 on failure. Failure prints the error code,
 * message, and recovery hint so a user can act on the result without
 * reading source.
 */

import * as path from "node:path";

import {
  defaultInstallerEnvironment,
  runInstaller,
  type InstallerEvent,
} from "../src/lib/setup/gbrain-installer";

interface CliArgs {
  json: boolean;
  brainRoot?: string;
  repoRoot: string;
  skipNetworkCheck: boolean;
  allowAutoInstallBun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    json: false,
    repoRoot: process.cwd(),
    skipNetworkCheck: false,
    allowAutoInstallBun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        args.json = true;
        break;
      case "--brain-root": {
        const next = argv[i + 1];
        if (!next) {
          throw new Error("--brain-root requires a path argument");
        }
        args.brainRoot = path.resolve(next);
        i += 1;
        break;
      }
      case "--repo-root": {
        const next = argv[i + 1];
        if (!next) {
          throw new Error("--repo-root requires a path argument");
        }
        args.repoRoot = path.resolve(next);
        i += 1;
        break;
      }
      case "--skip-network-check":
        args.skipNetworkCheck = true;
        break;
      case "--auto-install-bun":
        args.allowAutoInstallBun = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `install-gbrain — create ~/.scienceswarm/brain and wire it into .env\n\n` +
      `Usage: npx tsx scripts/install-gbrain.ts [options]\n\n` +
      `Options:\n` +
      `  --json                  Emit progress as JSON-lines (one event per line)\n` +
      `  --brain-root <path>     Override the brain root directory\n` +
      `  --repo-root <path>      Override the project repo root (defaults to cwd)\n` +
      `  --skip-network-check    Skip the bun.sh reachability probe\n` +
      `  --auto-install-bun      If bun is missing, hint that you've consented to\n` +
      `                          run the official curl installer (still does not\n` +
      `                          run it; the spec requires user-driven install)\n` +
      `  -h, --help              Show this help\n`,
  );
}

function renderEventHuman(event: InstallerEvent): string {
  if (event.type === "summary") {
    if (event.status === "ok") {
      return `\n[ok] gbrain ready at ${event.brainRoot}\n`;
    }
    const error = event.error;
    if (!error) {
      return `\n[failed] install failed (no error details available)\n`;
    }
    return (
      `\n[failed] ${error.message}\n` +
      `         code:     ${error.code}\n` +
      `         recovery: ${error.recovery}\n` +
      (error.cause ? `         cause:    ${error.cause}\n` : "")
    );
  }
  const prefix =
    event.status === "started"
      ? "..."
      : event.status === "succeeded"
        ? " ok"
        : event.status === "skipped"
          ? "skp"
          : "err";
  const detail = event.detail ? ` — ${event.detail}` : "";
  if (event.status === "failed" && event.error) {
    return `[${prefix}] ${event.step}: ${event.error.message}\n         recovery: ${event.error.recovery}\n`;
  }
  return `[${prefix}] ${event.step}${detail}\n`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const env = await defaultInstallerEnvironment();
  let exitCode = 0;
  for await (const event of runInstaller(
    {
      repoRoot: args.repoRoot,
      brainRoot: args.brainRoot,
      skipNetworkCheck: args.skipNetworkCheck,
      allowAutoInstallBun: args.allowAutoInstallBun,
    },
    env,
  )) {
    if (args.json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else {
      process.stdout.write(renderEventHuman(event));
    }
    if (event.type === "summary" && event.status === "failed") {
      exitCode = 1;
    }
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`install-gbrain: ${message}\n`);
    process.exit(2);
  });
