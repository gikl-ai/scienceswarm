import { beforeEach, describe, expect, it, vi } from "vitest";

const { transcribeMock, speakMock } = vi.hoisted(() => ({
  transcribeMock: vi.fn(),
  speakMock: vi.fn(),
}));

vi.mock("@/lib/deepgram", () => ({
  transcribe: transcribeMock,
  speak: speakMock,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true, resetMs: 0 }),
}));

import { POST } from "@/app/api/voice/route";

function makeFormDataRequest(action: string, audioBlob: Blob): Request {
  const formData = new FormData();
  formData.append("audio", audioBlob, "recording.webm");
  return new Request(`http://localhost/api/voice?action=${action}`, {
    method: "POST",
    body: formData,
  });
}

describe("POST /api/voice", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("DEEPGRAM_OWNER_API_KEY", "test-key");
    transcribeMock.mockReset();
    speakMock.mockReset();
  });

  it("returns 503 when Deepgram key is missing", async () => {
    vi.stubEnv("DEEPGRAM_OWNER_API_KEY", "");

    const request = new Request("http://localhost/api/voice?action=transcribe", {
      method: "POST",
      body: new Blob(["audio"]),
    });
    const res = await POST(request);

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toContain("Deepgram is not configured");
  });

  it("returns 400 for unknown action", async () => {
    const request = new Request("http://localhost/api/voice?action=invalid", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(request);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Unknown action");
  });

  describe("action=transcribe", () => {
    it("transcribes audio from multipart form data", async () => {
      transcribeMock.mockResolvedValueOnce({
        transcript: "test transcript",
        confidence: 0.95,
        durationSec: 2.3,
        words: [{ word: "test", start: 0, end: 0.5, confidence: 0.95 }],
      });

      const audioBlob = new Blob(["fake-audio-data"], { type: "audio/webm" });
      const request = makeFormDataRequest("transcribe", audioBlob);
      const res = await POST(request);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.transcript).toBe("test transcript");
      expect(data.confidence).toBe(0.95);
      expect(data.durationSec).toBe(2.3);
      expect(transcribeMock).toHaveBeenCalledOnce();
    });

    it("transcribes audio from raw body", async () => {
      transcribeMock.mockResolvedValueOnce({
        transcript: "raw audio test",
        confidence: 0.9,
        durationSec: 1.0,
        words: [],
      });

      const request = new Request("http://localhost/api/voice?action=transcribe", {
        method: "POST",
        headers: { "Content-Type": "audio/webm" },
        body: new Blob(["raw-audio"]),
      });
      const res = await POST(request);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.transcript).toBe("raw audio test");
    });

    it("returns 400 when multipart form has no audio field", async () => {
      const formData = new FormData();
      formData.append("notaudio", "text");
      const request = new Request("http://localhost/api/voice?action=transcribe", {
        method: "POST",
        body: formData,
      });
      const res = await POST(request);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Missing audio file");
    });
  });

  describe("action=speak", () => {
    it("converts text to speech and returns audio", async () => {
      speakMock.mockResolvedValueOnce({
        audio: Buffer.from([1, 2, 3]),
        contentType: "audio/mpeg",
      });

      const request = new Request("http://localhost/api/voice?action=speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello world" }),
      });
      const res = await POST(request);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(speakMock).toHaveBeenCalledWith("hello world", {
        model: undefined,
        encoding: undefined,
      });
    });

    it("returns 400 when text is missing", async () => {
      const request = new Request("http://localhost/api/voice?action=speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const res = await POST(request);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Missing required field: text");
    });

    it("returns 413 when text exceeds character limit", async () => {
      const request = new Request("http://localhost/api/voice?action=speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "a".repeat(2001) }),
      });
      const res = await POST(request);

      expect(res.status).toBe(413);
      const data = await res.json();
      expect(data.error).toContain("2000 character limit");
    });
  });

  describe("action=converse", () => {
    it("returns 400 when not multipart", async () => {
      const request = new Request("http://localhost/api/voice?action=converse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: "data" }),
      });
      const res = await POST(request);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("multipart/form-data");
    });

    it("returns 422 when transcription yields no speech", async () => {
      transcribeMock.mockResolvedValueOnce({
        transcript: "",
        confidence: 0,
        durationSec: 0.5,
        words: [],
      });

      const audioBlob = new Blob(["silence"], { type: "audio/webm" });
      const request = makeFormDataRequest("converse", audioBlob);
      const res = await POST(request);

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toContain("no speech detected");
    });
  });
});
