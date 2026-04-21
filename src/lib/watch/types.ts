export type WatchSourceType = "rss" | "arxiv" | "web_search" | "twitter" | "discord" | "slack";
export type WatchExecutionMode = "openclaw" | "native";
export type WatchDeliveryChannel = "telegram" | "slack" | "web" | "discord" | "line" | "sms" | "whatsapp";

export interface ProjectWatchSchedule {
  enabled: boolean;
  cadence: "daily" | "weekdays" | "weekly";
  time: string;
  timezone: string;
  daysOfWeek?: number[];
  dayOfWeek?: number;
  schedulerJobId?: string;
}

export interface ProjectWatchSource {
  id: string;
  type: WatchSourceType;
  enabled?: boolean;
  label?: string;
  url?: string;
  query?: string;
  limit?: number;
}

export interface ProjectWatchConfig {
  version: 1;
  objective?: string;
  compiledPrompt?: string;
  searchQueries?: string[];
  executionMode?: WatchExecutionMode;
  deliveryChannel?: WatchDeliveryChannel;
  lastRun?: {
    at: string;
    mode: WatchExecutionMode;
    resultPath?: string;
    error?: string;
  };
  schedule?: ProjectWatchSchedule;
  keywords: string[];
  promotionThreshold: number;
  stagingThreshold: number;
  sources: ProjectWatchSource[];
}

export interface WatchCandidate {
  dedupeKey: string;
  title: string;
  summary: string;
  url: string;
  sourceLabel: string;
  publishedAt?: string;
}

export interface RankedWatchItem extends WatchCandidate {
  score: number;
  reasons: string[];
  status: "staged" | "promoted";
}
