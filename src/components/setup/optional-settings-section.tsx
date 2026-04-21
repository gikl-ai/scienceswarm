"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export interface OptionalSettingsValue {
  scienceswarmDir: string;
  googleClientId: string;
  googleClientSecret: string;
  githubId: string;
  githubSecret: string;
}

export interface OptionalSettingsConfiguredState {
  googleClientSecret?: boolean;
  githubSecret?: boolean;
}

export interface OptionalSettingsSectionProps {
  values?: OptionalSettingsValue;
  onChange?: (field: keyof OptionalSettingsValue, value: string) => void;
  configured?: OptionalSettingsConfiguredState;
  disabled?: boolean;
  scienceswarmDirHint?: ReactNode;
  showIntegrations?: boolean;
}

export function OptionalSettingsSection({
  disabled = false,
}: OptionalSettingsSectionProps) {
  return (
    <section
      className="rounded-[28px] border-2 border-border bg-white p-5 shadow-sm"
      data-testid="optional-settings-section"
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted">
        ADVANCED SETTINGS
      </p>
      <h2 className="mt-2 text-xl font-semibold text-foreground">
        Available after onboarding
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        Custom data directories, integrations, and other advanced controls
        now live on{" "}
        <code className="rounded bg-surface px-1 py-0.5 text-[12px]">
          /dashboard/settings
        </code>{" "}
        so onboarding stays focused on getting the local runtime online.
      </p>
      <div
        className="mt-4 rounded-2xl border border-border/70 bg-surface/30 p-4"
        data-testid="optional-settings-panel"
      >
        <p className="text-xs leading-5 text-muted">
          Finish the local OpenClaw + Ollama + Gemma setup here first. After
          the restart, open Settings to change the data directory or configure
          external integrations.
        </p>
        <Link
          href="/dashboard/settings"
          aria-disabled={disabled}
          className={`mt-3 inline-flex rounded-xl border border-border bg-white px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent ${
            disabled ? "pointer-events-none opacity-50" : ""
          }`}
        >
          Open advanced settings later
        </Link>
      </div>
    </section>
  );
}
