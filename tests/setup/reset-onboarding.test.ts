/**
 * Tests for `scripts/reset-onboarding.ts` and the matching
 * `POST /api/setup/reset` route.
 *
 * Both wipe onboarding state; both MUST refuse to touch anything
 * outside the resolved `$SCIENCESWARM_DIR` and MUST leave the user's
 * real `~/.openclaw` profile dir untouched.
 */

import { promises as fs, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isUnderScienceSwarmDataRoot,
  resetOnboarding,
} from "../../scripts/reset-onboarding";
import { POST as resetRoutePost } from "@/app/api/setup/reset/route";

interface TestFixture {
  repoRoot: string;
  fakeHome: string;
  dataRoot: string;
  openClawStateDir: string;
  brainDir: string;
  telegramSession: string;
  profileOpenClawDir: string;
  profileOpenClawFile: string;
}

async function makeFixture(): Promise<TestFixture> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "os-reset-repo-"));
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "os-reset-home-"));
  const dataRoot = path.join(fakeHome, ".scienceswarm");
  const openClawStateDir = path.join(dataRoot, "openclaw");
  const brainDir = path.join(dataRoot, "brain");
  const telegramSession = path.join(dataRoot, "telegram", "session");
  const profileOpenClawDir = path.join(fakeHome, ".openclaw");
  const profileOpenClawFile = path.join(profileOpenClawDir, "openclaw.json");

  await fs.mkdir(openClawStateDir, { recursive: true });
  await fs.mkdir(brainDir, { recursive: true });
  await fs.mkdir(path.dirname(telegramSession), { recursive: true });
  await fs.mkdir(profileOpenClawDir, { recursive: true });

  // Seed the ScienceSwarm-owned openclaw dir.
  await fs.writeFile(
    path.join(openClawStateDir, "openclaw.json"),
    JSON.stringify({ managed: "scienceswarm" }),
    "utf8",
  );
  // Seed the user's profile dir — this MUST NOT be touched.
  await fs.writeFile(
    profileOpenClawFile,
    JSON.stringify({ managed: "user-profile" }),
    "utf8",
  );
  // Seed brain + telegram so the reset has something to rm.
  await fs.writeFile(path.join(brainDir, "marker"), "brain", "utf8");
  await fs.writeFile(telegramSession, "session-bytes", "utf8");

  return {
    repoRoot,
    fakeHome,
    dataRoot,
    openClawStateDir,
    brainDir,
    telegramSession,
    profileOpenClawDir,
    profileOpenClawFile,
  };
}

async function writeEnv(repoRoot: string, body: string): Promise<string> {
  const envPath = path.join(repoRoot, ".env");
  await fs.writeFile(envPath, body, "utf8");
  return envPath;
}

async function cleanupFixture(fixture: TestFixture): Promise<void> {
  await fs.rm(fixture.repoRoot, { recursive: true, force: true });
  await fs.rm(fixture.fakeHome, { recursive: true, force: true });
}

