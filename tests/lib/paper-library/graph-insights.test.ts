import { describe, expect, it } from "vitest";

import { computeGraphInsights } from "@/lib/paper-library/graph-insights";
import type {
  PaperLibraryGraphEdge,
  PaperLibraryGraphNode,
} from "@/lib/paper-library/contracts";

// ── Fixtures ─────────────────────────────────────────

function node(
  id: string,
  partial: Partial<PaperLibraryGraphNode> = {},
): PaperLibraryGraphNode {
  return {
    id,
    kind: "external_paper",
    paperIds: [],
    title: id,
    authors: [],
    identifiers: {},
    local: false,
    suggestion: false,
    sources: [],
    evidence: [],
    ...partial,
  };
}

function edge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  kind: PaperLibraryGraphEdge["kind"],
): PaperLibraryGraphEdge {
  return {
    id,
    sourceNodeId,
    targetNodeId,
    kind,
    source: "semantic_scholar",
    evidence: [],
  };
}

// ── degree / direction counts ────────────────────────

describe("computeGraphInsights — direction-aware counts", () => {
  it("attributes prior count to the citing paper, not the cited one", () => {
    // Seed paper S references X. The graph emits a `references` edge
    // with sourceNodeId = S, targetNodeId = X (source-cites-target).
    const insights = computeGraphInsights({
      nodes: [node("seed"), node("X")],
      edges: [edge("e1", "seed", "X", "references")],
    });

    expect(insights.priorByNodeId.get("seed")).toBe(1);
    expect(insights.priorByNodeId.get("X")).toBe(0);
  });

  it("attributes derivative count to the cited paper for a `references` edge", () => {
    // The edge "X cites seed" arrives as a `references` edge with
    // sourceNodeId = X, targetNodeId = seed (source-cites-target).
    // Seed should be credited with 1 derivative citation.
    const insights = computeGraphInsights({
      nodes: [node("seed"), node("X")],
      edges: [edge("e1", "X", "seed", "references")],
    });

    expect(insights.derivativeByNodeId.get("seed")).toBe(1);
    expect(insights.derivativeByNodeId.get("X")).toBe(0);
  });

  it("attributes derivative count to the cited paper for a `cited_by` edge", () => {
    // Semantic Scholar's forward-citations adapter emits edges with
    // sourceNodeId = citing, targetNodeId = seed and kind `cited_by`.
    // The seed (target) should be credited as cited.
    const insights = computeGraphInsights({
      nodes: [node("seed"), node("citing")],
      edges: [edge("e1", "citing", "seed", "cited_by")],
    });

    expect(insights.derivativeByNodeId.get("seed")).toBe(1);
    expect(insights.derivativeByNodeId.get("citing")).toBe(0);
  });

  it("ignores `same_identity` and `bridge_suggestion` edges in cite counts", () => {
    const insights = computeGraphInsights({
      nodes: [node("a"), node("b")],
      edges: [
        edge("e1", "a", "b", "same_identity"),
        edge("e2", "a", "b", "bridge_suggestion"),
      ],
    });

    expect(insights.priorByNodeId.get("a")).toBe(0);
    expect(insights.derivativeByNodeId.get("b")).toBe(0);
    // Degree still counts the edge (it's a graph link).
    expect(insights.degreeByNodeId.get("a")).toBe(2);
    expect(insights.degreeByNodeId.get("b")).toBe(2);
  });

  it("computes degree as in + out", () => {
    const insights = computeGraphInsights({
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        edge("e1", "a", "b", "references"),
        edge("e2", "c", "a", "references"),
      ],
    });
    expect(insights.degreeByNodeId.get("a")).toBe(2);
    expect(insights.degreeByNodeId.get("b")).toBe(1);
    expect(insights.degreeByNodeId.get("c")).toBe(1);
  });

  it("counts unique citing/cited papers, not edges", () => {
    // Two adapters can both report the same A→B citation: one as a
    // `references` edge from A's bibliography, one as a `cited_by`
    // edge from B's incoming citations. The duplicate edges should
    // contribute one unique pair to each side, not two.
    const insights = computeGraphInsights({
      nodes: [node("A"), node("B")],
      edges: [
        edge("e1", "A", "B", "references"),
        edge("e2", "A", "B", "cited_by"),
      ],
    });
    expect(insights.priorByNodeId.get("A")).toBe(1);
    expect(insights.derivativeByNodeId.get("B")).toBe(1);
  });
});

// ── prior / derivative neighbour split ───────────────

