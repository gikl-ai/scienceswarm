/**
 * Pure derivations for the Paper Library citation-graph UI.
 *
 * The command center's right-hand panel summarises a selected paper's
 * neighbourhood in the citation graph. The graph itself is built by
 * `graph.ts` and emits two directed edge kinds:
 *
 *   - `references`  source = citing paper, target = cited paper
 *                   ("source cites target")
 *   - `cited_by`    source = citing paper, target = cited paper
 *                   ("source cites target") — the same orientation, but
 *                   emitted in response to *forward* citations data
 *                   from Semantic Scholar (papers that cite the seed)
 *
 * Both edge kinds therefore share the source-cites-target convention.
 * The asymmetry is which side of the edge we treat as "ours" relative
 * to the selected paper:
 *
 *   - **Prior references** of node N: edges where N is the source
 *     ("N cites X"). These are backward references — work N built on.
 *   - **Derivative citations** of node N: edges where N is the target
 *     ("Y cites N"). These are forward citations — papers that cite N
 *     as the field moves forward.
 *
 * This module exposes a single pure function so it can be unit-tested
 * without spinning up the React tree, and so the command-center memo
 * stays a thin wrapper.
 */

import type {
  PaperLibraryGraphEdge,
  PaperLibraryGraphNode,
} from "./contracts";

export interface GraphInsights {
  /** Total degree (in + out) per node id. */
  degreeByNodeId: Map<string, number>;
  /** Count of papers each node id cites (outgoing references). */
  priorByNodeId: Map<string, number>;
  /** Count of papers that cite each node id (incoming citations). */
  derivativeByNodeId: Map<string, number>;
  /** Nodes sorted: locals first, then by descending degree, then title. */
  sortedNodes: PaperLibraryGraphNode[];
  /** The currently-selected node, or null if no selection / not present. */
  selectedNode: PaperLibraryGraphNode | null;
  /** Edges incident to the selected node. */
  selectedEdges: PaperLibraryGraphEdge[];
  /** Up to `neighborLimit` papers the selected node references (backward). */
  priorNeighbors: PaperLibraryGraphNode[];
  /** Up to `neighborLimit` papers that cite the selected node (forward). */
  derivativeNeighbors: PaperLibraryGraphNode[];
  /**
   * Combined neighbour list (prior ∪ derivative) preserving the original
   * `neighborNodes` shape for callers that don't yet split by direction.
   */
  neighborNodes: PaperLibraryGraphNode[];
  /** Aggregate counts used by overview chrome. */
  externalCount: number;
  localCount: number;
  suggestionCount: number;
}

export interface ComputeGraphInsightsInput {
  nodes: PaperLibraryGraphNode[];
  edges: PaperLibraryGraphEdge[];
  selectedNodeId?: string | null;
  /** Cap on how many neighbours each direction returns (default 6). */
  neighborLimit?: number;
}

const DEFAULT_NEIGHBOR_LIMIT = 6;

/**
 * Compute citation-graph insights for the command-center panel.
 *
 * Pure: the same input always produces structurally-equal output and the
 * function never reads from outside its arguments.
 */
