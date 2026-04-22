// src/lib/radar/types.ts

export interface RadarTopic {
  name: string
  description: string
  weight: number // 0.0–1.0
  origin: "inferred" | "user"
}

export type SourceAdapter =
  | "rsshub"
  | "semantic-scholar"
  | "reddit-api"
  | "bluesky-api"
  | "changedetection"
  | "openclaw-browse"
  | "rss-direct"

export type SourceType =
  | "arxiv"
  | "rss"
  | "twitter"
  | "reddit"
  | "bluesky"
  | "discord"
  | "slack"
  | "web"
  | "browse"

export interface RadarSource {
  id: string
  type: SourceType
  adapter: SourceAdapter
  url?: string
  query?: string
  enabled: boolean
}

export interface RadarFilter {
  type: "exclude-topic" | "language" | "min-relevance"
  value: string
}

export interface RadarSchedule {
  cron: string // e.g., "0 8 * * *"
  timezone: string // e.g., "America/Los_Angeles"
  fetchLeadMinutes: number // default 120
}

export interface RadarChannels {
  telegram: boolean
  dashboard: boolean
  email: boolean // fast-follow, not MVP
}

export interface Radar {
  id: string
  topics: RadarTopic[]
  sources: RadarSource[]
  schedule: RadarSchedule
  channels: RadarChannels
  filters: RadarFilter[]
  createdAt: string
  updatedAt: string
}

export interface Signal {
  id: string
  title: string
  sourceId: string // which RadarSource produced this
  url: string
  timestamp: string
  content: string
  metadata: {
    authors?: string[]
    citations?: number
    tldr?: string
    socialScore?: number
  }
}

export interface RankedSignal extends Signal {
  relevanceScore: number
  matchedTopics: string[] // topic names
  explanation: string // why this matters to the user
}

export type FrontierProgramArea =
  | "hypothesis"
  | "decision"
  | "experiment"
  | "question"
  | "method"
  | "topic"

export interface FrontierProgramMatch {
  area: FrontierProgramArea
  reference: string
  whyThisMatters: string
  recommendedAction: string
  evidence: string[]
  confidence: "low" | "medium" | "high"
}

export interface RadarBriefing {
  id: string
  radarId: string
  generatedAt: string
  matters: Array<{
    signal: RankedSignal
    whyItMatters: string
    programMatches?: FrontierProgramMatch[]
  }>
  horizon: Array<{
    signal: RankedSignal
    whyItMatters: string
    programMatches?: FrontierProgramMatch[]
  }>
  nothingToday: boolean
  quietReason?: string
  stats: {
    signalsFetched: number
    signalsRanked: number
    sourcesQueried: number
    sourcesFailed: string[]
  }
}

export interface RadarFeedback {
  briefingId: string
  signalId: string
  action: "save-to-brain" | "dismiss" | "expand" | "more-like-this" | "less-like-this"
  timestamp: string
}

export const DEFAULT_SCHEDULE: RadarSchedule = {
  cron: "0 6 * * *",
  timezone: "UTC",
  fetchLeadMinutes: 120,
}

export const DEFAULT_CHANNELS: RadarChannels = {
  telegram: false,
  dashboard: true,
  email: false,
}
