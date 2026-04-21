import { describe, it, expect } from "vitest";
import {
  groupByType,
  matchesProject,
  searchProjectArtifacts,
} from "@/brain/project-scope";
import type {
  BrainPage,
  BrainStore,
  ImportResult,
} from "@/brain/store";
import type { SearchInput, SearchResult } from "@/brain/types";

class FakeBrainStore implements BrainStore {
  results: SearchResult[] = [];
  lastInput: SearchInput | null = null;
  shouldThrow = false;

  async search(input: SearchInput): Promise<SearchResult[]> {
    this.lastInput = input;
    if (this.shouldThrow) throw new Error("brain unavailable");
    return this.results;
  }
  async getPage(_slug: string): Promise<BrainPage | null> {
    return null;
  }
  async getTimeline() {
    return [];
  }
  async getLinks() {
    return [];
  }
  async getBacklinks() {
    return [];
  }
  async importCorpus(_dirPath: string): Promise<ImportResult> {
    throw new Error("not implemented");
  }
  async listPages() {
    return [];
  }
  async health() {
    return { ok: true, pageCount: 0 };
  }
  async dispose() {}
}

function makeResult(path: string, type = "paper"): SearchResult {
  return {
    path,
    title: path,
    type: type as SearchResult["type"],
    snippet: "",
    relevance: 1,
  };
}

describe("matchesProject", () => {
  it.each([
    ["hubble-1929", "hubble-1929", true],
    ["hubble-1929-critique", "hubble-1929", true],
    ["hubble-1929-revision-plan", "hubble-1929", true],
    ["mendel-1866", "hubble-1929", false],
    ["hubble-1929x", "hubble-1929", false],
  ])("'%s' in project '%s' → %s", (slug, project, expected) => {
    expect(matchesProject({ path: slug }, project)).toBe(expected);
  });
});

describe("searchProjectArtifacts", () => {
  it("returns an empty array for an empty project slug", async () => {
    const store = new FakeBrainStore();
    const out = await searchProjectArtifacts({ project: "   ", store });
    expect(out).toEqual([]);
    expect(store.lastInput).toBeNull();
  });

  it("passes a list-mode query to the store with the project as the default query", async () => {
    const store = new FakeBrainStore();
    store.results = [
      makeResult("hubble-1929"),
      makeResult("hubble-1929-critique", "note"),
      makeResult("mendel-1866"),
    ];
    const out = await searchProjectArtifacts({
      project: "hubble-1929",
      store,
    });
    expect(store.lastInput?.mode).toBe("list");
    expect(store.lastInput?.query).toBe("hubble-1929");
    expect(out.map((r) => r.slug)).toEqual([
      "hubble-1929",
      "hubble-1929-critique",
    ]);
  });

  it("degrades to an empty array when the store throws", async () => {
    const store = new FakeBrainStore();
    store.shouldThrow = true;
    const out = await searchProjectArtifacts({
      project: "hubble-1929",
      store,
    });
    expect(out).toEqual([]);
  });

  it("applies the limit option", async () => {
    const store = new FakeBrainStore();
    store.results = [];
    await searchProjectArtifacts({ project: "x", store, limit: 5 });
    expect(store.lastInput?.limit).toBe(5);
  });
});

describe("groupByType", () => {
  it("buckets results by type", () => {
    const out = groupByType([
      {
        slug: "hubble-1929",
        title: "Hubble",
        type: "paper",
        snippet: "",
        relevance: 1,
      },
      {
        slug: "hubble-1929-critique",
        title: "Critique",
        type: "note",
        snippet: "",
        relevance: 1,
      },
      {
        slug: "hubble-1929-revision",
        title: "Revision",
        type: "paper",
        snippet: "",
        relevance: 1,
      },
    ]);
    expect(Object.keys(out).sort()).toEqual(["note", "paper"]);
    expect(out.paper).toHaveLength(2);
    expect(out.note).toHaveLength(1);
  });

  it("treats a blank type as 'unknown'", () => {
    const out = groupByType([
      {
        slug: "x",
        title: "X",
        type: "",
        snippet: "",
        relevance: 1,
      },
    ]);
    expect(out.unknown).toHaveLength(1);
  });
});
