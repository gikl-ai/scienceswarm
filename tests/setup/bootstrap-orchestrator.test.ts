import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// finalizeOpenClawDefaults lazy-imports `runOpenClaw` to configure
// OpenClaw's Ollama provider and default model at the end of a successful
// bootstrap. Those spawns try to contact the real openclaw CLI,
// which times out during unit tests and makes this file take >20s.
// Stub the whole runner module so every wrapper call resolves
// instantly with a success shape.
vi.mock("@/lib/openclaw/runner", () => ({
  runOpenClaw: vi.fn().mockResolvedValue({
    ok: true,
    stdout: "",
    stderr: "",
    code: 0,
  }),
  resolveOpenClawMode: vi.fn().mockReturnValue({
    kind: "state-dir",
    stateDir: "/tmp/fake-openclaw-state",
    configPath: "/tmp/fake-openclaw-state/openclaw.json",
  }),
}));

import {
  runBootstrap,
  persistIdentity,
} from "@/lib/setup/bootstrap-orchestrator";
import { runOpenClaw } from "@/lib/openclaw/runner";
import { TEST_TELEGRAM_BOT_TOKEN } from "../helpers/telegram-fixtures";
import type {
  BootstrapEvent,
  BootstrapStreamEvent,
  BootstrapTaskId,
  InstallTask,
  TaskYield,
} from "@/lib/setup/install-tasks/types";

const runOpenClawMock = vi.mocked(runOpenClaw);

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scienceswarm-bootstrap-"));
  await fs.writeFile(path.join(dir, ".env"), "", { encoding: "utf8" });
  return dir;
}

function fakeTask(id: BootstrapTaskId, events: TaskYield[]): InstallTask {
  return {
    id,
    async *run() {
      for (const e of events) {
        yield e;
      }
    },
  };
}

describe("bootstrap-orchestrator types", () => {
  it("exports the BootstrapEvent discriminated union", () => {
    const event: BootstrapEvent = {
      type: "task",
      task: "gbrain-init",
      status: "succeeded",
    };
    expect(event.type).toBe("task");
  });

  it("allows summary events in the stream union", () => {
    const event: BootstrapStreamEvent = {
      type: "summary",
      status: "ok",
      failed: [],
      skipped: [],
    };
    expect(event.type).toBe("summary");
  });
});

