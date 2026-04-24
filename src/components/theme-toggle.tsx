"use client";

/**
 * ThemeToggle — an icon-only button that flips between light and dark.
 * Uses the Phosphor icon set (already in deps). No filled-accent color —
 * the icon inherits the surrounding text tone, matching the design
 * system's color-discipline rule (accent reserved for action moments).
 */

import { Moon, Sun } from "@phosphor-icons/react";

import { useTheme } from "@/components/theme-provider";

export function ThemeToggle({
  className = "",
  size = 16,
}: {
  className?: string;
  size?: number;
}) {
  const { theme, toggleTheme } = useTheme();
  const next = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={
        "inline-grid place-items-center h-7 w-7 rounded-md text-dim " +
        "hover:bg-sunk hover:text-strong " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
        "focus-visible:ring-offset-ink focus-visible:ring-accent " +
        "transition-colors " +
        className
      }
    >
      {theme === "light" ? (
        <Moon size={size} weight="regular" aria-hidden="true" />
      ) : (
        <Sun size={size} weight="regular" aria-hidden="true" />
      )}
    </button>
  );
}
