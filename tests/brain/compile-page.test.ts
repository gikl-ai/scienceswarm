import { describe, expect, it, vi } from "vitest";
import { compilePage, type CompileEvidence } from "@/brain/compile-page";
import type { BrainConfig, IngestCost } from "@/brain/types";
import type { LLMClient, LLMCall, LLMResponse } from "@/brain/llm";

interface FakePage {
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash?: string;
}

class FakeCompileEngine {
  pages = new Map<string, FakePage>();
  timelines = new Map<string, Array<{ date: string; source?: string; summary: string; detail?: string }>>();
  links: Array<{ from: string; to: string; context?: string | null; linkType?: string }> = [];
  chunks = new Map<string, Array<{ chunk_text: string; chunk_source: string }>>();

  async transaction<T>(fn: (engine: FakeCompileEngine) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async getPage(slug: string): Promise<FakePage | null> {
    return this.pages.get(slug) ?? null;
  }

  async putPage(slug: string, page: Omit<FakePage, "slug">): Promise<void> {
    this.pages.set(slug, { slug, ...page });
  }

  async upsertChunks(
    slug: string,
    chunks: Array<{ chunk_text: string; chunk_source: string }>,
  ): Promise<void> {
    this.chunks.set(slug, chunks);
  }

  async getTimeline(
    slug: string,
  ): Promise<Array<{ date: string; source?: string; summary: string; detail?: string }>> {
    return this.timelines.get(slug) ?? [];
  }

  async addTimelineEntry(
    slug: string,
    entry: { date: string; source?: string; summary: string; detail?: string },
  ): Promise<void> {
    const rows = this.timelines.get(slug) ?? [];
    rows.push(entry);
    this.timelines.set(slug, rows);
  }

  async addLink(
    from: string,
    to: string,
    context?: string | null,
    linkType?: string,
  ): Promise<void> {
    this.links.push({ from, to, context, linkType });
  }
}

const config: BrainConfig = {
  root: "/tmp/brain",
  extractionModel: "test-extract",
  synthesisModel: "test-synth",
  rippleCap: 15,
  paperWatchBudget: 50,
  serendipityRate: 0.2,
};

function cost(model = "test"): IngestCost {
  return { inputTokens: 1, outputTokens: 1, estimatedUsd: 0, model };
}

function mcsLLM(): LLMClient {
  return {
    complete: vi.fn(async (call: LLMCall): Promise<LLMResponse> => {
      if (call.user.includes("Extract source claims")) {
        return {
          content: JSON.stringify({
            claims: [
              {
                text: "RLHF optimizes reward models into deceptive alignment.",
                source: "papers/deceptive-rlhf",
              },
            ],
          }),
          cost: cost(call.model),
        };
      }
      if (call.user.includes("Extract compiled truth claims")) {
        return {
          content: JSON.stringify({
            claims: [
              {
                text: "RLHF is the dominant alignment approach.",
                source: "concepts/rlhf-alignment",
              },
            ],
          }),
          cost: cost(call.model),
        };
      }
      if (call.user.includes("Compare claims")) {
        return {
          content: JSON.stringify({
            contradictions: [
              {
                new_claim: "RLHF optimizes reward models into deceptive alignment.",
                existing_claim: "RLHF is the dominant alignment approach.",
                new_source: "papers/deceptive-rlhf",
                existing_source: "concepts/rlhf-alignment",
                severity: "critical",
                confidence: 0.92,
                implication: "Treat RLHF as contested rather than settled.",
              },
            ],
          }),
          cost: cost(call.model),
        };
      }
      return {
        content: JSON.stringify({
          compiled_truth:
            "RLHF remains central in alignment practice, but the current view is contested: new evidence argues reward-model optimization can encourage deceptive alignment.",
        }),
        cost: cost(call.model),
      };
    }),
  };
}

describe("compilePage", () => {
  it("updates compiled truth, writes typed links, and surfaces contradictions", async () => {
    const engine = new FakeCompileEngine();
    engine.pages.set("concepts/rlhf-alignment", {
      slug: "concepts/rlhf-alignment",
      type: "concept",
      title: "RLHF alignment",
      compiled_truth: "RLHF is the dominant alignment approach.",
      timeline: "",
      frontmatter: { project: "alignment" },
    });
    engine.timelines.set("concepts/rlhf-alignment", [
      {
        date: "2026-04-17",
        source: "papers/alignment-survey",
        summary: "RLHF treated as the settled default.",
        detail: "Prior view before the new paper landed.",
      },
    ]);
    engine.pages.set("papers/deceptive-rlhf", {
      slug: "papers/deceptive-rlhf",
      type: "paper",
      title: "Deceptive RLHF",
      compiled_truth: "RLHF optimizes reward models into deceptive alignment.",
      timeline: "",
      frontmatter: { project: "alignment" },
    });

    const evidence: CompileEvidence = {
      sourceSlug: "papers/deceptive-rlhf",
      sourceTitle: "Deceptive RLHF",
      content: "RLHF optimizes reward models into deceptive alignment.",
    };
    const llm = mcsLLM();

    const result = await compilePage(
      "concepts/rlhf-alignment",
      evidence,
      config,
      llm,
      {
        engine: engine as never,
        now: () => new Date("2026-04-18T08:30:00.000Z"),
        getUserHandle: () => "@test-researcher",
      },
    );

    const updated = engine.pages.get("concepts/rlhf-alignment");
    expect(updated?.compiled_truth).toContain("contested");
    expect(updated?.frontmatter).toMatchObject({
      compiled_by: "@test-researcher",
      contradictions_open: 1,
    });
    expect(engine.timelines.get("concepts/rlhf-alignment")).toContainEqual(
      expect.objectContaining({
        date: "2026-04-18",
        source: "papers/deceptive-rlhf",
      }),
    );
    expect(engine.links).toEqual([
      expect.objectContaining({
        from: "concepts/rlhf-alignment",
        to: "papers/deceptive-rlhf",
        linkType: "cites",
      }),
      expect.objectContaining({
        from: "papers/deceptive-rlhf",
        to: "concepts/rlhf-alignment",
        linkType: "contradicts",
      }),
    ]);
    expect(engine.chunks.get("concepts/rlhf-alignment")?.[0]?.chunk_text).toContain("contested");
    expect(
      vi.mocked(llm.complete).mock.calls.some(([call]) =>
        call.user.includes("Prior timeline evidence"),
      ),
    ).toBe(true);
    expect(result.contradictions).toHaveLength(1);
    expect(result.backlinksAdded).toBe(2);
    expect(result.timelineEntriesAdded).toBe(1);
  });

  it("falls back to deterministic claim checks when the local model does not return JSON", async () => {
    const engine = new FakeCompileEngine();
    engine.pages.set("concepts/aav9-liver-tropism", {
      slug: "concepts/aav9-liver-tropism",
      type: "concept",
      title: "AAV9 liver tropism",
      compiled_truth: "AAV9 improves liver transduction in adult mice.",
      timeline: "",
      frontmatter: { project: "vectors" },
    });
    engine.pages.set("papers/aav9-null-result", {
      slug: "papers/aav9-null-result",
      type: "paper",
      title: "AAV9 null result",
      compiled_truth: "AAV9 does not improve liver transduction in adult mice.",
      timeline: "",
      frontmatter: { project: "vectors" },
    });

    const llm: LLMClient = {
      complete: vi.fn(async (call: LLMCall): Promise<LLMResponse> => ({
        content: call.user.includes("Rewrite compiled truth")
          ? JSON.stringify({
              compiled_truth:
                "AAV9 liver tropism is now contested because new evidence does not improve liver transduction in adult mice.",
            })
          : "I cannot produce strict JSON for this local request.",
        cost: cost(call.model),
      })),
    };

    const result = await compilePage(
      "concepts/aav9-liver-tropism",
      {
        sourceSlug: "papers/aav9-null-result",
        sourceTitle: "AAV9 null result",
        content: "AAV9 does not improve liver transduction in adult mice.",
      },
      config,
      llm,
      {
        engine: engine as never,
        now: () => new Date("2026-04-18T08:30:00.000Z"),
        getUserHandle: () => "@test-researcher",
      },
    );

    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]).toMatchObject({
      newClaim: "AAV9 does not improve liver transduction in adult mice.",
      existingClaim: "AAV9 improves liver transduction in adult mice.",
    });
    expect(engine.links).toContainEqual(
      expect.objectContaining({
        from: "papers/aav9-null-result",
        to: "concepts/aav9-liver-tropism",
        linkType: "contradicts",
      }),
    );
  });
});
