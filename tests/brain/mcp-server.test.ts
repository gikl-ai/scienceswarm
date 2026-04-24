import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import * as brainInitModule from "@/brain/init";
import * as projectOrganizerModule from "@/brain/project-organizer";
import * as researchPacketsModule from "@/lib/research-packets";
import type { BrainConfig } from "@/brain/types";
import type { LLMClient, LLMResponse } from "@/brain/llm";
import { getBrainStore, resetBrainStore } from "@/brain/store";
import {
  handleBrainInit,
  handleBrainImportRegistry,
  handleBrainSearch,
  handleBrainRead,
  handleBrainStatus,
  handleBrainMaintenance,
  handleBrainProjectOrganize,
  handleResearchLandscape,
  handleBrainGuide,
  handleBrainRipple,
  handleBrainCapture,
} from "@/brain/mcp-server";

let TEST_ROOT = "";
let originalBrainRoot: string | undefined;
let originalPglitePath: string | undefined;
let originalUserHandle: string | undefined;

function assignTestRoot(): string {
  TEST_ROOT = mkdtempSync(join(tmpdir(), "scienceswarm-brain-test-mcp-"));
  return TEST_ROOT;
}

function makeConfig(): BrainConfig {
  return {
    root: TEST_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

/** Mock LLM that returns canned responses */
function mockLLM(): LLMClient {
  return {
    async complete(): Promise<LLMResponse> {
      // Default: return a valid wiki page for ripple
      return {
        content: [
          "---",
          "title: Test Paper",
          "date: 2026-04-07",
          "type: paper",
          "para: resources",
          "authors: [Smith]",
          "year: 2026",
          "venue: Nature",
          "tags: [test, biology]",
          "---",
          "",
          "# Test Paper",
          "",
          "## Summary",
          "This is a test paper about biology. [^1]",
          "",
          "## Citations",
          "[^1]: test.pdf, p.1",
        ].join("\n"),
        cost: { inputTokens: 500, outputTokens: 200, estimatedUsd: 0.02, model: "test" },
      };
    },
  };
}

beforeEach(() => {
  originalBrainRoot = process.env.BRAIN_ROOT;
  originalPglitePath = process.env.BRAIN_PGLITE_PATH;
  originalUserHandle = process.env.SCIENCESWARM_USER_HANDLE;
  assignTestRoot();
  brainInitModule.initBrain({ root: TEST_ROOT, name: "Test Researcher" });
});

afterEach(async () => {
  await resetBrainStore();
  if (TEST_ROOT) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
  TEST_ROOT = "";
  restoreEnv("BRAIN_ROOT", originalBrainRoot);
  restoreEnv("BRAIN_PGLITE_PATH", originalPglitePath);
  restoreEnv("SCIENCESWARM_USER_HANDLE", originalUserHandle);
  vi.restoreAllMocks();
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function writeCorpusFixture(name: string, files: Record<string, string>): string {
  const root = join(TEST_ROOT, name);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

// ── brain_init ────────────────────────────────────────────

describe("brain_init", () => {
  it("initializes a new brain at specified root", async () => {
    const freshRoot = join(tmpdir(), "scienceswarm-brain-test-mcp-init");
    rmSync(freshRoot, { recursive: true, force: true });
    const initBrainWithInstallerSpy = vi
      .spyOn(brainInitModule, "initBrainWithInstaller")
      .mockResolvedValue({
        root: freshRoot,
        created: true,
        message: `Brain initialized at ${freshRoot}.`,
      });

    const result = await handleBrainInit({ root: freshRoot, name: "Alice" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created).toBe(true);
    expect(parsed.root).toBe(freshRoot);
    expect(initBrainWithInstallerSpy).toHaveBeenCalledWith({
      root: freshRoot,
      name: "Alice",
      field: undefined,
    });

    rmSync(freshRoot, { recursive: true, force: true });
  });

  it("defaults brain_init to SCIENCESWARM_DIR/brain when no root is specified", async () => {
    const original = process.env.BRAIN_ROOT;
    const originalDataRoot = process.env.SCIENCESWARM_DIR;
    delete process.env.BRAIN_ROOT;
    process.env.SCIENCESWARM_DIR = join(TEST_ROOT, "..");

    const defaultRoot = join(TEST_ROOT, "..", "brain");
    rmSync(defaultRoot, { recursive: true, force: true });
    const initBrainWithInstallerSpy = vi
      .spyOn(brainInitModule, "initBrainWithInstaller")
      .mockResolvedValue({
        root: defaultRoot,
        created: true,
        message: `Brain initialized at ${defaultRoot}.`,
      });

    const result = await handleBrainInit({});
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(parsed.created).toBe(true);
    expect(parsed.root).toBe(defaultRoot);
    expect(initBrainWithInstallerSpy).toHaveBeenCalledWith({
      root: defaultRoot,
      name: undefined,
      field: undefined,
    });

    if (original) process.env.BRAIN_ROOT = original;
    else delete process.env.BRAIN_ROOT;
    if (originalDataRoot) process.env.SCIENCESWARM_DIR = originalDataRoot;
    else delete process.env.SCIENCESWARM_DIR;
    rmSync(defaultRoot, { recursive: true, force: true });
  });

  it("reports existing brain without modification", async () => {
    const initBrainWithInstallerSpy = vi
      .spyOn(brainInitModule, "initBrainWithInstaller")
      .mockResolvedValue({
        root: TEST_ROOT,
        created: false,
        message: `Brain already exists at ${TEST_ROOT}`,
      });
    const result = await handleBrainInit({ root: TEST_ROOT });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created).toBe(false);
    expect(parsed.message).toContain("already exists");
    expect(initBrainWithInstallerSpy).toHaveBeenCalledWith({
      root: TEST_ROOT,
      name: undefined,
      field: undefined,
    });
  });

  it("returns an MCP error payload when the installer fails", async () => {
    vi.spyOn(brainInitModule, "initBrainWithInstaller").mockRejectedValue(
      new Error("installer failed"),
    );

    const result = await handleBrainInit({ root: TEST_ROOT });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: installer failed");
  });
});

// brain_ingest / brain_observe tests removed — those MCP tools were
// deleted in Phase B (PR #239). Capture flows through brain_capture.

describe("brain_capture", () => {
  it("keeps ordinary local MCP captures working without runtime provenance", async () => {
    const originalUserHandle = process.env.SCIENCESWARM_USER_HANDLE;
    process.env.SCIENCESWARM_USER_HANDLE = "@test-researcher";
    const writes: Array<{ slug: string; content: string }> = [];

    try {
      const result = await handleBrainCapture(
        {
          async putPage(slug, content) {
            writes.push({ slug, content });
            return { stdout: "ok\n", stderr: "" };
          },
          async linkPages() {
            return { stdout: "", stderr: "" };
          },
        },
        {
          content: "Ordinary local capture",
          title: "Local capture",
          channel: "openclaw",
          userId: "alice",
        },
      );

      expect(result.isError).toBeUndefined();
      expect(writes).toHaveLength(1);
      expect(writes[0].content).toContain("title: Local capture");
      expect(writes[0].content).not.toContain("runtime_gbrain_provenance");
    } finally {
      if (originalUserHandle === undefined) {
        delete process.env.SCIENCESWARM_USER_HANDLE;
      } else {
        process.env.SCIENCESWARM_USER_HANDLE = originalUserHandle;
      }
    }
  });
});

// ── brain_search ──────────────────────────────────────────

describe("brain_search", () => {
  it("rejects empty query", async () => {
    const config = makeConfig();

    const result = await handleBrainSearch(config, { query: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("query is required");
  });

  it("returns results for matching content", async () => {
    const config = makeConfig();

    // Create a page with searchable content
    mkdirSync(join(TEST_ROOT, "wiki/resources"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "wiki/resources/test-note.md"),
      "---\ntype: note\ntags: [biology]\n---\n# Biology Note\nCRISPR gene editing is powerful."
    );

    const result = await handleBrainSearch(config, {
      query: "CRISPR",
      mode: "grep",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].path).toContain("wiki/");
  });

  it("accepts gbrain search detail hints", async () => {
    const config = makeConfig();

    mkdirSync(join(TEST_ROOT, "wiki/resources"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "wiki/resources/detail-note.md"),
      "---\ntype: note\n---\n# Detail Note\nChunk evidence belongs here.",
    );

    const result = await handleBrainSearch(config, {
      query: "Chunk evidence",
      mode: "grep",
      detail: "high",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("rejects invalid search detail hints", async () => {
    const config = makeConfig();

    const result = await handleBrainSearch(config, {
      query: "CRISPR",
      detail: "full",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "detail must be one of low, medium, or high",
    );
  });

  it("returns empty array for no matches", async () => {
    const config = makeConfig();

    const result = await handleBrainSearch(config, {
      query: "zzz_nonexistent_query_zzz",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([]);
  });

  it("allows list mode without a query", async () => {
    const config = makeConfig();

    const result = await handleBrainSearch(config, {
      query: "",
      mode: "list",
      limit: 50,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });
});

// ── brain_read ────────────────────────────────────────────

describe("brain_read", () => {
  it("rejects empty path", async () => {
    const config = makeConfig();

    const result = await handleBrainRead(config, { path: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("path is required");
  });

  it("rejects path traversal with ../", async () => {
    const config = makeConfig();

    const result = await handleBrainRead(config, {
      path: "../../../etc/passwd",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("path traversal detected");
  });

  it("rejects path traversal with absolute path outside root", async () => {
    const config = makeConfig();

    const result = await handleBrainRead(config, { path: "/etc/passwd" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("path traversal detected");
  });

  it("rejects sneaky path traversal with encoded dots", async () => {
    const config = makeConfig();

    const result = await handleBrainRead(config, {
      path: "wiki/../../etc/passwd",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("path traversal detected");
  });

  it("reads a file within brain root", async () => {
    const config = makeConfig();

    const result = await handleBrainRead(config, { path: "BRAIN.md" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("ScienceSwarm Research Brain");
  });

  it("reads gbrain pages by search-result path when no mirror file exists", async () => {
    const config = makeConfig();
    process.env.BRAIN_ROOT = TEST_ROOT;
    process.env.BRAIN_PGLITE_PATH = join(TEST_ROOT, "brain.pglite");
    process.env.SCIENCESWARM_USER_HANDLE = "@mcp-test";
    await resetBrainStore();
    await getBrainStore({ root: TEST_ROOT }).importCorpus(
      writeCorpusFixture("gbrain-import", {
        "wiki/entities/papers/math-paper.md": [
          "---",
          "title: Math Paper",
          "type: paper",
          "---",
          "This page studies algebraic topology.",
        ].join("\n"),
      }),
    );

    const result = await handleBrainRead(config, {
      path: "wiki/entities/papers/math-paper.md",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Math Paper");
    expect(result.content[0].text).toContain("algebraic topology");
  });

  it("returns error for non-existent file", async () => {
    const config = makeConfig();

    const result = await handleBrainRead(config, {
      path: "wiki/nonexistent.md",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("file not found");
  });
});

// ── brain_status ──────────────────────────────────────────

describe("brain_status", () => {
  it("returns expected shape", async () => {
    const config = makeConfig();

    const result = await handleBrainStatus(config);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(typeof parsed.monthCost).toBe("number");
    expect(typeof parsed.budgetExceeded).toBe("boolean");
    expect(Array.isArray(parsed.recentEvents)).toBe(true);
    expect(typeof parsed.pageCount).toBe("number");
    expect(parsed.pageCount).toBeGreaterThan(0); // init creates log.md, home.md, index.md
  });

  it("returns recentEvents as an array", async () => {
    const config = makeConfig();

    const result = await handleBrainStatus(config);
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.recentEvents)).toBe(true);
  });
});

// ── brain_maintenance ────────────────────────────────────

describe("brain_maintenance", () => {
  it("returns ranked maintenance recommendations", async () => {
    const config = makeConfig();
    mkdirSync(join(TEST_ROOT, "concepts"), { recursive: true });
    writeFileSync(join(TEST_ROOT, "concepts", "rlhf.md"), "# RLHF\n", "utf-8");

    const result = await handleBrainMaintenance(config);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      source: expect.any(String),
      score: expect.any(Number),
      signals: expect.any(Object),
      recommendations: expect.any(Array),
    });
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    expect(parsed.recommendations[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        priority: expect.any(String),
        action: expect.any(String),
      }),
    );
    expect(parsed.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "bridge-research-layout",
        }),
      ]),
    );
  });
});

// ── brain_project_organize ───────────────────────────────

describe("brain_project_organize", () => {
  it("returns the read-only project organizer summary", async () => {
    const config = makeConfig();
    vi.spyOn(projectOrganizerModule, "buildProjectOrganizerReadout").mockResolvedValue({
      project: "alpha",
      generatedAt: "2026-04-19T12:00:00.000Z",
      pageCount: 4,
      pageScanLimit: 5000,
      pageScanLimitReached: false,
      pageCountsByType: { paper: 2, task: 1, note: 1 },
      importSummary: null,
      threads: [],
      duplicatePapers: [],
      importDuplicateGroups: [],
      trackedExportCount: 0,
      staleExports: [],
      nextMove: { recommendation: "Review the imported notes." },
      dueTasks: [],
      frontier: [],
      suggestedPrompts: ["Organize this project."],
    });

    const result = await handleBrainProjectOrganize(config, { project: "alpha" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(
      expect.objectContaining({
        project: "alpha",
        pageCount: 4,
        nextMove: { recommendation: "Review the imported notes." },
      }),
    );
  });

  it("rejects an empty project slug", async () => {
    const config = makeConfig();

    const result = await handleBrainProjectOrganize(config, { project: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("project is required");
  });

  it("rejects an unsafe project slug", async () => {
    const config = makeConfig();

    const result = await handleBrainProjectOrganize(config, { project: "../alpha" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("safe bare slug");
  });
});

describe("brain_import_registry", () => {
  it("returns the authoritative import registry for a valid project slug", async () => {
    const config = makeConfig();
    const registrySpy = vi.spyOn(await import("@/brain/import-registry"), "buildProjectImportRegistry")
      .mockResolvedValue({
        project: "alpha",
        generatedAt: "2026-04-19T12:00:00.000Z",
        detectedItemCount: 5,
        registeredItemCount: 4,
        duplicateGroupCount: 1,
        entries: [],
        duplicateGroups: [],
        warnings: [],
      });

    const result = await handleBrainImportRegistry(config, { project: "alpha" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(
      expect.objectContaining({
        project: "alpha",
        detectedItemCount: 5,
        registeredItemCount: 4,
      }),
    );
    expect(registrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ project: "alpha" }),
    );
  });

  it("rejects an empty project slug", async () => {
    const config = makeConfig();

    const result = await handleBrainImportRegistry(config, { project: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("project is required");
  });
});

// ── brain_guide ───────────────────────────────────────────

describe("brain_guide", () => {
  it("returns a structured briefing", async () => {
    const config = makeConfig();

    const result = await handleBrainGuide(config, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.stats).toEqual(
      expect.objectContaining({
        pageCount: expect.any(Number),
      }),
    );
    expect(Array.isArray(parsed.alerts)).toBe(true);
    expect(Array.isArray(parsed.recentChanges)).toBe(true);
    expect(Array.isArray(parsed.activeExperiments)).toBe(true);
    expect(Array.isArray(parsed.readingSuggestions)).toBe(true);
    expect(parsed.focus).toBe("general");
  });

  it("uses focus parameter for reading suggestions", async () => {
    const config = makeConfig();

    // Create a page with searchable content
    mkdirSync(join(TEST_ROOT, "wiki/resources"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "wiki/resources/focus-test.md"),
      "---\ntype: note\ntags: [neuroscience]\n---\n# Neuroscience Note\nBrain plasticity research."
    );
    writeFileSync(
      join(TEST_ROOT, "wiki/log.md"),
      "# Brain Log\n\nNeuroscience note was ingested."
    );
    writeFileSync(
      join(TEST_ROOT, "wiki/index.md"),
      "# Brain Index\n\n- [[wiki/resources/focus-test|Neuroscience Note]]"
    );

    const result = await handleBrainGuide(config, { focus: "neuroscience" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.focus).toBe("neuroscience");
    expect(parsed.readingSuggestions.every((s: { path: string }) => !["wiki/log.md", "wiki/index.md"].includes(s.path))).toBe(true);
  });
});

// ── brain_ripple ──────────────────────────────────────────

describe("brain_ripple", () => {
  it("rejects empty pagePath", async () => {
    const config = makeConfig();
    const llm = mockLLM();

    const result = await handleBrainRipple(config, llm, { pagePath: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pagePath is required");
  });

  it("rejects non-existent page", async () => {
    const config = makeConfig();
    const llm = mockLLM();

    const result = await handleBrainRipple(config, llm, {
      pagePath: "wiki/nonexistent.md",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("page not found");
  });

  it("runs ripple on an existing page", async () => {
    const config = makeConfig();
    const llm = mockLLM();

    const result = await handleBrainRipple(config, llm, {
      pagePath: "wiki/home.md",
      tags: ["test"],
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.updates)).toBe(true);
    expect(Array.isArray(parsed.contradictions)).toBe(true);
  });
});

describe("research_landscape", () => {
  it("rejects an empty query", async () => {
    const config = makeConfig();

    const result = await handleResearchLandscape(config, { query: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("query is required");
  });

  it("returns the deterministic packet result", async () => {
    const config = makeConfig();
    const runResearchLandscapeSpy = vi.spyOn(researchPacketsModule, "runResearchLandscape")
      .mockResolvedValue({
        status: "completed",
        query: "graph neural networks",
        packet: {
          slug: "packets/2026-04-22-graph-neural-networks-abcd1234",
          diskPath: `${TEST_ROOT}/packets/2026-04-22-graph-neural-networks-abcd1234.md`,
          title: "Research Packet: graph neural networks",
          write_status: "persisted",
        },
        journal: {
          slug: "journals/2026-04-22-graph-neural-networks-abcd1234",
          diskPath: `${TEST_ROOT}/journals/2026-04-22-graph-neural-networks-abcd1234.md`,
          title: "Research Landscape Journal: graph neural networks",
          write_status: "persisted",
        },
        pointerPath: `${TEST_ROOT}/.research-landscape-last-run.json`,
        sourceRuns: [],
        collectedCandidates: 0,
        retainedCandidates: 0,
        duplicatesDropped: 0,
        retainedWrites: [],
        failures: [],
      });

    const result = await handleResearchLandscape(config, {
      query: "graph neural networks",
      project: "alpha",
      sources: ["pubmed"],
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("completed");
    expect(parsed.packet.slug).toContain("packets/");
    expect(runResearchLandscapeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "graph neural networks",
        project: "alpha",
        sources: ["pubmed"],
      }),
      expect.objectContaining({
        brainRoot: TEST_ROOT,
      }),
    );
  });
});
