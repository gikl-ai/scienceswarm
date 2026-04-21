import { injectBrainContext } from "@/brain/chat-inject";
import { isStrictLocalOnlyEnabled } from "@/lib/env-flags";
import { getOpenAIClient, getOpenAIModel } from "@/lib/openai-client";
import {
  isLocalProviderConfigured,
  completeLocal,
  streamLocal,
} from "@/lib/local-llm";
import type OpenAI from "openai";

const SYSTEM_PROMPT = `You are ScienceSwarm, an AI research assistant for scientific projects. You help researchers build, run, and publish their work end to end.

Your research pipeline:
📄 Literature Review → 🔬 Hypothesis → 🧪 Experiments → 📊 Analysis → ✏️ Writing → 📋 Review → 🚀 Submit

Your capabilities:
- **Paper analysis**: Read uploaded papers deeply. Quote specific theorems, definitions, equations. Identify gaps, open problems, and connections to the user's work.
- **Literature review**: Compare papers, find common themes, identify contradictions, suggest missing references.
- **Experiment design**: Help design experiments, suggest parameters, predict outcomes, analyze results.
- **Data analysis**: Interpret statistical results, suggest visualizations, identify patterns and anomalies.
- **Paper writing**: Help draft sections, improve clarity, suggest structure, check mathematical notation.
- **Code review**: Review research code for correctness, efficiency, reproducibility.
- **Proof assistance**: Help develop mathematical proofs, check logical steps, suggest proof strategies.

Your personality:
- You are a sharp research collaborator, not a generic assistant.
- Be specific: cite page numbers, theorem numbers, equation numbers from uploaded papers.
- When analyzing results, give concrete statistical interpretations, not vague summaries.
- Ask ONE question at a time when clarifying.
- When the user uploads a paper, read it thoroughly and summarize: key contributions, methodology, results, limitations, and relevance to the current project.
- When reviewing code, focus on scientific correctness (wrong formula, off-by-one in indices, numerical stability) over style.
- When helping write, match academic tone and be precise with technical language.

Format: Use **bold** for key findings. Use bullet points for structured analysis. Include specific references (Theorem 3.2, Equation 7, Figure 4) when discussing papers.`;

export interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  files?: Array<{ name: string; size: string }>;
  channel: "web" | "mobile" | "telegram" | "slack";
  maxTokens?: number;
  projectId?: string | null;
}

async function buildMessages(
  req: ChatRequest
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  const lastUserMessage =
    [...req.messages]
      .reverse()
      .find((m) => m.role === "user")?.content ?? "";
  const system: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: await injectBrainContext(
        SYSTEM_PROMPT,
        lastUserMessage,
        req.projectId ?? undefined,
        { disableBackgroundEntityDetection: isLocalProviderConfigured() },
      ),
    },
  ];

  if (req.files && req.files.length > 0) {
    const fileNames = req.files
      .map((f) => `${f.name} (${f.size})`)
      .join(", ");
    system.push({
      role: "system",
      content: `The user has uploaded files: ${fileNames}. The full file contents have been provided in the conversation. Analyze them deeply when asked. Quote specific sections, identify gaps, reference page numbers or sections.`,
    });
  }

  return [
    ...system,
    ...req.messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
      switch (m.role) {
        case "system":
          return { role: "system", content: m.content };
        case "assistant":
          return { role: "assistant", content: m.content };
        default:
          return { role: "user", content: m.content };
      }
    }),
  ];
}

const channelMaxTokens: Record<string, number> = {
  web: 2048,
  mobile: 2048,
  telegram: 4096,
  slack: 3000,
};

function assertStrictLocalOnlyPath(): void {
  if (isStrictLocalOnlyEnabled() && !isLocalProviderConfigured()) {
    throw new Error(
      "Strict local-only mode is enabled. Set LLM_PROVIDER=local and configure a local Ollama model in Settings before chatting.",
    );
  }
}

function getModel(): string {
  return getOpenAIModel();
}

/** Streaming response via local Ollama model (returns SSE ReadableStream) */
function streamLocalChat(
  messages: Array<{ role: string; content: string }>,
): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamLocal(messages)) {
          if (typeof chunk.thinking === "string" && chunk.thinking.length > 0) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ thinking: chunk.thinking })}\n\n`),
            );
          }
          if (typeof chunk.text === "string" && chunk.text.length > 0) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: chunk.text })}\n\n`),
            );
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stream error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
        );
        controller.close();
      }
    },
  });
}

/** Streaming response for web/mobile (returns SSE ReadableStream) */
export async function streamChat(req: ChatRequest): Promise<ReadableStream> {
  assertStrictLocalOnlyPath();
  const messages = await buildMessages(req);

  // Use local model when LLM_PROVIDER=local
  if (isLocalProviderConfigured()) {
    return streamLocalChat(
      messages.map((m) => ({ role: m.role as string, content: typeof m.content === "string" ? m.content : "" })),
    );
  }

  const openai = getOpenAIClient();
  const maxTokens = req.maxTokens || channelMaxTokens[req.channel] || 2048;

  const stream = await openai.chat.completions.create({
    model: getModel(),
    messages,
    stream: true,
    max_completion_tokens: maxTokens,
    temperature: 0.7,
  });

  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta?.content;
          if (text) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text })}\n\n`)
            );
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stream error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`)
        );
        controller.close();
      }
    },
  });
}

/** Complete response for bots (returns full text string) */
export async function completeChat(req: ChatRequest): Promise<string> {
  assertStrictLocalOnlyPath();
  const messages = await buildMessages(req);

  // Use local model when LLM_PROVIDER=local
  if (isLocalProviderConfigured()) {
    return completeLocal(
      messages.map((m) => ({ role: m.role as string, content: typeof m.content === "string" ? m.content : "" })),
    );
  }

  const openai = getOpenAIClient();
  const maxTokens = req.maxTokens || channelMaxTokens[req.channel] || 2048;

  const response = await openai.chat.completions.create({
    model: getModel(),
    messages,
    stream: false,
    max_completion_tokens: maxTokens,
    temperature: 0.7,
  });

  return response.choices[0]?.message?.content || "";
}
