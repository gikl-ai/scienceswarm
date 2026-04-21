import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  critiqueArtifact,
  linkArtifact,
  readArtifact,
  resolveArtifact,
  type CritiqueSubmitter,
  type ToolDeps,
} from "@/brain/audit-revise-tools";
import type {
  BrainPage,
  BrainStore,
  ImportResult,
} from "@/brain/store";
import type { SearchInput, SearchResult } from "@/brain/types";
import type { GbrainClient } from "@/brain/gbrain-client";

const FIXTURES = join(process.cwd(), "tests/fixtures/audit-revise");

class FakeBrainStore implements BrainStore {
  pages = new Map<string, BrainPage>();
  searchResults: SearchResult[] = [];
  searchCalls: SearchInput[] = [];

  async search(input: SearchInput): Promise<SearchResult[]> {
    this.searchCalls.push(input);
    return this.searchResults;
  }
  async getPage(slug: string): Promise<BrainPage | null> {
    return this.pages.get(slug) ?? null;
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
    return Array.from(this.pages.values());
  }
  async health() {
    return { ok: true, pageCount: this.pages.size };
  }
  async dispose() {}
}

class FakeGbrainClient implements GbrainClient {
  puts: Array<{ slug: string; content: string }> = [];
  links: Array<{ from: string; to: string; linkType?: string }> = [];

  async putPage(slug: string, content: string) {
    this.puts.push({ slug, content });
    return { stdout: `created ${slug}`, stderr: "" };
  }
  async linkPages(from: string, to: string, options?: { linkType?: string }) {
    this.links.push({ from, to, linkType: options?.linkType });
    return { stdout: `linked ${from} -> ${to}`, stderr: "" };
  }
}

function loadCachedCritique(): unknown {
  const raw = readFileSync(
    join(FIXTURES, "descartes-cached/hubble-1929.professional.json"),
    "utf8",
  );
  return JSON.parse(raw);
}

function buildDeps(overrides: Partial<ToolDeps> = {}): {
  deps: ToolDeps;
  brain: FakeBrainStore;
  gbrain: FakeGbrainClient;
  submitter: { calls: number; result: () => Promise<unknown> };
} {
  const brain = new FakeBrainStore();
  const gbrain = new FakeGbrainClient();
  const submitState = {
    calls: 0,
    result: () => Promise.resolve({ ok: false, status: 500, error: "not set" }),
  };
  const submitter: CritiqueSubmitter = {
    submit: async () => {
      submitState.calls += 1;
      return (await submitState.result()) as ReturnType<
        CritiqueSubmitter["submit"]
      > extends Promise<infer U>
        ? U
        : never;
    },
  };
  const deps: ToolDeps = {
    brain,
    gbrain,
    critique: submitter,
    loadPaperBytes: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    now: () => new Date("2026-04-14T22:00:00Z"),
    ...overrides,
  };
  return { deps, brain, gbrain, submitter: submitState as typeof submitState };
}

beforeEach(() => {
  process.env.SCIENCESWARM_USER_HANDLE = "@scienceswarm-demo";
});

describe("audit-revise-tools: resolveArtifact", () => {
  it("returns a slug when exactly one artifact matches the project", async () => {
    const { deps, brain } = buildDeps();
    brain.pages.set("hubble-1929", {
      path: "hubble-1929",
      title: "Hubble",
      type: "paper",
      content: "",
      frontmatter: {
        type: "paper",
        project: "acceptance-hubble",
        source_filename: "hubble-1929.pdf",
      },
    });
    brain.pages.set("mendel-1866", {
      path: "mendel-1866",
      title: "Mendel",
      type: "paper",
      content: "",
      frontmatter: { type: "paper", project: "acceptance-mendel" },
    });
    const out = await resolveArtifact(deps, {
      project: "acceptance-hubble",
      hint: "hubble-1929",
    });
    expect(out.slug).toBe("hubble-1929");
    expect(out.multiple).toBeUndefined();
  });

  it("returns a disambiguation list when more than one matches", async () => {
    const { deps, brain } = buildDeps();
    brain.pages.set("hubble-1929", {
      path: "hubble-1929",
      title: "Hubble",
      type: "paper",
      content: "",
      frontmatter: { type: "paper", project: "acceptance-hubble" },
    });
    brain.pages.set("hubble-1929-critique", {
      path: "hubble-1929-critique",
      title: "Critique",
      type: "note",
      content: "",
      frontmatter: { type: "critique", project: "acceptance-hubble" },
    });
    const out = await resolveArtifact(deps, {
      project: "acceptance-hubble",
      hint: "hubble",
    });
    expect(out.multiple).toEqual(["hubble-1929", "hubble-1929-critique"]);
  });

  it("returns a message when nothing matches", async () => {
    const { deps } = buildDeps();
    const out = await resolveArtifact(deps, { project: "nope" });
    expect(out.slug).toBeUndefined();
    expect(out.message).toContain("No artifacts matched");
  });
});

