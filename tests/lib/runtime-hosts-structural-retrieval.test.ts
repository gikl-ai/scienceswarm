import { describe, expect, it, vi } from "vitest";

import type { GbrainCapabilities } from "@/brain/gbrain-capabilities";
import type { BrainStore } from "@/brain/store";
import {
  createRuntimeStructuralRetrievalHandler,
} from "@/lib/runtime-hosts/mcp/structural-retrieval";

function capabilities(
  structuralNavigationAvailable: boolean,
): GbrainCapabilities {
  return {
    structuralNavigationAvailable,
    package: {
      requiredVersion: "0.21.0",
      requiredCommit: "commit",
      expectedVersion: "0.21.0",
      expectedResolved: "commit",
      installedVersion: "0.21.0",
      installedName: "gbrain",
      binPath: "/tmp/gbrain",
      binExists: true,
      inSync: true,
      ready: true,
    },
    doctor: {
      ok: structuralNavigationAvailable,
      schemaVersion: structuralNavigationAvailable ? 29 : null,
      rawStatus: structuralNavigationAvailable ? "ready" : "unknown",
    },
    schema: {
      requiredVersion: 28,
      observedVersion: structuralNavigationAvailable ? 29 : null,
      requiredFieldsPresent: structuralNavigationAvailable,
      missingFields: structuralNavigationAvailable ? [] : ["content_chunks.symbol_name"],
      rawStatus: structuralNavigationAvailable ? "ready" : "unknown",
    },
    operations: {
      required: ["code-def", "code-refs", "code-callers", "code-callees", "reindex-code"],
      available: structuralNavigationAvailable
        ? ["code-def", "code-refs", "code-callers", "code-callees", "reindex-code"]
        : [],
      missing: structuralNavigationAvailable
        ? []
        : ["code-def", "code-refs", "code-callers", "code-callees", "reindex-code"],
      rawStatus: structuralNavigationAvailable ? "ready" : "unknown",
    },
    chunker: {
      requiredVersion: "4",
      sourceVersions: structuralNavigationAvailable ? ["4"] : [],
      supported: structuralNavigationAvailable,
      rawStatus: structuralNavigationAvailable ? "ready" : "unknown",
    },
    reindex: {
      status: structuralNavigationAvailable ? "not-required" : "unknown",
      reason: structuralNavigationAvailable
        ? "No sources report an older chunker version."
        : "Local gbrain schema metadata was unavailable.",
    },
    blockers: structuralNavigationAvailable ? [] : ["local schema is missing required structural fields."],
  };
}

const baseInput = {
  projectId: "project-alpha",
  runtimeSessionId: "session-secret-token-like-value",
  hostId: "codex",
  query: "private-query-needle",
};