describe("runBootstrap orchestrator", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    runOpenClawMock.mockClear();
    runOpenClawMock.mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
      code: 0,
    });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("writes SCIENCESWARM_USER_HANDLE to .env before any task runs", async () => {
    const tasks: InstallTask[] = [
      fakeTask("gbrain-init", [{ status: "succeeded" }]),
    ];
    for await (const _ of runBootstrap(
      { handle: "alice", email: "s@example.com", repoRoot },
      { tasks },
    )) {
      void _;
    }
    const envContents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(envContents).toContain("SCIENCESWARM_USER_HANDLE=alice");
    expect(envContents).toContain("GIT_USER_EMAIL=s@example.com");
  });

  it("emits a `pending` event for every task up front", async () => {
    const tasks: InstallTask[] = [
      fakeTask("gbrain-init", [{ status: "succeeded" }]),
      fakeTask("openclaw", [{ status: "succeeded" }]),
    ];
    const events: BootstrapStreamEvent[] = [];
    for await (const e of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      events.push(e);
    }
    const pending = events.filter(
      (e) => e.type === "task" && e.status === "pending",
    );
    expect(pending.length).toBe(2);
  });

  it("runs the telegram task when .env already has a bot token and no phone was submitted", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      `TELEGRAM_BOT_TOKEN=${TEST_TELEGRAM_BOT_TOKEN}\n`,
      "utf8",
    );
    const tasks: InstallTask[] = [
      fakeTask("gbrain-init", [{ status: "succeeded" }]),
      fakeTask("telegram-bot", [{ status: "succeeded", detail: "reused" }]),
    ];
    const events: BootstrapStreamEvent[] = [];
    for await (const e of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      events.push(e);
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task",
        task: "telegram-bot",
        status: "pending",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task",
        task: "telegram-bot",
        status: "succeeded",
        detail: "reused",
      }),
    );
  });

  it("emits a summary with status ok when every task succeeds", async () => {
    const tasks: InstallTask[] = [
      fakeTask("gbrain-init", [{ status: "succeeded" }]),
      fakeTask("openclaw", [{ status: "succeeded" }]),
    ];
    const events: BootstrapStreamEvent[] = [];
    for await (const e of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      events.push(e);
    }
    const summary = events.at(-1);
    expect(summary).toMatchObject({
      type: "summary",
      status: "ok",
      failed: [],
      skipped: [],
    });
  });

  it("emits status 'partial' when one task fails and others succeed", async () => {
    const tasks: InstallTask[] = [
      fakeTask("gbrain-init", [{ status: "succeeded" }]),
      fakeTask("openclaw", [{ status: "failed", error: "boom" }]),
    ];
    const events: BootstrapStreamEvent[] = [];
    for await (const e of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      events.push(e);
    }
    const summary = events.at(-1);
    expect(summary).toMatchObject({
      type: "summary",
      status: "partial",
      failed: ["openclaw"],
    });
  });

  it("dedupes failed ids when a task yields failed and then throws", async () => {
    // Greptile P2 regression: if a task yields `{ status: "failed" }`
    // and the generator then throws, both the loop's yield-handling
    // branch and the catch branch used to push to `failed[]`, which
    // could misreport all-failed as 'partial'. The Set-based tracker
    // must collapse that into a single entry.
    const flakyTask: InstallTask = {
      id: "gbrain-init",
      async *run() {
        yield { status: "failed", error: "first" } as const;
        throw new Error("second");
      },
    };
    const tasks: InstallTask[] = [
      flakyTask,
      fakeTask("openclaw", [{ status: "failed", error: "ok" }]),
    ];
    const events: BootstrapStreamEvent[] = [];
    for await (const e of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      events.push(e);
    }
    const summary = events.at(-1);
    // With two unique failures over two tasks, status must be
    // `failed` (not `partial`).
    expect(summary).toMatchObject({
      type: "summary",
      status: "failed",
    });
    // failed array must list each task id at most once.
    if (summary && summary.type === "summary") {
      const uniq = new Set(summary.failed);
      expect(uniq.size).toBe(summary.failed.length);
    }
  });

  it("routes identity write failures to a top-level summary error instead of a fake task failure", async () => {
    // Greptile round 3 P2 regression: persistIdentity failure used to
    // be stamped with `task: "gbrain-init"`, misleading a user into
    // debugging PGLite when the real cause was .env filesystem perms.
    // It now lands on the summary event's top-level `error` field
    // and no synthetic task event is emitted.
    const readOnlyRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-readonly-"),
    );
    const envPath = path.join(readOnlyRoot, ".env");
    await fs.writeFile(envPath, "", "utf8");
    // Make .env unwritable so writeEnvFileAtomic fails.
    await fs.chmod(envPath, 0o400);
    // Also make the dir unwritable so atomic rename (into the dir)
    // can't succeed.
    await fs.chmod(readOnlyRoot, 0o500);
    try {
      const events: BootstrapStreamEvent[] = [];
      for await (const e of runBootstrap(
        { handle: "alice", repoRoot: readOnlyRoot },
        { tasks: [fakeTask("gbrain-init", [{ status: "succeeded" }])] },
      )) {
        events.push(e);
      }
      // No `type: "task"` events for gbrain-init (it never ran).
      const taskEvents = events.filter((e) => e.type === "task");
      expect(taskEvents).toEqual([]);
      // The summary must carry the error message.
      const summary = events.at(-1);
      expect(summary).toMatchObject({ type: "summary", status: "failed" });
      if (summary && summary.type === "summary") {
        expect(summary.error).toContain("Failed to write .env");
        expect(summary.failed).toEqual([]);
      }
    } finally {
      // Restore perms so cleanup works.
      await fs.chmod(readOnlyRoot, 0o700).catch(() => {});
      await fs.chmod(envPath, 0o600).catch(() => {});
      await fs.rm(readOnlyRoot, { recursive: true, force: true });
    }
  });

  it("stamps `type: 'task'` and the task id on every child yield", async () => {
    const tasks: InstallTask[] = [
      fakeTask("gbrain-init", [
        { status: "running", detail: "hello" },
        { status: "succeeded", detail: "done" },
      ]),
    ];
    const events: BootstrapStreamEvent[] = [];
    for await (const e of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      events.push(e);
    }
    const taskEvents = events.filter((e) => e.type === "task") as BootstrapEvent[];
    for (const e of taskEvents) {
      expect(e.type).toBe("task");
      expect(e.task).toBe("gbrain-init");
    }
    // Running + succeeded must both be present in addition to the pending stamp.
    expect(taskEvents.some((e) => e.status === "running" && e.detail === "hello")).toBe(true);
    expect(taskEvents.some((e) => e.status === "succeeded" && e.detail === "done")).toBe(true);
  });

  it("runs telegram-bot only after OpenClaw setup settles", async () => {
    let finishOpenClaw: (() => void) | undefined;
    const order: string[] = [];

    const openclaw: InstallTask = {
      id: "openclaw",
      async *run() {
        order.push("openclaw:start");
        yield { status: "running", detail: "openclaw running" } as const;
        await new Promise<void>((resolve) => {
          finishOpenClaw = resolve;
        });
        order.push("openclaw:end");
        yield { status: "succeeded", detail: "openclaw done" } as const;
      },
    };
    const telegram: InstallTask = {
      id: "telegram-bot",
      async *run() {
        order.push("telegram:start");
        yield { status: "succeeded", detail: "telegram done" } as const;
      },
    };

    const events: BootstrapStreamEvent[] = [];
    const run = (async () => {
      for await (const e of runBootstrap(
        {
          handle: "h",
          repoRoot,
          existingBot: {
            token: TEST_TELEGRAM_BOT_TOKEN,
          },
        },
        { tasks: [openclaw, telegram] },
      )) {
        events.push(e);
      }
    })();

    await vi.waitFor(() => {
      expect(order).toContain("openclaw:start");
    });
    expect(order).not.toContain("telegram:start");

    finishOpenClaw?.();
    await run;

    expect(order).toEqual(["openclaw:start", "openclaw:end", "telegram:start"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task",
        task: "telegram-bot",
        status: "pending",
      }),
    );
  });
});

