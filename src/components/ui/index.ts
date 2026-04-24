/**
 * Public surface of the ScienceSwarm design-system component layer.
 *
 * Re-exports the `ss-*` wrapper layer (Layer 1) only. The raw shadcn
 * primitives (button.tsx, dialog.tsx, ...) are Layer 0 — internal.
 * Application code (`src/app/**`, `src/components/research/**`, etc.)
 * must import from this index, not from the raw files. The
 * `no-restricted-imports` rule in eslint.config.mjs enforces that.
 *
 * Order below mirrors COMPONENT_ARCHITECTURE.md §4.1–4.5 groupings.
 */

// 4.1 Foundation
export * from "./ss-button";
export * from "./ss-input";
export * from "./ss-label";
export * from "./ss-textarea";
export * from "./ss-separator";

// 4.2 Overlays
export * from "./ss-dialog";
export * from "./ss-popover";
export * from "./ss-tooltip";
export * from "./ss-dropdown-menu";
export * from "./ss-sheet";

// 4.3 Input primitives
export * from "./ss-select";
export * from "./ss-checkbox";
export * from "./ss-switch";
export * from "./ss-command";

// 4.4 Data
export * from "./ss-tabs";
export * from "./ss-scroll-area";

// 4.5 Feedback
export * from "./ss-sonner";
export * from "./ss-progress";
