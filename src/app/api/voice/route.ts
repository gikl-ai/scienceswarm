/**
 * POST /api/voice
 *
 * Voice endpoint for Deepgram STT and TTS.
 *
 * Actions (via query param or form field):
 *   ?action=transcribe  — audio file in, transcript text out
 *   ?action=speak        — JSON { text } in, audio stream out
 *   ?action=converse     — audio file in, chat via OpenClaw/NanoClaw, audio response out
 */

import { transcribe, speak, type TranscribeOptions } from "@/lib/deepgram";
import { checkRateLimit } from "@/lib/rate-limit";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// ── Transcribe: audio → text ─────────────────────────────────────

async function handleTranscribe(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";

  let audioBuffer: Buffer;
  let mimeType = "audio/webm";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("audio");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "Missing audio file in form data" }, { status: 400 });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return Response.json({ error: "Audio file exceeds 25 MB limit" }, { status: 413 });
    }
    mimeType = file.type || "audio/webm";
    audioBuffer = Buffer.from(await file.arrayBuffer());
  } else {
    // Raw audio body
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_AUDIO_BYTES) {
      return Response.json({ error: "Audio file exceeds 25 MB limit" }, { status: 413 });
    }
    mimeType = contentType || "audio/webm";
    audioBuffer = Buffer.from(await request.arrayBuffer());
    if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
      return Response.json({ error: "Audio file exceeds 25 MB limit" }, { status: 413 });
    }
  }

  if (audioBuffer.byteLength === 0) {
    return Response.json({ error: "Empty audio body" }, { status: 400 });
  }

  const options: TranscribeOptions = { mimeType };
  const result = await transcribe(audioBuffer, options);

  return Response.json({
    transcript: result.transcript,
    confidence: result.confidence,
    durationSec: result.durationSec,
    words: result.words,
  });
}

// ── Speak: text → audio ──────────────────────────────────────────

async function handleSpeak(request: Request): Promise<Response> {
  const body = await request.json();
  const { text, model, encoding } = body as {
    text?: string;
    model?: string;
    encoding?: string;
  };

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return Response.json({ error: "Missing required field: text" }, { status: 400 });
  }

  if (text.length > 2000) {
    return Response.json({ error: "Text exceeds 2000 character limit" }, { status: 413 });
  }

  const result = await speak(text.trim(), { model, encoding });

  return new Response(result.audio as unknown as BodyInit, {
    headers: {
      "Content-Type": result.contentType,
      "Content-Length": String(result.audio.byteLength),
      "Cache-Control": "no-cache",
    },
  });
}

// ── Converse: audio → chat → audio ──────────────────────────────

async function handleConverse(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";

  let audioBuffer: Buffer;
  let mimeType = "audio/webm";
  let ttsModel: string | undefined;

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("audio");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "Missing audio file in form data" }, { status: 400 });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return Response.json({ error: "Audio file exceeds 25 MB limit" }, { status: 413 });
    }
    mimeType = file.type || "audio/webm";
    audioBuffer = Buffer.from(await file.arrayBuffer());
    const modelField = formData.get("ttsModel");
    if (typeof modelField === "string") ttsModel = modelField;
  } else {
    return Response.json(
      { error: "Converse requires multipart/form-data with an audio field" },
      { status: 400 },
    );
  }

  if (audioBuffer.byteLength === 0) {
    return Response.json({ error: "Empty audio body" }, { status: 400 });
  }

  // 1. Transcribe
  const sttResult = await transcribe(audioBuffer, { mimeType });
  if (!sttResult.transcript.trim()) {
    return Response.json(
      { error: "Could not transcribe audio — no speech detected" },
      { status: 422 },
    );
  }

  // 2. Send transcript through unified chat endpoint (internal fetch)
  // Always use the request's own origin so we hit the running server,
  // not NEXTAUTH_URL which may point to a different port.
  const chatBaseUrl = new URL(request.url).origin;
  const chatUrl = `${chatBaseUrl}/api/chat/unified`;

  const chatRes = await fetch(chatUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: sttResult.transcript,
      messages: [{ role: "user", content: sttResult.transcript }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  let assistantText: string;
  const chatBackend = chatRes.headers.get("X-Chat-Backend");

  if (chatBackend === "direct") {
    // SSE stream — collect all chunks
    const reader = chatRes.body?.getReader();
    if (!reader) {
      return Response.json({ error: "No chat response stream" }, { status: 502 });
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const chunks: string[] = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) chunks.push(parsed.text);
          } catch { /* skip */ }
        }
      }
    }
    assistantText = chunks.join("");
  } else {
    if (!chatRes.ok) {
      const errText = await chatRes.text().catch(() => "");
      return Response.json(
        { error: `Chat backend error: ${errText || chatRes.status}` },
        { status: 502 },
      );
    }
    const chatData = await chatRes.json();
    assistantText = chatData.response ?? "";
  }

  if (!assistantText.trim()) {
    return Response.json(
      { transcript: sttResult.transcript, response: "", error: "Empty chat response" },
      { status: 200 },
    );
  }

  // 3. TTS the response
  const ttsResult = await speak(assistantText.slice(0, 2000), { model: ttsModel });

  // Return JSON with base64 audio + metadata
  return Response.json({
    transcript: sttResult.transcript,
    response: assistantText,
    audio: ttsResult.audio.toString("base64"),
    audioContentType: ttsResult.contentType,
    sttConfidence: sttResult.confidence,
    sttDurationSec: sttResult.durationSec,
  });
}

// ── Route handler ────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    if (!process.env.DEEPGRAM_OWNER_API_KEY) {
      return Response.json(
        { error: "Deepgram is not configured. Set DEEPGRAM_OWNER_API_KEY in .env" },
        { status: 503 },
      );
    }

    const ip = getClientIp(request);
    const rl = checkRateLimit(ip, "web");
    if (!rl.allowed) {
      return Response.json(
        { error: "Rate limit exceeded. Try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(rl.resetMs / 1000)),
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }

    const url = new URL(request.url);
    const action = url.searchParams.get("action") ?? "transcribe";

    switch (action) {
      case "transcribe":
        return await handleTranscribe(request);
      case "speak":
        return await handleSpeak(request);
      case "converse":
        return await handleConverse(request);
      default:
        return Response.json(
          { error: `Unknown action: ${action}. Use transcribe, speak, or converse.` },
          { status: 400 },
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice processing failed";
    console.error("Voice API error:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}