describe("runBootstrap finalize ready flags", () => {
  // Regression guard for the "/dashboard bounces back to /setup" bug
  // caught during setup-flow dogfood. After a fully
  // successful bootstrap the user was stuck in a redirect loop because
  // getConfigStatus(repoRoot).ready was false — AGENT_BACKEND and the
  // LLM provider were never written. These tests pin the new
  // finalizeReadyFlags step so a future refactor cannot regress.

  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scienceswarm-finalize-"));
    await fs.writeFile(path.join(repoRoot, ".env"), "", { encoding: "utf8" });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("writes AGENT_BACKEND=openclaw when openclaw task succeeded", async () => {
    const tasks: InstallTask[] = [
      fakeTask("openclaw", [{ status: "succeeded" }]),
      fakeTask("ollama-gemma", [{ status: "succeeded" }]),
    ];
    for await (const _ of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      void _;
    }
    const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(contents).toMatch(/^AGENT_BACKEND=openclaw$/m);
  });

  it("writes LLM_PROVIDER=local + OLLAMA_MODEL + OLLAMA_API_KEY sentinel when no API key + ollama succeeded", async () => {
    const tasks: InstallTask[] = [
      fakeTask("openclaw", [{ status: "succeeded" }]),
      fakeTask("ollama-gemma", [{ status: "succeeded" }]),
    ];
    for await (const _ of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      void _;
    }
    const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(contents).toMatch(/^LLM_PROVIDER=local$/m);
    expect(contents).toMatch(/^OLLAMA_MODEL=gemma4:latest$/m);
    // OpenClaw's Ollama provider plugin requires this sentinel to
    // register Ollama as an authenticated provider. Any value works;
    // "ollama-local" is the string the plugin's own error message
    // suggests. Without this, first agent call returns
    // "Unknown model: ollama/gemma4:latest".
    expect(contents).toMatch(/^OLLAMA_API_KEY=ollama-local$/m);
  });

  it("writes LLM_PROVIDER=openai when a pre-seeded OPENAI_API_KEY is present", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      "OPENAI_API_KEY=sk-test-1234567890abcdef\n",
      "utf8",
    );
    const tasks: InstallTask[] = [
      fakeTask("openclaw", [{ status: "succeeded" }]),
      fakeTask("ollama-gemma", [{ status: "succeeded" }]),
    ];
    for await (const _ of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      void _;
    }
    const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(contents).toMatch(/^LLM_PROVIDER=openai$/m);
    // Must NOT flip to local mode when the user has a key.
    expect(contents).not.toMatch(/^LLM_PROVIDER=local$/m);
    expect(contents).not.toMatch(/^OLLAMA_MODEL=gemma4:latest$/m);
  });

  it("preserves a pre-seeded LLM_PROVIDER choice instead of overwriting it", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      "LLM_PROVIDER=openai\n",
      "utf8",
    );
    const tasks: InstallTask[] = [
      fakeTask("openclaw", [{ status: "succeeded" }]),
      fakeTask("ollama-gemma", [{ status: "succeeded" }]),
    ];
    for await (const _ of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      void _;
    }
    const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(contents).toMatch(/^LLM_PROVIDER=openai$/m);
    expect(contents).not.toMatch(/^LLM_PROVIDER=local$/m);
    expect(contents).not.toMatch(/^OLLAMA_MODEL=gemma4:latest$/m);
    expect(contents).not.toMatch(/^OLLAMA_API_KEY=/m);
  });

  it("backfills the OLLAMA_API_KEY sentinel when local provider is already configured", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      "LLM_PROVIDER=local\nOLLAMA_MODEL=gemma4:latest\n",
      "utf8",
    );
    const tasks: InstallTask[] = [
      fakeTask("openclaw", [{ status: "succeeded" }]),
      fakeTask("ollama-gemma", [{ status: "succeeded" }]),
    ];
    for await (const _ of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      void _;
    }
    const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(contents).toMatch(/^LLM_PROVIDER=local$/m);
    expect(contents).toMatch(/^OLLAMA_MODEL=gemma4:latest$/m);
    expect(contents).toMatch(/^OLLAMA_API_KEY=ollama-local$/m);
  });

  it("registers OpenClaw's Ollama provider before selecting the local default model", async () => {
    const tasks: InstallTask[] = [
      fakeTask("openclaw", [{ status: "succeeded" }]),
      fakeTask("ollama-gemma", [{ status: "succeeded" }]),
    ];

    for await (const _ of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      void _;
    }

    const calls = runOpenClawMock.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const providerCall = calls[0]!;
    const modelCall = calls[1]!;
    expect(providerCall).toEqual([
      [
        "config",
        "set",
        "models.providers.ollama",
        expect.any(String),
        "--strict-json",
      ],
      { timeoutMs: 10_000 },
    ]);
    const providerConfig = JSON.parse(providerCall[0][3] as string) as {
      api: string;
      apiKey: string;
      baseUrl: string;
      models: Array<{ id: string; reasoning?: boolean }>;
    };
    expect(providerConfig).toMatchObject({
      api: "ollama",
      apiKey: "ollama-local",
      baseUrl: "http://localhost:11434",
    });
    expect(providerConfig.models).toContainEqual(
      expect.objectContaining({
        id: "gemma4:latest",
        reasoning: true,
      }),
    );
    expect(modelCall).toEqual([
      ["models", "set", "ollama/gemma4:latest"],
      {
        timeoutMs: 10_000,
        extraEnv: { OLLAMA_API_KEY: "ollama-local" },
      },
    ]);
  });

  it("does NOT write AGENT_BACKEND when the openclaw task failed", async () => {
    const tasks: InstallTask[] = [
      fakeTask("openclaw", [{ status: "failed", error: "boom" }]),
      fakeTask("ollama-gemma", [{ status: "succeeded" }]),
    ];
    for await (const _ of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      void _;
    }
    const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(contents).not.toMatch(/^AGENT_BACKEND=/m);
  });

  it("does NOT write LLM_PROVIDER=local when no API key AND ollama task failed", async () => {
    const tasks: InstallTask[] = [
      fakeTask("openclaw", [{ status: "succeeded" }]),
      fakeTask("ollama-gemma", [{ status: "failed", error: "no disk" }]),
    ];
    for await (const _ of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
      void _;
    }
    const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    // AGENT_BACKEND still written because openclaw succeeded, but
    // there's no usable LLM path so LLM_PROVIDER stays unset.
    expect(contents).toMatch(/^AGENT_BACKEND=openclaw$/m);
    expect(contents).not.toMatch(/^LLM_PROVIDER=/m);
    expect(contents).not.toMatch(/^OLLAMA_MODEL=/m);
    // Sentinel is only written on the local path, which we're not on.
    expect(contents).not.toMatch(/^OLLAMA_API_KEY=/m);
  });

  it("preserves SCIENCESWARM_USER_HANDLE from the persistIdentity step", async () => {
    const tasks: InstallTask[] = [
      fakeTask("openclaw", [{ status: "succeeded" }]),
    ];
    for await (const _ of runBootstrap({ handle: "alice", repoRoot }, { tasks })) {
      void _;
    }
    const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
    expect(contents).toMatch(/^SCIENCESWARM_USER_HANDLE=alice$/m);
    expect(contents).toMatch(/^AGENT_BACKEND=openclaw$/m);
  });

  it("writes readiness flags before openhands-docker finishes warming up", async () => {
    let releaseDockerWarmup: (() => void) | undefined;
    const tasks: InstallTask[] = [
      fakeTask("gbrain-init", [{ status: "succeeded" }]),
      fakeTask("openclaw", [{ status: "succeeded" }]),
      {
        id: "openhands-docker",
        async *run() {
          yield { status: "running", detail: "Starting Docker Desktop…" } as const;
          await new Promise<void>((resolve) => {
            releaseDockerWarmup = resolve;
          });
          yield { status: "succeeded", detail: "Image ready" } as const;
        },
      },
      fakeTask("ollama-gemma", [{ status: "succeeded" }]),
    ];

    const consumeBootstrap = (async () => {
      for await (const _ of runBootstrap({ handle: "h", repoRoot }, { tasks })) {
        void _;
      }
    })();

    await vi.waitFor(async () => {
      const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
      expect(contents).toMatch(/^AGENT_BACKEND=openclaw$/m);
      expect(contents).toMatch(/^LLM_PROVIDER=local$/m);
      expect(contents).toMatch(/^OLLAMA_MODEL=gemma4:latest$/m);
    });

    releaseDockerWarmup?.();
    await consumeBootstrap;
  });

  it("does not emit a synthetic running event when finalizeReadyFlags fails after openclaw succeeds", async () => {
    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-finalize-failure-"),
    );
    await fs.writeFile(path.join(repoRoot, ".env"), "", "utf8");

    const lockingTask: InstallTask = {
      id: "openclaw",
      async *run() {
        yield { status: "succeeded" } as const;
        await fs.chmod(path.join(repoRoot, ".env"), 0o400);
        await fs.chmod(repoRoot, 0o500);
      },
    };

    try {
      const events: BootstrapStreamEvent[] = [];
      for await (const e of runBootstrap(
        { handle: "h", repoRoot },
        { tasks: [lockingTask, fakeTask("ollama-gemma", [{ status: "succeeded" }])] },
      )) {
        events.push(e);
      }

      const postSuccessRunningEvent = events.find(
        (event) =>
          event.type === "task"
          && event.task === "openclaw"
          && event.status === "running"
          && event.detail?.includes("could not write ready flags"),
      );
      expect(postSuccessRunningEvent).toBeUndefined();
    } finally {
      await fs.chmod(repoRoot, 0o700).catch(() => {});
      await fs.chmod(path.join(repoRoot, ".env"), 0o600).catch(() => {});
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("persistIdentity", () => {
  it("preserves other env keys when setting handle", async () => {
    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-identity-"),
    );
    await fs.writeFile(path.join(repoRoot, ".env"), "OTHER=keep\n", "utf8");
    try {
      await persistIdentity({ handle: "h", repoRoot });
      const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
      expect(contents).toContain("OTHER=keep");
      expect(contents).toContain("SCIENCESWARM_USER_HANDLE=h");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("overwrites an existing SCIENCESWARM_USER_HANDLE in place", async () => {
    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-identity-"),
    );
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      "SCIENCESWARM_USER_HANDLE=old\nOTHER=keep\n",
      "utf8",
    );
    try {
      await persistIdentity({ handle: "new", repoRoot });
      const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
      expect(contents).toContain("SCIENCESWARM_USER_HANDLE=new");
      expect(contents).not.toContain("SCIENCESWARM_USER_HANDLE=old");
      expect(contents).toContain("OTHER=keep");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("clears a pre-existing OPENCLAW_URL from a seeded .env", async () => {
    // Task 2.6 strips `OPENCLAW_URL=ws://127.0.0.1:18789/ws` from
    // `.env.example`, but existing user `.env` files will still carry
    // that historical default. bootstrap must wipe it so downstream
    // code that reads `OPENCLAW_URL` gets empty and falls through to
    // port-based derivation.
    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-identity-"),
    );
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      "OPENCLAW_URL=ws://127.0.0.1:18789/ws\nOTHER=keep\n",
      "utf8",
    );
    try {
      await persistIdentity({ handle: "h", repoRoot });
      const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
      // Unrelated keys survive.
      expect(contents).toContain("OTHER=keep");
      expect(contents).toContain("SCIENCESWARM_USER_HANDLE=h");
      // The old default must not survive as a live value.
      expect(contents).not.toContain("OPENCLAW_URL=ws://127.0.0.1:18789/ws");
      // "Clear" means either the line is removed OR it is set to an
      // empty value. Any other live `OPENCLAW_URL=<non-empty>` line is
      // a regression — pin with a regex that only permits the empty
      // form.
      const liveLine = contents
        .split(/\r?\n/)
        .find(
          (line) => /^OPENCLAW_URL=/.test(line) && !line.trim().startsWith("#"),
        );
      if (liveLine !== undefined) {
        expect(liveLine).toMatch(/^OPENCLAW_URL=\s*$/);
      }
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not write OPENCLAW_PORT to a fresh .env (drift guard)", async () => {
    // Drift guard: the single source of truth for the openclaw port
    // is `DEFAULT_PORTS.openclaw` in `src/lib/config/ports.ts`.
    // Writing the same literal to `.env` creates drift the moment
    // either side changes. The /plan-eng-review session explicitly
    // decided to remove this write. This test pins that decision.
    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-identity-"),
    );
    await fs.writeFile(path.join(repoRoot, ".env"), "", "utf8");
    try {
      await persistIdentity({ handle: "h", repoRoot });
      const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
      const portLines = contents
        .split(/\r?\n/)
        .filter(
          (line) => /^OPENCLAW_PORT=/.test(line) && !line.trim().startsWith("#"),
        );
      expect(portLines).toEqual([]);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not write OPENCLAW_PROFILE to a fresh .env (state-dir mode default)", async () => {
    // Drift guard: state-dir mode is the default, and that mode
    // means `OPENCLAW_PROFILE` is unset. The wrapper at
    // `src/lib/openclaw/runner.ts` picks the right mode based on
    // whether the env var is set. Writing it here would force every
    // bootstrapped user into profile mode.
    const repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-identity-"),
    );
    await fs.writeFile(path.join(repoRoot, ".env"), "", "utf8");
    try {
      await persistIdentity({ handle: "h", repoRoot });
      const contents = await fs.readFile(path.join(repoRoot, ".env"), "utf8");
      const profileLines = contents
        .split(/\r?\n/)
        .filter(
          (line) =>
            /^OPENCLAW_PROFILE=/.test(line) && !line.trim().startsWith("#"),
        );
      expect(profileLines).toEqual([]);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
