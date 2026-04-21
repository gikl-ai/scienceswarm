"use client";

import { useEffect, useMemo, useState } from "react";

import { TelegramBotReady } from "@/components/setup/telegram-bot-ready";
import { TelegramCodePrompt } from "@/components/setup/telegram-code-prompt";
import type {
  BootstrapEvent,
  BootstrapStreamEvent,
  BootstrapSummaryEvent,
} from "@/lib/setup/install-tasks/types";
import { isTelegramBotTokenShape } from "@/lib/telegram/bot-token";
import { creatureDisplayName } from "@/lib/telegram/creature-names";

import { Section, StatusDot } from "./_primitives";

type TelegramMode = "fresh" | "reuse";

interface TelegramStatus {
  botToken: string | null;
  configured: boolean;
  paired?: boolean;
  username?: string | null;
  creature?: string | null;
  userId?: string | null;
  pendingPairing?: {
    userId: string;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    createdAt?: string | null;
    lastSeenAt?: string | null;
  } | null;
}

interface Props {
  userHandle: string;
  userEmail: string;
  initialPhone: string;
  telegram: TelegramStatus;
  openclawInstalled: boolean;
  openclawSource?: "system" | "external" | "none";
  inputClassName: string;
  primaryButtonClassName: string;
  secondaryButtonClassName: string;
  onRefreshPendingPairing?: () => Promise<void> | void;
  onUpdated?: () => void;
}

function parseTelegramSuccessDetail(
  detail: string | undefined,
): { botUrl: string; creature: string; displayName: string } | null {
  if (!detail) return null;
  const urlMatch = /https:\/\/t\.me\/(\S+)/.exec(detail);
  if (!urlMatch) return null;
  const botUrl = urlMatch[0];
  const username = urlMatch[1];
  const creature = username.split("_")[0] ?? "claw";
  const sepIdx = detail.indexOf(" — https://");
  const displayName = sepIdx > 0 ? detail.slice(0, sepIdx) : detail;
  return { botUrl, creature, displayName };
}

function findLatestTelegramEvent(
  events: BootstrapStreamEvent[],
): BootstrapEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "task" && event.task === "telegram-bot") {
      return event;
    }
  }
  return null;
}

function parseStreamFrame(frame: string): BootstrapStreamEvent | null {
  const dataLine = frame
    .split(/\r?\n/)
    .find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  try {
    return JSON.parse(
      dataLine.slice("data:".length).trim(),
    ) as BootstrapStreamEvent;
  } catch {
    return null;
  }
}