describe("runtime structural retrieval", () => {
  it("degrades explicitly without touching gbrain reads when capability gates fail", async () => {
    const ensureReady = vi.fn(async () => {});
    const getStore = vi.fn();
    const handler = createRuntimeStructuralRetrievalHandler({
      probeCapabilities: async () => capabilities(false),
      ensureReady,
      getStore,
    });

    await expect(handler(baseInput)).resolves.toMatchObject({
      status: "degraded",
      degraded: true,
      records: [],
      provenance: {
        capability: {
          structuralNavigationAvailable: false,
          blockers: ["local schema is missing required structural fields."],
        },
      },
    });
    expect(ensureReady).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
  });

  it("denies cross-study scope before capability or store access", async () => {
    const probeCapabilities = vi.fn(async () => capabilities(true));
    const getStore = vi.fn();
    const handler = createRuntimeStructuralRetrievalHandler({
      probeCapabilities,
      getStore,
    });

    await expect(
      handler({
        ...baseInput,
        studySlug: "project-beta",
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_STRUCTURAL_RETRIEVAL_SCOPE_DENIED",
    });
    expect(probeCapabilities).not.toHaveBeenCalled();
    expect(getStore).not.toHaveBeenCalled();
  });

  it("accepts a Study id when the active Study slug matches the runtime project", async () => {
    const handler = createRuntimeStructuralRetrievalHandler({
      probeCapabilities: async () => capabilities(false),
    });

    await expect(
      handler({
        ...baseInput,
        studyId: "study_project_alpha",
        studySlug: "project-alpha",
      }),
    ).resolves.toMatchObject({ status: "degraded" });
  });

  it("returns compact structural records without raw body, query, session, or token material", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            page_id: "wiki/projects/project-alpha/assay.md",
            page_title: "Assay summary",
            page_type: "artifact",
            chunk_id: 42,
            chunk_index: 3,
            source_id: "source_alpha",
            symbol_name: "scoreAssay",
            symbol_type: "function",
            symbol_name_qualified: "analysis.scoreAssay",
            parent_symbol_path: "analysis",
            incoming_edges: 2,
            outgoing_edges: 5,
            chunk_text: "raw body must not leak",
          },
        ],
      })),
    };
    const store = {
      engine: { db },
      search: vi.fn(),
    } as unknown as BrainStore;
    const handler = createRuntimeStructuralRetrievalHandler({
      probeCapabilities: async () => capabilities(true),
      ensureReady: async () => {},
      getStore: () => store,
    });

    const result = await handler({
      ...baseInput,
      studySlug: "project-alpha",
      sourceIds: ["source_alpha"],
      nearSymbol: "analysis.scoreAssay",
      walkDepth: 2,
      limit: 4,
    });

    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      pageId: "wiki/projects/project-alpha/assay.md",
      chunkId: "42",
      sourceId: "source_alpha",
      symbol: {
        qualifiedName: "analysis.scoreAssay",
      },
      graph: {
        incomingEdges: 2,
        outgoingEdges: 5,
        walkDepth: 2,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw body must not leak");
    expect(serialized).not.toContain(baseInput.query);
    expect(serialized).not.toContain(baseInput.runtimeSessionId);
  });

  it("falls back to compact keyword records when structural rows are unavailable", async () => {
    const store = {
      engine: {},
      search: vi.fn(async () => [
        {
          path: "wiki/projects/project-alpha/assay.md",
          title: "Assay summary",
          snippet: "full keyword snippet must not leak",
          relevance: 0.9,
          type: "artifact",
          chunkId: 7,
          chunkIndex: 1,
          sourceId: "source_alpha",
        },
      ]),
      getPage: vi.fn(async () => ({
        path: "wiki/projects/project-alpha/assay.md",
        title: "Assay summary",
        type: "artifact",
        content: "page body must not leak",
        frontmatter: { project: "project-alpha" },
      })),
    } as unknown as BrainStore;
    const handler = createRuntimeStructuralRetrievalHandler({
      probeCapabilities: async () => capabilities(true),
      ensureReady: async () => {},
      getStore: () => store,
    });

    const result = await handler(baseInput);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      pageId: "wiki/projects/project-alpha/assay.md",
      chunkId: "7",
      provenance: { retrieval: "keyword-fallback" },
    });
    expect(JSON.stringify(result)).not.toContain("full keyword snippet must not leak");
    expect(JSON.stringify(result)).not.toContain("page body must not leak");
  });

  it("filters keyword fallback records back to the active project scope", async () => {
    const store = {
      engine: {},
      search: vi.fn(async () => [
        {
          path: "wiki/projects/project-beta/assay.md",
          title: "Beta assay",
          snippet: "beta body",
          relevance: 0.9,
          type: "artifact",
          chunkId: 1,
          chunkIndex: 0,
          sourceId: "source_beta",
        },
        {
          path: "wiki/projects/project-alpha/assay.md",
          title: "Alpha assay",
          snippet: "alpha body",
          relevance: 0.8,
          type: "artifact",
          chunkId: 2,
          chunkIndex: 0,
          sourceId: "source_alpha",
        },
      ]),
      getPage: vi.fn(async (pagePath: string) => ({
        path: pagePath,
        title: pagePath.includes("project-alpha") ? "Alpha assay" : "Beta assay",
        type: "artifact",
        content: "body must not leak",
        frontmatter: {
          project: pagePath.includes("project-alpha") ? "project-alpha" : "project-beta",
        },
      })),
    } as unknown as BrainStore;
    const handler = createRuntimeStructuralRetrievalHandler({
      probeCapabilities: async () => capabilities(true),
      ensureReady: async () => {},
      getStore: () => store,
    });

    const result = await handler(baseInput);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].pageId).toBe("wiki/projects/project-alpha/assay.md");
    expect(JSON.stringify(result)).not.toContain("project-beta/assay");
  });
});
