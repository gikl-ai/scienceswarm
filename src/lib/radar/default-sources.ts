import type { RadarSource, RadarTopic } from "./types"

interface SourceTemplate {
  id: string
  type: RadarSource["type"]
  adapter: RadarSource["adapter"]
  url?: string
  query?: string
}

const ALWAYS_SOURCES: SourceTemplate[] = [
  { id: "arxiv-cs-ai", type: "arxiv", adapter: "semantic-scholar", query: "cs.AI" },
  { id: "arxiv-cs-lg", type: "arxiv", adapter: "semantic-scholar", query: "cs.LG" },
  { id: "reddit-ml", type: "reddit", adapter: "reddit-api", url: "r/MachineLearning" },
]

const TOPIC_SOURCE_MAP: Record<string, SourceTemplate[]> = {
  interpretability: [
    { id: "arxiv-cs-cl", type: "arxiv", adapter: "semantic-scholar", query: "cs.CL" },
  ],
  safety: [
    { id: "reddit-aisafety", type: "reddit", adapter: "reddit-api", url: "r/aisafety" },
  ],
  agent: [
    { id: "arxiv-cs-ma", type: "arxiv", adapter: "semantic-scholar", query: "cs.MA" },
  ],
  reinforcement: [
    { id: "arxiv-cs-rl", type: "arxiv", adapter: "semantic-scholar", query: "cs.AI reinforcement learning" },
  ],
  vision: [
    { id: "arxiv-cs-cv", type: "arxiv", adapter: "semantic-scholar", query: "cs.CV" },
  ],
  nlp: [
    { id: "arxiv-cs-cl-nlp", type: "arxiv", adapter: "semantic-scholar", query: "cs.CL" },
  ],
  robotics: [
    { id: "arxiv-cs-ro", type: "arxiv", adapter: "semantic-scholar", query: "cs.RO" },
  ],
}

function matchesKeyword(topic: RadarTopic, keyword: string): boolean {
  const text = `${topic.name} ${topic.description}`.toLowerCase()
  return text.includes(keyword.toLowerCase())
}

export function defaultSourcesForTopics(topics: RadarTopic[]): RadarSource[] {
  const seen = new Set<string>()
  const sources: RadarSource[] = []

  function addSource(template: SourceTemplate): void {
    if (seen.has(template.id)) return
    seen.add(template.id)
    sources.push({ ...template, enabled: true })
  }

  for (const s of ALWAYS_SOURCES) {
    addSource(s)
  }

  for (const topic of topics) {
    for (const [keyword, templates] of Object.entries(TOPIC_SOURCE_MAP)) {
      if (matchesKeyword(topic, keyword)) {
        for (const t of templates) {
          addSource(t)
        }
      }
    }
  }

  return sources
}
