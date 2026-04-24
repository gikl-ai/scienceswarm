"use client";

/**
 * SsSonner — ScienceSwarm-wrapped toast host.
 *
 * The raw `Toaster` reads theme from `next-themes`. Our theme system
 * lives on `<html data-theme>`, populated by the ThemeProvider that
 * landed in the foundation PR (#217). The wrapper resolves the active
 * theme from the attribute directly so toasts stay in lockstep with
 * the rest of the UI instead of out-of-band through next-themes.
 *
 * Editorial-voice defaults (per DESIGN.md §9):
 *   - `saved(msg?)`   — replaces "Success!".
 *   - `synced(msg?)`  — replaces "Saved successfully.".
 *   - `stalled(msg?)` — replaces "Pending...".
 *   - `offTrack(msg)` — replaces "Error!".
 *
 * These helpers wrap `sonner`'s `toast` so callers never have to
 * reach for exclamation-driven copy.
 */

import * as React from "react";
import { Toaster } from "./sonner";
import { toast as sonnerToast, type ToasterProps } from "sonner";

type ResolvedTheme = "dark" | "light";

function readTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "dark";
  const value = document.documentElement.getAttribute("data-theme");
  return value === "light" ? "light" : "dark";
}

export function SsSonner(props: Omit<ToasterProps, "theme">) {
  // Defer mounting until after hydration. SSR can't read the
  // <html data-theme> attribute, so emitting a concrete theme on the
  // server and then reconciling on the client produces a hydration
  // warning. Skipping the first render sidesteps the mismatch and
  // avoids the post-mount theme flip.
  const [mounted, setMounted] = React.useState(false);
  const [theme, setTheme] = React.useState<ResolvedTheme>(() => readTheme());

  React.useEffect(() => {
    setMounted(true);
    setTheme(readTheme());
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  if (!mounted) return null;
  return <Toaster theme={theme} {...props} />;
}

/** Editorial microcopy helpers. Keep messages understated — no "!". */
export const ssToast = {
  saved: (msg: string = "Saved") => sonnerToast(msg),
  synced: (msg: string = "Synced") => sonnerToast(msg),
  stalled: (msg: string = "Still working") => sonnerToast(msg),
  offTrack: (msg: string) => sonnerToast.error(msg),
  /** Direct passthrough for callers that want the raw sonner API. */
  raw: sonnerToast,
};
