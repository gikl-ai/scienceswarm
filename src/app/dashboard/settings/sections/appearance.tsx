"use client";

import { useTheme } from "@/components/theme-provider";
import { Moon, Sun } from "@phosphor-icons/react";

import { Section } from "./_primitives";

/**
 * Appearance — exposes the theme toggle in Settings so users have a
 * discoverable control. The underlying state is persisted in
 * localStorage (scienceswarm.theme) via ThemeProvider and stays in sync
 * across tabs.
 */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  const options: Array<{ value: "light" | "dark"; label: string; Icon: typeof Sun }> = [
    { value: "light", label: "Light", Icon: Sun },
    { value: "dark", label: "Dark", Icon: Moon },
  ];

  return (
    <Section id="appearance" title="Appearance">
      <div className="text-sm text-dim">
        Switch between the light and dark themes. Your choice persists across
        sessions and tabs.
      </div>
      {/*
       * Toolbar of toggle buttons — not a radiogroup. Native <button> Tab
       * navigation is sufficient and expected here; using role="radiogroup"
       * would imply the ARIA roving-tabindex + arrow-key contract, which we
       * don't want to take on for a two-option theme picker.
       */}
      <div
        role="toolbar"
        aria-label="Theme"
        className="inline-flex rounded-md border border-rule bg-sunk p-1 text-sm"
      >
        {options.map(({ value, label, Icon }) => {
          const active = theme === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              aria-label={`Use ${label.toLowerCase()} theme`}
              onClick={() => setTheme(value)}
              className={[
                "inline-flex items-center gap-2 rounded px-3 py-1.5 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
                "focus-visible:ring-offset-ink focus-visible:ring-accent",
                active
                  ? "bg-raised text-strong"
                  : "text-dim hover:text-strong",
              ].join(" ")}
            >
              <Icon size={14} weight="regular" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
    </Section>
  );
}
