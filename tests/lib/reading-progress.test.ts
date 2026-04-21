import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteReadingEntry,
  getReadingProgressPath,
  loadReadingProgress,
  upsertReadingEntry,
} from "@/lib/reading-progress";

const ROOT = path.join(tmpdir(), "scienceswarm-reading-progress");

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("reading-progress", () => {
  it("getReadingProgressPath returns the expected path", () => {
    expect(getReadingProgressPath(ROOT, "my-project")).toBe(
      path.join(ROOT, "projects", "my-project", "reading-progress.json"),
    );
  });

  it("loadReadingProgress returns empty store when file missing", async () => {
    const store = await loadReadingProgress(ROOT, "ghost-project");
    expect(store).toEqual({ version: 1, entries: {} });
  });

  it("upsertReadingEntry creates then updates an entry", async () => {
    const slug = "alpha";

    const created = await upsertReadingEntry(ROOT, slug, {
      paperId: "papers/intro.pdf",
      status: "reading",
    });
    expect(created.status).toBe("reading");

    const updated = await upsertReadingEntry(ROOT, slug, {
      paperId: "papers/intro.pdf",
      status: "done",
      notes: "finished on train",
    });
    expect(updated.status).toBe("done");
    expect(updated.notes).toBe("finished on train");

    const store = await loadReadingProgress(ROOT, slug);
    expect(Object.keys(store.entries)).toEqual(["papers/intro.pdf"]);
    expect(store.entries["papers/intro.pdf"].status).toBe("done");
  });

  it("upsertReadingEntry sets updatedAt on each upsert", async () => {
    const slug = "beta";
    const before = Date.now();
    const entry = await upsertReadingEntry(ROOT, slug, {
      paperId: "paper.pdf",
      status: "unread",
    });
    const after = Date.now();

    const ts = Date.parse(entry.updatedAt);
    expect(Number.isFinite(ts)).toBe(true);
    // Allow a 1s fudge factor on either side to avoid flakes on slow CI.
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });

  it("deleteReadingEntry removes and returns true", async () => {
    const slug = "gamma";
    await upsertReadingEntry(ROOT, slug, {
      paperId: "paper.pdf",
      status: "reading",
    });

    const removed = await deleteReadingEntry(ROOT, slug, "paper.pdf");
    expect(removed).toBe(true);

    const store = await loadReadingProgress(ROOT, slug);
    expect(store.entries).toEqual({});
  });

  it("deleteReadingEntry on missing id returns false without throwing", async () => {
    const slug = "delta";
    await upsertReadingEntry(ROOT, slug, {
      paperId: "paper.pdf",
      status: "reading",
    });

    const removed = await deleteReadingEntry(ROOT, slug, "does-not-exist.pdf");
    expect(removed).toBe(false);

    const store = await loadReadingProgress(ROOT, slug);
    expect(Object.keys(store.entries)).toEqual(["paper.pdf"]);
  });

  it("invalid status throws", async () => {
    await expect(
      upsertReadingEntry(ROOT, "epsilon", {
        paperId: "paper.pdf",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: "skimmed" as any,
      }),
    ).rejects.toThrow(/Invalid status/);
  });

  it("empty paperId throws", async () => {
    await expect(
      upsertReadingEntry(ROOT, "zeta", {
        paperId: "",
        status: "reading",
      }),
    ).rejects.toThrow(/paperId/);

    await expect(
      upsertReadingEntry(ROOT, "zeta", {
        paperId: "   ",
        status: "reading",
      }),
    ).rejects.toThrow(/paperId/);
  });

  it("successful writes leave no .tmp sidecar behind", async () => {
    const slug = "eta";
    await upsertReadingEntry(ROOT, slug, {
      paperId: "paper.pdf",
      status: "reading",
    });

    const dir = path.join(ROOT, "projects", slug);
    expect(existsSync(path.join(dir, "reading-progress.json"))).toBe(true);

    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("multiple slugs don't stomp each other", async () => {
    await upsertReadingEntry(ROOT, "project-a", {
      paperId: "paper.pdf",
      status: "reading",
    });
    await upsertReadingEntry(ROOT, "project-b", {
      paperId: "paper.pdf",
      status: "done",
    });

    const storeA = await loadReadingProgress(ROOT, "project-a");
    const storeB = await loadReadingProgress(ROOT, "project-b");

    expect(storeA.entries["paper.pdf"].status).toBe("reading");
    expect(storeB.entries["paper.pdf"].status).toBe("done");

    // And deleting in one does not affect the other.
    await deleteReadingEntry(ROOT, "project-a", "paper.pdf");
    const storeAAfter = await loadReadingProgress(ROOT, "project-a");
    const storeBAfter = await loadReadingProgress(ROOT, "project-b");
    expect(storeAAfter.entries).toEqual({});
    expect(storeBAfter.entries["paper.pdf"].status).toBe("done");
  });

  it("notes round-trip through load", async () => {
    const slug = "theta";
    await upsertReadingEntry(ROOT, slug, {
      paperId: "paper.pdf",
      status: "done",
      notes: "Key result: theorem 3.2.",
    });

    const store = await loadReadingProgress(ROOT, slug);
    expect(store.entries["paper.pdf"].notes).toBe("Key result: theorem 3.2.");
  });

  it("upsertReadingEntry with no notes does not persist an undefined notes field", async () => {
    const slug = "iota";
    const entry = await upsertReadingEntry(ROOT, slug, {
      paperId: "paper.pdf",
      status: "reading",
    });
    expect("notes" in entry).toBe(false);
  });

  it("serializes concurrent upserts for the same project", async () => {
    const slug = "kappa";
    await Promise.all([
      upsertReadingEntry(ROOT, slug, {
        paperId: "paper-a.pdf",
        status: "reading",
      }),
      upsertReadingEntry(ROOT, slug, {
        paperId: "paper-b.pdf",
        status: "done",
      }),
    ]);

    const store = await loadReadingProgress(ROOT, slug);
    expect(Object.keys(store.entries).sort()).toEqual([
      "paper-a.pdf",
      "paper-b.pdf",
    ]);
    expect(store.entries["paper-a.pdf"].status).toBe("reading");
    expect(store.entries["paper-b.pdf"].status).toBe("done");
  });
});