describe("computeGraphInsights — neighbour splits", () => {
  it("splits a selected paper's neighbours into prior (out) and derivative (in)", () => {
    const insights = computeGraphInsights({
      nodes: [
        node("seed"),
        node("R1"),
        node("R2"),
        node("C1"),
        node("C2"),
      ],
      edges: [
        edge("e1", "seed", "R1", "references"),
        edge("e2", "seed", "R2", "references"),
        edge("e3", "C1", "seed", "cited_by"),
        edge("e4", "C2", "seed", "cited_by"),
      ],
      selectedNodeId: "seed",
    });

    expect(insights.priorNeighbors.map((n) => n.id).sort()).toEqual(["R1", "R2"]);
    expect(insights.derivativeNeighbors.map((n) => n.id).sort()).toEqual([
      "C1",
      "C2",
    ]);
  });

  it("dedupes when a neighbour appears in both directions (mutual citation)", () => {
    // X both cites and is cited by seed.
    const insights = computeGraphInsights({
      nodes: [node("seed"), node("X")],
      edges: [
        edge("e1", "seed", "X", "references"),
        edge("e2", "X", "seed", "cited_by"),
      ],
      selectedNodeId: "seed",
    });
    expect(insights.priorNeighbors.map((n) => n.id)).toEqual(["X"]);
    expect(insights.derivativeNeighbors.map((n) => n.id)).toEqual(["X"]);
    // Combined neighbour list should not duplicate X.
    expect(insights.neighborNodes.map((n) => n.id)).toEqual(["X"]);
  });

  it("respects the neighbor limit per direction", () => {
    const nodes = [
      node("seed"),
      ...Array.from({ length: 10 }, (_, i) => node(`R${i + 1}`)),
    ];
    const edges: PaperLibraryGraphEdge[] = nodes
      .filter((n) => n.id !== "seed")
      .map((n, i) => edge(`e${i + 1}`, "seed", n.id, "references"));

    const insights = computeGraphInsights({
      nodes,
      edges,
      selectedNodeId: "seed",
      neighborLimit: 3,
    });

    expect(insights.priorNeighbors).toHaveLength(3);
    expect(insights.neighborNodes).toHaveLength(3);
  });

  it("returns empty neighbour lists when no node is selected", () => {
    const insights = computeGraphInsights({
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b", "references")],
    });
    expect(insights.selectedNode).toBeNull();
    expect(insights.priorNeighbors).toEqual([]);
    expect(insights.derivativeNeighbors).toEqual([]);
    expect(insights.neighborNodes).toEqual([]);
  });

  it("returns empty neighbour lists when the selectedNodeId is unknown", () => {
    const insights = computeGraphInsights({
      nodes: [node("a")],
      edges: [],
      selectedNodeId: "does-not-exist",
    });
    expect(insights.selectedNode).toBeNull();
    expect(insights.priorNeighbors).toEqual([]);
    expect(insights.derivativeNeighbors).toEqual([]);
  });

  it("orders the combined neighbour list with derivative (forward) first", () => {
    // Forward citations are usually the more actionable view ("who built
    // on this work?") so the merged fallback list should surface them
    // ahead of backward references.
    const insights = computeGraphInsights({
      nodes: [node("seed"), node("R1"), node("C1")],
      edges: [
        edge("e1", "seed", "R1", "references"),
        edge("e2", "C1", "seed", "cited_by"),
      ],
      selectedNodeId: "seed",
    });
    expect(insights.neighborNodes.map((n) => n.id)).toEqual(["C1", "R1"]);
  });

  it("falls back to all-kinds neighbours when prior+derivative are both empty", () => {
    // A node connected only via `same_identity` or `bridge_suggestion`
    // edges has no prior/derivative neighbours. The "Related papers"
    // fallback in the UI relies on `neighborNodes` containing those
    // edges' counterparties so it has something to render.
    const insights = computeGraphInsights({
      nodes: [
        node("seed", { local: true }),
        node("siblingId"),
        node("bridge"),
      ],
      edges: [
        edge("e1", "seed", "siblingId", "same_identity"),
        edge("e2", "seed", "bridge", "bridge_suggestion"),
      ],
      selectedNodeId: "seed",
    });
    expect(insights.priorNeighbors).toEqual([]);
    expect(insights.derivativeNeighbors).toEqual([]);
    expect(insights.neighborNodes.map((n) => n.id).sort()).toEqual([
      "bridge",
      "siblingId",
    ]);
  });
});

// ── sortedNodes / aggregate counts ───────────────────

describe("computeGraphInsights — sorting and aggregates", () => {
  it("sorts locals before externals, then by degree desc, then title", () => {
    const insights = computeGraphInsights({
      nodes: [
        node("ext-z", { title: "Zebra", local: false }),
        node("ext-a", { title: "Apple", local: false }),
        node("local-b", { title: "Banana", local: true }),
      ],
      edges: [edge("e1", "ext-z", "ext-a", "references")],
    });
    const titles = insights.sortedNodes.map((n) => n.title);
    expect(titles[0]).toBe("Banana"); // local first
    // Among externals, ext-z and ext-a both have degree 1; tie-break
    // by title ascending puts Apple before Zebra.
    expect(titles.slice(1)).toEqual(["Apple", "Zebra"]);
  });

  it("counts externalCount / localCount / suggestionCount", () => {
    const insights = computeGraphInsights({
      nodes: [
        node("local-1", { local: true }),
        node("local-2", { local: true }),
        node("ext-1", { local: false }),
        node("bridge-1", { kind: "bridge_suggestion", suggestion: true }),
      ],
      edges: [],
    });
    expect(insights.localCount).toBe(2);
    expect(insights.externalCount).toBe(1);
    expect(insights.suggestionCount).toBe(1);
  });

  it("returns selectedEdges containing only edges incident to the selection", () => {
    const insights = computeGraphInsights({
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [
        edge("e1", "a", "b", "references"),
        edge("e2", "b", "c", "references"),
        edge("e3", "c", "d", "references"),
      ],
      selectedNodeId: "b",
    });
    expect(insights.selectedEdges.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  });
});
