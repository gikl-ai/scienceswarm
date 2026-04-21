/**
 * Second Brain — Public API
 *
 * This is the shared engine that both MCP server and REST API wrap.
 * No Next.js imports — pure Node.js.
 */

export { search } from "./search";
export { ripple } from "./ripple";
export { loadBrainConfig, resolveBrainRoot, brainExists } from "./config";
export { initBrain } from "./init";
export { createLLMClient } from "./llm";
export { aggregateCosts, getMonthCost, isBudgetExceeded, logEvent, getRecentEvents } from "./cost";
export { getBrainStore, resetBrainStore } from "./store";
export { compilePage } from "./compile-page";
export { compileAffectedConceptsForSource } from "./compile-affected";

export { buildChatContext, formatBrainPrompt, extractKeywords, estimateTokens } from "./chat-context";
export { injectBrainContext } from "./chat-inject";

export type * from "./types";
export type { ChatContext } from "./chat-context";
export type { LLMClient, LLMCall, LLMResponse } from "./llm";
export type {
  BrainStore,
  BrainPage,
  BrainLink,
  BrainTimelineEntry,
  ImportResult,
} from "./store";
export type {
  CompileEvidence,
  CompilePageResult,
  CompileContradiction,
  CompileClaim,
} from "./compile-page";