export function TelegramOpenClawSection({
  userHandle,
  userEmail,
  initialPhone,
  telegram,
  openclawInstalled,
  openclawSource = "system",
  inputClassName,
  primaryButtonClassName,
  secondaryButtonClassName,
  onRefreshPendingPairing,
  onUpdated,
}: Props) {
  const [mode, setMode] = useState<TelegramMode>(telegram.configured ? "reuse" : "fresh");
  const [phoneDraft, setPhoneDraft] = useState(initialPhone);
  const [botTokenDraft, setBotTokenDraft] = useState("");
  const [events, setEvents] = useState<BootstrapStreamEvent[]>([]);
  const [summary, setSummary] = useState<BootstrapSummaryEvent | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [approvingPending, setApprovingPending] = useState(false);
  const [refreshingPending, setRefreshingPending] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineSuccess, setInlineSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (connecting) return;
    setPhoneDraft(initialPhone);
    setMode(telegram.configured ? "reuse" : "fresh");
    setBotTokenDraft("");
  }, [connecting, initialPhone, telegram.configured]);

  const latestTelegramEvent = useMemo(
    () => findLatestTelegramEvent(events),
    [events],
  );
  const isPaired = telegram.paired ?? Boolean(telegram.userId);
  const pendingPairing = telegram.pendingPairing ?? null;
  const currentBotUrl = telegram.username ? `https://t.me/${telegram.username}` : null;
  const currentDisplayName = telegram.creature
    ? creatureDisplayName(telegram.creature)
    : telegram.username
      ? `@${telegram.username}`
      : null;
  const latestSuccessBot =
    latestTelegramEvent?.status === "succeeded"
      ? parseTelegramSuccessDetail(latestTelegramEvent.detail)
      : null;
  const currentConfiguredBot =
    currentBotUrl && currentDisplayName
      ? {
          botUrl: currentBotUrl,
          creature: telegram.creature ?? "claw",
          displayName: currentDisplayName,
        }
      : null;
  const currentOrLatestBot = latestSuccessBot ?? currentConfiguredBot;
  const savedBotAvailable = Boolean(telegram.botToken);
  const reuseUsesSavedBot = mode === "reuse" && botTokenDraft.trim().length === 0 && savedBotAvailable;
  const disabledByRuntime = openclawSource === "external" || !openclawInstalled;
  const waitingForCode =
    latestTelegramEvent?.status === "waiting-for-input"
    && latestTelegramEvent.needs === "telegram-code"
    && latestTelegramEvent.sessionId
      ? latestTelegramEvent.sessionId
      : null;
  const waitingForClaim =
    latestTelegramEvent?.status === "waiting-for-input"
    && latestTelegramEvent.needs === "telegram-nonce-claim"
    && latestTelegramEvent.nonceClaim
      ? latestTelegramEvent.nonceClaim
      : null;
  const errorMessage =
    inlineError
    ?? latestTelegramEvent?.error
    ?? (summary?.status === "failed" ? summary.error ?? "Telegram connection failed." : null);

  async function handleConnect() {
    const trimmedPhone = phoneDraft.trim();
    const trimmedToken = botTokenDraft.trim();

    if (!userHandle.trim()) {
      setInlineError("Save your handle above before connecting Telegram.");
      return;
    }

    if (disabledByRuntime) {
      setInlineError(
        openclawSource === "external"
          ? "This OpenClaw runtime is external. Configure Telegram on that runtime directly."
          : "Install OpenClaw above before connecting Telegram.",
      );
      return;
    }

    if (mode === "fresh" && trimmedPhone.length === 0) {
      setInlineError("Enter the Telegram phone number that should own the new bot.");
      return;
    }

    if (mode === "reuse" && trimmedToken.length > 0 && !isTelegramBotTokenShape(trimmedToken)) {
      setInlineError("Paste a valid Telegram bot token.");
      return;
    }

    if (mode === "reuse" && trimmedToken.length === 0 && !savedBotAvailable) {
      setInlineError("Paste the Telegram bot token you want OpenClaw to use.");
      return;
    }

    setInlineError(null);
    setInlineSuccess(null);
    setEvents([]);
    setSummary(null);
    setConnecting(true);

    try {
      if (mode === "fresh") {
        const savePhoneResponse = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "save-telegram-phone",
            telegramPhone: trimmedPhone,
          }),
        });
        if (!savePhoneResponse.ok) {
          const payload = (await savePhoneResponse.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? "Failed to save the Telegram phone number.");
        }
      }

      const response = await fetch("/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          handle: userHandle,
          email: userEmail,
          phone: mode === "fresh" ? trimmedPhone : undefined,
          botToken: mode === "reuse" ? trimmedToken : undefined,
        }),
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Telegram connection failed (HTTP ${response.status}).`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let frameEnd = buffer.indexOf("\n\n");
        while (frameEnd !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const event = parseStreamFrame(frame);
          if (event) {
            setEvents((previous) => [...previous, event]);
            if (event.type === "summary") {
              setSummary(event);
            }
          }
          frameEnd = buffer.indexOf("\n\n");
        }
      }

      setBotTokenDraft("");
      onUpdated?.();
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : "Telegram connection failed.",
      );
    } finally {
      setConnecting(false);
    }
  }

  async function handleApprovePendingPairing() {
    setInlineError(null);
    setInlineSuccess(null);
    setApprovingPending(true);
    try {
      const response = await fetch("/api/settings/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve-pending" }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        warning?: string | null;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? `Telegram approval failed (HTTP ${response.status}).`);
      }
      if (payload.warning) {
        setInlineError(payload.warning);
      } else {
        setInlineSuccess("Telegram pairing approved. Send your message again.");
      }
      onUpdated?.();
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : "Telegram approval failed.",
      );
    } finally {
      setApprovingPending(false);
    }
  }

  async function handleRefreshPendingPairing() {
    if (!onRefreshPendingPairing) return;
    setInlineError(null);
    setInlineSuccess(null);
    setRefreshingPending(true);
    try {
      await onRefreshPendingPairing();
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : "Could not check for pending Telegram pairing.",
      );
    } finally {
      setRefreshingPending(false);
    }
  }

  return (
    <Section title="Telegram & OpenClaw">
      <p className="text-sm text-muted">
        Choose whether ScienceSwarm should create a brand-new Telegram bot for this
        OpenClaw or connect a bot you already own. The phone path creates a new personal
        bot; the token path reuses an existing bot and points it at this OpenClaw.
      </p>

      <div className="space-y-4 rounded-lg border border-border bg-background p-4">
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted"
          data-testid="telegram-current-status"
        >
          <StatusDot status={isPaired ? "ok" : telegram.configured ? "warn" : "off"} />
          {telegram.configured
            ? currentBotUrl
              ? (
                <>
                  <span>
                    {isPaired ? "Paired bot:" : "Bot configured:"}{" "}
                    <span className="font-medium text-foreground">{currentDisplayName}</span>
                  </span>
                  <a
                    href={currentBotUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-foreground underline"
                  >
                    {currentBotUrl}
                  </a>
                </>
              )
              : `Telegram bot token saved: ${telegram.botToken}`
            : "No Telegram bot is connected to this OpenClaw yet."}
        </div>

        {telegram.configured && !isPaired && (
          <div
            className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
            data-testid="settings-telegram-pairing-status"
          >
            OpenClaw has a Telegram bot token, but your Telegram account is not paired yet. Send
            the bot a message or tap <strong>Start</strong>, then approve the pending pairing
            below.
          </div>
        )}

        {telegram.configured && !isPaired && !pendingPairing && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background/70 p-3 text-sm text-muted">
            <span>
              Pending Telegram approvals are checked on demand so the Settings page opens quickly.
            </span>
            <button
              type="button"
              onClick={handleRefreshPendingPairing}
              disabled={connecting || approvingPending || refreshingPending || disabledByRuntime}
              className={secondaryButtonClassName}
              data-testid="settings-telegram-refresh-pending-button"
            >
              {refreshingPending ? "Checking..." : "Check for pending Telegram account"}
            </button>
          </div>
        )}

        {openclawSource === "external" && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            This machine is attached to an external OpenClaw runtime. Configure Telegram on that
            OpenClaw instance directly so ScienceSwarm does not overwrite a runtime it does not own.
          </div>
        )}

        {!openclawInstalled && openclawSource !== "external" && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Install OpenClaw in the card above first. This Telegram section only attaches a bot to
            the current local OpenClaw runtime.
          </div>
        )}

        {pendingPairing && (
          <div
            className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900"
            data-testid="settings-telegram-pending-pairing"
          >
            <p className="font-medium">
              OpenClaw saw a pending Telegram pairing request from{" "}
              {pendingPairing.firstName ?? pendingPairing.username ?? pendingPairing.userId}.
            </p>
            <p className="mt-1">
              Approve this account so the bot can reply normally instead of waiting in pairing
              mode.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleApprovePendingPairing}
                disabled={connecting || approvingPending || disabledByRuntime}
                className={primaryButtonClassName}
                data-testid="settings-telegram-approve-pending-button"
              >
                {approvingPending ? "Approving..." : "Approve pending Telegram account"}
              </button>
              <span className="self-center text-xs text-sky-900/80">
                {pendingPairing.username
                  ? `Telegram username: @${pendingPairing.username}`
                  : `Telegram user id: ${pendingPairing.userId}`}
              </span>
            </div>
          </div>
        )}

        <fieldset
          className="grid gap-2"
          data-testid="settings-telegram-mode-toggle"
          disabled={connecting || approvingPending || disabledByRuntime}
        >
          <legend className="text-xs font-semibold uppercase tracking-wider text-muted">
            Telegram connection mode
          </legend>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border-2 border-border bg-white px-4 py-3 text-sm">
            <input
              type="radio"
              name="settings-telegram-mode"
              value="fresh"
              checked={mode === "fresh"}
              onChange={() => setMode("fresh")}
              className="mt-1 accent-accent"
              data-testid="settings-telegram-mode-fresh"
            />
            <span>
              <span className="font-medium text-foreground">Create a new personal bot</span>
              <span className="mt-1 block text-xs text-muted">
                We use your Telegram phone number once, create a fresh bot via BotFather, and wire
                that bot into this OpenClaw.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border-2 border-border bg-white px-4 py-3 text-sm">
            <input
              type="radio"
              name="settings-telegram-mode"
              value="reuse"
              checked={mode === "reuse"}
              onChange={() => setMode("reuse")}
              className="mt-1 accent-accent"
              data-testid="settings-telegram-mode-reuse"
            />
            <span>
              <span className="font-medium text-foreground">Connect an existing bot token</span>
              <span className="mt-1 block text-xs text-muted">
                Paste a bot token you already own, or reuse the token already saved on this machine.
                ScienceSwarm validates it and points that bot at this OpenClaw.
              </span>
            </span>
          </label>
        </fieldset>

        {mode === "fresh" ? (
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Telegram phone number
            </span>
            <input
              type="tel"
              value={phoneDraft}
              onChange={(event) => setPhoneDraft(event.target.value)}
              placeholder="+1 415 555 1234"
              className={`mt-1 ${inputClassName}`}
              disabled={connecting || approvingPending || disabledByRuntime}
              data-testid="settings-telegram-phone-input"
            />
            <span className="mt-2 block text-xs text-muted">
              This is the Telegram account that should own the new bot. Nothing changes until you
              click the button below.
            </span>
          </label>
        ) : (
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Telegram bot token
            </span>
            <input
              type="password"
              value={botTokenDraft}
              onChange={(event) => setBotTokenDraft(event.target.value)}
              placeholder={savedBotAvailable ? "Leave blank to reuse the saved token" : "123456789:..."}
              autoComplete="off"
              spellCheck={false}
              className={`mt-1 ${inputClassName}`}
              disabled={connecting || approvingPending || disabledByRuntime}
              data-testid="settings-telegram-bot-token-input"
            />
            <span className="mt-2 block text-xs text-muted">
              {savedBotAvailable
                ? `Saved token on file: ${telegram.botToken}. Leave the field blank to reconnect that bot, or paste a new token to replace it.`
                : "Paste the token for a bot you already created with BotFather."}
            </span>
          </label>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleConnect}
            disabled={connecting || approvingPending || disabledByRuntime}
            className={primaryButtonClassName}
            data-testid="settings-telegram-connect-button"
          >
            {connecting
              ? "Connecting..."
              : mode === "fresh"
                ? "Create and connect bot"
                : reuseUsesSavedBot
                  ? "Reconnect saved bot"
                  : "Connect existing bot"}
          </button>
          <span className="self-center text-xs text-muted">
            {mode === "fresh"
              ? "Creates a new bot for this OpenClaw."
              : "Attaches an existing Telegram bot to this OpenClaw."}
          </span>
        </div>

        {latestTelegramEvent?.detail && latestTelegramEvent.status !== "succeeded" && (
          <div className="rounded-lg border border-border bg-surface/40 p-3 text-sm text-foreground">
            {latestTelegramEvent.detail}
          </div>
        )}

        {inlineSuccess && (
          <div
            className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
            data-testid="settings-telegram-success"
          >
            {inlineSuccess}
          </div>
        )}

        {errorMessage && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            data-testid="settings-telegram-error"
          >
            {errorMessage}
          </div>
        )}

        {waitingForClaim && (
          <div
            className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900"
            data-testid="settings-telegram-claim"
          >
            <p className="font-medium">Open Telegram to finish connecting this bot.</p>
            <p className="mt-1">
              Tap <strong>Start</strong> in the bot chat below. ScienceSwarm will keep listening and
              finish the OpenClaw connection automatically.
            </p>
            <a
              href={waitingForClaim.deeplink}
              target="_blank"
              rel="noreferrer"
              className={`${secondaryButtonClassName} mt-3 inline-flex`}
              data-testid="settings-telegram-claim-link"
            >
              Open bot in Telegram
            </a>
          </div>
        )}

        {waitingForCode && (
          <TelegramCodePrompt
            sessionId={waitingForCode}
            onSubmitted={() => {
              // The stream resumes on its own after /api/setup/telegram-code resolves.
            }}
          />
        )}

        {latestTelegramEvent?.status === "succeeded" && currentOrLatestBot && (
          <TelegramBotReady
            botUrl={currentOrLatestBot.botUrl}
            creature={currentOrLatestBot.creature}
            displayName={currentOrLatestBot.displayName}
          />
        )}
      </div>
    </Section>
  );
}