export function computeGraphInsights(
  input: ComputeGraphInsightsInput,
): GraphInsights {
  const { nodes, edges } = input;
  const neighborLimit = input.neighborLimit ?? DEFAULT_NEIGHBOR_LIMIT;

  const degreeByNodeId = new Map<string, number>();
  const priorByNodeId = new Map<string, number>();
  const derivativeByNodeId = new Map<string, number>();
  for (const node of nodes) {
    degreeByNodeId.set(node.id, 0);
    priorByNodeId.set(node.id, 0);
    derivativeByNodeId.set(node.id, 0);
  }

  for (const edge of edges) {
    degreeByNodeId.set(
      edge.sourceNodeId,
      (degreeByNodeId.get(edge.sourceNodeId) ?? 0) + 1,
    );
    degreeByNodeId.set(
      edge.targetNodeId,
      (degreeByNodeId.get(edge.targetNodeId) ?? 0) + 1,
    );
    if (edge.kind === "references" || edge.kind === "cited_by") {
      // Both kinds share the source-cites-target orientation. The edge
      // contributes to the citing paper's prior count (it cites someone)
      // and to the cited paper's derivative count (it is cited by
      // someone) — independent of which adapter happened to emit it.
      priorByNodeId.set(
        edge.sourceNodeId,
        (priorByNodeId.get(edge.sourceNodeId) ?? 0) + 1,
      );
      derivativeByNodeId.set(
        edge.targetNodeId,
        (derivativeByNodeId.get(edge.targetNodeId) ?? 0) + 1,
      );
    }
  }

  const sortedNodes = [...nodes].sort((left, right) => {
    if (left.local !== right.local) return left.local ? -1 : 1;
    const degreeDelta =
      (degreeByNodeId.get(right.id) ?? 0) -
      (degreeByNodeId.get(left.id) ?? 0);
    if (degreeDelta !== 0) return degreeDelta;
    return graphNodeSortTitle(left).localeCompare(graphNodeSortTitle(right));
  });

  const selectedNode = input.selectedNodeId
    ? (nodes.find((node) => node.id === input.selectedNodeId) ?? null)
    : null;

  const selectedEdges = selectedNode
    ? edges.filter(
        (edge) =>
          edge.sourceNodeId === selectedNode.id ||
          edge.targetNodeId === selectedNode.id,
      )
    : [];

  const priorNeighbors = selectedNode
    ? collectNeighbors(
        selectedEdges.filter(
          (edge) =>
            (edge.kind === "references" || edge.kind === "cited_by") &&
            edge.sourceNodeId === selectedNode.id,
        ),
        sortedNodes,
        (edge) => edge.targetNodeId,
        neighborLimit,
      )
    : [];

  const derivativeNeighbors = selectedNode
    ? collectNeighbors(
        selectedEdges.filter(
          (edge) =>
            (edge.kind === "references" || edge.kind === "cited_by") &&
            edge.targetNodeId === selectedNode.id,
        ),
        sortedNodes,
        (edge) => edge.sourceNodeId,
        neighborLimit,
      )
    : [];

  const neighborNodes = mergeUniquePreservingOrder(
    derivativeNeighbors,
    priorNeighbors,
    neighborLimit,
  );

  return {
    degreeByNodeId,
    derivativeByNodeId,
    derivativeNeighbors,
    externalCount: nodes.filter(
      (node) =>
        !node.local && !node.suggestion && node.kind !== "bridge_suggestion",
    ).length,
    localCount: nodes.filter((node) => node.local).length,
    neighborNodes,
    priorByNodeId,
    priorNeighbors,
    selectedEdges,
    selectedNode,
    sortedNodes,
    suggestionCount: nodes.filter(
      (node) => node.suggestion || node.kind === "bridge_suggestion",
    ).length,
  };
}

function graphNodeSortTitle(node: PaperLibraryGraphNode): string {
  if (node.title) return node.title;
  if (node.identifiers?.doi) return node.identifiers.doi;
  if (node.identifiers?.arxivId) return node.identifiers.arxivId;
  if (node.paperIds[0]) return node.paperIds[0];
  return node.id;
}

function collectNeighbors(
  edges: PaperLibraryGraphEdge[],
  sortedNodes: PaperLibraryGraphNode[],
  pickNeighborId: (edge: PaperLibraryGraphEdge) => string,
  limit: number,
): PaperLibraryGraphNode[] {
  const neighborIds = new Set(edges.map(pickNeighborId));
  return sortedNodes
    .filter((node) => neighborIds.has(node.id))
    .slice(0, limit);
}

function mergeUniquePreservingOrder(
  primary: PaperLibraryGraphNode[],
  secondary: PaperLibraryGraphNode[],
  limit: number,
): PaperLibraryGraphNode[] {
  const seen = new Set<string>();
  const merged: PaperLibraryGraphNode[] = [];
  for (const node of [...primary, ...secondary]) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    merged.push(node);
    if (merged.length >= limit) break;
  }
  return merged;
}
