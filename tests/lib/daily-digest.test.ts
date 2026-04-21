import path from "node:path";
import { mkdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeDailyDigest } from "@/lib/daily-digest";

const ROOT = path.join(tmpdir(), "scienceswarm-daily-digest-lib");
// Use a fixed "now" so every test is deterministic regardless of wall clock.
const FIXED_NOW = new Date("2026-03-15T12:00:00.000Z");
const NOW_MS = FIXED_NOW.getTime();

function seed(rel: string, body = "x"): string {
  const full = path.join(ROOT, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
  return full;
}

/** Force mtime and atime to a specific Date so window logic is deterministic. */
function setMtime(fullPath: string, when: Date): void {
  utimesSync(fullPath, when, when);
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("computeDailyDigest", () => {
  it("includes a file seeded inside the default 24h window", async () => {
    const p = seed("papers/recent.pdf");
    // ctime is set by the seed itself (near FIXED_NOW in real time), so we
    // only need mtime to be inside the window relative to FIXED_NOW.
    setMtime(p, new Date(NOW_MS - 2 * 3600 * 1000));

    const digest = await computeDailyDigest(ROOT, { now: FIXED_NOW });
    const all = [...digest.added, ...digest.modified].map((f) => f.path);
    expect(all).toContain("papers/recent.pdf");
  });

  it("excludes a file seeded outside the window", async () => {
    const p = seed("papers/old.pdf");
    // 48h ago, i.e. outside the 24h window.
    setMtime(p, new Date(NOW_MS - 48 * 3600 * 1000));

    const digest = await computeDailyDigest(ROOT, { now: FIXED_NOW });
    const all = [...digest.added, ...digest.modified].map((f) => f.path);
    expect(all).not.toContain("papers/old.pdf");
    expect(digest.totals.added).toBe(0);
    expect(digest.totals.modified).toBe(0);
  });

  it("classifies mtime-only-in-window as modified (ctime older)", async () => {
    // ctime is the inode change time — for a freshly seeded file, ctime is
    // ≈ real wall-clock "now". To test the "modified" lane reliably we pick
    // a synthetic `now` that is far in the future, with a narrow window.
    // Then we force mtime into that future window via utimesSync. ctime
    // stays at real wall-clock → below the window → file is mtime-only.
    const p = seed("code/script.py");
    const realNowMs = Date.now();
    const syntheticNow = new Date(realNowMs + 10 * 24 * 3600 * 1000);
    // Force mtime to be inside the synthetic window (last 1 hour of it).
    setMtime(p, new Date(syntheticNow.getTime() - 30 * 60 * 1000));

    const digest = await computeDailyDigest(ROOT, {
      now: syntheticNow,
      windowHours: 1,
    });
    const modifiedPaths = digest.modified.map((f) => f.path);
    const addedPaths = digest.added.map((f) => f.path);
    // ctime ≈ realNow, window = [syntheticNow − 1h, syntheticNow], so ctime
    // is far below the window → mtime-only-in-window → modified lane.
    expect(modifiedPaths).toContain("code/script.py");
    expect(addedPaths).not.toContain("code/script.py");
  });

  it("classifies ctime+mtime both in window as added", async () => {
    // ctime is ~wall clock "now" from the seed. Use a `now` that is ~seconds
    // later and a wide window so both timestamps fall inside.
    const realNow = new Date();
    const p = seed("data/fresh.csv");
    setMtime(p, realNow);

    const digest = await computeDailyDigest(ROOT, {
      // now slightly after real wall clock, still in the same 24h window.
      now: new Date(realNow.getTime() + 1000),
      windowHours: 24,
    });
    const addedPaths = digest.added.map((f) => f.path);
    expect(addedPaths).toContain("data/fresh.csv");
  });

  it("sorts added/modified newest-first with a path tiebreaker", async () => {
    const a = seed("code/a.py");
    const b = seed("code/b.py");
    const c = seed("code/c.py");
    setMtime(a, new Date(NOW_MS - 3 * 3600 * 1000));
    setMtime(b, new Date(NOW_MS - 1 * 3600 * 1000));
    setMtime(c, new Date(NOW_MS - 1 * 3600 * 1000));

    const digest = await computeDailyDigest(ROOT, {
      now: FIXED_NOW,
      windowHours: 24,
    });
    const all = [...digest.added, ...digest.modified];
    const paths = all.map((f) => f.path);
    // b and c share the same mtime; b should come first (path tiebreaker).
    expect(paths.indexOf("code/b.py")).toBeLessThan(paths.indexOf("code/c.py"));
    // a is older → it comes after both b and c.
    expect(paths.indexOf("code/a.py")).toBeGreaterThan(
      paths.indexOf("code/c.py"),
    );
  });

  it("counts byBucket across added and modified", async () => {
    const p1 = seed("papers/p1.pdf");
    const p2 = seed("papers/p2.pdf");
    const c1 = seed("code/c1.py");
    setMtime(p1, new Date(NOW_MS - 1 * 3600 * 1000));
    setMtime(p2, new Date(NOW_MS - 2 * 3600 * 1000));
    setMtime(c1, new Date(NOW_MS - 3 * 3600 * 1000));

    const digest = await computeDailyDigest(ROOT, {
      now: FIXED_NOW,
      windowHours: 24,
    });
    expect(digest.byBucket.papers).toBe(2);
    expect(digest.byBucket.code).toBe(1);
  });

  it("returns an empty digest for an empty project", async () => {
    const digest = await computeDailyDigest(ROOT, { now: FIXED_NOW });
    expect(digest.added).toEqual([]);
    expect(digest.modified).toEqual([]);
    expect(digest.totals).toEqual({ added: 0, modified: 0 });
    expect(digest.byBucket).toEqual({});
  });

  it("returns an empty digest for a missing project root without throwing", async () => {
    const missing = path.join(ROOT, "does-not-exist");
    const digest = await computeDailyDigest(missing, { now: FIXED_NOW });
    expect(digest.added).toEqual([]);
    expect(digest.modified).toEqual([]);
    expect(digest.totals.added).toBe(0);
    expect(digest.totals.modified).toBe(0);
  });

  it("returns an empty digest when resolving the project root realpath fails", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
      return {
        ...actual,
        realpath: async (target: string) => {
          if (target === ROOT) {
            throw new Error("broken realpath");
          }
          return await actual.realpath(target);
        },
      };
    });

    try {
      const { computeDailyDigest: computeDailyDigestWithBrokenRealpath } =
        await import("@/lib/daily-digest");
      const digest = await computeDailyDigestWithBrokenRealpath(ROOT, { now: FIXED_NOW });
      expect(digest.added).toEqual([]);
      expect(digest.modified).toEqual([]);
      expect(digest.totals).toEqual({ added: 0, modified: 0 });
      expect(digest.byBucket).toEqual({});
    } finally {
      vi.doUnmock("node:fs/promises");
    }
  });

  it("excludes a file touched 2h ago when the window is 1h", async () => {
    const p = seed("code/two-hours-old.py");
    setMtime(p, new Date(NOW_MS - 2 * 3600 * 1000));

    const digest = await computeDailyDigest(ROOT, {
      now: FIXED_NOW,
      windowHours: 1,
    });
    const all = [...digest.added, ...digest.modified].map((f) => f.path);
    expect(all).not.toContain("code/two-hours-old.py");
  });

  it("excludes .references.json and dotfiles", async () => {
    const refs = seed(".references.json", "{}");
    const hidden = seed(".secret", "nope");
    const hiddenInDir = seed("papers/.draft", "nope");
    setMtime(refs, new Date(NOW_MS - 10 * 60 * 1000));
    setMtime(hidden, new Date(NOW_MS - 10 * 60 * 1000));
    setMtime(hiddenInDir, new Date(NOW_MS - 10 * 60 * 1000));

    // Also seed a real paper so the walk actually finds something.
    const real = seed("papers/real.pdf");
    setMtime(real, new Date(NOW_MS - 10 * 60 * 1000));

    const digest = await computeDailyDigest(ROOT, {
      now: FIXED_NOW,
      windowHours: 24,
    });
    const all = [...digest.added, ...digest.modified].map((f) => f.path);
    expect(all).toContain("papers/real.pdf");
    expect(all).not.toContain(".references.json");
    expect(all).not.toContain(".secret");
    expect(all).not.toContain("papers/.draft");
  });

  it("honours a custom `now` option", async () => {
    // File touched exactly at real wall clock time. We'll pass a `now` 10h
    // later with a 1h window → file must be outside.
    const realNow = new Date();
    const p = seed("code/time.py");
    setMtime(p, realNow);

    const farFuture = new Date(realNow.getTime() + 10 * 3600 * 1000);
    const digest = await computeDailyDigest(ROOT, {
      now: farFuture,
      windowHours: 1,
    });
    expect(digest.totals.added + digest.totals.modified).toBe(0);

    // Same seed, wider window → must be visible.
    const digest2 = await computeDailyDigest(ROOT, {
      now: farFuture,
      windowHours: 24,
    });
    const all = [...digest2.added, ...digest2.modified].map((f) => f.path);
    expect(all).toContain("code/time.py");
  });

  it("skips node_modules and .claude directories", async () => {
    const nm = seed("node_modules/pkg/index.js");
    const cl = seed(".claude/settings.json", "{}");
    const real = seed("code/real.py");
    const tenMinAgo = new Date(NOW_MS - 10 * 60 * 1000);
    setMtime(nm, tenMinAgo);
    setMtime(cl, tenMinAgo);
    setMtime(real, tenMinAgo);

    const digest = await computeDailyDigest(ROOT, {
      now: FIXED_NOW,
      windowHours: 24,
    });
    const all = [...digest.added, ...digest.modified].map((f) => f.path);
    expect(all).toContain("code/real.py");
    expect(all.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(all.some((p) => p.startsWith(".claude/"))).toBe(false);
  });

  it("classifies files outside known top-level folders as `other`", async () => {
    const p = seed("random/stuff.bin");
    setMtime(p, new Date(NOW_MS - 10 * 60 * 1000));
    const digest = await computeDailyDigest(ROOT, {
      now: FIXED_NOW,
      windowHours: 24,
    });
    const all = [...digest.added, ...digest.modified];
    const entry = all.find((f) => f.path === "random/stuff.bin");
    expect(entry?.bucket).toBe("other");
  });

  it("includes symlinked files in the digest", async () => {
    const target = seed("papers/actual.pdf", "%PDF-1.4 fake");
    const alias = path.join(ROOT, "papers", "alias.pdf");
    symlinkSync(target, alias);
    setMtime(target, new Date(NOW_MS - 10 * 60 * 1000));

    const digest = await computeDailyDigest(ROOT, {
      now: FIXED_NOW,
      windowHours: 24,
    });
    const all = [...digest.added, ...digest.modified].map((f) => f.path);
    expect(all).toContain("papers/alias.pdf");
  });

  it("skips symlinks that point outside the project root", async () => {
    const outsideRoot = path.join(tmpdir(), "scienceswarm-daily-digest-outside");
    const outsideTarget = path.join(outsideRoot, "outside.pdf");
    const alias = path.join(ROOT, "papers", "outside-link.pdf");
    mkdirSync(outsideRoot, { recursive: true });
    mkdirSync(path.dirname(alias), { recursive: true });
    writeFileSync(outsideTarget, "%PDF-1.4 outside");
    setMtime(outsideTarget, new Date(NOW_MS - 10 * 60 * 1000));
    symlinkSync(outsideTarget, alias);

    const digest = await computeDailyDigest(ROOT, {
      now: FIXED_NOW,
      windowHours: 24,
    });
    const all = [...digest.added, ...digest.modified].map((f) => f.path);
    expect(all).not.toContain("papers/outside-link.pdf");

    rmSync(outsideRoot, { recursive: true, force: true });
  });
});
