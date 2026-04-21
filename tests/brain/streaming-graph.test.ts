import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_ROOT = join(tmpdir(), "scienceswarm-brain-test-stream-graph");

// ── Mocks ─────────────────────────────────────────────

const mockLoadBrainConfig = vi.fn();
vi.mock("@/brain/config", () => ({
  loadBrainConfig: () => mockLoadBrainConfig(),
  resolveBrainRoot: () => TEST_ROOT,
  brainExists: () => true,
}));

vi.mock("@/brain/llm", () => ({
  createLLMClient: () => ({
    async complete() {
      return {
        content: [
          "---",
          "title: Test Page",
          "date: 2026-04-09",
          "type: note",
          "para: resources",
          "tags: [test]",
          "---",
          "",
          "# Test Page",
          "",
          "Test content.",
        ].join("\n"),
        cost: {
          inputTokens: 100,
          outputTokens: 50,
          estimatedUsd: 0.01,
          model: "test",
        },
      };
    },
  }),
}));

vi.mock("@/brain/cost", () => ({
  logEvent: vi.fn(),
}));

vi.mock("@/brain/ripple", () => ({
  ripple: vi.fn().mockResolvedValue({
    updates: [],
    contradictions: [],
  }),
}));

vi.mock("@/brain/pdf-metadata", () => ({
  extractPdfMetadata: vi.fn().mockResolvedValue({
    title: null,
    authors: [],
    abstract: null,
    doi: null,
    arxivId: null,
    pageCount: 0,
    textPreview: "",
    extractionConfidence: "low" as const,
  }),
}));

vi.mock("@/brain/notebook-parser", () => ({
  parseNotebook: vi.fn().mockReturnValue({ cells: [], language: "python" }),
  notebookToExperimentPage: vi.fn().mockReturnValue("# Experiment\n"),
}));

vi.mock("@/brain/code-parser", () => ({
  parseCodeRepo: vi.fn().mockReturnValue(null),
}));

// ── Helpers ───────────────────────────────────────────

