#!/usr/bin/env node
/**
 * Print ScienceSwarm service ports for shell consumption.
 *
 * Usage:
 *   npx tsx scripts/print-port.ts                 # KEY=VALUE env block
 *   npx tsx scripts/print-port.ts env             # KEY=VALUE env block
 *   npx tsx scripts/print-port.ts frontend        # single port number
 *   npx tsx scripts/print-port.ts openhands       # single port number
 *   npx tsx scripts/print-port.ts openclaw        # literal default
 *   npx tsx scripts/print-port.ts nanoclaw
 *   npx tsx scripts/print-port.ts ollama          # literal default
 */
import {
  DEFAULT_PORTS,
  getFrontendPort,
  getNanoClawUrl,
  getOllamaPort,
  getOpenClawPort,
  getOpenHandsPort,
} from "../src/lib/config/ports";

/** Parse a NanoClaw port out of its URL, falling back to the default. */
function getNanoClawPort(): number {
  const url = getNanoClawUrl();
  try {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port, 10);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    // Fall through to default.
  }
  return DEFAULT_PORTS.nanoclaw;
}

/**
 * The env block printed by `env` / no-arg.
 *
 * All port lines honor the matching `*_PORT` env override, so e.g.
 * `OPENCLAW_PORT=19000 npx tsx scripts/print-port.ts env` prints
 * `OPENCLAW_PORT=19000` — consistent with what the ports module uses.
 */
function envLines(): string[] {
  return [
    `FRONTEND_PORT=${getFrontendPort()}`,
    `OPENHANDS_PORT=${getOpenHandsPort()}`,
    `OPENCLAW_PORT=${getOpenClawPort()}`,
    `NANOCLAW_PORT=${getNanoClawPort()}`,
    `OLLAMA_PORT=${getOllamaPort()}`,
  ];
}

function main(): void {
  const arg = process.argv[2];

  if (!arg || arg === "env") {
    for (const line of envLines()) {
      process.stdout.write(`${line}\n`);
    }
    return;
  }

  switch (arg) {
    case "frontend":
      process.stdout.write(`${getFrontendPort()}\n`);
      return;
    case "openhands":
      process.stdout.write(`${getOpenHandsPort()}\n`);
      return;
    case "openclaw":
      process.stdout.write(`${getOpenClawPort()}\n`);
      return;
    case "nanoclaw":
      process.stdout.write(`${getNanoClawPort()}\n`);
      return;
    case "ollama":
      process.stdout.write(`${getOllamaPort()}\n`);
      return;
    default:
      process.stderr.write(
        `print-port: unknown service "${arg}". ` +
          `Expected one of: env, frontend, openhands, openclaw, nanoclaw, ollama.\n`,
      );
      process.exit(1);
  }
}

main();
