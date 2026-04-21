import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GbrainEngineAdapter } from "@/brain/stores/gbrain-engine-adapter";
import type { BrainStore } from "@/brain/store";

let adapter: BrainStore;
let originalUserHandle: string | undefined;

beforeEach(async () => {
  // importCorpus enforces the attribution contract via
  // getCurrentUserHandle(); set a stable handle for the duration of
  // each test so the bulk-import path can stamp `captured_by`.
  originalUserHandle = process.env.SCIENCESWARM_USER_HANDLE;
  process.env.SCIENCESWARM_USER_HANDLE = "@test-adapter";
  adapter = new GbrainEngineAdapter();
  await (adapter as GbrainEngineAdapter).initialize({ engine: "pglite" });
});

afterEach(async () => {
  await adapter.dispose();
  if (originalUserHandle === undefined) {
    delete process.env.SCIENCESWARM_USER_HANDLE;
  } else {
    process.env.SCIENCESWARM_USER_HANDLE = originalUserHandle;
  }
});

describe("GbrainEngineAdapter", () => {
  it("satisfies the BrainStore interface", () => {
    expect(typeof adapter.search).toBe("function");
    expect(typeof adapter.getPage).toBe("function");
    expect(typeof adapter.getTimeline).toBe("function");
    expect(typeof adapter.getLinks).toBe("function");
    expect(typeof adapter.getBacklinks).toBe("function");
    expect(typeof adapter.importCorpus).toBe("function");
    expect(typeof adapter.health).toBe("function");
    expect(typeof adapter.dispose).toBe("function");
  });

  it("reports healthy after initialization", async () => {
    const status = await adapter.health();
    expect(status.ok).toBe(true);
    expect(status.pageCount).toBe(0);
    expect(status.brainScore).toBe(0);
    expect(status.chunkCount).toBe(0);
    expect(status.linkCount).toBe(0);
    expect(status.timelineEntryCount).toBe(0);
    expect(status.syncRepoPath).toBeNull();
  });

  it("returns null for non-existent pages", async () => {
    const page = await adapter.getPage("does-not-exist");
    expect(page).toBeNull();
  });

  it("stores and retrieves a page via the engine", async () => {
    const engine = (adapter as GbrainEngineAdapter).engine;
    await engine.putPage("test-page", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-repo type cast
      type: "concept" as any,
      title: "Test Page",
      compiled_truth: "This is test content about sparse autoencoders.",
      timeline: "",
      frontmatter: { tags: ["testing"] },
    });

    const page = await adapter.getPage("test-page");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Test Page");
    expect(page!.content).toContain("sparse autoencoders");
    expect(page!.path).toBe("test-page.md");
  });

  it("returns timeline entries and typed links with counterpart titles", async () => {
    const engine = (adapter as GbrainEngineAdapter).engine;
    await engine.putPage("concepts/rlhf-alignment", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-repo type cast
      type: "concept" as any,
      title: "RLHF alignment",
      compiled_truth: "RLHF is contested.",
      timeline: "",
    });
    await engine.putPage("papers/deceptive-rlhf", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-repo type cast
      type: "paper" as any,
      title: "Deceptive RLHF",
      compiled_truth: "Reward-model optimization can induce deception.",
      timeline: "",
    });
    await engine.addTimelineEntry("concepts/rlhf-alignment", {
      date: "2026-04-18",
      source: "papers/deceptive-rlhf",
      summary: "Compiled truth updated",
      detail: "Contradiction surfaced.",
    });
    await engine.addLink(
      "concepts/rlhf-alignment",
      "papers/deceptive-rlhf",
      "claim-level evidence",
      "contradicts",
    );

    await expect(adapter.getTimeline("concepts/rlhf-alignment.md")).resolves.toEqual([
      expect.objectContaining({
        date: "2026-04-18",
        source: "papers/deceptive-rlhf",
        summary: "Compiled truth updated",
      }),
    ]);
    await expect(adapter.getLinks("concepts/rlhf-alignment.md")).resolves.toEqual([
      expect.objectContaining({
        slug: "papers/deceptive-rlhf.md",
        kind: "contradicts",
        title: "Deceptive RLHF",
      }),
    ]);
    await expect(adapter.getBacklinks("papers/deceptive-rlhf.md")).resolves.toEqual([
      expect.objectContaining({
        slug: "concepts/rlhf-alignment.md",
        kind: "contradicts",
        title: "RLHF alignment",
      }),
    ]);
  });

  it("searches by keyword and returns ScienceSwarm-shaped results", async () => {
    const engine = (adapter as GbrainEngineAdapter).engine;
    await engine.putPage("sae-paper", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cross-repo type cast
      type: "concept" as any,
      title: "Sparse Autoencoders",
      compiled_truth:
        "Sparse autoencoders learn monosemantic features from neural networks.",
      timeline: "",
    });
    await engine.upsertChunks("sae-paper", [
      {
        chunk_index: 0,
        chunk_text:
          "Sparse autoencoders learn monosemantic features from neural networks.",
        chunk_source: "compiled_truth",
      },
    ]);

    const results = await adapter.search({ query: "sparse autoencoders" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("sae-paper.md");
    expect(results[0].title).toBe("Sparse Autoencoders");
    expect(results[0].snippet).toContain("monosemantic");
    expect(typeof results[0].relevance).toBe("number");
    expect(results[0].relevance).toBeGreaterThan(0);
    expect(results[0].relevance).toBeLessThanOrEqual(1);
    expect(results[0].chunkId).toEqual(expect.any(Number));
    expect(results[0].chunkIndex).toBe(0);
  });

  it("forwards gbrain detail options to keyword search", async () => {
    const engine = (adapter as GbrainEngineAdapter).engine;
    const searchKeyword = vi.spyOn(engine, "searchKeyword");

    await adapter.search({
      query: "sparse autoencoders",
      limit: 7,
      detail: "high",
    });

    expect(searchKeyword).toHaveBeenCalledWith("sparse autoencoders", {
      limit: 7,
      detail: "high",
    });
  });

  it("returns empty results for unmatched queries", async () => {
    const results = await adapter.search({ query: "quantum gravity" });
    expect(results).toEqual([]);
  });

  it("imports a markdown corpus using wiki paths", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "scienceswarm-gbrain-import-"));
    mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
    writeFileSync(
      path.join(root, "wiki", "concepts", "sparse-autoencoders.md"),
      [
        "---",
        'title: "Sparse Autoencoders"',
        "type: concept",
        "tags: [mechanistic-interpretability]",
        "---",
        "",
        "# Sparse Autoencoders",
        "",
        "TopK activation improves sparse feature recovery in practice.",
        "",
      ].join("\n"),
      "utf-8",
    );

    try {
      const result = await adapter.importCorpus(root);
      expect(result.imported).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);

      const page = await adapter.getPage("wiki/concepts/sparse-autoencoders.md");
      expect(page?.path).toBe("wiki/concepts/sparse-autoencoders.md");
      expect(page?.title).toBe("Sparse Autoencoders");
      // Attribution contract: importCorpus must stamp `captured_by`
      // from getCurrentUserHandle() into the page frontmatter so the
      // bulk-imported pages are not silently unattributed.
      expect(page?.frontmatter?.captured_by).toBe("@test-adapter");

      const results = await adapter.search({ query: "TopK sparse feature recovery" });
      expect(results.some((entry) => entry.path === "wiki/concepts/sparse-autoencoders.md")).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when SCIENCESWARM_USER_HANDLE is unset during importCorpus", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "scienceswarm-gbrain-import-"));
    mkdirSync(path.join(root, "wiki"), { recursive: true });
    writeFileSync(
      path.join(root, "wiki", "note.md"),
      ["---", 'title: "Note"', "type: note", "---", "", "body"].join("\n"),
      "utf-8",
    );

    delete process.env.SCIENCESWARM_USER_HANDLE;

    try {
      await expect(adapter.importCorpus(root)).rejects.toThrow(
        /SCIENCESWARM_USER_HANDLE/,
      );
    } finally {
      process.env.SCIENCESWARM_USER_HANDLE = "@test-adapter";
      rmSync(root, { recursive: true, force: true });
    }
  });
});
