/**
 * Deepgram client — STT (speech-to-text) and TTS (text-to-speech)
 *
 * Uses the Deepgram REST API with the owner API key from DEEPGRAM_OWNER_API_KEY.
 * Docs: https://developers.deepgram.com/reference
 */

// ── Config ───────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.DEEPGRAM_OWNER_API_KEY;
  if (!key) throw new Error("DEEPGRAM_OWNER_API_KEY is not set");
  return key;
}

const STT_URL = "https://api.deepgram.com/v1/listen";
const TTS_URL = "https://api.deepgram.com/v1/speak";

// ── STT (Speech-to-Text) ────────────────────────────────────────

export interface TranscribeOptions {
  /** Audio MIME type, e.g. "audio/webm", "audio/wav" */
  mimeType?: string;
  /** Language code, defaults to "en" */
  language?: string;
  /** Model to use, defaults to "nova-3" */
  model?: string;
  /** Enable smart formatting (punctuation, capitalization) */
  smartFormat?: boolean;
}

export interface TranscribeResult {
  transcript: string;
  confidence: number;
  durationSec: number;
  words: Array<{ word: string; start: number; end: number; confidence: number }>;
}

/**
 * Transcribe an audio buffer to text using Deepgram's STT API.
 */
export async function transcribe(
  audio: Buffer | Uint8Array,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const {
    mimeType = "audio/webm",
    language = "en",
    model = "nova-3",
    smartFormat = true,
  } = options;

  const params = new URLSearchParams({
    model,
    language,
    smart_format: String(smartFormat),
    punctuate: "true",
  });

  const res = await fetch(`${STT_URL}?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${getApiKey()}`,
      "Content-Type": mimeType,
    },
    body: audio as unknown as BodyInit,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Deepgram STT error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const alt = data?.results?.channels?.[0]?.alternatives?.[0];

  return {
    transcript: alt?.transcript ?? "",
    confidence: alt?.confidence ?? 0,
    durationSec: data?.metadata?.duration ?? 0,
    words: (alt?.words ?? []).map(
      (w: { word: string; start: number; end: number; confidence: number }) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence,
      }),
    ),
  };
}

// ── TTS (Text-to-Speech) ────────────────────────────────────────

export interface SpeakOptions {
  /** Voice model, defaults to "aura-2-asteria-en" */
  model?: string;
  /** Output encoding, defaults to "mp3" */
  encoding?: string;
  /** Sample rate in Hz */
  sampleRate?: number;
}

/**
 * Convert text to speech using Deepgram's TTS API.
 * Returns the raw audio buffer and its content type.
 */
export async function speak(
  text: string,
  options: SpeakOptions = {},
): Promise<{ audio: Buffer; contentType: string }> {
  const {
    model = "aura-2-asteria-en",
    encoding = "mp3",
    sampleRate,
  } = options;

  const params = new URLSearchParams({ model, encoding });
  if (sampleRate) params.set("sample_rate", String(sampleRate));

  const res = await fetch(`${TTS_URL}?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Deepgram TTS error ${res.status}: ${errText}`);
  }

  const contentType = res.headers.get("content-type") ?? `audio/${encoding}`;
  const arrayBuffer = await res.arrayBuffer();

  return {
    audio: Buffer.from(arrayBuffer),
    contentType,
  };
}
