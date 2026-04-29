"use client";

import { useState, type FormEvent } from "react";
import { Spinner } from "@/components/spinner";
import {
  BRAIN_PRESET_OPTIONS,
  DEFAULT_BRAIN_PRESET,
  type BrainPresetId,
} from "@/brain/presets/types";
import { isTelegramBotTokenShape } from "@/lib/telegram/bot-token";
import {
  createRandomUserHandle,
  isValidUserHandle,
} from "@/lib/setup/user-handle";

export interface BootstrapFormValues {
  handle: string;
  email: string;
  phone: string;
  brainPreset: BrainPresetId;
  existingBot?: {
    token: string;
  };
}

interface BootstrapFormProps {
  disabled: boolean;
  onSubmit: (values: BootstrapFormValues) => void;
  initialHandle?: string;
  showWindowsNote?: boolean;
}

export function BootstrapForm({
  disabled,
  onSubmit,
  initialHandle,
  showWindowsNote = false,
}: BootstrapFormProps) {
  // Use an anonymous generated handle by default. Do not derive this
  // from OS username or computer name because it is copied into durable
  // brain attribution metadata.
  const [handle, setHandle] = useState(() =>
    initialHandle?.trim() || createRandomUserHandle()
  );
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [brainPreset, setBrainPreset] =
    useState<BrainPresetId>(DEFAULT_BRAIN_PRESET);
  const [mode, setMode] = useState<"fresh" | "reuse">("fresh");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!isValidUserHandle(handle)) {
      setError("Handle must be 1-64 letters/digits/._- only.");
      return;
    }
    const trimmedToken = token.trim();
    if (mode === "reuse" && !isTelegramBotTokenShape(trimmedToken)) {
      setError("Paste a valid Telegram bot token.");
      return;
    }
    setError(null);
    const values: BootstrapFormValues = {
      handle: handle.trim(),
      email: email.trim(),
      phone: mode === "fresh" ? phone.trim() : "",
      brainPreset,
    };
    if (mode === "reuse") {
      values.existingBot = { token: trimmedToken };
    }
    onSubmit(values);
  };

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="bootstrap-form"
      className="rounded-[28px] border-2 border-border bg-white p-5 shadow-sm"
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted">
        LOCAL-FIRST SETUP
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-foreground">
        Set up ScienceSwarm
      </h1>
      <p className="mt-2 text-sm leading-6 text-muted">
        A couple of quick things — then we install everything else for you.
      </p>
      {showWindowsNote && (
        <p
          className="mt-3 rounded-2xl border border-rule bg-sunk px-3 py-2 text-xs leading-5 text-body"
          data-testid="bootstrap-windows-note"
        >
          Windows users: ScienceSwarm currently supports Windows via WSL2. Keep
          the repo and ScienceSwarm data in the WSL Linux filesystem, not under
          <code className="mx-1 rounded bg-white/70 px-1 py-0.5 text-[11px]">/mnt/c</code>,
          for better import and file-watching performance.
        </p>
      )}

      <div className="mt-5 space-y-4">
        <fieldset className="grid gap-4" data-testid="user-information-section">
          <legend className="text-xs font-semibold uppercase tracking-wider text-muted">
            User information
          </legend>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Handle
            </span>
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              required
              data-testid="handle-input"
              className="mt-1 block w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm"
              disabled={disabled}
            />
            <span className="mt-1 block text-xs text-muted">
              Used to sign everything you write. We generated a local handle
              so setup can start fast; rename it here or later in Settings.
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Email (optional)
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="email-input"
              className="mt-1 block w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm"
              disabled={disabled}
            />
            <span className="mt-1 block text-xs text-muted">
              Used for git commit author and radar alerts. Never shared.
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Brain preset
            </span>
            <select
              value={brainPreset}
              onChange={(e) => setBrainPreset(e.target.value as BrainPresetId)}
              data-testid="brain-preset-select"
              className="mt-1 block w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm"
              disabled={disabled}
            >
              {BRAIN_PRESET_OPTIONS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-muted">
              {BRAIN_PRESET_OPTIONS.find((preset) => preset.id === brainPreset)?.description}
            </span>
          </label>
        </fieldset>

        <fieldset className="grid gap-2" data-testid="telegram-mode-toggle">
          <legend className="text-xs font-semibold uppercase tracking-wider text-muted">
            Telegram bot (optional)
          </legend>
          <label className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-sm">
            <input
              type="radio"
              name="telegram-mode"
              value="fresh"
              checked={mode === "fresh"}
              onChange={() => setMode("fresh")}
              disabled={disabled}
              data-testid="telegram-mode-fresh"
            />
            <span>Create a new bot</span>
          </label>
          <label className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-sm">
            <input
              type="radio"
              name="telegram-mode"
              value="reuse"
              checked={mode === "reuse"}
              onChange={() => setMode("reuse")}
              disabled={disabled}
              data-testid="telegram-mode-reuse"
            />
            <span>Reuse an existing bot token</span>
          </label>

        {mode === "fresh" ? (
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Phone for Telegram (optional)
            </span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 415 555 1234"
              data-testid="phone-input"
              className="mt-1 block w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm"
              disabled={disabled}
            />
            <span className="mt-1 block text-xs text-muted">
              Optional. If provided, we create your personal OpenClaw Telegram bot
              so you can chat with ScienceSwarm from anywhere. You can also set
              this up later from Settings.
            </span>
          </label>
        ) : (
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Bot token
            </span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              data-testid="bot-token-input"
              className="mt-1 block w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm"
              disabled={disabled}
            />
            <span className="mt-1 block text-xs text-muted">
              We validate this with Telegram, then ask you to open the bot once
              so we can approve your account without sending an SMS code.
            </span>
          </label>
        )}
        </fieldset>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 text-sm text-danger"
          data-testid="form-error"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={disabled}
        data-testid="bootstrap-submit"
        className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {disabled && (
          <Spinner size="h-4 w-4" className="text-white" testId="bootstrap-submit-spinner" />
        )}
        {disabled ? "Setting up…" : "Set up my workspace"}
      </button>
    </form>
  );
}
