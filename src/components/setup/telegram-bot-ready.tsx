"use client";

import { useEffect, useState } from "react";

interface TelegramBotReadyProps {
  botUrl: string;
  /** The whimsical creature name, e.g. "wobblefinch". */
  creature: string;
  /** Display name as shown in Telegram, e.g. "Wobblefinch — your ScienceSwarm claw". */
  displayName: string;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function TelegramBotReady({
  botUrl,
  creature,
  displayName,
}: TelegramBotReadyProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import("qrcode")
      .then((qr) =>
        qr.toDataURL(botUrl).then((d) => {
          if (!cancelled) setQrDataUrl(d);
        }),
      )
      // If the `qrcode` dynamic import or `toDataURL` rejects (malformed
      // URL, CSP blocking the chunk, etc.) we swallow it — the bot URL
      // link below the QR is always rendered, so the flow still works
      // without the QR, and we don't want a noisy unhandled-rejection.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [botUrl]);

  const capitalizedCreature = capitalize(creature);

  return (
    <section
      className="rounded-[28px] border-2 border-ok/30 bg-ok/10 p-5 shadow-sm"
      data-testid="telegram-bot-ready"
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-ok">
        MEET YOUR CLAW
      </p>
      <h2
        className="mt-2 text-2xl font-semibold text-ok"
        data-testid="creature-name"
      >
        {capitalizedCreature}
      </h2>
      <p
        className="mt-1 text-sm text-ok"
        data-testid="creature-tagline"
      >
        {displayName}
      </p>
      <p className="mt-3 text-sm text-ok">
        Open <strong>{capitalizedCreature}</strong> on your phone or desktop
        and hit <em>Start</em> to begin chatting.
      </p>
      <div className="mt-3 flex items-center gap-4">
        {qrDataUrl && (
          // Using a plain img is appropriate here: the QR is a generated
          // data URL, not a file Next's image optimizer can help with.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qrDataUrl}
            alt={`QR code to open ${capitalizedCreature} on Telegram`}
            className="h-32 w-32 rounded-lg border border-ok/40"
            data-testid="telegram-qr"
          />
        )}
        <a
          href={botUrl}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-sm text-ok underline"
        >
          {botUrl}
        </a>
      </div>
    </section>
  );
}
