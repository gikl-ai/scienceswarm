/**
 * Tests for the gbrain installer (`src/lib/setup/gbrain-installer.ts`).
 *
 * Phase A Lane 1 of the ScienceSwarm -> gbrain pivot.
 *
 * Coverage targets, copied from the lane brief:
 *
 *   1. Happy path: mocked filesystem, fake bun present, fake gbrain
 *      init callable -> all 7 steps succeed, progress events emitted,
 *      `.env` updated with BRAIN_ROOT.
 *   2. Each of the 5 spec-mandated error taxonomy cases: correct
 *      detection, correct error code/message, no side effects on
 *      failure (env file untouched, gbrain init never called).
 *   3. Idempotency: running the installer twice on a machine that
 *      already has `~/.scienceswarm/brain/` does NOT destroy data.
 *
 * What we deliberately do NOT test here:
 *   * Real PGLite init. That belongs in the gbrain contract test
 *     lane (the brief says "do NOT add integration tests that
 *     actually invoke gbrain"). The fake `initGbrain` records its
 *     calls so we can assert side effects without spinning up WASM.
 *   * The Next.js API route's SSE wire format. That's covered
 *     separately by the route's own contract tests if/when we add
 *     them; here we focus on the library that the route wraps.
 *   * The `SCIENCESWARM_USER_HANDLE` resolver is unit-tested below
 *     with the rest of the library (it's exported alongside).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as brainPresets from "@/brain/presets";

import {
  getCurrentUserHandle,
  runInstallerToCompletion,
  type InstallerEnvironment,
  type InstallerEvent,
} from "@/lib/setup/gbrain-installer";

// -----------------------------------------------------------------
// Fake environment
// -----------------------------------------------------------------

interface FakeEnvOpts {
  /** Map of bin name -> resolved path. Missing keys mean `which` returns null. */
  bins?: Record<string, string>;
  /** URLs that respond 2xx. Anything else is "blocked". */
  reachable?: Set<string>;
  /** Pre-existing files (path -> contents). */
  files?: Record<string, string>;
  /** Pre-existing directories. */
  dirs?: Set<string>;
  /** Paths that explode on writeFile (read-only mounts). */
  readOnlyPaths?: Set<string>;
  /** Paths that explode on mkdir. */
  unmkdirableDirs?: Set<string>;
  /** Whether `gitInit` should throw. */
  gitInitFails?: boolean;
  /** Whether `initGbrain` should throw (with this message). */
  gbrainInitFailureMessage?: string | null;
  /** Override homedir(). */
  homeDir?: string;
}

interface FakeEnvCalls {
  whichCalls: string[];
  reachCalls: string[];
  mkdirCalls: string[];
  writeFileCalls: { path: string; contents: string }[];
  unlinkCalls: string[];
  envWrites: { path: string; contents: string }[];
  gitInitCalls: string[];
  initGbrainCalls: { databasePath: string }[];
}

interface FakeEnvHandle {
  env: InstallerEnvironment;
  calls: FakeEnvCalls;
  /** Read whatever the installer wrote into the fake .env file. */
  envFileContents(repoRoot: string): string | null;
  /** Inspect the fake filesystem. */
  fileAt(filePath: string): string | null;
  hasDir(filePath: string): boolean;
}

