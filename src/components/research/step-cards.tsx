"use client";

import { useState } from "react";

// ── Types ──────────────────────────────────────────────────────

/**
 * A single agent "step" — one high-level action the agent takes while
 * working on a user turn (read a file, search gbrain, draft a reply…).
 *
 * The shape is intentionally narrow and explicit so the UI can render
 * consistent pills regardless of the underlying event source (real
 * agent stream or a local mock).
 */
export interface Step {
  id: string;
  verb: "reading" | "searching" | "drafting" | "running";
  target: string;
  status: "running" | "done" | "error";
  at?: number;
}

// ── Verb metadata ──────────────────────────────────────────────

const VERB_META: Record<
  Step["verb"],
  { icon: string; label: string }
> = {
  reading: { icon: "\u{1F4D6}", label: "Reading" },
  searching: { icon: "\u{1F50E}", label: "Searching" },
  drafting: { icon: "\u{270F}\u{FE0F}", label: "Drafting" },
  running: { icon: "\u{26A1}", label: "Running" },
};

// ── Props ──────────────────────────────────────────────────────

export interface StepCardsProps {
  steps?: Step[];
}

// ── Single pill ────────────────────────────────────────────────

interface StepPillProps {
  step: Step;
}

function StepPill({ step }: StepPillProps) {
  // Completed steps are expandable so the user can re-inspect the
  // target after the pill has collapsed to a checkmark. Running / error
  // steps stay fully rendered (no expand affordance needed) and render
  // as plain <div> rather than <button> to avoid a misleading a11y role.
  const isExpandable = step.status === "done";
  const [expanded, setExpanded] = useState(false);

  const meta = VERB_META[step.verb];
  const statusIcon =
    step.status === "done"
      ? "\u2713"
      : step.status === "error"
        ? "\u26A0\uFE0F"
        : null;

  const colorClasses =
    step.status === "error"
      ? "border-danger/30 bg-danger/10 text-danger"
      : step.status === "done"
        ? "border-border bg-muted/5 text-muted"
        : "border-accent/30 bg-accent/5 text-accent";

  const pillBase =
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors";

  // Collapsed/done pill: just the check + verb label, no target.
  // Expanded or running: full "[icon] [verb] [target]" form.
  const showFull = !isExpandable || expanded;

  const body = (
    <>
      {step.status === "done" && !expanded ? (
        <span aria-hidden="true">{statusIcon}</span>
      ) : (
        <span aria-hidden="true">{meta.icon}</span>
      )}
      <span>{meta.label}</span>
      {showFull && (
        <span className="inline-block max-w-[18rem] truncate align-bottom opacity-80">
          {step.target}
        </span>
      )}
      {step.status === "running" && (
        <span
          className="ml-1 inline-block h-1 w-1 animate-pulse rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {step.status === "error" && statusIcon && (
        <span aria-hidden="true">{statusIcon}</span>
      )}
    </>
  );

  const ariaLabel = `${meta.label} ${step.target} (${step.status})`;

  if (isExpandable) {
    return (
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={ariaLabel}
        onClick={() => setExpanded((v) => !v)}
        className={`${pillBase} ${colorClasses} cursor-pointer hover:bg-muted/10`}
      >
        {body}
      </button>
    );
  }

  return (
    <div
      role="status"
      aria-label={ariaLabel}
      className={pillBase + " " + colorClasses}
    >
      {body}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────

/**
 * Renders a horizontal row of step pills above an assistant message.
 * No-op when `steps` is absent/empty — safe to drop into any message
 * renderer without gating.
 */
export function StepCards({ steps }: StepCardsProps) {
  if (!steps || steps.length === 0) return null;

  return (
    <div
      data-testid="step-cards"
      className="mb-2 flex flex-wrap gap-1.5"
      aria-label="Agent progress"
    >
      {steps.map((step) => (
        <StepPill key={step.id} step={step} />
      ))}
    </div>
  );
}
