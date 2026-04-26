// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ResizableLayout } from "@/components/resizable-layout";

describe("ResizableLayout", () => {
  it("pins the dashboard shell to the viewport so nested panes do not create document scrolling", () => {
    const { container } = render(
      <ResizableLayout sidebar={<nav aria-label="Sidebar">Sidebar</nav>}>
        <section>Dashboard content</section>
      </ResizableLayout>,
    );

    const shell = container.firstElementChild;
    expect(shell).toHaveClass("fixed", "inset-0", "overflow-hidden");
    expect(screen.getByRole("main")).toHaveClass("min-w-0", "overflow-y-auto");
  });
});
