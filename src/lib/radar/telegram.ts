// src/lib/radar/telegram.ts
import type { TelegramTextContext } from "@/lib/telegram-capture-handler"
import { getActiveRadar, createRadar } from "./store"
import { defaultSourcesForTopics } from "./default-sources"
import { runRadarPipeline } from "./pipeline"
import { buildProductionFetchers } from "./fetchers/index"
import { ensureBrainStoreReady, getBrainStore } from "@/brain/store"
import { evaluateStrictLocalDestination } from "@/lib/runtime/strict-local-policy"
import { getRadarStateDir } from "@/lib/radar/state-dir"

// ---------------------------------------------------------------------------
// Hybrid intent classifier: deterministic rules (fast) + LLM fallback (smart)
// ---------------------------------------------------------------------------

type RadarIntent =
  | "setup"
  | "status"
  | "on-demand"
  | "save"
  | "add"
  | "remove"

// Stage 1: High-precision deterministic rules.
// These match obvious, unambiguous phrasings with zero latency/cost.
function classifyByRules(text: string): RadarIntent | null {
  const t = text.toLowerCase()

  // save #N — most specific, check first
  if (/\bsave\s+#?\d+\b/.test(t)) return "save"

  // status queries
  if (/\bwhat.{0,10}(on|is).{0,15}radar\b/.test(t)) return "status"

  // setup — contains "radar" + a setup verb
  if (
    /\bradar\b/.test(t) &&
    /\b(set\s*up|create|start|configure|activate)\b/.test(t)
  )
    return "setup"

  // setup — "keep me posted/updated/informed"
  if (/\bkeep\s+me\s+(posted|updated|informed)\b/.test(t)) return "setup"

  // on-demand briefing — explicit "briefing" or "what's new"
  if (/\b(briefing|my\s+briefing)\b/.test(t)) return "on-demand"
  if (/\bwhat.{0,5}(happened|new|changed)\b/.test(t)) return "on-demand"

  // add/remove — explicit radar management
  if (/\b(add|also\s+watch)\b/.test(t) && /\b(radar|topic|source|blog|feed)\b/.test(t))
    return "add"
  if (/\b(stop|drop|remove)\s+(watching|tracking)\b/.test(t)) return "remove"

  return null
}

// Keywords that suggest the message might be radar-related, even if rules
// didn't match. Used to gate the LLM fallback so we don't classify every
// message.
const RADAR_ADJACENT_KEYWORDS =
  /\b(radar|monitor|briefing|research\s+update|field|posted|papers|arxiv|frontier|watch\s+for)\b/i

const INTENT_CLASSIFICATION_PROMPT = `Classify this Telegram message into one of these research radar intents:

- setup: user wants to create or configure their research monitoring radar
- status: user wants to see what their radar is currently tracking
- on-demand: user wants a research briefing right now
- save: user wants to save a specific item from a briefing
- add: user wants to add a topic or source to their radar
- remove: user wants to remove a topic or source from their radar
- none: message is NOT about the research radar feature

Return ONLY a JSON object: {"intent": "...", "confidence": 0.0-1.0}

Message: "{text}"`

const LLM_CONFIDENCE_THRESHOLD = 0.8

async function classifyByLLM(
  text: string,
  llm: { generate(prompt: string): Promise<string> }
): Promise<{ intent: RadarIntent; confidence: number } | null> {
  try {
    const prompt = INTENT_CLASSIFICATION_PROMPT.replace("{text}", () => text)
    const response = await llm.generate(prompt)
    const parsed = JSON.parse(response.trim()) as {
      intent: string
      confidence: number
    }

    if (
      parsed.intent === "none" ||
      parsed.confidence < LLM_CONFIDENCE_THRESHOLD
    ) {
      return null
    }

    const validIntents = new Set<string>([
      "setup", "status", "on-demand", "save", "add", "remove",
    ])
    if (!validIntents.has(parsed.intent)) return null

    return {
      intent: parsed.intent as RadarIntent,
      confidence: parsed.confidence,
    }
  } catch {
    return null
  }
}

// Combined classifier: rules first, LLM fallback for ambiguous messages.
// Returns null if the message is not a radar intent (falls through to
// watch/capture in the Telegram handler).
export async function classifyRadarIntent(
  text: string,
  llm?: { generate(prompt: string): Promise<string> }
): Promise<RadarIntent | null> {
  // Stage 1: deterministic rules (instant, free)
  const ruleResult = classifyByRules(text)
  if (ruleResult) return ruleResult

  // Stage 2: LLM fallback (only if radar-adjacent keywords present)
  if (!RADAR_ADJACENT_KEYWORDS.test(text)) return null
  if (!llm) return null

  const llmResult = await classifyByLLM(text, llm)
  return llmResult?.intent ?? null
}

// Synchronous fast-path for the Telegram handler guard.
// Checks rules only — the full async classification happens inside
// handleRadarMessage.
export function isRadarIntent(text: string): boolean {
  return classifyByRules(text) !== null || RADAR_ADJACENT_KEYWORDS.test(text)
}

async function handleSetup(
  ctx: TelegramTextContext,
  text: string
): Promise<void> {
  const stateDir = getRadarStateDir()

  // Check if radar already exists
  const existing = await getActiveRadar(stateDir)
  if (existing) {
    const topicNames = existing.topics.map((t) => t.name).join(", ")
    await ctx.reply(
      `You already have a radar set up.\n\nTopics: ${topicNames}\n\nSay "what's on my radar" to check status, or "briefing" to get an on-demand update.`
    )
    return
  }

  // Create a simple topic from the user's message
  const topics = [
    {
      name: text.slice(0, 50),
      description: text,
      weight: 0.8 as const,
      origin: "user" as const,
    },
  ]
  const sources = defaultSourcesForTopics(topics)

  const radar = await createRadar(stateDir, { topics, sources })

  const topicNames = radar.topics.map((t) => t.name).join(", ")
  await ctx.reply(
    `Radar set up. I'll monitor:\n${topicNames}\n\nYou'll get a briefing at 8am PT each day. Say "briefing" any time for an on-demand update.`
  )
}

async function handleStatus(ctx: TelegramTextContext): Promise<void> {
  const stateDir = getRadarStateDir()
  const radar = await getActiveRadar(stateDir)

  if (!radar) {
    await ctx.reply(
      `No radar configured yet. Say "set up my radar" or "keep me posted on [your research area]" to get started.`
    )
    return
  }

  const topicLines = radar.topics
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n")
  const sourcesEnabled = radar.sources.filter((s) => s.enabled).length

  await ctx.reply(
    `Your Research Radar\n\nTopics:\n${topicLines}\n\nSources: ${sourcesEnabled} active\nSchedule: Daily at ${radar.schedule.cron} (${radar.schedule.timezone})\n\nSay "briefing" for an on-demand update.`
  )
}

async function handleOnDemand(ctx: TelegramTextContext): Promise<void> {
  const stateDir = getRadarStateDir()
  const radar = await getActiveRadar(stateDir)

  if (!radar) {
    await ctx.reply(
      `No radar configured yet. Say "set up my radar" to get started.`
    )
    return
  }

  await ctx.reply("Running your radar now, give me a moment...")

  try {
    const fetchers = buildProductionFetchers()
    await ensureBrainStoreReady()
    const result = await runRadarPipeline({
      stateDir,
      radarId: radar.id,
      fetchers,
      brainStore: getBrainStore(),
      llm: buildLLMClient(),
    })

    if (!result) {
      await ctx.reply("Could not run radar — configuration missing.")
      return
    }

    await ctx.reply(result.telegram)
  } catch (err) {
    console.error("[radar/telegram] on-demand pipeline error:", err)
    await ctx.reply(
      "Failed to run radar briefing. Check that your sources are reachable."
    )
  }
}

/**
 * Build a minimal LLM client backed by the OpenAI-compatible endpoint
 * configured via environment variables, matching the pattern used elsewhere.
 */
function buildLLMClient(): { generate(prompt: string): Promise<string> } {
  return {
    async generate(prompt: string): Promise<string> {
      const decision = evaluateStrictLocalDestination({
        destination: "openai",
        dataClass: "model-prompt",
        feature: "radar Telegram intent classification",
        privacy: "hosted",
      })
      if (!decision.allowed) {
        return "[]"
      }

      const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY
      const baseUrl =
        process.env.LLM_BASE_URL || "https://api.openai.com/v1"
      const model = process.env.LLM_MODEL || "gpt-4o-mini"

      if (!apiKey) {
        return "[]"
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
        }),
      })

      if (!res.ok) return "[]"

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      return data.choices?.[0]?.message?.content ?? "[]"
    },
  }
}

export async function handleRadarMessage(
  ctx: TelegramTextContext
): Promise<boolean> {
  const text = ctx.message.text
  const llm = buildLLMClient()

  // Full async classification (rules + LLM fallback)
  const intent = await classifyRadarIntent(text, llm)

  if (!intent) {
    // Not a radar intent — tell the caller to continue to next handler
    return false
  }

  switch (intent) {
    case "setup":
      await handleSetup(ctx, text)
      break

    case "status":
      await handleStatus(ctx)
      break

    case "on-demand":
      await handleOnDemand(ctx)
      break

    case "save":
    case "add":
    case "remove":
      await ctx.reply("Coming soon — this radar action is not yet available.")
      break
  }

  return true
}
