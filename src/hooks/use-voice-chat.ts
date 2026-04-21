"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// ── Types ──────────────────────────────────────────────────────

export type VoiceState = "idle" | "recording" | "transcribing" | "speaking";

export interface VoiceChatResult {
  transcript: string;
  response: string;
  audioUrl: string | null;
}

export interface UseVoiceChat {
  voiceState: VoiceState;
  lastResult: VoiceChatResult | null;
  error: string | null;
  /** Start recording from the microphone */
  startRecording: () => Promise<void>;
  /** Stop recording and process the audio */
  stopRecording: () => void;
  /** Speak arbitrary text via TTS */
  speakText: (text: string) => Promise<void>;
  /** Stop any currently playing audio */
  stopPlayback: () => void;
  /** Clear the current error */
  clearError: () => void;
  /** True when the browser supports MediaRecorder */
  isSupported: boolean;
}

function detectVoiceSupport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

// ── Hook ───────────────────────────────────────────────────────

export function useVoiceChat(options?: {
  /** "converse" does full round-trip (STT→chat→TTS), "transcribe" just returns text */
  mode?: "converse" | "transcribe";
  /** Called with the transcript text so the caller can inject it into chat */
  onTranscript?: (text: string) => void;
  /** Called with the assistant's text response */
  onResponse?: (text: string) => void;
  /** Specific audio input device ID (from enumerateDevices) */
  deviceId?: string;
}): UseVoiceChat {
  const { mode = "converse", onTranscript, onResponse, deviceId } = options ?? {};

  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [lastResult, setLastResult] = useState<VoiceChatResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentAudioUrl = useRef<string | null>(null);

  // Stable refs for callbacks so recorder.onstop always sees the latest
  const modeRef = useRef(mode);
  const onTranscriptRef = useRef(onTranscript);
  const onResponseRef = useRef(onResponse);

  const deviceIdRef = useRef(deviceId);

  useEffect(() => {
    modeRef.current = mode;
    onTranscriptRef.current = onTranscript;
    onResponseRef.current = onResponse;
    deviceIdRef.current = deviceId;
  }, [mode, onTranscript, onResponse, deviceId]);

  useEffect(() => {
    setIsSupported(detectVoiceSupport());
  }, []);

  const cleanupAudioUrl = useCallback(() => {
    if (currentAudioUrl.current) {
      URL.revokeObjectURL(currentAudioUrl.current);
      currentAudioUrl.current = null;
    }
  }, []);

  // ── Audio playback ──

  const playResolveRef = useRef<(() => void) | null>(null);

  const playAudioUrl = useCallback(
    (url: string): Promise<void> =>
      new Promise((resolve) => {
        const audio = new Audio(url);
        audioRef.current = audio;
        playResolveRef.current = resolve;
        audio.onended = () => { playResolveRef.current = null; resolve(); };
        audio.onerror = () => { playResolveRef.current = null; resolve(); };
        audio.play().catch(() => { playResolveRef.current = null; resolve(); });
      }),
    [],
  );

  // ── Process recorded audio ──
  // Defined as a ref-stable function so startRecording can call it
  // without a circular useCallback dependency.

  const processAudioRef = useRef<(blob: Blob) => Promise<void>>(undefined);

  processAudioRef.current = async (blob: Blob) => {
    setVoiceState("transcribing");

    try {
      const formData = new FormData();
      formData.append("audio", blob, "recording.webm");

      if (modeRef.current === "transcribe") {
        const res = await fetch("/api/voice?action=transcribe", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error((data as { error?: string }).error ?? `Transcribe failed: ${res.status}`);
        }

        const data = await res.json();
        const transcript = data.transcript ?? "";
        onTranscriptRef.current?.(transcript);
        setLastResult({ transcript, response: "", audioUrl: null });
        setVoiceState("idle");
        return;
      }

      // Full converse mode: STT → chat → TTS
      const res = await fetch("/api/voice?action=converse", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Voice converse failed: ${res.status}`);
      }

      const data = await res.json();
      const transcript = data.transcript ?? "";
      const response = data.response ?? "";

      onTranscriptRef.current?.(transcript);
      onResponseRef.current?.(response);

      let audioUrl: string | null = null;
      if (data.audio) {
        const audioBytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
        const audioBlob = new Blob([audioBytes], {
          type: data.audioContentType || "audio/mpeg",
        });
        audioUrl = URL.createObjectURL(audioBlob);
        currentAudioUrl.current = audioUrl;
      }

      setLastResult({ transcript, response, audioUrl });

      // Auto-play the response
      if (audioUrl) {
        setVoiceState("speaking");
        await playAudioUrl(audioUrl);
        setVoiceState("idle");
      } else {
        setVoiceState("idle");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Voice processing failed";
      setError(msg);
      setVoiceState("idle");
    }
  };

  // ── Recording ──

  const startRecording = useCallback(async () => {
    if (!isSupported) {
      setError("Voice recording is not supported in this browser");
      return;
    }

    setError(null);
    cleanupAudioUrl();

    let stream: MediaStream | undefined;
    try {
      const audioConstraints: MediaTrackConstraints | boolean = deviceIdRef.current
        ? { deviceId: { exact: deviceIdRef.current } }
        : true;
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

      // Pick best supported format
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Stop all tracks to release the microphone
        stream!.getTracks().forEach((t) => t.stop());

        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size === 0) {
          setVoiceState("idle");
          setError("No audio recorded");
          return;
        }

        await processAudioRef.current?.(blob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setVoiceState("recording");
    } catch (err) {
      // Release microphone if getUserMedia succeeded but setup failed after
      stream?.getTracks().forEach((t) => t.stop());
      const msg = err instanceof Error ? err.message : "Microphone access denied";
      setError(msg);
      setVoiceState("idle");
    }
  }, [isSupported, cleanupAudioUrl]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.stop();
      setVoiceState("transcribing");
    }
  }, []);

  // ── TTS for arbitrary text ──

  const speakText = useCallback(async (text: string) => {
    if (!text.trim()) return;

    setError(null);
    setVoiceState("speaking");
    cleanupAudioUrl();

    try {
      const res = await fetch("/api/voice?action=speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error((errData as { error?: string }).error ?? `TTS failed: ${res.status}`);
      }

      const audioBlob = await res.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      currentAudioUrl.current = audioUrl;

      await playAudioUrl(audioUrl);
      setVoiceState("idle");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Text-to-speech failed";
      setError(msg);
      setVoiceState("idle");
    }
  }, [cleanupAudioUrl, playAudioUrl]);

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    // Resolve pending playAudioUrl promise so awaiting callers can proceed
    if (playResolveRef.current) {
      playResolveRef.current();
      playResolveRef.current = null;
    }
    if (voiceState === "speaking") {
      setVoiceState("idle");
    }
  }, [voiceState]);

  const clearError = useCallback(() => setError(null), []);

  return {
    voiceState,
    lastResult,
    error,
    startRecording,
    stopRecording,
    speakText,
    stopPlayback,
    clearError,
    isSupported,
  };
}
