"use client";

import { useState, type FormEvent } from "react";

interface TelegramCodePromptProps {
  sessionId: string;
  onSubmitted: () => void;
}

export function TelegramCodePrompt({
  sessionId,
  onSubmitted,
}: TelegramCodePromptProps) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/telegram-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, code: code.trim() }),
      });
      if (res.status === 204) {
        onSubmitted();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `Submit failed (HTTP ${res.status})`);
    } catch (err) {
      // Network error, aborted fetch, etc. Without this branch, the
      // rejection would escape the handler and leave the button
      // permanently disabled with no error message.
      setError(
        err instanceof Error ? err.message : "Network error while submitting code.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="telegram-code-prompt"
      className="rounded-[28px] border-2 border-rule bg-sunk p-5 shadow-sm"
    >
      <h2 className="text-xl font-semibold text-strong">Check Telegram</h2>
      <p className="mt-1 text-sm text-body">
        Telegram sent you a login code. Enter it here to finish Telegram setup.
      </p>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="12345"
        data-testid="telegram-code-input"
        className="mt-3 block w-full rounded-xl border border-rule bg-raised px-3 py-2 text-sm"
        required
      />
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting || code.trim().length === 0}
        data-testid="telegram-code-submit"
        className="mt-3 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-strong transition-colors hover:bg-accent-dim disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Submit"}
      </button>
    </form>
  );
}
