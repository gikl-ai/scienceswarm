"use client";

import { useCallback, useMemo, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────

export interface CitationGraphNode {
  id: string;
  title: string;
  type: "paper" | "concept" | "person" | "project";
  citationCount?: number;
  isInBrain: boolean;
}

export interface CitationGraphEdge {
  source: string;
  target: string;
  type: "cites" | "cited-by" | "references" | "related" | "authored";
}

export interface CitationGraphData {
  nodes: CitationGraphNode[];
  edges: CitationGraphEdge[];
  rootNode: string;
}

interface SimNode extends CitationGraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// ── Constants ────────────────────────────────────────

const NODE_COLORS: Record<CitationGraphNode["type"], string> = {
  paper: "#3b82f6",    // blue
  concept: "#22c55e",  // green
  person: "#f97316",   // orange
  project: "#a855f7",  // purple
};

const NODE_RADIUS = 8;
const LABEL_OFFSET = 12;
const WIDTH = 800;
const HEIGHT = 600;

// ── Force simulation ─────────────────────────────────

function initSimNodes(nodes: CitationGraphNode[], rootNode: string): SimNode[] {
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  return nodes.map((n, i) => {
    const isRoot = n.id === rootNode;
    const angle = (2 * Math.PI * i) / nodes.length;
    const radius = isRoot ? 0 : 150 + Math.random() * 100;
    return {
      ...n,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });
}

function simulateForces(
  nodes: SimNode[],
  edges: CitationGraphEdge[],
  iterations: number,
): SimNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;

  for (let iter = 0; iter < iterations; iter++) {
    const alpha = 1 - iter / iterations;
    const strength = alpha * 0.3;

    // Repulsion between all nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (300 * strength) / (dist * dist);
        dx = (dx / dist) * force;
        dy = (dy / dist) * force;
        a.vx -= dx;
        a.vy -= dy;
        b.vx += dx;
        b.vy += dy;
      }
    }

    // Attraction along edges
    for (const edge of edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - 100) * 0.01 * strength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }

    // Center gravity
    for (const node of nodes) {
      node.vx += (cx - node.x) * 0.005 * strength;
      node.vy += (cy - node.y) * 0.005 * strength;
    }

    // Apply velocities with damping
    for (const node of nodes) {
      node.vx *= 0.8;
      node.vy *= 0.8;
      node.x += node.vx;
      node.y += node.vy;
      // Constrain to viewport
      node.x = Math.max(NODE_RADIUS + 4, Math.min(WIDTH - NODE_RADIUS - 4, node.x));
      node.y = Math.max(NODE_RADIUS + 4, Math.min(HEIGHT - NODE_RADIUS - 4, node.y));
    }
  }

  return nodes;
}

// ── Component ────────────────────────────────────────

export function CitationGraph({
  data,
  onNavigate,
}: {
  data: CitationGraphData;
  onNavigate?: (nodeId: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const simNodes = useMemo(() => {
    if (data.nodes.length === 0) return [];
    const initial = initSimNodes(data.nodes, data.rootNode);
    return simulateForces(initial, data.edges, 150);
  }, [data]);

  const nodeMap = useMemo(
    () => new Map(simNodes.map((n) => [n.id, n])),
    [simNodes],
  );

  const handleClick = useCallback(
    (nodeId: string) => {
      const node = nodeMap.get(nodeId);
      if (node?.isInBrain && onNavigate) {
        onNavigate(nodeId);
      }
    },
    [nodeMap, onNavigate],
  );

  const filteredNodes = selectedType
    ? simNodes.filter((n) => n.type === selectedType)
    : simNodes;
  const filteredIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = selectedType
    ? data.edges.filter(
        (e) => filteredIds.has(e.source) || filteredIds.has(e.target),
      )
    : data.edges;

  if (data.nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-400 text-sm">
        No citation data available. Import papers to see the graph.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Legend + filter */}
      <div className="flex items-center gap-4 px-2 text-xs">
        <button
          onClick={() => setSelectedType(null)}
          className={`px-2 py-1 rounded transition-colors ${
            !selectedType
              ? "bg-zinc-200 text-zinc-800 font-medium"
              : "text-zinc-500 hover:text-zinc-700"
          }`}
        >
          All ({data.nodes.length})
        </button>
        {(["paper", "concept", "person", "project"] as const).map((type) => {
          const count = data.nodes.filter((n) => n.type === type).length;
          if (count === 0) return null;
          return (
            <button
              key={type}
              onClick={() =>
                setSelectedType(selectedType === type ? null : type)
              }
              className={`flex items-center gap-1.5 px-2 py-1 rounded transition-colors ${
                selectedType === type
                  ? "bg-zinc-200 text-zinc-800 font-medium"
                  : "text-zinc-500 hover:text-zinc-700"
              }`}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: NODE_COLORS[type] }}
              />
              {type} ({count})
            </button>
          );
        })}
        <span className="ml-auto text-zinc-400">
          {data.nodes.filter((n) => !n.isInBrain).length} ghost nodes
        </span>
      </div>

      {/* SVG Graph */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full border-2 border-border rounded-lg bg-surface"
        style={{ maxHeight: "600px" }}
      >
        {/* Edges */}
        {filteredEdges.map((edge, i) => {
          const source = nodeMap.get(edge.source);
          const target = nodeMap.get(edge.target);
          if (!source || !target) return null;
          const isHighlighted =
            hoveredNode === edge.source || hoveredNode === edge.target;
          return (
            <line
              key={`edge-${i}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={isHighlighted ? "#6366f1" : "#d4d4d8"}
              strokeWidth={isHighlighted ? 2 : 1}
              strokeOpacity={isHighlighted ? 0.8 : 0.4}
              strokeDasharray={
                edge.type === "references" ? "4,4" : undefined
              }
            />
          );
        })}

        {/* Nodes */}
        {filteredNodes.map((node) => {
          const isRoot = node.id === data.rootNode;
          const isHovered = hoveredNode === node.id;
          const r = isRoot ? NODE_RADIUS + 3 : NODE_RADIUS;

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
              onClick={() => handleClick(node.id)}
              style={{ cursor: node.isInBrain ? "pointer" : "default" }}
            >
              <circle
                r={r}
                fill={
                  node.isInBrain
                    ? NODE_COLORS[node.type]
                    : "transparent"
                }
                stroke={NODE_COLORS[node.type]}
                strokeWidth={isRoot ? 3 : node.isInBrain ? 2 : 2}
                strokeDasharray={node.isInBrain ? undefined : "3,3"}
                opacity={isHovered ? 1 : 0.85}
              />

              {/* Label */}
              {(isHovered || isRoot) && (
                <text
                  y={-LABEL_OFFSET}
                  textAnchor="middle"
                  className="text-[10px] fill-zinc-700 select-none pointer-events-none"
                  fontWeight={isRoot ? "bold" : "normal"}
                >
                  {node.title.length > 30
                    ? node.title.slice(0, 27) + "..."
                    : node.title}
                </text>
              )}

              {/* Citation count badge */}
              {isHovered && node.citationCount != null && (
                <text
                  y={LABEL_OFFSET + 10}
                  textAnchor="middle"
                  className="text-[9px] fill-zinc-400 select-none pointer-events-none"
                >
                  {node.citationCount} link{node.citationCount === 1 ? "" : "s"}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
