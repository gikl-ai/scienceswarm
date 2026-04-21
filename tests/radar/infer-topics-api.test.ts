/**
 * Contract tests for GET /api/radar/infer-topics
 *
 * The endpoint calls inferTopicsFromBrain() and returns up to 5 topics.
 * It never returns an error status — degrades to empty topics on any failure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mocks ─────────────────────────────────────────────
// Mock the brain store module
vi.mock("@/brain/store", () => ({
  getBrainStore: vi.fn(),
  ensureBrainStoreReady: vi.fn(),
}))

// Mock the shared brain config helper
vi.mock("@/app/api/brain/_shared", () => ({
  getBrainConfig: vi.fn(),
  getLLMClient: vi.fn(),
  isErrorResponse: vi.fn((v: unknown) => v instanceof Response),
}))

// Mock the inferTopicsFromBrain function
vi.mock("@/lib/radar/infer-topics", () => ({
  inferTopicsFromBrain: vi.fn(),
}))

// Import after mocks are set up
import { GET } from "@/app/api/radar/infer-topics/route"
import { getBrainStore, ensureBrainStoreReady } from "@/brain/store"
import { getBrainConfig, getLLMClient } from "@/app/api/brain/_shared"
import { inferTopicsFromBrain } from "@/lib/radar/infer-topics"
import type { RadarTopic } from "@/lib/radar/types"

const mockGetBrainConfig = vi.mocked(getBrainConfig)
const mockGetLLMClient = vi.mocked(getLLMClient)
const mockGetBrainStore = vi.mocked(getBrainStore)
const mockEnsureBrainStoreReady = vi.mocked(ensureBrainStoreReady)
const mockInferTopics = vi.mocked(inferTopicsFromBrain)

function makeRequest(): Request {
  return new Request("http://localhost/api/radar/infer-topics")
}

describe("GET /api/radar/infer-topics", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns inferred topics from the brain", async () => {
    const topics: RadarTopic[] = [
      { name: "mechanistic interpretability", description: "Circuit analysis", weight: 0.9, origin: "inferred" },
      { name: "agent evaluation", description: "Benchmarking agents", weight: 0.8, origin: "inferred" },
    ]

    mockGetBrainConfig.mockReturnValue({ root: "/brain" } as ReturnType<typeof getBrainConfig>)
    mockGetLLMClient.mockReturnValue({ complete: vi.fn() } as unknown as ReturnType<typeof getLLMClient>)
    mockEnsureBrainStoreReady.mockResolvedValue(undefined)
    mockGetBrainStore.mockReturnValue({} as ReturnType<typeof getBrainStore>)
    mockInferTopics.mockResolvedValue(topics)

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.topics).toHaveLength(2)
    expect(body.topics[0].name).toBe("mechanistic interpretability")
    expect(body.topics[1].name).toBe("agent evaluation")
  })

  it("caps topics at 5", async () => {
    const topics: RadarTopic[] = Array.from({ length: 8 }, (_, i) => ({
      name: `topic-${i}`,
      description: `Description ${i}`,
      weight: 0.9 - i * 0.1,
      origin: "inferred" as const,
    }))

    mockGetBrainConfig.mockReturnValue({ root: "/brain" } as ReturnType<typeof getBrainConfig>)
    mockGetLLMClient.mockReturnValue({ complete: vi.fn() } as unknown as ReturnType<typeof getLLMClient>)
    mockEnsureBrainStoreReady.mockResolvedValue(undefined)
    mockGetBrainStore.mockReturnValue({} as ReturnType<typeof getBrainStore>)
    mockInferTopics.mockResolvedValue(topics)

    const res = await GET(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.topics).toHaveLength(5)
    expect(body.topics[0].name).toBe("topic-0")
  })

  it("returns empty topics when brain config is unavailable", async () => {
    mockGetBrainConfig.mockReturnValue(
      Response.json(
        {
          error: "No research brain is initialized yet.",
          code: "brain_not_initialized",
        },
        { status: 503 },
      ),
    )

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.topics).toEqual([])
  })

  it("returns empty topics when brain store initialization fails", async () => {
    mockGetBrainConfig.mockReturnValue({ root: "/brain" } as ReturnType<typeof getBrainConfig>)
    mockGetLLMClient.mockReturnValue({ complete: vi.fn() } as unknown as ReturnType<typeof getLLMClient>)
    mockEnsureBrainStoreReady.mockRejectedValue(new Error("PGLite unavailable"))

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.topics).toEqual([])
  })

  it("returns empty topics when inferTopicsFromBrain throws", async () => {
    mockGetBrainConfig.mockReturnValue({ root: "/brain" } as ReturnType<typeof getBrainConfig>)
    mockGetLLMClient.mockReturnValue({ complete: vi.fn() } as unknown as ReturnType<typeof getLLMClient>)
    mockEnsureBrainStoreReady.mockResolvedValue(undefined)
    mockGetBrainStore.mockReturnValue({} as ReturnType<typeof getBrainStore>)
    mockInferTopics.mockRejectedValue(new Error("LLM call failed"))

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.topics).toEqual([])
  })

  it("returns empty topics when OpenAI key is missing (getLLMClient throws)", async () => {
    mockGetBrainConfig.mockReturnValue({ root: "/brain" } as ReturnType<typeof getBrainConfig>)
    mockGetLLMClient.mockImplementation(() => {
      throw new Error("Missing OPENAI_API_KEY")
    })

    const res = await GET(makeRequest())
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.topics).toEqual([])
  })
})