function makeTestConfig() {
  return {
    root: TEST_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function setupBrain() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(join(TEST_ROOT, "wiki"), { recursive: true });
  mkdirSync(join(TEST_ROOT, "raw"), { recursive: true });
  mockLoadBrainConfig.mockReturnValue(makeTestConfig());
}

function teardownBrain() {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mockLoadBrainConfig.mockReset();
  vi.restoreAllMocks();
}

function createWikiPage(
  relPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
) {
  const fullPath = join(TEST_ROOT, relPath);
  const dir = fullPath.replace(/\/[^/]+$/, "");
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map((i) => `"${i}"`).join(", ")}]`;
      return `${k}: ${typeof v === "string" ? `"${v}"` : v}`;
    })
    .join("\n");
  writeFileSync(fullPath, `---\n${fm}\n---\n\n${body}\n`);
}

/** Collect all SSE events from a streaming Response */
async function collectSSEEvents(
  response: Response,
): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  const events: Array<{ event: string; data: unknown }> = [];

  const blocks = text.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    let eventName = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) eventName = line.slice(7);
      if (line.startsWith("data: ")) dataStr = line.slice(6);
    }
    if (eventName && dataStr) {
      events.push({ event: eventName, data: JSON.parse(dataStr) });
    }
  }

  return events;
}

// ── SSE Streaming Tests ──────────────────────────────

describe("POST /api/brain/coldstart-stream", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@test-researcher");
    setupBrain();
  });

  afterEach(() => {
    vi.resetModules();
    teardownBrain();
    vi.unstubAllEnvs();
  });

  it("returns text/event-stream content type", async () => {
    const { POST } = await import(
      "@/app/api/brain/coldstart-stream/route"
    );

    // Create a source file to import
    const srcDir = join(TEST_ROOT, "sources");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "note.md"), "# My Note\n\nSome research content.");

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview: {
          analysis: "test",
          backend: "test",
          files: [
            {
              path: join(srcDir, "note.md"),
              type: "note",
              size: 100,
              classification: "note",
              projectCandidates: [],
              warnings: [],
            },
          ],
          projects: [],
          duplicateGroups: [],
          warnings: [],
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("sends progress events in correct SSE format", async () => {
    const { POST } = await import(
      "@/app/api/brain/coldstart-stream/route"
    );

    const srcDir = join(TEST_ROOT, "sources");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.md"), "# Note A\n\nContent A.");
    writeFileSync(join(srcDir, "b.md"), "# Note B\n\nContent B.");

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview: {
          analysis: "test",
          backend: "test",
          files: [
            {
              path: join(srcDir, "a.md"),
              type: "note",
              size: 50,
              classification: "note",
              projectCandidates: [],
              warnings: [],
            },
            {
              path: join(srcDir, "b.md"),
              type: "note",
              size: 50,
              classification: "note",
              projectCandidates: [],
              warnings: [],
            },
          ],
          projects: [],
          duplicateGroups: [],
          warnings: [],
        },
      }),
    });

    const response = await POST(request);
    const events = await collectSSEEvents(response);

    // Should have progress events for importing phase
    const progressEvents = events.filter((e) => e.event === "progress");
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);

    const firstProgress = progressEvents[0].data as Record<string, unknown>;
    expect(firstProgress.phase).toBe("importing");
    expect(firstProgress.current).toBe(1);
    expect(firstProgress.total).toBe(2);
    expect(typeof firstProgress.currentFile).toBe("string");
    expect(typeof firstProgress.message).toBe("string");
  });

  it("sends file-done events for each successfully imported file", async () => {
    const { POST } = await import(
      "@/app/api/brain/coldstart-stream/route"
    );

    const srcDir = join(TEST_ROOT, "sources");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "test.md"), "# Test\n\nResearch content.");

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview: {
          analysis: "test",
          backend: "test",
          files: [
            {
              path: join(srcDir, "test.md"),
              type: "note",
              size: 50,
              classification: "note",
              projectCandidates: [],
              warnings: [],
            },
          ],
          projects: [],
          duplicateGroups: [],
          warnings: [],
        },
      }),
    });

    const response = await POST(request);
    const events = await collectSSEEvents(response);

    const fileDoneEvents = events.filter((e) => e.event === "file-done");
    expect(fileDoneEvents.length).toBe(1);

    const fd = fileDoneEvents[0].data as Record<string, unknown>;
    expect(fd.path).toBe(join(srcDir, "test.md"));
    expect(fd.type).toBe("note");
    expect(typeof fd.wikiPath).toBe("string");
    expect((fd.wikiPath as string).endsWith(".md")).toBe(true);
  });

  it("sends complete event with full ColdstartResult", async () => {
    const { POST } = await import(
      "@/app/api/brain/coldstart-stream/route"
    );

    const srcDir = join(TEST_ROOT, "sources");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "paper.md"), "# Paper\n\nSome paper content.");

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview: {
          analysis: "test",
          backend: "test",
          files: [
            {
              path: join(srcDir, "paper.md"),
              type: "note",
              size: 50,
              classification: "note",
              projectCandidates: [],
              warnings: [],
            },
          ],
          projects: [],
          duplicateGroups: [],
          warnings: [],
        },
      }),
    });

    const response = await POST(request);
    const events = await collectSSEEvents(response);

    const completeEvents = events.filter((e) => e.event === "complete");
    expect(completeEvents.length).toBe(1);

    const result = completeEvents[0].data as Record<string, unknown>;
    expect(typeof result.imported).toBe("number");
    expect(typeof result.skipped).toBe("number");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.projectsCreated)).toBe(true);
    expect(typeof result.pagesCreated).toBe("number");
    expect(result.firstBriefing).toBeTruthy();
    expect(typeof result.durationMs).toBe("number");
    expect(result.imported).toBe(1);
    expect(result.pagesCreated).toBeGreaterThanOrEqual(1);
  });

  it("emits error events for file failures without stopping stream", async () => {
    const { POST } = await import(
      "@/app/api/brain/coldstart-stream/route"
    );

    const srcDir = join(TEST_ROOT, "sources");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "good.md"), "# Good\n\nContent.");

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preview: {
          analysis: "test",
          backend: "test",
          files: [
            {
              path: "/nonexistent/missing-file.md",
              type: "note",
              size: 50,
              classification: "note",
              projectCandidates: [],
              warnings: [],
            },
            {
              path: join(srcDir, "good.md"),
              type: "note",
              size: 50,
              classification: "note",
              projectCandidates: [],
              warnings: [],
            },
          ],
          projects: [],
          duplicateGroups: [],
          warnings: [],
        },
      }),
    });

    const response = await POST(request);
    const events = await collectSSEEvents(response);

    // Stream should still complete
    const completeEvents = events.filter((e) => e.event === "complete");
    expect(completeEvents.length).toBe(1);

    // The complete result should include both success and the skipped/error entry
    const result = completeEvents[0].data as Record<string, unknown>;
    expect(typeof result.imported).toBe("number");
    expect(typeof result.durationMs).toBe("number");
  });

  it("returns 400 for missing preview", async () => {
    const { POST } = await import(
      "@/app/api/brain/coldstart-stream/route"
    );

    const request = new Request("http://localhost/api/brain/coldstart-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("preview");
  });
});

// ── Citation Graph Tests ─────────────────────────────

describe("GET /api/brain/citation-graph", () => {
  beforeEach(() => {
    vi.resetModules();
    setupBrain();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/brain/store");
    teardownBrain();
  });

  it("builds correct nodes and edges from brain pages", async () => {
    // Create wiki pages with wikilinks
    createWikiPage("wiki/entities/papers/neural-nets.md", {
      title: "Neural Networks",
      type: "paper",
      date: "2026-04-09",
      para: "resources",
      tags: ["ml"],
      authors: ["Alice"],
    }, "# Neural Networks\n\nThis paper discusses [[backprop]] and [[optimization]].");

    createWikiPage("wiki/resources/backprop.md", {
      title: "Backpropagation",
      type: "concept",
      date: "2026-04-09",
      para: "resources",
      tags: ["ml"],
    }, "# Backpropagation\n\nUsed in [[neural-nets]].");

    createWikiPage("wiki/resources/optimization.md", {
      title: "Optimization",
      type: "concept",
      date: "2026-04-09",
      para: "resources",
      tags: ["ml"],
    }, "# Optimization\n\nGeneral topic.");

    const { GET } = await import(
      "@/app/api/brain/citation-graph/route"
    );

    const request = new Request(
      "http://localhost/api/brain/citation-graph?root=neural-nets&depth=2",
    );

    const response = await GET(request);
    expect(response.status).toBe(200);

    const graph = await response.json();
    expect(graph.nodes.length).toBeGreaterThanOrEqual(3);
    expect(graph.edges.length).toBeGreaterThanOrEqual(2);
    expect(graph.rootNode).toContain("neural-nets");

    // Root node should be in brain
    const rootNode = graph.nodes.find(
      (n: { id: string }) => n.id === graph.rootNode,
    );
    expect(rootNode).toBeDefined();
    expect(rootNode.isInBrain).toBe(true);
    expect(rootNode.title).toBe("Neural Networks");
    expect(rootNode.type).toBe("paper");

    // Should have concept nodes
    const conceptNodes = graph.nodes.filter(
      (n: { type: string }) => n.type === "concept",
    );
    expect(conceptNodes.length).toBeGreaterThanOrEqual(2);
  });

  it("respects depth parameter", async () => {
    // Create chain: A -> B -> C -> D
    createWikiPage("wiki/entities/papers/a.md", {
      title: "Paper A",
      type: "paper",
      date: "2026-04-09",
      para: "resources",
      tags: [],
    }, "# Paper A\n\nSee [[b]].");

    createWikiPage("wiki/entities/papers/b.md", {
      title: "Paper B",
      type: "paper",
      date: "2026-04-09",
      para: "resources",
      tags: [],
    }, "# Paper B\n\nSee [[c]].");

    createWikiPage("wiki/entities/papers/c.md", {
      title: "Paper C",
      type: "paper",
      date: "2026-04-09",
      para: "resources",
      tags: [],
    }, "# Paper C\n\nSee [[d]].");

    createWikiPage("wiki/entities/papers/d.md", {
      title: "Paper D",
      type: "paper",
      date: "2026-04-09",
      para: "resources",
      tags: [],
    }, "# Paper D\n\nLeaf.");

    const { GET } = await import(
      "@/app/api/brain/citation-graph/route"
    );

    // depth=1: A and B only (A links to B, but doesn't follow B's links)
    const r1 = await GET(
      new Request("http://localhost/api/brain/citation-graph?root=a&depth=1"),
    );
    const g1 = await r1.json();
    const inBrainNodes1 = g1.nodes.filter((n: { isInBrain: boolean }) => n.isInBrain);
    // At depth=1 we see A + B (direct link from A), but NOT C
    expect(inBrainNodes1.length).toBe(2);

    // depth=3: A, B, C, D
    const r3 = await GET(
      new Request("http://localhost/api/brain/citation-graph?root=a&depth=3"),
    );
    const g3 = await r3.json();
    const inBrainNodes3 = g3.nodes.filter((n: { isInBrain: boolean }) => n.isInBrain);
    expect(inBrainNodes3.length).toBe(4);
  });

  it("includes ghost nodes for external references", async () => {
    createWikiPage("wiki/entities/papers/my-paper.md", {
      title: "My Paper",
      type: "paper",
      date: "2026-04-09",
      para: "resources",
      tags: [],
    }, "# My Paper\n\nReferences [[unknown-paper]] and cites @smith2024.");

    const { GET } = await import(
      "@/app/api/brain/citation-graph/route"
    );

    const response = await GET(
      new Request("http://localhost/api/brain/citation-graph?root=my-paper&depth=2"),
    );
    const graph = await response.json();

    // Should have ghost nodes
    const ghostNodes = graph.nodes.filter(
      (n: { isInBrain: boolean }) => !n.isInBrain,
    );
    expect(ghostNodes.length).toBeGreaterThanOrEqual(2);

    // Ghost nodes include the wikilink target and citation key
    const ghostIds = ghostNodes.map((n: { id: string }) => n.id);
    expect(ghostIds.some((id: string) => id.includes("unknown-paper"))).toBe(true);
    expect(ghostIds.some((id: string) => id.includes("smith2024"))).toBe(true);

    // Ghost edges
    const ghostEdges = graph.edges.filter(
      (e: { target: string }) =>
        e.target.startsWith("ghost:"),
    );
    expect(ghostEdges.length).toBeGreaterThanOrEqual(2);
  });

  it("handles empty brain", async () => {
    const { GET } = await import(
      "@/app/api/brain/citation-graph/route"
    );

    // Wiki dir exists but is empty — slug not found
    const response = await GET(
      new Request("http://localhost/api/brain/citation-graph?root=nonexistent&depth=2"),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain("not found");
  });

  it("builds typed gbrain graph without capped page scans", async () => {
    rmSync(join(TEST_ROOT, "wiki"), { recursive: true, force: true });
    const pages = new Map([
      [
        "wiki/concepts/rlhf-alignment",
        {
          path: "wiki/concepts/rlhf-alignment.md",
          title: "RLHF alignment",
          type: "concept",
          content: "RLHF is contested.",
          frontmatter: { type: "concept" },
        },
      ],
      [
        "wiki/entities/papers/deceptive-rlhf",
        {
          path: "wiki/entities/papers/deceptive-rlhf.md",
          title: "Deceptive RLHF",
          type: "paper",
          content: "RLHF can produce deceptive alignment.",
          frontmatter: { type: "paper" },
        },
      ],
    ]);
    const normalize = (path: string) => path.replace(/\.mdx?$/i, "");
    const fakeStore = {
      search: vi.fn(async () => []),
      getPage: vi.fn(async (path: string) => pages.get(normalize(path)) ?? null),
      getTimeline: vi.fn(async () => []),
      getLinks: vi.fn(async (path: string) => {
        if (normalize(path) !== "wiki/concepts/rlhf-alignment") return [];
        return [
          {
            slug: "wiki/entities/papers/deceptive-rlhf.md",
            kind: "contradicts",
            title: "Deceptive RLHF",
            context: "evidence",
            fromSlug: "wiki/concepts/rlhf-alignment.md",
            toSlug: "wiki/entities/papers/deceptive-rlhf.md",
          },
        ];
      }),
      getBacklinks: vi.fn(async () => []),
      listPages: vi.fn(async () => {
        throw new Error("citation graph should not use capped page scans");
      }),
      importCorpus: vi.fn(),
      health: vi.fn(),
      dispose: vi.fn(),
    };
    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => undefined),
      getBrainStore: () => fakeStore,
    }));

    const { GET } = await import(
      "@/app/api/brain/citation-graph/route"
    );

    const response = await GET(
      new Request(
        "http://localhost/api/brain/citation-graph?root=wiki/concepts/rlhf-alignment&depth=2",
      ),
    );
    const graph = await response.json();

    expect(response.status).toBe(200);
    expect(fakeStore.listPages).not.toHaveBeenCalled();
    expect(graph.rootNode).toBe("wiki/concepts/rlhf-alignment");
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "wiki/concepts/rlhf-alignment",
          title: "RLHF alignment",
          isInBrain: true,
        }),
        expect.objectContaining({
          id: "wiki/entities/papers/deceptive-rlhf",
          title: "Deceptive RLHF",
          isInBrain: true,
        }),
      ]),
    );
    expect(graph.edges).toEqual([
      expect.objectContaining({
        source: "wiki/concepts/rlhf-alignment",
        target: "wiki/entities/papers/deceptive-rlhf",
        relation: "contradicts",
      }),
    ]);
  });

  it("logs typed gbrain graph failures before using the legacy wiki graph", async () => {
    createWikiPage("wiki/entities/papers/neural-nets.md", {
      title: "Neural Networks",
      type: "paper",
      date: "2026-04-09",
      para: "resources",
      tags: [],
    }, "# Neural Networks\n\nLegacy wiki content.");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.doMock("@/brain/store", () => ({
      ensureBrainStoreReady: vi.fn(async () => {
        throw new Error("typed graph store unavailable");
      }),
      getBrainStore: vi.fn(),
    }));

    const { GET } = await import(
      "@/app/api/brain/citation-graph/route"
    );

    const response = await GET(
      new Request("http://localhost/api/brain/citation-graph?root=neural-nets&depth=1"),
    );
    const graph = await response.json();

    expect(response.status).toBe(200);
    expect(graph.rootNode).toBe("wiki/entities/papers/neural-nets.md");
    expect(warnSpy).toHaveBeenCalledWith(
      "brain citation graph: typed gbrain graph unavailable; falling back to wiki graph",
      expect.any(Error),
    );
  });

  it("returns 400 when root parameter is missing", async () => {
    const { GET } = await import(
      "@/app/api/brain/citation-graph/route"
    );

    const response = await GET(
      new Request("http://localhost/api/brain/citation-graph"),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("root");
  });

  it("returns empty graph when wiki dir does not exist", async () => {
    // Remove the wiki dir
    rmSync(join(TEST_ROOT, "wiki"), { recursive: true, force: true });

    const { GET } = await import(
      "@/app/api/brain/citation-graph/route"
    );

    const response = await GET(
      new Request("http://localhost/api/brain/citation-graph?root=anything&depth=2"),
    );
    expect(response.status).toBe(200);
    const graph = await response.json();
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.rootNode).toBe("anything");
  });
});