describe("audit-revise-tools: readArtifact", () => {
  it("returns a structured shape with frontmatter and extracted links", async () => {
    const { deps, brain } = buildDeps();
    brain.pages.set("hubble-1929-revision", {
      path: "hubble-1929-revision",
      title: "Hubble Revision",
      type: "note",
      content:
        "# Hubble Revision\n\nSee [[hubble-1929-critique]] for findings.",
      frontmatter: {
        type: "revision",
        project: "hubble-1929",
        parent: "hubble-1929",
        plan: "hubble-1929-revision-plan",
      },
    });
    const out = await readArtifact(deps, { slug: "hubble-1929-revision" });
    expect(out.type).toBe("revision");
    expect(out.title).toBe("Hubble Revision");
    expect(out.links).toContain("hubble-1929");
    expect(out.links).toContain("hubble-1929-revision-plan");
    expect(out.links).toContain("hubble-1929-critique");
  });

  it("throws a clear error when the slug is missing", async () => {
    const { deps } = buildDeps();
    await expect(
      readArtifact(deps, { slug: "missing-slug" }),
    ).rejects.toThrow(/no page for slug/);
  });
});

describe("audit-revise-tools: linkArtifact", () => {
  it("calls gbrain.linkPages with the relation set as link type", async () => {
    const { deps, gbrain } = buildDeps();
    const out = await linkArtifact(deps, {
      from: "hubble-1929",
      to: "hubble-1929-critique",
      relation: "audited_by",
    });
    expect(out).toEqual({
      ok: true,
      from: "hubble-1929",
      to: "hubble-1929-critique",
      relation: "audited_by",
    });
    expect(gbrain.links).toEqual([
      { from: "hubble-1929", to: "hubble-1929-critique", linkType: "audited_by" },
    ]);
  });

  it("rejects unknown relations via the Zod schema", async () => {
    const { deps } = buildDeps();
    await expect(
      linkArtifact(deps, {
        from: "a",
        to: "b",
        relation: "wrong_relation" as unknown as "audited_by",
      }),
    ).rejects.toThrow();
  });
});

describe("audit-revise-tools: critiqueArtifact", () => {
  function seedHubble(brain: FakeBrainStore): void {
    brain.pages.set("hubble-1929", {
      path: "hubble-1929",
      title: "Hubble 1929",
      type: "paper",
      content: "# Hubble 1929\n\nText body.",
      frontmatter: {
        type: "paper",
        project: "hubble-1929",
        source_filename: "hubble-1929.pdf",
      },
    });
  }

  it("writes a critique page with severity counts and brief, and returns a summary", async () => {
    const cached = loadCachedCritique();
    const { deps, brain, gbrain, submitter } = buildDeps();
    seedHubble(brain);
    submitter.result = async () => ({
      ok: true,
      status: 200,
      payload: cached,
    });

    const result = await critiqueArtifact(deps, { slug: "hubble-1929" });

    expect(result.critique_slug).toBe("hubble-1929-critique");
    expect(result.brief.length).toBeGreaterThan(20);
    expect(
      Object.values(result.severity_counts).reduce((a, b) => a + b, 0),
    ).toBeGreaterThan(0);
    expect(submitter.calls).toBe(1);
    expect(gbrain.puts).toHaveLength(1);
    // Plan §2.2 step 7: the critique page must be linked back to its
    // parent paper via the `audited_by` relation. This was previously
    // missing — the page existed but no gbrain link was created.
    expect(gbrain.links).toEqual([
      {
        from: "hubble-1929",
        to: "hubble-1929-critique",
        linkType: "audited_by",
      },
    ]);
    const put = gbrain.puts[0];
    expect(put.slug).toBe("hubble-1929-critique");
    expect(put.content).toContain("type: critique");
    expect(put.content).toContain("parent: hubble-1929");
    expect(put.content).toContain("style_profile: professional");
    // Verbatim JSON block (plan §2.2 / principle 6).
    expect(put.content).toContain("```json");
    expect(put.content).toContain("Raw Descartes response");
  });

  it("throws the upstream timeout message when submit reports 504", async () => {
    const { deps, brain, submitter } = buildDeps();
    seedHubble(brain);
    submitter.result = async () => ({
      ok: false,
      status: 504,
      error:
        "the critique service did not respond after 900 seconds — try again or check the service status.",
    });
    await expect(
      critiqueArtifact(deps, { slug: "hubble-1929" }),
    ).rejects.toThrow(/did not respond after 900 seconds/);
  });

  it("rejects non-paper slugs loudly", async () => {
    const { deps, brain } = buildDeps();
    brain.pages.set("hubble-1929-revision", {
      path: "hubble-1929-revision",
      title: "Revision",
      type: "note",
      content: "",
      frontmatter: { type: "revision", project: "hubble-1929" },
    });
    await expect(
      critiqueArtifact(deps, { slug: "hubble-1929-revision" }),
    ).rejects.toThrow(/has type 'revision'/);
  });

  it("throws clearly when the paper page is missing", async () => {
    const { deps } = buildDeps();
    await expect(
      critiqueArtifact(deps, { slug: "nothing" }),
    ).rejects.toThrow(/no paper page/);
  });
});