function makeFakeEnv(opts: FakeEnvOpts = {}): FakeEnvHandle {
  const bins: Record<string, string> = opts.bins ?? {
    bun: "/usr/local/bin/bun",
    git: "/usr/bin/git",
    node: "/usr/bin/node",
  };
  const reachable = opts.reachable ?? new Set(["https://bun.sh/install"]);
  const files: Map<string, string> = new Map(
    Object.entries(opts.files ?? {}),
  );
  const dirs: Set<string> = new Set(opts.dirs ?? []);
  const readOnly: Set<string> = opts.readOnlyPaths ?? new Set();
  const unmkdirable: Set<string> = opts.unmkdirableDirs ?? new Set();
  const homeDirValue = opts.homeDir ?? "/home/test";

  const calls: FakeEnvCalls = {
    whichCalls: [],
    reachCalls: [],
    mkdirCalls: [],
    writeFileCalls: [],
    unlinkCalls: [],
    envWrites: [],
    gitInitCalls: [],
    initGbrainCalls: [],
  };

  const env: InstallerEnvironment = {
    homeDir() {
      return homeDirValue;
    },
    async which(bin: string) {
      calls.whichCalls.push(bin);
      return bins[bin] ?? null;
    },
    async canReach(url: string) {
      calls.reachCalls.push(url);
      return reachable.has(url);
    },
    async stat(filePath: string) {
      if (dirs.has(filePath)) return { isDirectory: true };
      if (files.has(filePath)) return { isDirectory: false };
      return null;
    },
    async mkdir(filePath: string) {
      calls.mkdirCalls.push(filePath);
      if (unmkdirable.has(filePath)) {
        throw new Error(`EACCES: cannot mkdir ${filePath}`);
      }
      // Also mkdir all parents — the real mkdir is recursive.
      let cursor = filePath;
      while (cursor && cursor !== path.dirname(cursor)) {
        dirs.add(cursor);
        cursor = path.dirname(cursor);
      }
    },
    async writeFile(filePath: string, contents: string) {
      calls.writeFileCalls.push({ path: filePath, contents });
      const parent = path.dirname(filePath);
      if (readOnly.has(filePath) || readOnly.has(parent)) {
        throw new Error(`EROFS: read-only filesystem, ${filePath}`);
      }
      // Auto-create parent dir (matches real fs behaviour when
      // parent already exists, which is the only state we hit in
      // these tests).
      files.set(filePath, contents);
    },
    async unlink(filePath: string) {
      calls.unlinkCalls.push(filePath);
      files.delete(filePath);
    },
    async readFile(filePath: string) {
      return files.has(filePath) ? (files.get(filePath) ?? null) : null;
    },
    async writeEnvFileAtomic(filePath: string, contents: string) {
      calls.envWrites.push({ path: filePath, contents });
      const parent = path.dirname(filePath);
      if (readOnly.has(filePath) || readOnly.has(parent)) {
        throw new Error(`EROFS: read-only filesystem, ${filePath}`);
      }
      files.set(filePath, contents);
    },
    async gitInit(dir: string) {
      calls.gitInitCalls.push(dir);
      if (opts.gitInitFails) {
        throw new Error("git init failed (simulated)");
      }
      dirs.add(path.join(dir, ".git"));
    },
    async initGbrain({ databasePath }: { databasePath: string }) {
      calls.initGbrainCalls.push({ databasePath });
      if (opts.gbrainInitFailureMessage) {
        throw new Error(opts.gbrainInitFailureMessage);
      }
      // Simulate gbrain creating its PGLite directory.
      dirs.add(databasePath);
      files.set(path.join(databasePath, "PG_VERSION"), "15");
    },
  };

  return {
    env,
    calls,
    envFileContents(repoRoot: string) {
      return files.get(path.join(repoRoot, ".env")) ?? null;
    },
    fileAt(filePath: string) {
      return files.get(filePath) ?? null;
    },
    hasDir(filePath: string) {
      return dirs.has(filePath);
    },
  };
}

// -----------------------------------------------------------------
// Helpers for assertions on event streams
// -----------------------------------------------------------------

const HAPPY_PATH_STEPS = [
  "verify-prerequisites",
  "ensure-home-writable",
  "ensure-target-dir",
  "git-init",
  "gbrain-init",
  "seed-resolver",
  "write-env",
] as const;

function eventsByStep(
  events: InstallerEvent[],
  step: string,
): InstallerEvent[] {
  return events.filter((e) => e.type === "step" && e.step === step);
}

function lastEvent(events: InstallerEvent[]): InstallerEvent {
  const last = events[events.length - 1];
  if (!last) {
    throw new Error("no events emitted");
  }
  return last;
}

// -----------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------

