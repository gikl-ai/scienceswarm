"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useVoiceChat } from "@/hooks/use-voice-chat";

interface AudioDevice {
  deviceId: string;
  label: string;
}

async function enumerateMics(): Promise<AudioDevice[]> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch { /* permission denied */ }

  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "audioinput")
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Microphone ${i + 1}`,
    }));
}

function useMicDevices() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selected, setSelected] = useState<string>("");

  const refresh = useCallback(async () => {
    const mics = await enumerateMics();
    setDevices(mics);
    setSelected((prev) => {
      if (mics.length > 0 && !mics.find((m) => m.deviceId === prev)) {
        return mics[0].deviceId;
      }
      return prev;
    });
  }, []);

  useEffect(() => {
    const handler = () => void refresh();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, [refresh]);

  useEffect(() => {
    void enumerateMics().then((mics) => {
      setDevices(mics);
      setSelected((prev) => {
        if (mics.length > 0 && !mics.find((m) => m.deviceId === prev)) {
          return mics[0].deviceId;
        }
        return prev;
      });
    });
  }, []);

  return { devices, selected, setSelected, refresh };
}

function AudioLevelMeter({ deviceId }: { deviceId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!deviceId) return;

    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId } },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;

        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const canvas = canvasRef.current;
        if (!canvas) return;
        const canvasCtx = canvas.getContext("2d")!;

        const draw = () => {
          if (cancelled) return;
          animRef.current = requestAnimationFrame(draw);
          analyser!.getByteFrequencyData(dataArray);

          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          const peak = Math.max(...dataArray);

          canvasCtx.fillStyle = "#f3f4f6";
          canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

          const barWidth = (avg / 255) * canvas.width;
          canvasCtx.fillStyle = avg > 10 ? "#22c55e" : "#d1d5db";
          canvasCtx.fillRect(0, 0, barWidth, canvas.height / 2 - 1);

          const peakWidth = (peak / 255) * canvas.width;
          canvasCtx.fillStyle = peak > 30 ? "#3b82f6" : "#d1d5db";
          canvasCtx.fillRect(0, canvas.height / 2 + 1, peakWidth, canvas.height / 2 - 1);

          canvasCtx.fillStyle = "#6b7280";
          canvasCtx.font = "10px monospace";
          canvasCtx.fillText(`avg: ${Math.round(avg)}`, 4, 12);
          canvasCtx.fillText(`peak: ${peak}`, 4, canvas.height - 4);
        };

        draw();
      } catch {
        // mic access failed
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (ctx && ctx.state !== "closed") ctx.close();
    };
  }, [deviceId]);

  return (
    <canvas
      ref={canvasRef}
      width={300}
      height={32}
      className="w-full h-8 rounded border border-gray-200"
    />
  );
}

const STATE_DOT: Record<string, string> = {
  idle: "bg-gray-500",
  recording: "bg-red-500",
  transcribing: "bg-amber-500",
  speaking: "bg-blue-500",
};

export default function VoiceTestPage() {
  const [mode, setMode] = useState<"converse" | "transcribe">("transcribe");
  const [ttsInput, setTtsInput] = useState("");
  const [log, setLog] = useState<string[]>([]);

  const { devices, selected, setSelected, refresh } = useMicDevices();

  const addLog = (msg: string) =>
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  const {
    voiceState,
    lastResult,
    error,
    startRecording,
    stopRecording,
    speakText,
    stopPlayback,
    clearError,
    isSupported,
  } = useVoiceChat({
    mode,
    deviceId: selected || undefined,
    onTranscript: (text) => addLog(`STT transcript: "${text}"`),
    onResponse: (text) => addLog(`Chat response: "${text}"`),
  });

  const handleTTS = async () => {
    if (!ttsInput.trim()) return;
    addLog(`TTS request: "${ttsInput}"`);
    await speakText(ttsInput);
    addLog("TTS playback finished");
  };

  return (
    <div className="max-w-[640px] mx-auto px-5 py-10 font-sans">
      <h1 className="text-2xl mb-2">Deepgram Voice Test</h1>
      <p className="text-gray-500 mb-6">
        Test STT, TTS, and full converse flow with OpenClaw.
      </p>

      {!isSupported && (
        <div className="bg-red-50 border border-red-300 p-3 rounded-lg mb-4">
          MediaRecorder not supported in this browser. Use Chrome or Firefox.
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-300 p-3 rounded-lg mb-4 flex justify-between">
          <span>{error}</span>
          <button onClick={clearError} className="cursor-pointer bg-transparent border-none font-bold">x</button>
        </div>
      )}

      <div className="flex items-center gap-3 mb-6">
        <span className={`w-3 h-3 rounded-full inline-block ${STATE_DOT[voiceState]}`} />
        <span className="font-semibold capitalize">{voiceState}</span>
      </div>

      {/* Mic selector */}
      <fieldset className="border border-gray-200 rounded-lg p-4 mb-6">
        <legend className="font-semibold px-2">Microphone</legend>
        <div className="flex gap-2 mb-3">
          <select
            value={selected}
            onChange={(e) => { setSelected(e.target.value); addLog(`Switched mic: ${e.target.selectedOptions[0]?.text}`); }}
            className="flex-1 px-3 py-2 rounded-md border border-gray-300 text-sm"
          >
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
            {devices.length === 0 && <option value="">No microphones found</option>}
          </select>
          <button
            onClick={() => { refresh(); addLog("Refreshed device list"); }}
            className="px-3 py-2 rounded-md border border-gray-300 bg-white cursor-pointer text-sm"
          >
            Refresh
          </button>
        </div>
        {selected && (
          <div>
            <div className="text-xs text-gray-500 mb-1">Live level (speak to see green bars):</div>
            <AudioLevelMeter deviceId={selected} />
          </div>
        )}
      </fieldset>

      {/* Mode selector */}
      <fieldset className="border border-gray-200 rounded-lg p-4 mb-6">
        <legend className="font-semibold px-2">STT Mode</legend>
        <label className="mr-4 cursor-pointer">
          <input type="radio" value="transcribe" checked={mode === "transcribe"} onChange={() => setMode("transcribe")} />
          {" "}Transcribe only (STT)
        </label>
        <label className="cursor-pointer">
          <input type="radio" value="converse" checked={mode === "converse"} onChange={() => setMode("converse")} />
          {" "}Converse (STT + Chat + TTS)
        </label>
      </fieldset>

      {/* Recording controls */}
      <fieldset className="border border-gray-200 rounded-lg p-4 mb-6">
        <legend className="font-semibold px-2">Record &amp; Transcribe</legend>
        <div className="flex gap-2">
          <button
            onClick={() => { addLog(`Recording with: ${devices.find(d => d.deviceId === selected)?.label || "default"}`); startRecording(); }}
            disabled={voiceState !== "idle" || !isSupported}
            className={`px-4 py-2 rounded-md border-none text-white font-semibold ${voiceState === "idle" ? "bg-red-500 cursor-pointer" : "bg-gray-300 cursor-not-allowed"}`}
          >
            Start Recording
          </button>
          <button
            onClick={() => { addLog("Recording stopped, transcribing..."); stopRecording(); }}
            disabled={voiceState !== "recording"}
            className={`px-4 py-2 rounded-md border-none text-white font-semibold ${voiceState === "recording" ? "bg-amber-500 cursor-pointer" : "bg-gray-300 cursor-not-allowed"}`}
          >
            Stop Recording
          </button>
          {voiceState === "speaking" && (
            <button
              onClick={stopPlayback}
              className="px-4 py-2 rounded-md border-none bg-blue-500 text-white cursor-pointer font-semibold"
            >
              Stop Playback
            </button>
          )}
        </div>
      </fieldset>

      {/* TTS test */}
      <fieldset className="border border-gray-200 rounded-lg p-4 mb-6">
        <legend className="font-semibold px-2">Text-to-Speech</legend>
        <div className="flex gap-2">
          <input
            type="text"
            value={ttsInput}
            onChange={(e) => setTtsInput(e.target.value)}
            placeholder="Type something to hear it spoken..."
            onKeyDown={(e) => e.key === "Enter" && handleTTS()}
            className="flex-1 px-3 py-2 rounded-md border border-gray-300 text-sm"
          />
          <button
            onClick={handleTTS}
            disabled={voiceState !== "idle" || !ttsInput.trim()}
            className={`px-4 py-2 rounded-md border-none text-white font-semibold ${voiceState === "idle" && ttsInput.trim() ? "bg-blue-500 cursor-pointer" : "bg-gray-300 cursor-not-allowed"}`}
          >
            Speak
          </button>
        </div>
      </fieldset>

      {/* Last result */}
      {lastResult && (
        <fieldset className="border border-gray-200 rounded-lg p-4 mb-6">
          <legend className="font-semibold px-2">Last Result</legend>
          <div className="mb-2">
            <strong>Transcript:</strong> {lastResult.transcript || "(empty)"}
          </div>
          {lastResult.response && (
            <div className="mb-2">
              <strong>Response:</strong> {lastResult.response}
            </div>
          )}
          {lastResult.audioUrl && (
            <audio controls src={lastResult.audioUrl} className="w-full" />
          )}
        </fieldset>
      )}

      {/* Log */}
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="font-semibold px-2">
          Log
          <button onClick={() => setLog([])} className="ml-2 text-xs cursor-pointer bg-transparent border-none text-gray-500">clear</button>
        </legend>
        <div className="font-mono text-xs max-h-[200px] overflow-auto whitespace-pre-wrap">
          {log.length === 0 ? "No events yet." : log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </fieldset>
    </div>
  );
}
