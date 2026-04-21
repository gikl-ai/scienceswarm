// Standalone launcher for the ScienceSwarm second-brain MCP server.
// Used by the OpenClaw plugin manifest (openclaw.plugin.json) to spawn the
// stdio transport without any init prompts. Invoke via `npx tsx
// scripts/start-mcp-server.ts` — no shebang to keep direct execution portable
// across macOS versions older than 12.3 (which lack `env -S`).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] != null) {
      continue;
    }
    const value = trimmed.slice(equals + 1).trim();
    process.env[key] = stripEnvQuotes(value);
  }
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

loadDotEnv();

async function main(): Promise<void> {
  const { startMcpServer } = await import("../src/brain/mcp-server");
  await startMcpServer();
}

main().catch((err: unknown) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