describe("install-gbrain happy path", () => {
  it("runs every step end-to-end on a fresh machine", async () => {
    const handle = makeFakeEnv();
    const repoRoot = "/repo";
    const { events, ok } = await runInstallerToCompletion(
      { repoRoot },
      handle.env,
    );

    expect(ok).toBe(true);

    // Every spec-mandated step started AND succeeded (no skips on
    // the fresh-machine path).
    for (const step of HAPPY_PATH_STEPS) {
      const stepEvents = eventsByStep(events, step);
      expect(stepEvents.length, `step ${step} should have at least 2 events`).toBeGreaterThanOrEqual(2);
      const statuses = stepEvents.map((e) =>
        e.type === "step" ? e.status : null,
      );
      expect(statuses).toContain("started");
      expect(statuses).toContain("succeeded");
      expect(statuses).not.toContain("failed");
    }

    // Final summary is success and reports the resolved brainRoot.
    const summary = lastEvent(events);
    expect(summary.type).toBe("summary");
    if (summary.type === "summary") {
      expect(summary.status).toBe("ok");
      expect(summary.brainRoot).toBe(
        path.join("/home/test", ".scienceswarm", "brain"),
      );
    }

    // Side effects: gbrain init was called exactly once, the brain
    // dir was git-initialized, RESOLVER.md was seeded, .env was
    // written with BRAIN_ROOT.
    expect(handle.calls.initGbrainCalls).toHaveLength(1);
    expect(handle.calls.initGbrainCalls[0]?.databasePath).toBe(
      path.join("/home/test", ".scienceswarm", "brain", "brain.pglite"),
    );
    expect(handle.calls.gitInitCalls).toEqual([
      path.join("/home/test", ".scienceswarm", "brain"),
    ]);
    const resolverSeed = handle.fileAt(
      path.join("/home/test", ".scienceswarm", "brain", "RESOLVER.md"),
    );
    expect(resolverSeed).toContain("ScienceSwarm scientific-research brain");
    expect(resolverSeed).toContain(
      "OpenClaw communicates; OpenHands executes; gbrain stores.",
    );
    expect(resolverSeed).toContain("gather candidate papers in bulk");
    expect(resolverSeed).toContain("write durable journal artifacts");
    expect(resolverSeed).toContain(
      "Do not run upstream gbrain autopilot daemon",
    );

    const envContents = handle.envFileContents(repoRoot);
    expect(envContents).not.toBeNull();
    expect(envContents).toContain(
      `BRAIN_ROOT=${path.join("/home/test", ".scienceswarm", "brain")}`,
    );
    expect(envContents).toContain("BRAIN_PRESET=scientific_research");
    expect(handle.calls.envWrites).toHaveLength(1);
  });

  it("checks bun.sh reachability exactly once", async () => {
    const handle = makeFakeEnv();
    await runInstallerToCompletion({ repoRoot: "/repo" }, handle.env);
    expect(handle.calls.reachCalls).toEqual(["https://bun.sh/install"]);
  });

  it("respects skipNetworkCheck", async () => {
    const handle = makeFakeEnv();
    await runInstallerToCompletion(
      { repoRoot: "/repo", skipNetworkCheck: true },
      handle.env,
    );
    expect(handle.calls.reachCalls).toEqual([]);
  });

  it("respects an explicit brainRoot override", async () => {
    const handle = makeFakeEnv();
    const customRoot = "/mnt/data/my-brain";
    const { events, ok } = await runInstallerToCompletion(
      { repoRoot: "/repo", brainRoot: customRoot },
      handle.env,
    );
    expect(ok).toBe(true);
    expect(handle.calls.gitInitCalls).toEqual([customRoot]);
    expect(handle.calls.initGbrainCalls[0]?.databasePath).toBe(
      path.join(customRoot, "brain.pglite"),
    );
    const summary = lastEvent(events);
    if (summary.type === "summary") {
      expect(summary.brainRoot).toBe(customRoot);
    }
  });

  it("supports the generic scientist preset override", async () => {
    const handle = makeFakeEnv();
    const { ok } = await runInstallerToCompletion(
      {
        repoRoot: "/repo",
        brainPreset: "generic_scientist",
      },
      handle.env,
    );

    expect(ok).toBe(true);
    const resolverSeed = handle.fileAt(
      path.join("/home/test", ".scienceswarm", "brain", "RESOLVER.md"),
    );
    expect(resolverSeed).toContain("ScienceSwarm scientist-defaults brain");
    expect(handle.envFileContents("/repo")).toContain(
      "BRAIN_PRESET=generic_scientist",
    );
  });

  it("cleans up the writability sentinel files after probing", async () => {
    const handle = makeFakeEnv();
    const customRoot = "/mnt/data/my-brain";
    await runInstallerToCompletion(
      { repoRoot: "/repo", brainRoot: customRoot },
      handle.env,
    );
    // Both sentinel writes should have happened during the probe.
    const writtenPaths = handle.calls.writeFileCalls.map((c) => c.path);
    expect(writtenPaths).toContain("/home/test/.scienceswarm/.writable");
    expect(writtenPaths).toContain(path.join(customRoot, ".writable"));
    // And both should have been unlinked afterward — no probe stubs
    // left behind.
    expect(handle.calls.unlinkCalls).toContain(
      "/home/test/.scienceswarm/.writable",
    );
    expect(handle.calls.unlinkCalls).toContain(
      path.join(customRoot, ".writable"),
    );
    // The fake filesystem confirms removal.
    expect(handle.fileAt("/home/test/.scienceswarm/.writable")).toBeNull();
    expect(handle.fileAt(path.join(customRoot, ".writable"))).toBeNull();
  });
});

