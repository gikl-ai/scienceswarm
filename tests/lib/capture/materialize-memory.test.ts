/**
 * materializeMemory unit tests — gbrain writer (Phase B Track A).
 *
 * Pre-pivot these tests read markdown files off disk and asserted on
 * raw string content (`fs.readFileSync` of `wiki/resources/<slug>.md`,
 * regex matches on `## Timeline`, `[Source: ...]`, `Referenced in [`).
 * Under the gbrain writer there is no markdown file on disk — every
 * assertion now goes through an in-memory PGLite engine.
 *
 * Test strategy:
 *   * Each test seeds a fresh in-memory PGLite engine
 *     (`createRuntimeEngine({ engine: "pglite" })` with no
 *     `database_path` → memory). The engine is injected into
 *     `materializeMemory` so we never touch `<brainRoot>/db`.
 *   * Assertions read structured data via `engine.getPage(slug)`,
 *     `engine.getTimeline(projectSlug)`, and
 *     `engine.getBacklinks(projectSlug)`.
 *   * Body / citation assertions match substrings inside
 *     `page.compiled_truth`, which is where the captured-page body lives.
 *   * The pseudo-path returned by materializeMemory still matches the
 *     pre-pivot regex shape (`wiki/<kind-dir>/<slug>.md`) so the
 *     wider integration tests (api-routes, capture-service,
 *     mvp-telegram-capture) keep passing — those tests assert on
 *     `materializedPath` shape, not on file existence.
 *
 * Test coverage map (PR #235 → Track A):
 *
 *   PR #235                                                 Track A
 *   ──────────────────────────────────────────────────      ──────────────
 *   inline [Source: ...] citation in page body              compiled_truth
 *   project Timeline back-link append                       getTimeline
 *   no-double-append on re-materialize                      getTimeline len
 *   bracket-escape inside markdown link label               (deleted: no
 *                                                            markdown link
 *                                                            anymore — see
 *                                                            "Bracket
 *                                                            escaping"
 *                                                            below)
 *   project page seeded on first touch                      getPage seed
 *
 * Bracket escaping:
 *   PR #235 escaped `[` and `]` inside the timeline entry's markdown
 *   link label (`[Calcium \[Ca2+\] regulation](...)`) so renderers
 *   wouldn't break the link. Under the gbrain writer the timeline
 *   entry is a structured row, not a markdown link, so there is no
 *   link label to escape. We still keep an idempotency assertion for
 *   bracketed titles to make sure the slug-based de-dup works for
 *   them — which is the underlying behavior that test was protecting.
 *
 * Track A NEW assertions (deferred concerns from PR #235 P1/P2 review):
 *   * Concurrent addTimelineEntry on the same project does not
 *     duplicate entries (the race condition the writeFile path was
 *     vulnerable to is now gbrain's responsibility — we pin it).
 *   * `SCIENCESWARM_USER_HANDLE` unset propagates as a clear error.
 *   * The composite `[Source: @handle via channel:id, date]` format
 *     appears in `compiled_truth`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeEngine } from "@/brain/stores/gbrain-runtime.mjs";
import {
  materializeMemory,
  resolvePgliteDatabasePath,
  PGLITE_DB_FILENAME,
  type MaterializeEngine,
} from "@/lib/capture/materialize-memory";
import type { PersistedRawCapture } from "@/lib/capture/persist-raw";
import { readProjectManifest } from "@/lib/state/project-manifests";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

interface PageRow {
  id: number;
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
}

interface TimelineRow {
  page_id: number;
  date: string | Date;
  source: string;
  summary: string;
  detail: string;
}

interface LinkRow {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
}

interface ContractEngine extends MaterializeEngine {
  getPage(slug: string): Promise<PageRow | null>;
  getTimeline(slug: string, opts?: { limit?: number }): Promise<TimelineRow[]>;
  getBacklinks(slug: string): Promise<LinkRow[]>;
  getLinks(slug: string): Promise<LinkRow[]>;
}

let engine: ContractEngine;
let tmpRoot: string;

function makeCapture(
  overrides: Partial<PersistedRawCapture> = {},
): PersistedRawCapture {
  return {
    captureId: "cap-001",
    channel: "telegram",
    userId: "user-42",
    kind: "note",
    project: "demo",
    privacy: "cloud-ok",
    sourceRefs: [],
    rawPath: "raw/captures/telegram/2026-04-13/cap-001.json",
    attachmentPaths: [],
    requiresClarification: false,
    content: "A note about the filing rules follow-up.",
    createdAt: "2026-04-13T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  // SCIENCESWARM_USER_HANDLE is required on every write path under
  // decision 3A. Set it here for the happy-path tests; the
  // "unset" test deletes it explicitly.
  process.env.SCIENCESWARM_USER_HANDLE = "@alice";

  // tmpRoot is only used as a state-dir parent for
  // `updateProjectManifest`, which still writes to `<brainRoot>/state`.
  // The gbrain pages themselves live in the in-memory PGLite engine
  // below — `<brainRoot>/db` is never touched.
  tmpRoot = mkdtempSync(path.join(tmpdir(), "scienceswarm-materialize-memory-"));

  engine = (await createRuntimeEngine({
    engine: "pglite",
    // no database_path → in-memory
  })) as unknown as ContractEngine;
  await engine.connect({ engine: "pglite" });
  await engine.initSchema();
});

afterEach(async () => {
  if (engine) {
    await engine.disconnect();
  }
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  delete process.env.SCIENCESWARM_USER_HANDLE;
});

describe("materializeMemory filing rules (gbrain writer)", () => {
  it("writes the captured page into gbrain with an inline [Source:] citation in compiled_truth", async () => {
    const result = await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture(),
      project: "demo",
      confidence: "medium",
      engine,
    });

    expect(result.materializedPath).toBeDefined();
    // The pseudo-path is the kind-dir + slug + .md so callers that
    // regex on it (api-routes, capture-service, mvp-telegram-capture)
    // still match the same shape.
    expect(result.materializedPath).toMatch(/^wiki\/resources\/2026-04-13-.*-cap-001\.md$/);

    // Derive the slug from the pseudo-path so we read the same page
    // gbrain just wrote.
    const slug = derivePageSlug(result.materializedPath!);
    const page = await engine.getPage(slug);
    expect(page).not.toBeNull();
    expect(page!.type).toBe("note");
    expect(page!.title).toContain("filing rules follow-up");

    const citationLines = page!.compiled_truth
      .split("\n")
      .filter((line) => line.startsWith("[Source:"));
    expect(citationLines.length).toBeGreaterThan(0);
    // Composite identity: local handle + channel:user-id (the new
    // 3A-compliant format).
    expect(
      citationLines.some(
        (line) => line.includes("@alice") && line.includes("telegram:user-42"),
      ),
    ).toBe(true);
    // Synthesis/compiled-from fallback keyed to capture id.
    expect(
      citationLines.some((line) => line.includes("compiled from capture cap-001")),
    ).toBe(true);
  });

  it("does not turn conversation and capture refs into noisy body citations", async () => {
    const result = await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture({
        sourceRefs: [
          { kind: "conversation", ref: "thread-123" },
          { kind: "capture", ref: "cap-prior" },
          { kind: "artifact", ref: "wiki/decisions/alpha" },
          { kind: "external", ref: "https://example.org/paper" },
        ],
      }),
      project: "demo",
      confidence: "medium",
      engine,
    });

    const slug = derivePageSlug(result.materializedPath!);
    const page = await engine.getPage(slug);
    expect(page).not.toBeNull();

    const citationLines = page!.compiled_truth
      .split("\n")
      .filter((line) => line.startsWith("[Source:"));
    expect(citationLines).toContain("[Source: artifact:wiki/decisions/alpha]");
    expect(citationLines).toContain("[Source: https://example.org/paper]");
    expect(citationLines).not.toContain("[Source: conversation:thread-123]");
    expect(citationLines).not.toContain("[Source: capture:cap-prior]");
  });

  it("logs captured pages as recent ingest events for Dream Cycle", async () => {
    const result = await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture(),
      project: "demo",
      confidence: "medium",
      engine,
    });

    const events = readFileSync(path.join(tmpRoot, "wiki", "events.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; contentType: string; created: string[] });
    const slug = derivePageSlug(result.materializedPath!);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ingest",
        contentType: "note",
        created: [`${slug}.md`],
      }),
    );
  });

  it("appends a Timeline back-link entry on the project page (idempotent by date+summary)", async () => {
    const result = await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture(),
      project: "demo",
      confidence: "medium",
      engine,
    });

    const timeline = await engine.getTimeline("demo", { limit: 50 });
    expect(timeline.length).toBe(1);

    const entry = timeline[0];
    // The summary string carries "Referenced in <title>" — the same
    // semantic the pre-pivot markdown link label conveyed.
    expect(entry.summary).toContain("Referenced in");
    expect(entry.summary).toContain("filing rules follow-up");
    // The detail string carries the kind, channel, and the
    // pseudo-path so a briefing renderer can link back to the
    // captured page.
    expect(entry.detail).toContain("note");
    expect(entry.detail).toContain("telegram");
    expect(entry.detail).toContain(result.materializedPath as string);
    // Date matches the capture's createdAt date (UTC slice).
    const dateStr = entry.date instanceof Date
      ? entry.date.toISOString().slice(0, 10)
      : String(entry.date).slice(0, 10);
    expect(dateStr).toBe("2026-04-13");
  });

  it("does not double-append the same Timeline entry on re-materialize", async () => {
    const capture = makeCapture();
    await materializeMemory({
      brainRoot: tmpRoot,
      capture,
      project: "demo",
      confidence: "medium",
      engine,
    });
    await materializeMemory({
      brainRoot: tmpRoot,
      capture,
      project: "demo",
      confidence: "medium",
      engine,
    });

    const timeline = await engine.getTimeline("demo", { limit: 50 });
    // gbrain's addTimelineEntry is idempotent-by-(slug, date,
    // summary) per the contract test. Re-materializing the same
    // capture must produce exactly one timeline row.
    expect(timeline.length).toBe(1);
  });

  it("survives bracketed titles ([Ca2+]) without breaking gbrain row writes", async () => {
    // Pre-pivot this test asserted on backslash-escaped link labels in
    // a markdown body. Under gbrain there is no markdown link — the
    // timeline entry is structured. We still want to make sure
    // titles with literal `[` / `]` don't break putPage, slug
    // derivation, or the second-call idempotency path.
    const cap = makeCapture({
      captureId: "cap-bracket",
      content: "Calcium [Ca2+] regulation in cardiomyocytes",
    });

    const first = await materializeMemory({
      brainRoot: tmpRoot,
      capture: cap,
      project: "demo",
      confidence: "medium",
      engine,
    });

    const slug = derivePageSlug(first.materializedPath!);
    const page = await engine.getPage(slug);
    expect(page).not.toBeNull();
    expect(page!.title).toContain("[Ca2+]");
    expect(page!.compiled_truth).toContain("Calcium [Ca2+] regulation");

    // Re-materialize the same capture — must still be idempotent on
    // the timeline side.
    await materializeMemory({
      brainRoot: tmpRoot,
      capture: cap,
      project: "demo",
      confidence: "medium",
      engine,
    });

    const timeline = await engine.getTimeline("demo", { limit: 50 });
    expect(timeline.length).toBe(1);
    expect(timeline[0].summary).toContain("Calcium");
  });

  it("seeds the project page on first touch when it doesn't yet exist", async () => {
    const before = await engine.getPage("fresh-project");
    expect(before).toBeNull();

    const result = await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture({ captureId: "cap-fresh", content: "Kickoff note" }),
      project: "fresh-project",
      confidence: "medium",
      engine,
    });

    const projectPage = await engine.getPage("fresh-project");
    expect(projectPage).not.toBeNull();
    expect(projectPage!.type).toBe("project");
    expect(projectPage!.title).toBe("fresh project");

    // The captured page itself was also written, and its slug is
    // recoverable from the materializedPath pseudo-path.
    const captureSlug = derivePageSlug(result.materializedPath!);
    const capturePage = await engine.getPage(captureSlug);
    expect(capturePage).not.toBeNull();
    expect(capturePage!.compiled_truth).toContain("Kickoff note");
  });

  it("does not overwrite an existing project page's title or body on subsequent captures", async () => {
    // Seed a project page with a hand-edited title + body that the
    // user would not want clobbered.
    await engine.putPage("demo", {
      type: "project",
      title: "Demo Sequencing Project (user-edited)",
      compiled_truth: "Hand-written project overview the user wrote in gbrain.",
      frontmatter: { owner: "@alice" },
    });

    await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture(),
      project: "demo",
      confidence: "medium",
      engine,
    });

    const projectPage = await engine.getPage("demo");
    expect(projectPage).not.toBeNull();
    expect(projectPage!.title).toBe("Demo Sequencing Project (user-edited)");
    expect(projectPage!.compiled_truth).toBe(
      "Hand-written project overview the user wrote in gbrain.",
    );
  });

  it("recovers a missing disk mirror without clobbering the gbrain project page", async () => {
    // Simulate a prior partial write: gbrain has a user-edited project
    // page but the disk mirror file was never created (or was deleted
    // out-of-band). The next materialize call should:
    //   1. NOT re-call putPage on the project slug (would clobber the
    //      user's edits).
    //   2. Mirror the gbrain compiled_truth + frontmatter to disk so
    //      briefing / dashboard consumers reading
    //      `<brainRoot>/wiki/projects/<slug>.md` pick it up again.
    await engine.putPage("demo", {
      type: "project",
      title: "Demo Sequencing Project (user-edited)",
      compiled_truth: "Hand-written project overview the user wrote in gbrain.",
      frontmatter: { owner: "@alice", privacy: "cloud-ok" },
    });

    // Verify the disk mirror does not exist yet.
    const { existsSync, readFileSync } = await import("node:fs");
    const diskPath = path.join(tmpRoot, "wiki", "projects", "demo.md");
    expect(existsSync(diskPath)).toBe(false);

    await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture(),
      project: "demo",
      confidence: "medium",
      engine,
    });

    // The gbrain page must be untouched — putPage was NOT called on
    // the recovery branch.
    const projectPage = await engine.getPage("demo");
    expect(projectPage!.title).toBe("Demo Sequencing Project (user-edited)");
    expect(projectPage!.compiled_truth).toBe(
      "Hand-written project overview the user wrote in gbrain.",
    );

    // The disk mirror must now exist and carry the gbrain body, not
    // the seed template.
    expect(existsSync(diskPath)).toBe(true);
    const diskContent = readFileSync(diskPath, "utf-8");
    expect(diskContent).toContain(
      "Hand-written project overview the user wrote in gbrain.",
    );
    // And NOT the seed placeholder that a fresh cold-start would write.
    expect(diskContent).not.toContain("Project page created by the capture pipeline");
  });

  it("creates an Iron-Law back-link from the captured page to the project", async () => {
    const result = await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture(),
      project: "demo",
      confidence: "medium",
      engine,
    });

    const captureSlug = derivePageSlug(result.materializedPath!);
    const backlinks = await engine.getBacklinks("demo");
    expect(backlinks.length).toBeGreaterThanOrEqual(1);
    expect(backlinks.some((link) => link.from_slug === captureSlug)).toBe(true);

    const outgoing = await engine.getLinks(captureSlug);
    expect(outgoing.some((link) => link.to_slug === "demo")).toBe(true);
  });

  it("returns early with no materialized path when project is null", async () => {
    const result = await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture({ project: null }),
      project: null,
      confidence: "medium",
      engine,
    });
    expect(result.materializedPath).toBeUndefined();
    expect(result.project).toBeNull();
    expect(result.sourceRef).toBeDefined();
  });

  it("files research-native capture kinds into dedicated homes with preserved gbrain types", async () => {
    const cases = [
      { kind: "survey", dir: "wiki/surveys" },
      { kind: "method", dir: "wiki/methods" },
      { kind: "original_synthesis", dir: "wiki/originals" },
      { kind: "research_packet", dir: "wiki/packets" },
      { kind: "overnight_journal", dir: "wiki/journals" },
    ] as const;

    for (const { kind, dir } of cases) {
      const capture = makeCapture({
        captureId: `cap-${kind}`,
        kind,
        content: `${kind} capture body`,
      });
      const result = await materializeMemory({
        brainRoot: tmpRoot,
        capture,
        project: "demo",
        confidence: "medium",
        engine,
      });

      expect(result.materializedPath).toMatch(
        new RegExp(`^${dir}/2026-04-13-.*\\.md$`),
      );

      const slug = derivePageSlug(result.materializedPath!);
      const page = await engine.getPage(slug);
      expect(page).not.toBeNull();
      expect(page!.type).toBe(kind);
      expect(page!.frontmatter.type).toBe(kind);
    }
  });

  it("adds research packets and overnight journals to project artifact paths", async () => {
    const packet = await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture({
        captureId: "cap-packet",
        kind: "research_packet",
        content: "Retained literature packet",
      }),
      project: "demo",
      confidence: "medium",
      engine,
    });

    const journal = await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture({
        captureId: "cap-journal",
        kind: "overnight_journal",
        content: "Overnight run journal",
      }),
      project: "demo",
      confidence: "medium",
      engine,
    });

    const manifest = await readProjectManifest("demo", path.join(tmpRoot, "state"));
    expect(manifest?.artifactPaths).toEqual(
      expect.arrayContaining([
        packet.materializedPath as string,
        journal.materializedPath as string,
      ]),
    );
  });
});

describe("materializeMemory attribution (decision 3A)", () => {
  it("propagates a clear error when SCIENCESWARM_USER_HANDLE is unset", async () => {
    delete process.env.SCIENCESWARM_USER_HANDLE;
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      await expect(
        materializeMemory({
          brainRoot: tmpRoot,
          capture: makeCapture(),
          project: "demo",
          confidence: "medium",
          engine,
        }),
      ).rejects.toThrow(/SCIENCESWARM_USER_HANDLE is not set/);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("uses the configured handle in the inline citation regardless of the external user id", async () => {
    process.env.SCIENCESWARM_USER_HANDLE = "@dr-frank";
    const result = await materializeMemory({
      brainRoot: tmpRoot,
      capture: makeCapture({
        channel: "web",
        userId: "anon-7",
        captureId: "cap-attr",
      }),
      project: "demo",
      confidence: "medium",
      engine,
    });

    const slug = derivePageSlug(result.materializedPath!);
    const page = await engine.getPage(slug);
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain("[Source: @dr-frank via web:anon-7,");
  });
});

describe("materializeMemory concurrent timeline writes", () => {
  it("does not duplicate timeline entries when the same capture is materialized concurrently", async () => {
    const capture = makeCapture({ captureId: "cap-concurrent" });

    // Fire ten in parallel against the same engine. Pre-pivot this
    // would race in the read-modify-write of `wiki/projects/demo.md`
    // (PR #235's deferred P1 concern). Under gbrain
    // addTimelineEntry is idempotent-by-(slug, date, summary) per
    // the contract test, so the result must still be exactly one
    // row.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        materializeMemory({
          brainRoot: tmpRoot,
          capture,
          project: "demo",
          confidence: "medium",
          engine,
        }),
      ),
    );

    const timeline = await engine.getTimeline("demo", { limit: 50 });
    expect(timeline.length).toBe(1);
  });
});

// ── PGLite database path resolver ─────────────────────
//
// Track A preflight fix: the writer and every caller-side reader must
// resolve the PGLite database file through a single helper so the
// installer-canonical `<brainRoot>/brain.pglite` path and the
// production materialize-memory path can never drift apart again (the
// original Track A draft hardcoded `<brainRoot>/db` which silently
// bypassed the installer's populated DB). These tests lock the contract.
describe("resolvePgliteDatabasePath", () => {
  const previousOverride = process.env.BRAIN_PGLITE_PATH;

  afterEach(() => {
    if (previousOverride === undefined) {
      delete process.env.BRAIN_PGLITE_PATH;
    } else {
      process.env.BRAIN_PGLITE_PATH = previousOverride;
    }
  });

  it("falls back to <brainRoot>/brain.pglite — the installer's canonical filename", () => {
    delete process.env.BRAIN_PGLITE_PATH;
    const resolved = resolvePgliteDatabasePath("/tmp/fake-brain");
    expect(resolved).toBe(path.join("/tmp/fake-brain", "brain.pglite"));
    // Belt-and-suspenders: the exported constant matches the installer's
    // PGLITE_DBNAME. If someone drifts either side of this pair, this
    // assertion plus a matching constant in the installer test will
    // fail.
    expect(PGLITE_DB_FILENAME).toBe("brain.pglite");
  });

  it("honors BRAIN_PGLITE_PATH env var override (parity with src/brain/store.ts)", () => {
    process.env.BRAIN_PGLITE_PATH = "/override/custom.pglite";
    expect(resolvePgliteDatabasePath("/tmp/anything")).toBe(
      "/override/custom.pglite",
    );
  });

  it("ignores empty string override", () => {
    process.env.BRAIN_PGLITE_PATH = "";
    expect(resolvePgliteDatabasePath("/tmp/fake-brain")).toBe(
      path.join("/tmp/fake-brain", "brain.pglite"),
    );
  });
});

// ── helpers ───────────────────────────────────────────

function derivePageSlug(materializedPath: string): string {
  // pseudo-path is `wiki/<kind-dir>/<slug>.md`
  const base = materializedPath.split("/").pop() ?? "";
  return base.replace(/\.md$/, "");
}
