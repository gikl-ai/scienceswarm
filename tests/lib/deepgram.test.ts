import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fetch globally
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("Deepgram client", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("DEEPGRAM_OWNER_API_KEY", "test-key-123");
    fetchMock.mockReset();
  });

  describe("transcribe", () => {
    it("sends audio to the STT endpoint and returns a transcript", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: {
              channels: [
                {
                  alternatives: [
                    {
                      transcript: "hello world",
                      confidence: 0.98,
                      words: [
                        { word: "hello", start: 0.0, end: 0.5, confidence: 0.99 },
                        { word: "world", start: 0.6, end: 1.0, confidence: 0.97 },
                      ],
                    },
                  ],
                },
              ],
            },
            metadata: { duration: 1.2 },
          }),
      });

      const { transcribe } = await import("@/lib/deepgram");
      const result = await transcribe(Buffer.from("fake-audio"));

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toContain("https://api.deepgram.com/v1/listen");
      expect(url).toContain("model=nova-3");
      expect(options.headers.Authorization).toBe("Token test-key-123");
      expect(options.headers["Content-Type"]).toBe("audio/webm");

      expect(result.transcript).toBe("hello world");
      expect(result.confidence).toBe(0.98);
      expect(result.durationSec).toBe(1.2);
      expect(result.words).toHaveLength(2);
    });

    it("throws on API error", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });

      const { transcribe } = await import("@/lib/deepgram");
      await expect(transcribe(Buffer.from("audio"))).rejects.toThrow(
        "Deepgram STT error 401: Unauthorized",
      );
    });

    it("returns empty transcript when no speech detected", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            results: {
              channels: [{ alternatives: [{ transcript: "", confidence: 0, words: [] }] }],
            },
            metadata: { duration: 0.5 },
          }),
      });

      const { transcribe } = await import("@/lib/deepgram");
      const result = await transcribe(Buffer.from("silence"));

      expect(result.transcript).toBe("");
      expect(result.confidence).toBe(0);
    });

    it("throws when API key is missing", async () => {
      vi.stubEnv("DEEPGRAM_OWNER_API_KEY", "");

      // Re-import to pick up the cleared env
      vi.resetModules();
      const { transcribe } = await import("@/lib/deepgram");

      await expect(transcribe(Buffer.from("audio"))).rejects.toThrow(
        "DEEPGRAM_OWNER_API_KEY is not set",
      );
    });
  });

  describe("speak", () => {
    it("sends text to the TTS endpoint and returns audio", async () => {
      const fakeAudio = new Uint8Array([1, 2, 3, 4]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "audio/mpeg" }),
        arrayBuffer: () => Promise.resolve(fakeAudio.buffer),
      });

      const { speak } = await import("@/lib/deepgram");
      const result = await speak("hello world");

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toContain("https://api.deepgram.com/v1/speak");
      expect(url).toContain("model=aura-2-asteria-en");
      expect(options.headers.Authorization).toBe("Token test-key-123");
      expect(JSON.parse(options.body)).toEqual({ text: "hello world" });

      expect(result.contentType).toBe("audio/mpeg");
      expect(result.audio).toBeInstanceOf(Buffer);
      expect(result.audio.byteLength).toBe(4);
    });

    it("throws on API error", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad request"),
      });

      const { speak } = await import("@/lib/deepgram");
      await expect(speak("hello")).rejects.toThrow("Deepgram TTS error 400: Bad request");
    });

    it("uses custom model and encoding when specified", async () => {
      const fakeAudio = new Uint8Array([5, 6]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "audio/wav" }),
        arrayBuffer: () => Promise.resolve(fakeAudio.buffer),
      });

      const { speak } = await import("@/lib/deepgram");
      await speak("test", { model: "aura-2-orion-en", encoding: "linear16", sampleRate: 16000 });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("model=aura-2-orion-en");
      expect(url).toContain("encoding=linear16");
      expect(url).toContain("sample_rate=16000");
    });
  });
});