// -----------------------------------------------------------------
// Error taxonomy (5 spec-mandated cases + one bonus for git)
// -----------------------------------------------------------------

describe("install-gbrain error taxonomy", () => {
  it("Case 1: bun missing -> bun-missing error, no side effects", async () => {
    const handle = makeFakeEnv({
      bins: {
        // bun absent, others present
        git: "/usr/bin/git",
        node: "/usr/bin/node",
      },
    });
    const { events, ok } = await runInstallerToCompletion(
      { repoRoot: "/repo" },
      handle.env,
    );
    expect(ok).toBe(false);
    const summary = lastEvent(events);
    expect(summary.type).toBe("summary");
    if (summary.type === "summary") {
      expect(summary.status).toBe("failed");
      expect(summary.error?.code).toBe("bun-missing");
      expect(summary.error?.message).toMatch(/bun is required/);
      expect(summary.error?.recovery).toMatch(/bun.sh/);
      // Phase D: bun installer needs `unzip`; minimal Linux images
      // (Debian slim, Ubuntu cloud base) don't ship it by default, so
      // the recovery hint must call it out explicitly.
      expect(summary.error?.recovery).toMatch(/unzip/);
      expect(summary.error?.recovery).toMatch(/apt-get install/);
    }
    // Critically: no files written, no gbrain init, no git init.
    expect(handle.calls.envWrites).toHaveLength(0);
    expect(handle.calls.initGbrainCalls).toHaveLength(0);
    expect(handle.calls.gitInitCalls).toHaveLength(0);
  });

  it("Case 2: git missing -> git-missing error, no side effects", async () => {
    const handle = makeFakeEnv({
      bins: {
        bun: "/usr/local/bin/bun",
        node: "/usr/bin/node",
      },
    });
    const { events, ok } = await runInstallerToCompletion(
      { repoRoot: "/repo" },
      handle.env,
    );
    expect(ok).toBe(false);
    const summary = lastEvent(events);
    if (summary.type === "summary") {
      expect(summary.status).toBe("failed");
      expect(summary.error?.code).toBe("git-missing");
      expect(summary.error?.message).toMatch(/git is required/);
      expect(summary.error?.recovery).toMatch(/brew install git|package manager/);
    }
    expect(handle.calls.envWrites).toHaveLength(0);
    expect(handle.calls.initGbrainCalls).toHaveLength(0);
  });

  it("Case 3: HTTPS blocked -> https-blocked error with proxy hint", async () => {
    const handle = makeFakeEnv({
      reachable: new Set(),
    });
    const { events, ok } = await runInstallerToCompletion(
      { repoRoot: "/repo" },
      handle.env,
    );
    expect(ok).toBe(false);
    const summary = lastEvent(events);
    if (summary.type === "summary") {
      expect(summary.status).toBe("failed");
      expect(summary.error?.code).toBe("https-blocked");
      expect(summary.error?.message).toMatch(/Cannot reach https:\/\/bun\.sh/);
      expect(summary.error?.recovery).toMatch(/HTTPS_PROXY/);
    }
    expect(handle.calls.envWrites).toHaveLength(0);
    expect(handle.calls.initGbrainCalls).toHaveLength(0);
  });

  it("Case 4: $HOME not writable -> home-not-writable error with SCIENCESWARM_HOME hint", async () => {
    const handle = makeFakeEnv({
      readOnlyPaths: new Set(["/home/test/.scienceswarm"]),
    });
    const { events, ok } = await runInstallerToCompletion(
      { repoRoot: "/repo" },
      handle.env,
    );
    expect(ok).toBe(false);
    const summary = lastEvent(events);
    if (summary.type === "summary") {
      expect(summary.status).toBe("failed");
      expect(summary.error?.code).toBe("home-not-writable");
      expect(summary.error?.message).toMatch(/Cannot write to .*\.scienceswarm/);
      expect(summary.error?.recovery).toMatch(/SCIENCESWARM_HOME/);
    }
    expect(handle.calls.envWrites).toHaveLength(0);
    expect(handle.calls.initGbrainCalls).toHaveLength(0);
  });

  it("Case 5: target directory read-only -> target-not-writable error with BRAIN_ROOT hint", async () => {
    // The brain root itself exists (e.g. on a SIP-locked path) but
    // the writable probe fails. We seed the dir into the fake fs so
    // mkdir is a no-op, then mark its sentinel write as read-only.
    const brainRoot = "/home/test/.scienceswarm/brain";
    const handle = makeFakeEnv({
      dirs: new Set(["/home/test", "/home/test/.scienceswarm", brainRoot]),
      readOnlyPaths: new Set([brainRoot]),
    });
    const { events, ok } = await runInstallerToCompletion(
      { repoRoot: "/repo" },
      handle.env,
    );
    expect(ok).toBe(false);
    const summary = lastEvent(events);
    if (summary.type === "summary") {
      expect(summary.status).toBe("failed");
      expect(summary.error?.code).toBe("target-not-writable");
      expect(summary.error?.recovery).toMatch(/BRAIN_ROOT/);
    }
    expect(handle.calls.envWrites).toHaveLength(0);
    expect(handle.calls.initGbrainCalls).toHaveLength(0);
  });

  it("gbrain init failure surfaces as gbrain-init-failed without writing .env", async () => {
    const handle = makeFakeEnv({
      gbrainInitFailureMessage: "PGLite WASM failed to load",
    });
    const { events, ok } = await runInstallerToCompletion(
      { repoRoot: "/repo" },
      handle.env,
    );
    expect(ok).toBe(false);
    const summary = lastEvent(events);
    if (summary.type === "summary") {
      expect(summary.status).toBe("failed");
      expect(summary.error?.code).toBe("gbrain-init-failed");
      expect(summary.error?.cause).toContain("PGLite WASM failed to load");
    }
    expect(handle.calls.envWrites).toHaveLength(0);
  });

  it("preset asset read failure surfaces as an internal installer error", async () => {
    const handle = makeFakeEnv();
    const presetSpy = vi
      .spyOn(brainPresets, "loadBrainPreset")
      .mockImplementation(() => {
        throw new Error("missing preset asset");
      });

    try {
      const { events, ok } = await runInstallerToCompletion(
        { repoRoot: "/repo" },
        handle.env,
      );

      expect(ok).toBe(false);
      const summary = lastEvent(events);
      if (summary.type === "summary") {
        expect(summary.status).toBe("failed");
        expect(summary.error?.code).toBe("internal");
        expect(summary.error?.cause).toContain("missing preset asset");
      }

      const seedResolverEvents = eventsByStep(events, "seed-resolver");
      expect(seedResolverEvents.at(-1)).toMatchObject({
        type: "step",
        step: "seed-resolver",
        status: "failed",
      });
      expect(handle.calls.envWrites).toHaveLength(0);
    } finally {
      presetSpy.mockRestore();
    }
  });
});

