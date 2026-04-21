#!/usr/bin/env npx tsx
/**
 * connect-gbrain — initialize ScienceSwarm's local PGLite-backed research brain.
 *
 * Creates wiki scaffolding under the configured brain root and eagerly
 * initializes the local PGLite store so later imports/searches don't pay
 * the first-call setup cost.
 *
 * Usage:
 *   npx tsx scripts/connect-gbrain.ts
  *   npm run connect-gbrain
 */

import { connectGbrain } from "../src/brain/connect-gbrain";

function die(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function info(message: string) {
  console.log(`  → ${message}`);
}

function success(message: string) {
  console.log(`  ✓ ${message}`);
}

async function main() {
  console.log("\n  connect-gbrain — Initialize the ScienceSwarm research brain\n");
  info("Creating wiki scaffolding and initializing the local PGLite store...");

  const result = await connectGbrain();

  if (!result.success) {
    die(result.message);
  }

  success("Local PGLite brain is ready");

  if (result.wikiCreated) {
    success(`Research wiki scaffolding created at ${result.brainRoot}`);
  } else {
    info(`Research wiki already exists at ${result.brainRoot}`);
  }

  console.log(`
  ──────────────────────────────────────────────
  ScienceSwarm is ready to use the local research brain.

  Next steps:
    1. Import your research corpus:
       Use the dashboard import flow or POST /api/brain/import-project

    2. Start ScienceSwarm:
       npm run dev

    3. Test the connection:
       curl -s http://localhost:3001/api/brain/status | jq
  ──────────────────────────────────────────────
`);
}

main().catch((e) => die(String(e)));
