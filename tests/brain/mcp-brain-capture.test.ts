import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable, Writable } from "stream";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import matter from "gray-matter";
import {
  buildCapturePage,
  createBrainCaptureHandler,
} from "@/brain/handle-brain-capture";
import { createGbrainClient, type SpawnFn } from "@/brain/gbrain-client";

const FIXED_DATE = new Date("2026-04-13T12:34:56Z");
const FIXED_HASH = "abc123";
const RUNTIME_PROVENANCE = {
  runtimeSessionId: "session-1",
  hostId: "codex",
  sourceArtifactId: "artifact-1",
  promptHash: "prompt-hash-1",
  inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
  approvalState: "approved" as const,
};

beforeEach(() => {
  vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buildCapturePage", () => {
  it("produces a slug that starts with today's date and contains the slugified title", () => {
    const page = buildCapturePage(
      { content: "body", title: "Sequence the alpha cohort" },
      FIXED_DATE,
      FIXED_HASH,
    );
    expect(page.slug).toBe("2026-04-13-sequence-the-alpha-cohort-abc123");
    expect(page.slug.startsWith("2026-04-13")).toBe(true);
    expect(page.slug).toContain("sequence-the-alpha-cohort");
  });

  it("falls back to the first non-empty line of content when no title is given", () => {
    const page = buildCapturePage(
      { content: "\n\nLoop extinction plateau around day 9\nmore notes here" },
      FIXED_DATE,
      FIXED_HASH,
    );
    expect(page.title).toBe("Loop extinction plateau around day 9");
    expect(page.slug).toContain("loop-extinction-plateau-around-day-9");
  });

  it("writes a markdown payload with frontmatter and an inline [Source:] line", () => {
    const page = buildCapturePage(
      {
        content: "Cohort looks stable at passage 7.",
        title: "Sequence the alpha cohort",
        kind: "observation",
        project: "alpha-cohort",
        tags: ["lab", "sequencing"],
        channel: "openclaw",
        userId: "alice",
      },
      FIXED_DATE,
      FIXED_HASH,
      "@alice",
    );

    const parsed = matter(page.markdown);
    expect(parsed.data.title).toBe("Sequence the alpha cohort");
    expect(parsed.data.date).toBe("2026-04-13");
    expect(parsed.data.kind).toBe("observation");
    expect(parsed.data.type).toBe("observation");
    expect(parsed.data.study).toBe("alpha-cohort");
    expect(parsed.data.study_slug).toBe("alpha-cohort");
    expect(parsed.data.legacy_project_slug).toBe("alpha-cohort");
    expect(parsed.data.channel).toBe("openclaw");
    expect(parsed.data.userId).toBe("alice");
    expect(parsed.data.tags).toEqual(["lab", "sequencing"]);
    expect(parsed.content).toContain("[Source: @alice via openclaw:alice, 2026-04-13]");
    expect(parsed.content).toContain("Cohort looks stable at passage 7.");
  });

  it("preserves research-native capture kinds as gbrain page types", () => {
    const page = buildCapturePage(
      {
        content: "Clustered the retained candidate papers into four themes.",
        kind: "research_packet",
      },
      FIXED_DATE,
      FIXED_HASH,
      "@alice",
    );

    const parsed = matter(page.markdown);
    expect(page.slug).toBe("packets/2026-04-13-clustered-the-retained-candidate-papers-into-four-themes-abc123");
    expect(parsed.data.kind).toBe("research_packet");
    expect(parsed.data.type).toBe("research_packet");
  });

  it("defaults channel/userId to mcp/unknown in the inline source line", () => {
    const page = buildCapturePage(
      { content: "Quick note" },
      FIXED_DATE,
      FIXED_HASH,
      "@alice",
    );
    expect(page.markdown).toContain("[Source: @alice via mcp:unknown, 2026-04-13]");
  });

  it("persists RuntimeGbrainProvenance in frontmatter when runtime provenance is supplied", () => {
    const page = buildCapturePage(
      {
        content: "Runtime synthesized a short note.",
        title: "Runtime note",
        runtimeProvenance: RUNTIME_PROVENANCE,
      },
      FIXED_DATE,
      FIXED_HASH,
      "@alice",
    );

    const parsed = matter(page.markdown);
    expect(parsed.data.runtime_gbrain_provenance).toEqual(RUNTIME_PROVENANCE);
  });

  it("strips leading markdown heading markers when auto-extracting the title", () => {
    const page = buildCapturePage(
      { content: "# My Research Note\nbody" },
      FIXED_DATE,
      FIXED_HASH,
    );
    // Title and slug must NOT contain the leading '#'.
    expect(page.title).toBe("My Research Note");
    expect(page.slug).toContain("my-research-note");
    expect(page.slug).not.toContain("#");
    // Frontmatter parses cleanly with a heading-free title (no js-yaml quoting).
    const parsed = matter(page.markdown);
    expect(parsed.data.title).toBe("My Research Note");
    // Body must not double-mark the heading: "# # My Research Note".
    expect(parsed.content).not.toMatch(/^#\s+#/m);
    // And the title heading must appear exactly once across the body — when
    // the content already opens with `# My Research Note`, we must NOT also
    // prepend our own `# My Research Note` block.
    const headingMatches = parsed.content.match(/^#\s+My Research Note$/gm) ?? [];
    expect(headingMatches).toHaveLength(1);
  });

  it("does not stack a second heading when content already opens with one", () => {
    const page = buildCapturePage(
      { content: "## A subheading first\nfollowed by body text" },
      FIXED_DATE,
      FIXED_HASH,
    );
    // The body must NOT begin with our own prepended `# A subheading first` —
    // it should defer to the content's existing heading.
    const parsed = matter(page.markdown);
    expect(parsed.content.startsWith("## A subheading first")).toBe(true);
    // No top-level `# A subheading first` line anywhere in the body.
    expect(parsed.content).not.toMatch(/^#\s+A subheading first$/m);
  });

  it("strips repeated heading markers (## or ###) from the auto-extracted title", () => {
    const page = buildCapturePage(
      { content: "### Triple-hash subhead\nrest" },
      FIXED_DATE,
      FIXED_HASH,
    );
    expect(page.title).toBe("Triple-hash subhead");
    expect(page.slug).toContain("triple-hash-subhead");
  });
});

describe("createBrainCaptureHandler", () => {
  it("invokes the injected gbrain client with the slug and markdown", async () => {
    const calls: Array<{ slug: string; content: string }> = [];
    const handler = createBrainCaptureHandler({
      now: () => FIXED_DATE,
      hash: () => FIXED_HASH,
      client: {
        async putPage(slug, content) {
          calls.push({ slug, content });
          return { stdout: "ok\n", stderr: "" };
        },
        async linkPages() {
          return { stdout: "", stderr: "" };
        },
      },
    });

    const result = await handler({
      content: "Body text",
      title: "My capture",
      project: "proj",
      tags: ["x"],
      channel: "web",
      userId: "u1",
    });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe("2026-04-13-my-capture-abc123");
    expect(calls[0].content).toContain("title: My capture");
    expect(calls[0].content).toContain("[Source: @test-researcher via web:u1, 2026-04-13]");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("created_or_updated");
    expect(parsed.slug).toBe("2026-04-13-my-capture-abc123");
  });

  it("writes research-native captures into canonical home slugs", async () => {
    const calls: Array<{ slug: string; content: string }> = [];
    const handler = createBrainCaptureHandler({
      now: () => FIXED_DATE,
      hash: () => FIXED_HASH,
      client: {
        async putPage(slug, content) {
          calls.push({ slug, content });
          return { stdout: "ok\n", stderr: "" };
        },
        async linkPages() {
          return { stdout: "", stderr: "" };
        },
      },
    });

    const result = await handler({
      content: "Retained papers after deterministic dedupe.",
      kind: "research_packet",
    });

    expect(result.isError).toBeUndefined();
    expect(calls[0].slug).toBe(
      "packets/2026-04-13-retained-papers-after-deterministic-dedupe-abc123",
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.slug).toBe(
      "packets/2026-04-13-retained-papers-after-deterministic-dedupe-abc123",
    );
  });

  it("rejects empty content before spawning", async () => {
    const client = { putPage: vi.fn(), linkPages: vi.fn() };
    const handler = createBrainCaptureHandler({ client });
    const result = await handler({ content: "   " });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("content is required");
    expect(client.putPage).not.toHaveBeenCalled();
  });

  it("rejects runtime-originated captures without RuntimeGbrainProvenance before writing", async () => {
    const client = { putPage: vi.fn(), linkPages: vi.fn() };
    const handler = createBrainCaptureHandler({ client });

    const result = await handler({
      content: "Runtime note",
      runtimeOriginated: true,
      runtimeSessionId: "session-1",
      runtimeHostId: "codex",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RuntimeGbrainProvenance");
    expect(client.putPage).not.toHaveBeenCalled();
  });

  it("rejects runtime-originated captures when provenance does not match the session", async () => {
    const client = { putPage: vi.fn(), linkPages: vi.fn() };
    const handler = createBrainCaptureHandler({ client });

    const result = await handler({
      content: "Runtime note",
      runtimeOriginated: true,
      runtimeSessionId: "session-2",
      runtimeHostId: "codex",
      runtimeProvenance: RUNTIME_PROVENANCE,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid RuntimeGbrainProvenance");
    expect(client.putPage).not.toHaveBeenCalled();
  });

  it("allows runtime-originated captures with matching RuntimeGbrainProvenance", async () => {
    const calls: Array<{ slug: string; content: string }> = [];
    const handler = createBrainCaptureHandler({
      now: () => FIXED_DATE,
      hash: () => FIXED_HASH,
      client: {
        async putPage(slug, content) {
          calls.push({ slug, content });
          return { stdout: "ok\n", stderr: "" };
        },
        async linkPages() {
          return { stdout: "", stderr: "" };
        },
      },
    });

    const result = await handler({
      content: "Runtime note",
      title: "Runtime note",
      runtimeOriginated: true,
      runtimeSessionId: "session-1",
      runtimeHostId: "codex",
      runtimeProvenance: RUNTIME_PROVENANCE,
    });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    const parsed = matter(calls[0].content);
    expect(parsed.data.runtime_gbrain_provenance).toEqual(RUNTIME_PROVENANCE);
  });

  it("reports a human-readable error when repo-local gbrain is missing (ENOENT)", async () => {
    const handler = createBrainCaptureHandler({
      client: {
        async putPage() {
          const err = Object.assign(new Error("spawn gbrain ENOENT"), {
            code: "ENOENT",
          });
          throw err;
        },
        async linkPages() {
          return { stdout: "", stderr: "" };
        },
      },
    });

    const result = await handler({ content: "hello" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("repo-local gbrain CLI");
    expect(result.content[0].text).toContain("npm ci");
  });

  it("fails loud when SCIENCESWARM_USER_HANDLE is unset", async () => {
    vi.unstubAllEnvs();
    const cwdWithoutEnv = mkdtempSync(join(tmpdir(), "scienceswarm-no-env-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwdWithoutEnv);
    const client = { putPage: vi.fn(), linkPages: vi.fn() };
    const handler = createBrainCaptureHandler({ client });

    try {
      const result = await handler({ content: "hello" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("SCIENCESWARM_USER_HANDLE");
      expect(client.putPage).not.toHaveBeenCalled();
    } finally {
      rmSync(cwdWithoutEnv, { recursive: true, force: true });
    }
  });

  it("surfaces stderr when gbrain exits non-zero", async () => {
    const handler = createBrainCaptureHandler({
      client: {
        async putPage() {
          const err = Object.assign(
            new Error("gbrain put exited with code 1: slug collision"),
            { exitCode: 1, stderr: "slug collision" },
          );
          throw err;
        },
        async linkPages() {
          return { stdout: "", stderr: "" };
        },
      },
    });

    const result = await handler({ content: "hello" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("slug collision");
  });
});

/** Build a fake ChildProcess for testing the spawn-based client. */
function makeFakeChild(opts: {
  exitCode?: number | null;
  stderr?: string;
  stdout?: string;
  emitError?: NodeJS.ErrnoException;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable & { _chunks: string[] };
  };
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const chunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as Writable & { _chunks: string[] };
  stdin._chunks = chunks;

  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;

  // Emit events on next tick so handlers can attach first.
  setImmediate(() => {
    if (opts.emitError) {
      child.emit("error", opts.emitError);
      return;
    }
    if (opts.stdout) stdout.push(opts.stdout);
    if (opts.stderr) stderr.push(opts.stderr);
    stdout.push(null);
    stderr.push(null);
    child.emit("close", opts.exitCode ?? 0);
  });

  return child;
}

describe("createGbrainClient", () => {
  it("defaults to ScienceSwarm's repo-local gbrain binary", async () => {
    const repoRoot = "/tmp/scienceswarm-repo";
    vi.stubEnv("SCIENCESWARM_REPO_ROOT", repoRoot);
    vi.stubEnv("SCIENCESWARM_GBRAIN_BIN", "");
    const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    const spawnFn: SpawnFn = ((cmd: string, args: readonly string[]) => {
      spawnCalls.push({ cmd, args });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return makeFakeChild({ exitCode: 0, stdout: "done\n" }) as any;
    }) as SpawnFn;

    const client = createGbrainClient({ spawnFn });
    await client.putPage("2026-04-13-foo-abc123", "# foo\n");

    expect(spawnCalls[0].cmd).toBe(
      join(
        repoRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "gbrain.cmd" : "gbrain",
      ),
    );
  });

  it("spawns `gbrain put <slug>` and writes markdown to stdin", async () => {
    const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    let captured: { _chunks: string[] } | null = null;
    const spawnFn: SpawnFn = ((cmd: string, args: readonly string[]) => {
      spawnCalls.push({ cmd, args });
      const child = makeFakeChild({ exitCode: 0, stdout: "done\n" });
      captured = child.stdin;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return child as any;
    }) as SpawnFn;

    const client = createGbrainClient({ spawnFn, bin: "gbrain" });
    const result = await client.putPage("2026-04-13-foo-abc123", "# foo\n");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe("gbrain");
    expect(spawnCalls[0].args).toEqual(["put", "2026-04-13-foo-abc123"]);
    expect(result.stdout).toBe("done\n");
    expect(captured).not.toBeNull();
    expect(captured!._chunks.join("")).toBe("# foo\n");
  });

  it("maps ENOENT spawn errors to an error with code=ENOENT", async () => {
    const spawnFn: SpawnFn = (() => {
      const err = Object.assign(new Error("spawn gbrain ENOENT"), {
        code: "ENOENT",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return makeFakeChild({ emitError: err }) as any;
    }) as SpawnFn;

    const client = createGbrainClient({ spawnFn });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let caught: any;
    try {
      await client.putPage("slug", "content");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe("ENOENT");
  });

  it("rejects with stderr attached when gbrain exits non-zero", async () => {
    const spawnFn: SpawnFn = (() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return makeFakeChild({ exitCode: 1, stderr: "slug collision" }) as any;
    }) as SpawnFn;

    const client = createGbrainClient({ spawnFn });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let caught: any;
    try {
      await client.putPage("slug", "content");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.exitCode).toBe(1);
    expect(String(caught.message)).toContain("slug collision");
  });

  it("rejects with a timeout error if the subprocess never closes", async () => {
    // Build a child that never emits 'close' or 'error'.
    const killCalls: number[] = [];
    const spawnFn: SpawnFn = (() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: Writable;
        kill: () => void;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.stdin = new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
      child.kill = () => {
        killCalls.push(1);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return child as any;
    }) as SpawnFn;

    const client = createGbrainClient({ spawnFn, timeoutMs: 25 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let caught: any;
    try {
      await client.putPage("slug", "content");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(String(caught.message)).toContain("timed out after 25ms");
    expect(killCalls).toHaveLength(1);
  });
});
