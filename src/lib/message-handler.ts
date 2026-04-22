import { isStrictLocalOnlyEnabled } from "@/lib/env-flags";
import { getOpenAIClient, getOpenAIModel } from "@/lib/openai-client";
import {
  buildScienceSwarmPromptContextText,
  buildScienceSwarmSystemPrompt,
  type PromptBackend,
} from "@/lib/scienceswarm-prompt-config";
import {
  isLocalProviderConfigured,
  completeLocal,
  streamLocal,
} from "@/lib/local-llm";
import type OpenAI from "openai";

export interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  files?: Array<{ name: string; size: string }>;
  channel: "web" | "mobile" | "telegram" | "slack";
  maxTokens?: number;
  projectId?: string | null;
  backend?: PromptBackend;
}

async function buildMessages(
  req: ChatRequest
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  const system: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: buildScienceSwarmSystemPrompt(),
    },
  ];
  const leadingUserContext: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const projectPromptContext = await buildScienceSwarmPromptContextText({
    projectId: req.projectId,
    backend: req.backend ?? "none",
  });

  if (projectPromptContext) {
    leadingUserContext.push({
      role: "user",
      content: projectPromptContext,
    });
  }

  if (req.files && req.files.length > 0) {
    leadingUserContext.push({
      role: "user",
      content: [
        "The user explicitly attached these files for this turn:",
        ...req.files.map((file) => `- ${file.name} (${file.size})`),
        "",
        "Only rely on actual file excerpts or file contents if they are provided elsewhere in the conversation.",
      ].join("\n"),
    });
  }

  return [
    ...system,
    ...leadingUserContext,
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