describe("isUnderScienceSwarmDataRoot", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "os-guard-"));
    process.env.SCIENCESWARM_DIR = tmpRoot;
  });

  afterEach(async () => {
    delete process.env.SCIENCESWARM_DIR;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("accepts the root itself", () => {
    expect(isUnderScienceSwarmDataRoot(tmpRoot)).toBe(true);
  });

  it("accepts a child directory", () => {
    expect(
      isUnderScienceSwarmDataRoot(path.join(tmpRoot, "openclaw")),
    ).toBe(true);
  });

  it("accepts a deeply nested child", () => {
    expect(
      isUnderScienceSwarmDataRoot(path.join(tmpRoot, "a", "b", "c")),
    ).toBe(true);
  });

  it("rejects a sibling directory that shares a prefix", () => {
    // /tmp/os-guard-XXXXX vs /tmp/os-guard-XXXXX-evil — the trailing
    // separator check in the guard stops prefix-match attacks.
    const sibling = `${tmpRoot}-evil`;
    expect(isUnderScienceSwarmDataRoot(sibling)).toBe(false);
  });

  it("rejects a traversal that escapes the root", () => {
    const escaped = path.join(tmpRoot, "..", "..", "etc", "passwd");
    expect(isUnderScienceSwarmDataRoot(escaped)).toBe(false);
  });

  it("rejects an absolute unrelated path", () => {
    expect(isUnderScienceSwarmDataRoot("/etc/passwd")).toBe(false);
  });

  it("honors an explicit dataRoot override", () => {
    const other = mkdtempSync(path.join(os.tmpdir(), "os-guard-other-"));
    try {
      // Target is under `other`, not under tmpRoot.
      expect(
        isUnderScienceSwarmDataRoot(path.join(other, "openclaw"), other),
      ).toBe(true);
      expect(
        isUnderScienceSwarmDataRoot(path.join(other, "openclaw"), tmpRoot),
      ).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("resetOnboarding", () => {
  let fixture: TestFixture;
  let logSpy: (msg: string) => void;
  let warnSpy: (msg: string) => void;

  beforeEach(async () => {
    fixture = await makeFixture();
    // Point SCIENCESWARM_DIR at our fake home so the resolver returns
    // deterministic paths. HOME is preserved by tests/setup.ts — we
    // never rely on the real `~/.openclaw`.
    process.env.SCIENCESWARM_DIR = fixture.dataRoot;
    logSpy = vi.fn<(msg: string) => void>();
    warnSpy = vi.fn<(msg: string) => void>();
  });

  afterEach(async () => {
    delete process.env.SCIENCESWARM_DIR;
    delete process.env.BRAIN_ROOT;
    delete process.env.SCIENCESWARM_ALLOW_RESET;
    await cleanupFixture(fixture);
    vi.restoreAllMocks();
  });

  it("default mode wipes $SCIENCESWARM_DIR/openclaw", async () => {
    const result = await resetOnboarding({
      repoRoot: fixture.repoRoot,
      log: logSpy,
      warn: warnSpy,
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toContain(fixture.openClawStateDir);

    // The ScienceSwarm-owned openclaw dir is gone.
    await expect(fs.stat(fixture.openClawStateDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("default mode does NOT touch the user's ~/.openclaw profile dir", async () => {
    const beforeStat = statSync(fixture.profileOpenClawFile);
    const beforeContents = await fs.readFile(
      fixture.profileOpenClawFile,
      "utf8",
    );

    const result = await resetOnboarding({
      repoRoot: fixture.repoRoot,
      log: logSpy,
      warn: warnSpy,
    });

    expect(result.ok).toBe(true);

    const afterStat = statSync(fixture.profileOpenClawFile);
    const afterContents = await fs.readFile(
      fixture.profileOpenClawFile,
      "utf8",
    );

    // Same contents, same mtime — proof the reset never reached in.
    expect(afterContents).toBe(beforeContents);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.ino).toBe(beforeStat.ino);
  });

  it("also wipes the brain dir and telegram session", async () => {
    const result = await resetOnboarding({
      repoRoot: fixture.repoRoot,
      log: logSpy,
      warn: warnSpy,
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual(
      expect.arrayContaining([
        fixture.brainDir,
        fixture.openClawStateDir,
        fixture.telegramSession,
      ]),
    );
    await expect(fs.stat(fixture.brainDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(fixture.telegramSession)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("--keep-openclaw preserves the state dir", async () => {
    const stateFile = path.join(fixture.openClawStateDir, "openclaw.json");
    const beforeContents = await fs.readFile(stateFile, "utf8");

    const result = await resetOnboarding({
      repoRoot: fixture.repoRoot,
      keepOpenClaw: true,
      log: logSpy,
      warn: warnSpy,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toContain(fixture.openClawStateDir);
    expect(result.removed).not.toContain(fixture.openClawStateDir);

    // File still there, untouched.
    const afterContents = await fs.readFile(stateFile, "utf8");
    expect(afterContents).toBe(beforeContents);
  });

  it("--keep-brain preserves the brain dir", async () => {
    const marker = path.join(fixture.brainDir, "marker");
    const before = await fs.readFile(marker, "utf8");

    const result = await resetOnboarding({
      repoRoot: fixture.repoRoot,
      keepBrain: true,
      log: logSpy,
      warn: warnSpy,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toContain(fixture.brainDir);
    expect(await fs.readFile(marker, "utf8")).toBe(before);
  });

  it("hydrates SCIENCESWARM_DIR from .env before snapshotting paths", async () => {
    // Move the env var out of process.env and into .env — this is
    // the exact sequence where PR #294's fix matters. If the script
    // clears the .env before resolving, BRAIN_ROOT and the openclaw
    // dir would fall back to defaults under the real ~/.scienceswarm.
    delete process.env.SCIENCESWARM_DIR;
    await writeEnv(
      fixture.repoRoot,
      [
        `SCIENCESWARM_DIR=${fixture.dataRoot}`,
        "SCIENCESWARM_USER_HANDLE=someone",
        "GIT_USER_EMAIL=someone@example.com",
        `BRAIN_ROOT=${fixture.brainDir}`,
        `BRAIN_PGLITE_PATH=${path.join(fixture.brainDir, "brain.pglite")}`,
        "AGENT_BACKEND=openclaw",
        "LLM_PROVIDER=openai",
        "OLLAMA_MODEL=gemma4:e4b",
        "OLLAMA_API_KEY=ollama-local",
        "OPENCLAW_PROFILE=project-alpha",
        "OPENCLAW_URL=ws://127.0.0.1:18799/ws",
        "TELEGRAM_BOT_TOKEN=123:bot-token",
        "TELEGRAM_BOT_USERNAME=old_bot",
        "TELEGRAM_BOT_CREATURE=oldcreature",
        "TELEGRAM_USER_ID=8647564254",
        "TELEGRAM_PHONE=+15555550123",
        "",
      ].join("\n"),
    );

    const result = await resetOnboarding({
      repoRoot: fixture.repoRoot,
      log: logSpy,
      warn: warnSpy,
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toContain(fixture.openClawStateDir);

    // .env onboarding keys are dropped, but SCIENCESWARM_DIR
    // survives (env-writer only clears the keys we name explicitly).
    const rewritten = await fs.readFile(
      path.join(fixture.repoRoot, ".env"),
      "utf8",
    );
    expect(rewritten).toContain(`SCIENCESWARM_DIR=${fixture.dataRoot}`);
    expect(rewritten).not.toMatch(/^SCIENCESWARM_USER_HANDLE=/m);
    expect(rewritten).not.toMatch(/^GIT_USER_EMAIL=/m);
    expect(rewritten).not.toMatch(/^BRAIN_ROOT=/m);
    expect(rewritten).not.toMatch(/^BRAIN_PGLITE_PATH=/m);
    expect(rewritten).not.toMatch(/^AGENT_BACKEND=/m);
    expect(rewritten).not.toMatch(/^LLM_PROVIDER=/m);
    expect(rewritten).not.toMatch(/^OLLAMA_MODEL=/m);
    expect(rewritten).not.toMatch(/^OLLAMA_API_KEY=/m);
    expect(rewritten).not.toMatch(/^OPENCLAW_PROFILE=/m);
    expect(rewritten).not.toMatch(/^OPENCLAW_URL=/m);
    expect(rewritten).not.toMatch(/^TELEGRAM_BOT_TOKEN=/m);
    expect(rewritten).not.toMatch(/^TELEGRAM_BOT_USERNAME=/m);
    expect(rewritten).not.toMatch(/^TELEGRAM_BOT_CREATURE=/m);
    expect(rewritten).not.toMatch(/^TELEGRAM_USER_ID=/m);
  });

  it("--keep-telegram-bot preserves bot metadata while wiping OpenClaw state", async () => {
    await writeEnv(
      fixture.repoRoot,
      [
        `SCIENCESWARM_DIR=${fixture.dataRoot}`,
        "SCIENCESWARM_USER_HANDLE=someone",
        "AGENT_BACKEND=openclaw",
        "TELEGRAM_BOT_TOKEN=123:bot-token",
        "TELEGRAM_BOT_USERNAME=old_bot",
        "TELEGRAM_BOT_CREATURE=oldcreature",
        "TELEGRAM_USER_ID=8647564254",
        "",
      ].join("\n"),
    );

    const result = await resetOnboarding({
      repoRoot: fixture.repoRoot,
      keepTelegramBot: true,
      log: logSpy,
      warn: warnSpy,
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toContain(fixture.openClawStateDir);
    await expect(fs.stat(fixture.openClawStateDir)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const rewritten = await fs.readFile(
      path.join(fixture.repoRoot, ".env"),
      "utf8",
    );
    expect(rewritten).toContain("TELEGRAM_BOT_TOKEN=123:bot-token");
    expect(rewritten).toContain("TELEGRAM_BOT_USERNAME=old_bot");
    expect(rewritten).toContain("TELEGRAM_BOT_CREATURE=oldcreature");
    expect(rewritten).toContain("TELEGRAM_USER_ID=8647564254");
    expect(rewritten).not.toMatch(/^TELEGRAM_PHONE=/m);
    expect(rewritten).not.toMatch(/^SCIENCESWARM_USER_HANDLE=/m);
    expect(rewritten).not.toMatch(/^AGENT_BACKEND=/m);
  });

  it("POST /api/setup/reset honors keepTelegramBot", async () => {
    await writeEnv(
      fixture.repoRoot,
      [
        `SCIENCESWARM_DIR=${fixture.dataRoot}`,
        "SCIENCESWARM_USER_HANDLE=someone",
        "AGENT_BACKEND=openclaw",
        "TELEGRAM_BOT_TOKEN=123:bot-token",
        "TELEGRAM_BOT_USERNAME=old_bot",
        "TELEGRAM_BOT_CREATURE=oldcreature",
        "TELEGRAM_USER_ID=8647564254",
        "TELEGRAM_PHONE=+15555550123",
        "",
      ].join("\n"),
    );
    process.env.SCIENCESWARM_ALLOW_RESET = "1";

    const previousCwd = process.cwd();
    process.chdir(fixture.repoRoot);
    try {
      const response = await resetRoutePost(
        new Request("http://localhost/api/setup/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keepTelegramBot: true }),
        }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      process.chdir(previousCwd);
    }

    const rewritten = await fs.readFile(
      path.join(fixture.repoRoot, ".env"),
      "utf8",
    );
    expect(rewritten).toContain("TELEGRAM_BOT_TOKEN=123:bot-token");
    expect(rewritten).toContain("TELEGRAM_BOT_USERNAME=old_bot");
    expect(rewritten).toContain("TELEGRAM_BOT_CREATURE=oldcreature");
    expect(rewritten).toContain("TELEGRAM_USER_ID=8647564254");
    expect(rewritten).not.toMatch(/^TELEGRAM_PHONE=/m);
    expect(rewritten).not.toMatch(/^SCIENCESWARM_USER_HANDLE=/m);
    await expect(fs.stat(fixture.openClawStateDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to delete when a resolved target escapes the data root", async () => {
    // Simulate a path-traversal bug: inject resolvers that hand back
    // an openclaw state dir OUTSIDE the resolved data root. The
    // guard MUST catch this and return a non-ok result; nothing
    // outside the root should be removed.
    const outside = path.join(fixture.fakeHome, "not-scienceswarm-at-all");
    await fs.mkdir(outside, { recursive: true });
    const sentinel = path.join(outside, "keep-me");
    await fs.writeFile(sentinel, "do-not-touch", "utf8");

    const result = await resetOnboarding({
      repoRoot: fixture.repoRoot,
      log: logSpy,
      warn: warnSpy,
      resolvers: {
        getDataRoot: () => fixture.dataRoot,
        getBrainDir: () => fixture.brainDir,
        // Point the openclaw resolver outside the data root.
        getOpenClawStateDir: () => outside,
        getTelegramSessionPath: () => fixture.telegramSession,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refused to delete/);
    expect(result.error).toContain(outside);

    // The spy target is untouched.
    expect(await fs.readFile(sentinel, "utf8")).toBe("do-not-touch");
    // And because we bailed early, the legitimate openclaw dir
    // under the data root is also still there.
    await expect(
      fs.stat(path.join(fixture.openClawStateDir, "openclaw.json")),
    ).resolves.toBeTruthy();
  });

  it("refuses deterministic-tmpdir traversal inputs", async () => {
    // Deterministic tmpdir-rooted traversal: `$tmp/a/../../elsewhere`
    // path.resolve()s to somewhere OUTSIDE $tmp — exactly the
    // condition we want the guard to flag.
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "os-traverse-"));
    try {
      const traversed = path.join(sandbox, "a", "..", "..", "elsewhere");
      expect(path.resolve(traversed).startsWith(path.resolve(sandbox))).toBe(
        false,
      );

      const result = await resetOnboarding({
        repoRoot: fixture.repoRoot,
        log: logSpy,
        warn: warnSpy,
        resolvers: {
          getDataRoot: () => sandbox,
          getBrainDir: () => path.join(sandbox, "brain"),
          getOpenClawStateDir: () => traversed,
          getTelegramSessionPath: () =>
            path.join(sandbox, "telegram", "session"),
        },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/refused to delete/);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });
});
