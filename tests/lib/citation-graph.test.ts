import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCitationGraph } from "@/lib/citation-graph";

// Each test gets a fresh papersRoot under an OS-temp folder. Using a unique
// folder per test file keeps parallel runs on CI from stomping on each other.
const ROOT = path.join(tmpdir(), "scienceswarm-citation-graph-test");

function seed(relPath: string, contents: string): void {
  const full = path.join(ROOT, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf-8");
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("buildCitationGraph", () => {
  it("creates an edge when one .md file \\cite{}s another by basename", async () => {
    seed(
      "paper-a.md",
      [
        "---",
        "title: Paper A",
        "---",
        "Intro body.",
        "\\cite{paper-b}",
      ].join("\n"),
    );
    seed(
      "paper-b.md",
      ["---", "title: Paper B", "---", "Body of B."].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    expect(graph.nodes.map((n) => n.id).sort()).toEqual([
      "paper-a",
      "paper-b",
    ]);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: "paper-a",
        target: "paper-b",
        refType: "bibkey",
      }),
    );
    expect(graph.externalRefs).toEqual({});
  });

  it("resolves a DOI reference to a node whose companion .md declares that DOI", async () => {
    seed(
      "cited.md",
      [
        "---",
        "title: Cited Paper",
        "doi: 10.1234/abc.def",
        "---",
        "Body.",
      ].join("\n"),
    );
    seed(
      "citer.md",
      [
        "---",
        "title: Citing Paper",
        "---",
        "See 10.1234/abc.def for details.",
      ].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    const edge = graph.edges.find((e) => e.source === "citer");
    expect(edge).toBeDefined();
    expect(edge!.target).toBe("cited");
    expect(edge!.refType).toBe("doi");
    expect(graph.externalRefs).toEqual({});
  });

  it("treats a DOI ref that doesn't match any node as an external ref", async () => {
    seed(
      "only-citer.md",
      [
        "---",
        "title: Only Citer",
        "---",
        "References 10.9999/unknown.ref in the body.",
      ].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    const edge = graph.edges.find((e) => e.source === "only-citer");
    expect(edge).toBeDefined();
    expect(edge!.target).toBe("external:10.9999/unknown.ref");
    expect(edge!.refType).toBe("doi");
    expect(graph.externalRefs["external:10.9999/unknown.ref"]).toEqual({
      refType: "doi",
      count: 1,
    });
  });

  it("resolves arXiv references and counts unknown ones as external", async () => {
    seed(
      "known.md",
      [
        "---",
        "title: Known Arxiv",
        'arxivId: "2401.12345"',
        "---",
      ].join("\n"),
    );
    seed(
      "discussion.md",
      [
        "---",
        "title: Discussion",
        "---",
        "See arxiv:2401.12345 for the method.",
        "Also see arxiv:2305.99999 which we don't have.",
      ].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    const resolved = graph.edges.find(
      (e) => e.refType === "arxiv" && e.target === "known",
    );
    const external = graph.edges.find(
      (e) => e.refType === "arxiv" && e.target === "external:2305.99999",
    );
    expect(resolved).toBeDefined();
    expect(external).toBeDefined();
    expect(graph.externalRefs["external:2305.99999"]).toEqual({
      refType: "arxiv",
      count: 1,
    });
  });

  it("resolves versioned arXiv references to an unversioned local node", async () => {
    seed(
      "known.md",
      [
        "---",
        "title: Known Arxiv",
        'arxivId: "2401.12345"',
        "---",
      ].join("\n"),
    );
    seed(
      "discussion.md",
      [
        "---",
        "title: Discussion",
        "---",
        "See arxiv:2401.12345v2 for the revised method.",
      ].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: "discussion",
        target: "known",
        refType: "arxiv",
        raw: "2401.12345",
      }),
    );
    expect(graph.externalRefs["external:2401.12345v2"]).toBeUndefined();
  });

  it("creates a node for a .pdf but extracts no edges from its content", async () => {
    // Raw PDF bytes (garbage) that happens to contain a DOI-shaped token.
    // We should NOT scan it: the only output is the node itself.
    seed(
      "opaque.pdf",
      "%PDF-1.4 this would match 10.1234/should.not.match if scanned",
    );

    const graph = await buildCitationGraph(ROOT);

    expect(graph.nodes.map((n) => n.id)).toEqual(["opaque"]);
    expect(graph.edges).toEqual([]);
    expect(graph.externalRefs).toEqual({});
  });

  it("attaches title and year from a companion .md frontmatter", async () => {
    seed(
      "paper-one.md",
      [
        "---",
        'title: "Paper One: A Study"',
        "year: 2021",
        "---",
        "Body.",
      ].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    const node = graph.nodes.find((n) => n.id === "paper-one");
    expect(node).toBeDefined();
    expect(node!.title).toBe("Paper One: A Study");
    expect(node!.year).toBe(2021);
  });

  it("collapses multiple files with the same basename into one node", async () => {
    seed("shared.pdf", "%PDF fake");
    seed("shared.bib", "@article{shared,title={S}}");
    seed(
      "shared.md",
      ["---", "title: Shared Paper", "year: 2020", "---", "Body."].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    const shared = graph.nodes.filter((n) => n.id === "shared");
    expect(shared).toHaveLength(1);
    // Metadata from the .md should make it through even though the .pdf was
    // seen first on disk in some walk orders.
    expect(shared[0].title).toBe("Shared Paper");
    expect(shared[0].year).toBe(2020);
  });

  it("picks up \\cite{} references embedded in a .bib or .tex file", async () => {
    seed(
      "target.md",
      ["---", "title: Target", "---", "Just the target."].join("\n"),
    );
    seed(
      "notes.tex",
      "\\documentclass{article}\\begin{document}\\cite{target}\\end{document}",
    );

    const graph = await buildCitationGraph(ROOT);

    const edge = graph.edges.find(
      (e) => e.source === "notes" && e.target === "target",
    );
    expect(edge).toBeDefined();
    expect(edge!.refType).toBe("bibkey");
  });

  it("dedupes repeated edges (same source, target, refType) into one", async () => {
    seed(
      "target.md",
      ["---", "title: Target", "---", "Body."].join("\n"),
    );
    seed(
      "source.md",
      [
        "---",
        "title: Source",
        "---",
        "First mention \\cite{target}.",
        "Second mention \\cite{target}.",
        "Grouped \\cite{target, target}.",
      ].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    const bibkeyEdges = graph.edges.filter(
      (e) =>
        e.source === "source" &&
        e.target === "target" &&
        e.refType === "bibkey",
    );
    expect(bibkeyEdges).toHaveLength(1);
  });

  it("returns an empty graph when the papersRoot does not exist", async () => {
    const missing = path.join(ROOT, "does", "not", "exist");
    const graph = await buildCitationGraph(missing);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.externalRefs).toEqual({});
    expect(typeof graph.scannedAt).toBe("string");
  });

  it("returns an empty graph when the papersRoot exists but is empty", async () => {
    // ROOT is already created fresh in beforeEach and contains nothing.
    const graph = await buildCitationGraph(ROOT);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.externalRefs).toEqual({});
  });

  it("counts each unique external DOI only once in externalRefs", async () => {
    seed(
      "mentions.md",
      [
        "---",
        "title: Mentions",
        "---",
        "First hit 10.1234/same.ref here.",
        "Second hit 10.1234/same.ref again.",
      ].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    expect(graph.externalRefs["external:10.1234/same.ref"]).toEqual({
      refType: "doi",
      count: 1,
    });
    // Edge should also be deduped (same source/target/refType).
    const edges = graph.edges.filter(
      (e) => e.target === "external:10.1234/same.ref",
    );
    expect(edges).toHaveLength(1);
  });

  it("keeps subdirectory basename collisions as distinct nodes", async () => {
    seed(
      "track-a/shared.md",
      ["---", "title: Shared A", "---", "Body."].join("\n"),
    );
    seed(
      "track-b/shared.md",
      ["---", "title: Shared B", "---", "Body."].join("\n"),
    );
    seed(
      "source.md",
      ["---", "title: Source", "---", "Uses \\cite{track-b/shared}."].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    expect(graph.nodes.map((node) => node.id).sort()).toEqual([
      "source",
      "track-a/shared",
      "track-b/shared",
    ]);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: "source",
        target: "track-b/shared",
        refType: "bibkey",
      }),
    );
  });

  it("does not create bibkey self-loops after case-insensitive resolution", async () => {
    seed(
      "source.md",
      [
        "---",
        "title: Source",
        "---",
        "References \\cite{SOURCE} as shorthand.",
      ].join("\n"),
    );

    const graph = await buildCitationGraph(ROOT);

    expect(
      graph.edges.some(
        (edge) => edge.source === "source" && edge.target === "source",
      ),
    ).toBe(false);
  });
});