// -----------------------------------------------------------------
// Idempotency
// -----------------------------------------------------------------

describe("install-gbrain idempotency", () => {
  it("second run on a populated brain dir does not destroy data", async () => {
    const brainRoot = "/home/test/.scienceswarm/brain";
    const dbPath = path.join(brainRoot, "brain.pglite");
    const pgVersionPath = path.join(dbPath, "PG_VERSION");
    const resolverPath = path.join(brainRoot, "RESOLVER.md");
    const userResolverContents = "# user-edited resolver — keep me\n";
    const handle = makeFakeEnv({
      dirs: new Set([
        "/home/test",
        "/home/test/.scienceswarm",
        brainRoot,
        path.join(brainRoot, ".git"),
        dbPath,
      ]),
      files: {
        [pgVersionPath]: "15",
        [resolverPath]: userResolverContents,
        "/repo/.env": "EXISTING=value\n",
      },
    });

    const { events, ok } = await runInstallerToCompletion(
      { repoRoot: "/repo" },
      handle.env,
    );
    expect(ok).toBe(true);

    // The skip events are emitted for the three idempotent steps.
    const skippedSteps = events
      .filter((e) => e.type === "step" && e.status === "skipped")
      .map((e) => (e.type === "step" ? e.step : null));
    expect(skippedSteps).toContain("git-init");
    expect(skippedSteps).toContain("gbrain-init");
    expect(skippedSteps).toContain("seed-resolver");

    // Critical: gbrain init was NOT called a second time. Data is safe.
    expect(handle.calls.initGbrainCalls).toHaveLength(0);
    // git init was NOT called a second time.
    expect(handle.calls.gitInitCalls).toHaveLength(0);
    // RESOLVER.md was not overwritten.
    expect(handle.fileAt(resolverPath)).toBe(userResolverContents);

    // The .env file was updated to include BRAIN_ROOT but the existing key was preserved.
    const envContents = handle.envFileContents("/repo");
    expect(envContents).toContain("EXISTING=value");
    expect(envContents).toContain(`BRAIN_ROOT=${brainRoot}`);
  });

  it("does not skip gbrain init for an empty stale brain.pglite directory", async () => {
    const brainRoot = "/home/test/.scienceswarm/brain";
    const dbPath = path.join(brainRoot, "brain.pglite");
    const resolverPath = path.join(brainRoot, "RESOLVER.md");
    const handle = makeFakeEnv({
      dirs: new Set([
        "/home/test",
        "/home/test/.scienceswarm",
        brainRoot,
        path.join(brainRoot, ".git"),
        dbPath,
      ]),
      files: {
        [resolverPath]: "# resolver\n",
      },
    });

    const { events, ok } = await runInstallerToCompletion(
      { repoRoot: "/repo" },
      handle.env,
    );
    expect(ok).toBe(true);
    expect(handle.calls.initGbrainCalls).toEqual([{ databasePath: dbPath }]);

    const gbrainInitEvents = eventsByStep(events, "gbrain-init")
      .filter((event) => event.type === "step")
      .map((event) => (event.type === "step" ? event.status : null));
    expect(gbrainInitEvents).toContain("succeeded");
    expect(gbrainInitEvents).not.toContain("skipped");
  });

  it("running twice from scratch is also safe (writes BRAIN_ROOT once per run)", async () => {
    const handle = makeFakeEnv();
    const first = await runInstallerToCompletion(
      { repoRoot: "/repo" },
      handle.env,
    );
    expect(first.ok).toBe(true);
    const envAfterFirst = handle.envFileContents("/repo");
    expect(envAfterFirst).toContain("BRAIN_ROOT=");

    const second = await runInstallerToCompletion(
      { repoRoot: "/repo" },
      handle.env,
    );
    expect(second.ok).toBe(true);
    // The second run should NOT call initGbrain again (database now exists).
    expect(handle.calls.initGbrainCalls).toHaveLength(1);
    // .env should still have exactly one BRAIN_ROOT line (the merge
    // helper updates in place, never appends a duplicate).
    const envAfterSecond = handle.envFileContents("/repo") ?? "";
    const occurrences = envAfterSecond
      .split("\n")
      .filter((line) => line.startsWith("BRAIN_ROOT=")).length;
    expect(occurrences).toBe(1);
  });
});

