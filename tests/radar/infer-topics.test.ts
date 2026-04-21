import { describe, it, expect, vi } from "vitest"
import { inferTopicsFromBrain } from "@/lib/radar/infer-topics"
import type { BrainStore } from "@/brain/store"
import type { SearchResult } from "@/brain/types"

function mockBrainStore(results: SearchResult[]): BrainStore {
  return {
    search: vi.fn().mockResolvedValue(results),
    getPage: vi.fn().mockResolvedValue(null),
    importCorpus: vi.fn(),
    listPages: vi.fn().mockResolvedValue([]),
    health: vi.fn().mockResolvedValue({ ok: true, pageCount: 10 }),
    dispose: vi.fn(),
  } as unknown as BrainStore
}

describe("inferTopicsFromBrain", () => {
  it("extracts topics from brain search results", async () => {
    const store = mockBrainStore([
      {
        relevance: 0.9,
        title: "Mechanistic Interpretability Notes",
        snippet: "Circuit-level analysis of transformer attention heads",
        path: "projects/mech-interp.md",
        type: "project",
      },
      {
        relevance: 0.8,
        title: "Agent Evaluation Framework",
        snippet: "Benchmarking autonomous agents on real-world tasks",
        path: "projects/agent-evals.md",
        type: "project",
      },
    ])

    const mockLLM = {
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            name: "mechanistic interpretability",
            description: "Circuit-level analysis of transformer attention heads",
            weight: 0.9,
          },
          {
            name: "agent evaluation",
            description: "Benchmarking autonomous agents on real-world tasks",
            weight: 0.8,
          },
        ])
      ),
    }

    const topics = await inferTopicsFromBrain(store, mockLLM)

    expect(topics).toHaveLength(2)
    expect(topics[0].name).toBe("mechanistic interpretability")
    expect(topics[0].origin).toBe("inferred")
    expect(topics[0].weight).toBeGreaterThan(0)
    expect(topics[1].name).toBe("agent evaluation")
  })

  it("returns empty array when brain is empty", async () => {
    const store = mockBrainStore([])
    const mockLLM = {
      generate: vi.fn().mockResolvedValue("[]"),
    }

    const topics = await inferTopicsFromBrain(store, mockLLM)
    expect(topics).toEqual([])
  })

  it("merges user prompt topics with inferred topics", async () => {
    const store = mockBrainStore([
      {
        relevance: 0.9,
        title: "Scaling Laws Research",
        snippet: "Neural scaling laws and compute-optimal training",
        path: "projects/scaling.md",
        type: "project",
      },
    ])

    const mockLLM = {
      generate: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            name: "scaling laws",
            description: "Neural scaling laws and compute-optimal training",
            weight: 0.9,
          },
        ])
      ),
    }

    const topics = await inferTopicsFromBrain(
      store,
      mockLLM,
      "Also watch sparse autoencoders"
    )

    expect(topics.length).toBeGreaterThanOrEqual(2)
    const names = topics.map((t) => t.name.toLowerCase())
    expect(names).toContain("scaling laws")
    const saeTopic = topics.find((t) =>
      t.name.toLowerCase().includes("sparse autoencoder")
    )
    expect(saeTopic).toBeDefined()
    expect(saeTopic!.origin).toBe("user")
  })
})
