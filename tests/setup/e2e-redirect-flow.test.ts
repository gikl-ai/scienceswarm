// @vitest-environment node
//
// End-to-end smoke test for the /setup MVP contract.
//
// This is a pure-function integration test that wires together the two
// halves of the setup pipeline:
//
//   1. `writeEnvFileAtomic` (the side the UI calls when a user hits Save)
//   2. `getConfigStatus` (the side the `/dashboard` layout calls to decide
//      whether to redirect to `/setup`)
//
// The core MVP contract: with no `.env`, `getConfigStatus`
// reports `ready: false`; after the UI writes a valid `.env`
// with a real-looking OpenAI key and a writable data directory, the
// same checker reports `ready: true`. If this assertion breaks, the
// user-visible "I saved valid values but the dashboard keeps bouncing
// me to /setup" bug re-emerges.
//
// The test uses a tmp dir for `process.cwd()` so nothing touches the
// real repo. Each test gets a fresh tmp dir so runs are independent.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfigStatus } from "@/lib/setup/config-status";
import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
} from "@/lib/setup/env-writer";

async function makeTempRepoRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "setup-e2e-repo-"));
}

async function makeTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "setup-e2e-data-"));
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe("setup MVP end-to-end: write → read → ready flag", () => {
  let repoRoot: string;
  let dataDir: string;

  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot();
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await rmrf(repoRoot);
    await rmrf(dataDir);
  });

  it("reports ready:false when no .env exists", async () => {
    const status = await getConfigStatus(repoRoot);
    expect(status.ready).toBe(false);
    expect(status.envFileExists).toBe(false);
    expect(status.openaiApiKey.state).toBe("missing");
    // An unset SCIENCESWARM_DIR falls back to the default (~/.scienceswarm),
    // which the validator treats as `ok`. The missing OpenAI key is what
    // keeps the overall status not-ready.
    expect(status.scienceswarmDir.state).toBe("ok");
  });

  it("flips ready:true after writeEnvFileAtomic persists valid values", async () => {
    // First confirm the checker sees nothing.
    const before = await getConfigStatus(repoRoot);
    expect(before.ready).toBe(false);

    // Simulate the /setup page's Save flow: start from an empty doc,
    // merge in the two required values, serialize, atomically write.
    const doc = parseEnvFile("");
    const merged = mergeEnvValues(doc, {
      OPENAI_API_KEY: "sk-real-looking-test-key-abcdef0123456789",
      SCIENCESWARM_DIR: dataDir,
      // Onboarding is agent-first: a usable LLM plus a writable data dir
      // are not enough to mark the install ready — the user must also
      // pick a backend. The setup page writes this on Save.
      AGENT_BACKEND: "openclaw",
    });
    await writeEnvFileAtomic(
      path.join(repoRoot, ".env"),
      serializeEnvDocument(merged),
    );

    // Now the checker must agree the config is ready.
    const after = await getConfigStatus(repoRoot);
    expect(after.envFileExists).toBe(true);
    expect(after.envFileParseError).toBeNull();
    expect(after.openaiApiKey.state).toBe("ok");
    expect(after.scienceswarmDir.state).toBe("ok");
    expect(after.ready).toBe(true);
  });

  it("still reports ready:false when the saved OPENAI_API_KEY is a placeholder", async () => {
    // Regression guard for the exact trap this task was opened to fix:
    // a user copies `.env.example` verbatim (with the old
    // `sk-your-key-here` placeholder) and hits Save. The checker must
    // refuse to mark this configuration ready.
    const doc = parseEnvFile("");
    const merged = mergeEnvValues(doc, {
      OPENAI_API_KEY: "sk-your-key-here",
      SCIENCESWARM_DIR: dataDir,
    });
    await writeEnvFileAtomic(
      path.join(repoRoot, ".env"),
      serializeEnvDocument(merged),
    );

    const status = await getConfigStatus(repoRoot);
    expect(status.ready).toBe(false);
    expect(status.openaiApiKey.state).toBe("placeholder");
  });

  it("still reports ready:false when SCIENCESWARM_DIR points at a placeholder path", async () => {
    // The original `SCIENCESWARM_DIR=/path/to/scienceswarm-data` trap.
    const doc = parseEnvFile("");
    const merged = mergeEnvValues(doc, {
      OPENAI_API_KEY: "sk-real-looking-test-key-abcdef0123456789",
      SCIENCESWARM_DIR: "/path/to/scienceswarm-data",
    });
    await writeEnvFileAtomic(
      path.join(repoRoot, ".env"),
      serializeEnvDocument(merged),
    );

    const status = await getConfigStatus(repoRoot);
    expect(status.ready).toBe(false);
    expect(status.scienceswarmDir.state).toBe("placeholder");
  });
});