// -----------------------------------------------------------------
// User attribution resolver (decision 3A)
// -----------------------------------------------------------------

describe("getCurrentUserHandle", () => {
  it("returns the configured handle when set", () => {
    expect(getCurrentUserHandle({ SCIENCESWARM_USER_HANDLE: "@alice" })).toBe(
      "@alice",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(
      getCurrentUserHandle({ SCIENCESWARM_USER_HANDLE: "  @alice  " }),
    ).toBe("@alice");
  });

  it("throws loudly when unset (never defaults to 'User')", () => {
    expect(() => getCurrentUserHandle({})).toThrowError(
      /SCIENCESWARM_USER_HANDLE is not set/,
    );
  });

  it("throws when set to an empty string", () => {
    expect(() =>
      getCurrentUserHandle({ SCIENCESWARM_USER_HANDLE: "" }),
    ).toThrowError(/SCIENCESWARM_USER_HANDLE is not set/);
  });

  it("throws when set to whitespace only", () => {
    expect(() =>
      getCurrentUserHandle({ SCIENCESWARM_USER_HANDLE: "   " }),
    ).toThrowError(/SCIENCESWARM_USER_HANDLE is not set/);
  });

  it("falls back to the saved .env after setup when process env is stale", async () => {
    const originalCwd = process.cwd();
    const originalHandle = process.env.SCIENCESWARM_USER_HANDLE;
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-handle-"));
    try {
      await mkdir(repoRoot, { recursive: true });
      await writeFile(
        path.join(repoRoot, ".env"),
        "SCIENCESWARM_USER_HANDLE=@saved-handle\n",
      );
      delete process.env.SCIENCESWARM_USER_HANDLE;
      process.chdir(repoRoot);

      expect(getCurrentUserHandle()).toBe("@saved-handle");
    } finally {
      process.chdir(originalCwd);
      if (typeof originalHandle === "string") {
        process.env.SCIENCESWARM_USER_HANDLE = originalHandle;
      } else {
        delete process.env.SCIENCESWARM_USER_HANDLE;
      }
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
