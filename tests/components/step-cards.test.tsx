// @vitest-environment jsdom

/**
 * Tests for `src/components/research/step-cards.tsx`.
 *
 * Covers the three core UI contracts the hook + page rely on:
 *   1. renders nothing when steps are absent/empty (safe drop-in),
 *   2. running steps render as non-button status elements,
 *   3. done steps render as expandable <button aria-expanded>.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StepCards, type Step } from "@/components/research/step-cards";

describe("StepCards", () => {
  it("renders nothing when steps is undefined", () => {
    const { container } = render(<StepCards />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when steps is an empty array", () => {
    const { container } = render(<StepCards steps={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a running step as a non-button status element", () => {
    const steps: Step[] = [
      { id: "s1", verb: "reading", target: "paper.pdf", status: "running" },
    ];
    render(<StepCards steps={steps} />);

    const container = screen.getByTestId("step-cards");
    expect(container).toBeInTheDocument();

    // Running steps should NOT be buttons — they have no expand action.
    expect(container.querySelector("button")).toBeNull();
    // Full "[verb] [target]" form is visible while running.
    expect(screen.getByText(/paper\.pdf/)).toBeInTheDocument();
  });

  it("renders a done step as an expandable button and toggles on click", () => {
    const steps: Step[] = [
      { id: "s1", verb: "searching", target: "gbrain: graph", status: "done" },
    ];
    render(<StepCards steps={steps} />);

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");
    // Collapsed: target is hidden.
    expect(screen.queryByText(/gbrain: graph/)).toBeNull();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/gbrain: graph/)).toBeInTheDocument();
  });

  it("renders multiple steps in order", () => {
    const steps: Step[] = [
      { id: "a", verb: "reading", target: "a.pdf", status: "done" },
      { id: "b", verb: "drafting", target: "reply", status: "running" },
    ];
    render(<StepCards steps={steps} />);

    const pills = screen
      .getByTestId("step-cards")
      .querySelectorAll("button, [role='status']");
    expect(pills.length).toBe(2);
  });
});
